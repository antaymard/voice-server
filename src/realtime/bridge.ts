import type WebSocket from "ws";
import type { RawData } from "ws";
import type {
  RealtimeConnection,
  RealtimeTranscription,
} from "@mistralai/mistralai/extra/realtime";
import {
  CLOSE_BAD_MESSAGE,
  CLOSE_DONE,
  CLOSE_IDLE_TIMEOUT,
  CLOSE_INTERNAL,
  CLOSE_SESSION_TOO_LONG,
  CLOSE_UPSTREAM_ERROR,
  SAMPLE_RATES,
  normalizeStart,
  parseClientMessage,
  type ServerErrorCode,
  type ServerEvent,
  type StartParams,
} from "../../client/src/protocol.ts";
import type { Config } from "../config.ts";
import { sendRawSessionUpdate } from "../mistral.ts";

const CONNECT_TIMEOUT_MS = 10_000;
const DONE_GRACE_MS = 10_000;
const MAX_PENDING_SENDS = 200; // ~20s of audio at 100ms frames
const MAX_PREREADY_BUFFER_BYTES = 512 * 1024; // ~16s @ 16kHz s16le
const MAX_CLIENT_BUFFERED_BYTES = 5 * 1024 * 1024;

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Bridge one browser WebSocket to one Mistral realtime connection.
 * Cleanup is idempotent and runs whichever side dies first.
 */
