/**
 * Wire protocol between browser clients and the voice-server `/v1/realtime`
 * WebSocket endpoint. Single source of truth: the server imports these types
 * from here, and the React kit ships them to consuming apps.
 *
 * Transport rules:
 * - Client -> server: one `start` text frame first, then raw binary frames of
 *   PCM s16le mono audio at the declared sample rate. `flush` and `stop` are
 *   optional text frames.
 * - Server -> client: JSON text frames (`ServerEvent`).
 */

export const SAMPLE_RATES = [8000, 16000, 22050, 44100, 48000] as const;
export type SampleRate = (typeof SAMPLE_RATES)[number];

export const MIN_TARGET_DELAY_MS = 240;
export const MAX_TARGET_DELAY_MS = 2400;

export type StartMessage = {
  type: "start";
  /** Sample rate of the PCM binary frames. Default 16000. */
  sampleRate?: number;
  /** Latency/accuracy tradeoff; clamped by the server to [240, 2400]. */
  targetDelayMs?: number;
};

/** Ask the transcriber to process buffered audio without waiting. */
export type FlushMessage = { type: "flush" };

/** End the session gracefully: remaining deltas and a `done` event follow. */
export type StopMessage = { type: "stop" };

export type ClientMessage = StartMessage | FlushMessage | StopMessage;

export type ReadyEvent = {
  type: "ready";
  requestId: string;
  model: string;
  sampleRate: number;
  targetDelayMs: number;
};

/** Committed transcript text, append-only (never rewritten). */
export type DeltaEvent = { type: "delta"; text: string };

/** A finalized segment with timestamps (seconds). */
export type SegmentEvent = { type: "segment"; text: string; start: number; end: number };

/** Language detected by the transcriber (ISO 639-1, e.g. "fr"). */
export type LanguageEvent = { type: "language"; language: string };

export type TranscriptSegment = { text: string; start: number; end: number };

export type DoneEvent = {
  type: "done";
  text: string;
  language: string | null;
  segments: TranscriptSegment[];
  usage?: unknown;
};

export type ServerErrorCode =
  | "bad_message"
  | "idle_timeout"
  | "session_too_long"
  | "upstream_error"
  | "backpressure"
  | "server_shutdown"
  | "server_error";

export type ServerErrorEvent = { type: "error"; code: ServerErrorCode; message: string };

export type ServerEvent =
  | ReadyEvent
  | DeltaEvent
  | SegmentEvent
  | LanguageEvent
  | DoneEvent
  | ServerErrorEvent;

// WebSocket close codes used by the server.
export const CLOSE_DONE = 1000;
export const CLOSE_SHUTDOWN = 1001;
export const CLOSE_INTERNAL = 1011;
export const CLOSE_BAD_MESSAGE = 4400;
export const CLOSE_IDLE_TIMEOUT = 4408;
export const CLOSE_SESSION_TOO_LONG = 4413;
export const CLOSE_UPSTREAM_ERROR = 4502;

/** Close codes after which a client should NOT auto-reconnect. */
export const NO_RECONNECT_CLOSE_CODES: readonly number[] = [
  CLOSE_DONE,
  CLOSE_SHUTDOWN,
  CLOSE_BAD_MESSAGE,
];

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const msg = value as Record<string, unknown>;
  switch (msg["type"]) {
    case "start": {
      const sampleRate = msg["sampleRate"];
      const targetDelayMs = msg["targetDelayMs"];
      if (sampleRate !== undefined && typeof sampleRate !== "number") return null;
      if (targetDelayMs !== undefined && typeof targetDelayMs !== "number") return null;
      return { type: "start", sampleRate, targetDelayMs };
    }
    case "flush":
      return { type: "flush" };
    case "stop":
      return { type: "stop" };
    default:
      return null;
  }
}

export type StartParams = { sampleRate: SampleRate; targetDelayMs: number };

/** Validate and normalize a start message. Returns null on unsupported sampleRate. */
export function normalizeStart(msg: StartMessage, defaultTargetDelayMs: number): StartParams | null {
  const sampleRate = msg.sampleRate ?? 16000;
  if (!(SAMPLE_RATES as readonly number[]).includes(sampleRate)) return null;
  const requested = msg.targetDelayMs ?? defaultTargetDelayMs;
  const targetDelayMs = Math.round(
    Math.min(MAX_TARGET_DELAY_MS, Math.max(MIN_TARGET_DELAY_MS, requested)),
  );
  return { sampleRate: sampleRate as SampleRate, targetDelayMs };
}

export function parseServerEvent(raw: string): ServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  switch ((value as Record<string, unknown>)["type"]) {
    case "ready":
    case "delta":
    case "segment":
    case "language":
    case "done":
    case "error":
      return value as ServerEvent;
    default:
      return null;
  }
}
