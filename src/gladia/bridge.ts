/**
 * Bridge one browser WebSocket to one Gladia live session:
 * POST /v2/live mints a per-session wss URL (the API key never leaves the
 * server), then binary PCM frames are forwarded verbatim and Gladia's
 * `transcript` messages come back as `partial` / `utterance` events.
 * Cleanup is idempotent and runs whichever side dies first.
 */
import type WebSocket from "ws";
import { WebSocket as UpstreamSocket, type RawData } from "ws";
import {
  normalizeGladiaStart,
  parseGladiaClientMessage,
  type GladiaFinalUtterance,
  type GladiaServerEvent,
  type GladiaStartParams,
  type GladiaWord,
} from "../../client/src/gladiaProtocol.ts";
import {
  CLOSE_BAD_MESSAGE,
  CLOSE_DONE,
  CLOSE_IDLE_TIMEOUT,
  CLOSE_INTERNAL,
  CLOSE_SESSION_TOO_LONG,
  CLOSE_UPSTREAM_ERROR,
  type ServerErrorCode,
} from "../../client/src/protocol.ts";
import type { Config } from "../config.ts";
import { type GladiaClient } from "./client.ts";

const CONNECT_TIMEOUT_MS = 10_000;
// Gladia runs a post-processing pass after stop_recording; give it headroom.
const DONE_GRACE_MS = 15_000;
const MAX_PREREADY_BUFFER_BYTES = 512 * 1024; // ~16s @ 16kHz s16le
const MAX_UPSTREAM_BUFFERED_BYTES = 5 * 1024 * 1024;
const MAX_CLIENT_BUFFERED_BYTES = 5 * 1024 * 1024;

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Build the Gladia POST /v2/live body for validated start params. */
export function buildLiveInitBody(params: GladiaStartParams, config: Config): Record<string, unknown> {
  const body: Record<string, unknown> = {
    encoding: "wav/pcm",
    sample_rate: params.sampleRate,
    bit_depth: 16,
    channels: 1,
    messages_config: {
      receive_partial_transcripts: params.partials,
      receive_final_transcripts: true,
      receive_speech_events: false,
      receive_acknowledgments: false,
      receive_errors: true,
      receive_lifecycle_events: false,
      // post-processing flags left to Gladia defaults so the
      // post_final_transcript message keeps arriving.
    },
  };
  if (config.gladiaLiveModel) body["model"] = config.gladiaLiveModel;
  if (params.languages.length > 0 || params.codeSwitching) {
    body["language_config"] = {
      ...(params.languages.length > 0 ? { languages: params.languages } : {}),
      code_switching: params.codeSwitching,
    };
  }
  if (params.vocabulary.length > 0) {
    body["realtime_processing"] = {
      custom_vocabulary: true,
      custom_vocabulary_config: {
        vocabulary: params.vocabulary,
        ...(params.vocabularyIntensity !== undefined
          ? { default_intensity: params.vocabularyIntensity }
          : {}),
      },
    };
  }
  if (params.endpointing !== undefined) body["endpointing"] = params.endpointing;
  if (params.maxDurationWithoutEndpointing !== undefined) {
    body["maximum_duration_without_endpointing"] = params.maxDurationWithoutEndpointing;
  }
  if (params.audioEnhancer) body["pre_processing"] = { audio_enhancer: true };
  return body;
}

type UpstreamTranscript = {
  is_final?: boolean;
  utterance?: {
    text?: unknown;
    start?: unknown;
    end?: unknown;
    language?: unknown;
    confidence?: unknown;
    words?: unknown;
  };
};

