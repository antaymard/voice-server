/**
 * One Mistral realtime transcription connection: the part shared by
 * `/v1/realtime` (which relays it to the browser) and `/v1/converse` (which
 * feeds it to a conversation). Handles connecting, the session settings,
 * ordered audio forwarding with backpressure, and reading events.
 */
import type { RawData } from "ws";
import type { RealtimeConnection, RealtimeTranscription } from "@mistralai/mistralai/extra/realtime";
import type { TranscriptSegment, TurnPhase } from "../../client/src/protocol.ts";
import { sendRawSessionUpdate, type RawSessionUpdate } from "../mistral.ts";

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_PENDING_SENDS = 200; // ~20s of audio at 100ms frames
const MAX_PREREADY_BUFFER_BYTES = 512 * 1024; // ~16s @ 16kHz s16le

const TURN_PHASES: Record<string, TurnPhase> = {
  "turn.start": "start",
  "turn.eager_end": "eager_end",
  "turn.resume": "resume",
  "turn.end": "end",
};

/** A WebSocket message payload as one Buffer. */
export function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export type TranscriptionErrorCode = "upstream_error" | "backpressure" | "server_error";

export type TranscriptionHandlers = {
  /** Settings are applied; audio sent earlier is forwarded right after this. */
  onReady: (requestId: string) => void;
  onDelta?: (text: string) => void;
  onSegment?: (segment: TranscriptSegment) => void;
  onLanguage?: (language: string) => void;
  onTurn?: (turn: { phase: TurnPhase; time: number; endReason?: "threshold" | "timeout" }) => void;
  /** `end()` has been passed on upstream: the final transcript is on its way. */
  onEnding?: () => void;
  onDone?: (done: { text: string; language: string | null; segments: TranscriptSegment[]; usage?: unknown }) => void;
  /** The connection is unusable; the owner should `close()` it. */
  onError: (code: TranscriptionErrorCode, message: string) => void;
};

export type Transcription = {
  /** Audio sent before the connection is ready is buffered (up to a limit). */
  sendAudio: (chunk: Buffer) => void;
  /** Ask for the buffered audio to be transcribed without waiting. */
  flush: () => void;
  /** No more audio: the final transcript (`onDone`) follows. */
  end: () => void;
  close: () => void;
};

export function connectTranscription(
  realtime: RealtimeTranscription,
  model: string,
  session: RawSessionUpdate,
  handlers: TranscriptionHandlers,
): Transcription {
  let conn: RealtimeConnection | null = null;
  let ready = false;
  let closed = false;
  let ending = false;
  let endPending = false;
  let pendingSends = 0;
  let sendChain: Promise<void> = Promise.resolve();
  const preReady: Buffer[] = [];
  let preReadyBytes = 0;

  const fail = (code: TranscriptionErrorCode, message: string): void => {
    if (!closed) handlers.onError(code, message);
  };

  const forward = (upstream: RealtimeConnection, chunk: Buffer): void => {
    pendingSends += 1;
    if (pendingSends > MAX_PENDING_SENDS) {
      fail("backpressure", "Audio arrives faster than upstream accepts it");
      return;
    }
    sendChain = sendChain
      .then(() => upstream.sendAudio(chunk))
      .catch((err) => {
        if (!ending) fail("upstream_error", `Failed to forward audio: ${String(err)}`);
      })
      .finally(() => {
        pendingSends -= 1;
      });
  };

  const executeEnd = (upstream: RealtimeConnection): void => {
    handlers.onEnding?.();
    sendChain = sendChain
      .then(async () => {
        await upstream.flushAudio();
        await upstream.endAudio();
      })
      .catch((err) => fail("upstream_error", `Failed to finalize: ${String(err)}`));
  };

  const pump = async (upstream: RealtimeConnection): Promise<void> => {
    try {
      for await (const event of upstream.events()) {
        if (closed) return;
        if ("raw" in event) {
          // The SDK doesn't model Voxtral 3 turn events yet; read them raw.
          const phase = TURN_PHASES[event.type];
          const raw = event.raw as { time_s?: unknown; end_reason?: unknown } | null;
          if (phase && raw && typeof raw.time_s === "number") {
            const endReason = raw.end_reason;
            handlers.onTurn?.({
              phase,
              time: raw.time_s,
              ...(endReason === "threshold" || endReason === "timeout" ? { endReason } : {}),
            });
          }
          continue; // other unparseable/unknown upstream events are dropped
        }
        switch (event.type) {
          case "transcription.text.delta":
            handlers.onDelta?.(event.text);
            break;
          case "transcription.segment":
            handlers.onSegment?.({
              text: event.text,
              start: event.start,
              end: event.end,
              speakerId: event.speakerId ?? null,
            });
            break;
          case "transcription.language":
            handlers.onLanguage?.(event.audioLanguage);
            break;
          case "transcription.done":
            handlers.onDone?.({
              text: event.text,
              language: event.language ?? null,
              segments: (event.segments ?? []).map((s) => ({
                text: s.text,
                start: s.start,
                end: s.end,
                speakerId: s.speakerId ?? null,
              })),
              usage: event.usage,
            });
            return;
          case "error": {
            const detail = event.error;
            fail(
              "upstream_error",
              typeof detail?.message === "string"
                ? detail.message
                : JSON.stringify(detail?.message ?? "Upstream error"),
            );
            return;
          }
        }
      }
      fail("upstream_error", "Upstream connection closed unexpectedly");
    } catch (err) {
      fail("upstream_error", `Upstream stream failed: ${String(err)}`);
    }
  };

  void (async () => {
    let upstream: RealtimeConnection;
    try {
      upstream = await realtime.connect(model, { timeoutMs: CONNECT_TIMEOUT_MS });
    } catch (err) {
      fail("upstream_error", `Could not reach the transcription service: ${String(err)}`);
      return;
    }
    if (closed) {
      void upstream.close().catch(() => {});
      return;
    }
    conn = upstream;
    try {
      // WS messages are processed in order upstream, so audio sent after
      // this update is transcribed with the requested settings (which lock
      // on the first audio chunk).
      sendRawSessionUpdate(upstream, session);
    } catch (err) {
      fail("server_error", String(err));
      return;
    }
    void pump(upstream);
    ready = true;
    handlers.onReady(upstream.requestId);
    for (const chunk of preReady.splice(0)) forward(upstream, chunk);
    preReadyBytes = 0;
    if (endPending && !closed) executeEnd(upstream);
  })();

  return {
    sendAudio: (chunk) => {
      if (closed || ending) return;
      if (conn && ready) {
        forward(conn, chunk);
        return;
      }
      preReadyBytes += chunk.length;
      if (preReadyBytes > MAX_PREREADY_BUFFER_BYTES) {
        fail("backpressure", "Too much audio buffered before the session was ready");
        return;
      }
      preReady.push(chunk);
    },
    flush: () => {
      const upstream = conn;
      if (upstream && ready && !ending && !closed) {
        sendChain = sendChain.then(() => upstream.flushAudio()).catch(() => {});
      }
    },
    end: () => {
      if (closed || ending) return;
      ending = true;
      if (conn && ready) executeEnd(conn);
      else endPending = true;
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (conn) void conn.close().catch(() => {});
    },
  };
}