export function runSession(
  ws: WebSocket,
  realtime: RealtimeTranscription,
  config: Config,
  onClose: () => void,
): void {
  let upstream: RealtimeConnection | null = null;
  let started = false;
  let ready = false;
  let stopping = false;
  let stopPending = false;
  let finished = false;
  let closeAfterDoneReason = "done";

  let pendingSends = 0;
  let sendChain: Promise<void> = Promise.resolve();
  const preReadyAudio: Buffer[] = [];
  let preReadyBytes = 0;

  let idleTimer: NodeJS.Timeout | null = null;
  let sessionTimer: NodeJS.Timeout | null = null;
  let doneTimer: NodeJS.Timeout | null = null;

  const clearTimers = (): void => {
    for (const t of [idleTimer, sessionTimer, doneTimer]) if (t) clearTimeout(t);
    idleTimer = sessionTimer = doneTimer = null;
  };

  const finish = (code: number, reason: string): void => {
    if (finished) return;
    finished = true;
    clearTimers();
    onClose();
    const conn = upstream;
    if (conn) void conn.close().catch(() => {});
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    }
  };

  const send = (event: ServerEvent): void => {
    if (finished || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
      finish(CLOSE_INTERNAL, "client_too_slow");
      return;
    }
    ws.send(JSON.stringify(event));
  };

  const fail = (code: ServerErrorCode, message: string, closeCode: number): void => {
    if (finished) return;
    // The client gets the error event, but keep a server-side trace too — a
    // client that mishandles the event otherwise leaves nothing to debug with.
    console.warn(`[realtime] session error (${code}, close ${closeCode}): ${message}`);
    send({ type: "error", code, message });
    finish(closeCode, code);
  };

  const resetIdle = (): void => {
    if (finished || stopping) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => fail("idle_timeout", `No client frames for ${config.idleTimeoutMs}ms`, CLOSE_IDLE_TIMEOUT),
      config.idleTimeoutMs,
    );
  };

  const forwardAudio = (chunk: Buffer): void => {
    const conn = upstream;
    if (!conn || finished || stopping) return;
    pendingSends += 1;
    if (pendingSends > MAX_PENDING_SENDS) {
      fail("backpressure", "Audio arrives faster than upstream accepts it", CLOSE_UPSTREAM_ERROR);
      return;
    }
    sendChain = sendChain
      .then(() => conn.sendAudio(chunk))
      .catch((err) => {
        if (!finished && !stopping) {
          fail("upstream_error", `Failed to forward audio: ${String(err)}`, CLOSE_UPSTREAM_ERROR);
        }
      })
      .finally(() => {
        pendingSends -= 1;
      });
  };

  const executeStop = (): void => {
    const conn = upstream;
    if (!conn || finished) return;
    const maxDuration = closeAfterDoneReason === "max_duration";
    doneTimer = setTimeout(
      () =>
        fail(
          maxDuration ? "session_too_long" : "upstream_error",
          "Timed out waiting for the final transcript",
          maxDuration ? CLOSE_SESSION_TOO_LONG : CLOSE_UPSTREAM_ERROR,
        ),
      DONE_GRACE_MS,
    );
    sendChain = sendChain
      .then(async () => {
        await conn.flushAudio();
        await conn.endAudio();
      })
      .catch((err) => {
        if (!finished) fail("upstream_error", `Failed to finalize: ${String(err)}`, CLOSE_UPSTREAM_ERROR);
      });
  };

  const beginStop = (reason: string): void => {
    if (finished || stopping) return;
    stopping = true;
    closeAfterDoneReason = reason;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!upstream || !ready) {
      stopPending = true;
      return;
    }
    executeStop();
  };

  const pumpEvents = (conn: RealtimeConnection): void => {
    void (async () => {
      try {
        for await (const event of conn.events()) {
          if (finished) break;
          if ("raw" in event) continue; // unparseable/unknown upstream event
          switch (event.type) {
            case "session.created":
            case "session.updated":
              break;
            case "transcription.text.delta":
              send({ type: "delta", text: event.text });
              break;
            case "transcription.segment":
              send({ type: "segment", text: event.text, start: event.start, end: event.end });
              break;
            case "transcription.language":
              send({ type: "language", language: event.audioLanguage });
              break;
            case "transcription.done":
              send({
                type: "done",
                text: event.text,
                language: event.language ?? null,
                segments: (event.segments ?? []).map((s) => ({
                  text: s.text,
                  start: s.start,
                  end: s.end,
                })),
                usage: event.usage,
              });
              finish(CLOSE_DONE, closeAfterDoneReason);
              return;
            case "error": {
              const detail = event.error;
              const message =
                typeof detail?.message === "string"
                  ? detail.message
                  : JSON.stringify(detail?.message ?? "Upstream error");
              fail("upstream_error", message, CLOSE_UPSTREAM_ERROR);
              return;
            }
          }
        }
        if (!finished) {
          fail("upstream_error", "Upstream connection closed unexpectedly", CLOSE_UPSTREAM_ERROR);
        }
      } catch (err) {
        if (!finished) {
          fail("upstream_error", `Upstream stream failed: ${String(err)}`, CLOSE_UPSTREAM_ERROR);
        }
      }
    })();
  };

  const connectUpstream = (params: StartParams): void => {
    void (async () => {
      let conn: RealtimeConnection;
      try {
        conn = await realtime.connect(config.realtimeModel, { timeoutMs: CONNECT_TIMEOUT_MS });
      } catch (err) {
        fail(
          "upstream_error",
          `Could not reach the transcription service: ${String(err)}`,
          CLOSE_UPSTREAM_ERROR,
        );
        return;
      }
      if (finished) {
        void conn.close().catch(() => {});
        return;
      }
      upstream = conn;
      try {
        // WS messages are processed in order upstream, so audio sent after
        // this update is transcribed with the requested format and delay.
        sendRawSessionUpdate(conn, {
          audio_format: { encoding: "pcm_s16le", sample_rate: params.sampleRate },
          target_streaming_delay_ms: params.targetDelayMs,
        });
      } catch (err) {
        fail("server_error", String(err), CLOSE_INTERNAL);
        return;
      }
      pumpEvents(conn);
      ready = true;
      send({
        type: "ready",
        requestId: conn.requestId,
        model: config.realtimeModel,
        sampleRate: params.sampleRate,
        targetDelayMs: params.targetDelayMs,
      });
      for (const chunk of preReadyAudio) forwardAudio(chunk);
      preReadyAudio.length = 0;
      preReadyBytes = 0;
      if (stopPending) executeStop();
    })();
  };

  ws.on("message", (data, isBinary) => {
    if (finished) return;
    resetIdle();

    if (isBinary) {
      if (!started) {
        fail("bad_message", "Binary audio received before `start`", CLOSE_BAD_MESSAGE);
        return;
      }
      if (stopping) return;
      const chunk = rawDataToBuffer(data);
      if (!ready) {
        preReadyBytes += chunk.length;
        if (preReadyBytes > MAX_PREREADY_BUFFER_BYTES) {
          fail("backpressure", "Too much audio buffered before the session was ready", CLOSE_UPSTREAM_ERROR);
          return;
        }
        preReadyAudio.push(chunk);
        return;
      }
      forwardAudio(chunk);
      return;
    }

    const message = parseClientMessage(rawDataToBuffer(data).toString("utf8"));
    if (!message) {
      fail("bad_message", "Unrecognized control message", CLOSE_BAD_MESSAGE);
      return;
    }
    switch (message.type) {
      case "start": {
        if (started) {
          fail("bad_message", "Duplicate `start`", CLOSE_BAD_MESSAGE);
          return;
        }
        const params = normalizeStart(message, config.defaultTargetDelayMs);
        if (!params) {
          fail(
            "bad_message",
            `Unsupported sampleRate (use one of ${SAMPLE_RATES.join(", ")})`,
            CLOSE_BAD_MESSAGE,
          );
          return;
        }
        started = true;
        connectUpstream(params);
        return;
      }
      case "flush": {
        if (!started) {
          fail("bad_message", "`flush` before `start`", CLOSE_BAD_MESSAGE);
          return;
        }
        const conn = upstream;
        if (conn && ready && !stopping) {
          sendChain = sendChain.then(() => conn.flushAudio()).catch(() => {});
        }
        return;
      }
      case "stop": {
        if (!started) {
          fail("bad_message", "`stop` before `start`", CLOSE_BAD_MESSAGE);
          return;
        }
        beginStop("done");
        return;
      }
    }
  });

  ws.on("close", () => finish(CLOSE_DONE, "client_closed"));
  ws.on("error", () => finish(CLOSE_INTERNAL, "client_error"));

  // Armed from accept so a client that connects and never speaks gets reaped.
  resetIdle();
  sessionTimer = setTimeout(() => {
    if (started && ready && !stopping) {
      // Try to finalize gracefully; the done-grace timeout falls back to 4413.
      beginStop("max_duration");
    } else {
      fail("session_too_long", "Maximum session duration reached", CLOSE_SESSION_TOO_LONG);
    }
  }, config.maxSessionMs);
}
