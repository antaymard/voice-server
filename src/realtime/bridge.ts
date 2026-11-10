import type WebSocket from "ws";
import type { RealtimeTranscription } from "@mistralai/mistralai/extra/realtime";
import {
  CLOSE_BAD_MESSAGE,
  CLOSE_DONE,
  CLOSE_IDLE_TIMEOUT,
  CLOSE_INTERNAL,
  CLOSE_SESSION_TOO_LONG,
  CLOSE_UPSTREAM_ERROR,
  normalizeStart,
  parseClientMessage,
  type ServerErrorCode,
  type ServerEvent,
  type StartParams,
} from "../../client/src/protocol.ts";
import type { Config } from "../config.ts";
import type { RawSessionUpdate } from "../mistral.ts";
import { connectTranscription, rawDataToBuffer, type Transcription } from "./upstream.ts";

const DONE_GRACE_MS = 10_000;
const MAX_CLIENT_BUFFERED_BYTES = 5 * 1024 * 1024;

export function toSessionUpdate(
  params: Pick<StartParams, "sampleRate" | "targetDelayMs" | "language" | "contextBias" | "turnDetection"> &
    Partial<Pick<StartParams, "diarize" | "speakerReferences">>,
): RawSessionUpdate {
  const turn = params.turnDetection;
  return {
    audio_format: { encoding: "pcm_s16le", sample_rate: params.sampleRate },
    target_streaming_delay_ms: params.targetDelayMs,
    ...(params.language ? { language: params.language } : {}),
    ...(params.contextBias ? { context_bias: params.contextBias } : {}),
    ...(params.diarize ? { diarize: true } : {}),
    ...(params.speakerReferences ? { speaker_references: params.speakerReferences } : {}),
    ...(turn
      ? {
          turn_detection: {
            start_threshold: turn.startThreshold,
            eager_end_threshold: turn.eagerEndThreshold,
            end_threshold: turn.endThreshold,
            min_silence_ms: turn.minSilenceMs,
            end_timeout_ms: turn.endTimeoutMs,
          },
        }
      : {}),
  };
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
  let upstream: Transcription | null = null;
  let started = false;
  let ready = false;
  let stopping = false;
  let finished = false;
  let closeAfterDoneReason = "done";

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
    upstream?.close();
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

  /** The final transcript is due: don't wait for it forever. */
  const armDoneTimer = (): void => {
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
  };

  const beginStop = (reason: string): void => {
    if (finished || stopping) return;
    stopping = true;
    closeAfterDoneReason = reason;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    upstream?.end();
  };

  const connectUpstream = (params: StartParams): void => {
    upstream = connectTranscription(realtime, config.realtimeModel, toSessionUpdate(params), {
      onReady: (requestId) => {
        ready = true;
        send({
          type: "ready",
          requestId,
          model: config.realtimeModel,
          sampleRate: params.sampleRate,
          targetDelayMs: params.targetDelayMs,
          language: params.language ?? null,
          diarize: params.diarize,
          turnDetection: params.turnDetection !== undefined,
        });
      },
      onDelta: (text) => send({ type: "delta", text }),
      onSegment: (segment) => send({ type: "segment", ...segment }),
      onLanguage: (language) => send({ type: "language", language }),
      onTurn: (turn) => send({ type: "turn", ...turn }),
      onEnding: armDoneTimer,
      onDone: (done) => {
        send({ type: "done", ...done });
        finish(CLOSE_DONE, closeAfterDoneReason);
      },
      onError: (code, message) =>
        fail(code, message, code === "server_error" ? CLOSE_INTERNAL : CLOSE_UPSTREAM_ERROR),
    });
  };

  ws.on("message", (data, isBinary) => {
    if (finished) return;
    resetIdle();

    if (isBinary) {
      if (!started) {
        fail("bad_message", "Binary audio received before `start`", CLOSE_BAD_MESSAGE);
        return;
      }
      upstream?.sendAudio(rawDataToBuffer(data));
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
        if ("error" in params) {
          fail("bad_message", params.error, CLOSE_BAD_MESSAGE);
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
        upstream?.flush();
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