export function runGladiaSession(
  ws: WebSocket,
  gladia: GladiaClient,
  config: Config,
  onClose: () => void,
): void {
  let upstream: InstanceType<typeof UpstreamSocket> | null = null;
  let started = false;
  let ready = false;
  let stopping = false;
  let stopPending = false;
  let finished = false;
  let doneSent = false;
  let closeAfterDoneReason = "done";

  const finalUtterances: GladiaFinalUtterance[] = [];
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
    if (conn && conn.readyState !== conn.CLOSED) {
      try {
        conn.close(1000);
      } catch {
        conn.terminate();
      }
    }
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    }
  };

  const send = (event: GladiaServerEvent): void => {
    if (finished || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
      finish(CLOSE_INTERNAL, "client_too_slow");
      return;
    }
    ws.send(JSON.stringify(event));
  };

  const fail = (code: ServerErrorCode, message: string, closeCode: number): void => {
    if (finished) return;
    console.warn(`[gladia-realtime] session error (${code}, close ${closeCode}): ${message}`);
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

  const sendDone = (text: string, utterances: GladiaFinalUtterance[]): void => {
    if (doneSent) return;
    doneSent = true;
    send({ type: "done", text, utterances });
    finish(CLOSE_DONE, closeAfterDoneReason);
  };

  const doneFromCollected = (): void => {
    sendDone(finalUtterances.map((u) => u.text).join(" ").trim(), finalUtterances);
  };

  const forwardAudio = (chunk: Buffer): void => {
    const conn = upstream;
    if (!conn || finished || stopping) return;
    if (conn.bufferedAmount > MAX_UPSTREAM_BUFFERED_BYTES) {
      fail("backpressure", "Audio arrives faster than upstream accepts it", CLOSE_UPSTREAM_ERROR);
      return;
    }
    conn.send(chunk, (err) => {
      if (err && !finished && !stopping) {
        fail("upstream_error", `Failed to forward audio: ${String(err)}`, CLOSE_UPSTREAM_ERROR);
      }
    });
  };

  const executeStop = (): void => {
    const conn = upstream;
    if (!conn || finished) return;
    const maxDuration = closeAfterDoneReason === "max_duration";
    doneTimer = setTimeout(() => {
      // Post-processing never came back; the collected utterances are still a
      // complete transcript, so prefer degrading to them over erroring out.
      if (finalUtterances.length > 0 && !maxDuration) {
        doneFromCollected();
        return;
      }
      fail(
        maxDuration ? "session_too_long" : "upstream_error",
        "Timed out waiting for the final transcript",
        maxDuration ? CLOSE_SESSION_TOO_LONG : CLOSE_UPSTREAM_ERROR,
      );
    }, DONE_GRACE_MS);
    try {
      conn.send(JSON.stringify({ type: "stop_recording" }));
    } catch (err) {
      fail("upstream_error", `Failed to finalize: ${String(err)}`, CLOSE_UPSTREAM_ERROR);
    }
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

  const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);

  const handleUpstreamMessage = (raw: string): void => {
    let msg: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null) return;
      msg = value as Record<string, unknown>;
    } catch {
      return; // ignore unparseable upstream frames
    }
    switch (msg["type"]) {
      case "transcript": {
        const data = (msg["data"] ?? {}) as UpstreamTranscript;
        const utterance = data.utterance ?? {};
        const text = typeof utterance.text === "string" ? utterance.text : "";
        if (!text) return;
        const language = typeof utterance.language === "string" ? utterance.language : undefined;
        const confidence =
          typeof utterance.confidence === "number" ? utterance.confidence : undefined;
        if (data.is_final === true) {
          const finalUtterance: GladiaFinalUtterance = {
            text,
            start: asNumber(utterance.start),
            end: asNumber(utterance.end),
            ...(language !== undefined ? { language } : {}),
            ...(confidence !== undefined ? { confidence } : {}),
          };
          finalUtterances.push(finalUtterance);
          send({
            type: "utterance",
            ...finalUtterance,
            ...(Array.isArray(utterance.words) ? { words: utterance.words as GladiaWord[] } : {}),
          });
        } else {
          send({
            type: "partial",
            text,
            ...(language !== undefined ? { language } : {}),
            ...(confidence !== undefined ? { confidence } : {}),
          });
        }
        return;
      }
      case "post_final_transcript": {
        const data = msg["data"];
        const transcription =
          typeof data === "object" && data !== null
            ? (data as Record<string, unknown>)["transcription"]
            : undefined;
        const fullTranscript =
          typeof transcription === "object" && transcription !== null
            ? (transcription as Record<string, unknown>)["full_transcript"]
            : undefined;
        sendDone(
          typeof fullTranscript === "string" && fullTranscript
            ? fullTranscript
            : finalUtterances.map((u) => u.text).join(" ").trim(),
          finalUtterances,
        );
        return;
      }
      case "error": {
        const detail = msg["message"] ?? msg["data"] ?? "Upstream error";
        fail(
          "upstream_error",
          typeof detail === "string" ? detail : JSON.stringify(detail),
          CLOSE_UPSTREAM_ERROR,
        );
        return;
      }
      default:
        return; // acknowledgments/lifecycle/addon messages we didn't ask for
    }
  };

  const connectUpstream = (params: GladiaStartParams): void => {
    void (async () => {
      let session: { id: string; url: string };
      try {
        session = await gladia.initLiveSession(buildLiveInitBody(params, config));
      } catch (err) {
        fail(
          "upstream_error",
          `Could not create the Gladia live session: ${String(err instanceof Error ? err.message : err)}`,
          CLOSE_UPSTREAM_ERROR,
        );
        return;
      }
      if (finished) return;

      const conn = new UpstreamSocket(session.url, {
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        perMessageDeflate: false,
      });
      upstream = conn;

      conn.on("open", () => {
        if (finished) {
          conn.close(1000);
          return;
        }
        ready = true;
        send({
          type: "ready",
          sessionId: session.id,
          sampleRate: params.sampleRate,
          partials: params.partials,
        });
        for (const chunk of preReadyAudio) forwardAudio(chunk);
        preReadyAudio.length = 0;
        preReadyBytes = 0;
        if (stopPending) executeStop();
      });

      conn.on("message", (data, isBinary) => {
        if (finished || isBinary) return;
        handleUpstreamMessage(rawDataToBuffer(data).toString("utf8"));
      });

      conn.on("close", (code) => {
        if (finished) return;
        // Gladia closes with 1000 after post-processing; if the final message
        // got lost, fall back to the utterances we already relayed.
        if (stopping && code === 1000) {
          doneFromCollected();
          return;
        }
        fail("upstream_error", `Upstream connection closed unexpectedly (${code})`, CLOSE_UPSTREAM_ERROR);
      });

      conn.on("error", (err) => {
        if (!finished) {
          fail("upstream_error", `Upstream socket failed: ${String(err)}`, CLOSE_UPSTREAM_ERROR);
        }
      });
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

    const message = parseGladiaClientMessage(rawDataToBuffer(data).toString("utf8"));
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
        const result = normalizeGladiaStart(message);
        if (!result.ok) {
          fail("bad_message", result.error, CLOSE_BAD_MESSAGE);
          return;
        }
        started = true;
        connectUpstream(result.params);
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
      beginStop("max_duration");
    } else {
      fail("session_too_long", "Maximum session duration reached", CLOSE_SESSION_TOO_LONG);
    }
  }, config.maxSessionMs);
}
