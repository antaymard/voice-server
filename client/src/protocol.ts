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

/**
 * Voxtral 3 accepts a streaming delay in [80, 1200] ms, or exactly 2400 ms.
 * Values in between snap to the nearest accepted bound.
 */
export const MIN_TARGET_DELAY_MS = 80;
export const MAX_CONTINUOUS_TARGET_DELAY_MS = 1200;
export const MAX_TARGET_DELAY_MS = 2400;

/** Max known-speaker clips per session (Mistral limit). */
export const MAX_SPEAKER_REFERENCES = 8;

/**
 * Turn detection tuning (Voxtral 3 realtime). Every field is optional; omitted
 * fields use Mistral's defaults (shown). Constraints:
 * `startThreshold >= eagerEndThreshold > endThreshold`, `endTimeoutMs >= minSilenceMs`.
 */
export type TurnDetectionOptions = {
  /** Speech score needed to start or resume a turn (0-1, default 0.5). */
  startThreshold?: number;
  /** Score under which an eager end is sent (0-1, default 0.5). */
  eagerEndThreshold?: number;
  /** Score under which the turn ends (0-1, default 0.33). */
  endThreshold?: number;
  /** Minimum pause before a turn can end (default 500 ms). */
  minSilenceMs?: number;
  /** Pause that ends the turn regardless of score (default 3000 ms). */
  endTimeoutMs?: number;
};

/** Mistral's documented presets; pass one as `turnDetection`. */
export const TURN_DETECTION_PRESETS = {
  default: {},
  aggressive: {
    startThreshold: 0.5,
    eagerEndThreshold: 0.4,
    endThreshold: 0.33,
    minSilenceMs: 300,
    endTimeoutMs: 2500,
  },
} as const satisfies Record<string, TurnDetectionOptions>;

const TURN_DEFAULTS: Required<TurnDetectionOptions> = {
  startThreshold: 0.5,
  eagerEndThreshold: 0.5,
  endThreshold: 0.33,
  minSilenceMs: 500,
  endTimeoutMs: 3000,
};

export type StartMessage = {
  type: "start";
  /** Sample rate of the PCM binary frames. Default 16000. */
  sampleRate?: number;
  /** Latency/accuracy tradeoff in ms: 80-1200, or 2400 (other values snap). */
  targetDelayMs?: number;
  /** Pin the spoken language (ISO 639-1, e.g. "fr"); omit to auto-detect. */
  language?: string;
  /** Names, terms, or a short description of the conversation, to fix spellings. */
  contextBias?: string[];
  /**
   * Label text by speaker: the server sends `segment` events (with
   * `speakerId`) instead of `delta` events. Incompatible with `turnDetection`.
   */
  diarize?: boolean;
  /**
   * Known speakers: name -> base64 audio clip (3-15 s, WAV/Opus/MP3/FLAC, up
   * to 8). The name becomes the `speakerId`. Implies `diarize`.
   */
  speakerReferences?: Record<string, string>;
  /**
   * Emit `turn` events (start / eager_end / resume / end). `true` = Mistral
   * defaults; or pass tuning options. Incompatible with `diarize`.
   */
  turnDetection?: boolean | TurnDetectionOptions;
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
  /** Pinned language, or null when auto-detected. */
  language: string | null;
  diarize: boolean;
  turnDetection: boolean;
};

/** Committed transcript text, append-only (never rewritten). Not sent when diarizing. */
export type DeltaEvent = { type: "delta"; text: string };

/**
 * A finalized, speaker-labelled segment (sent instead of deltas when
 * `diarize` is on). Realtime segments carry no timestamps: `start`/`end` are
 * null there. `speakerId` is "speaker_1", "speaker_2"… or a reference name.
 */
export type SegmentEvent = {
  type: "segment";
  text: string;
  start: number | null;
  end: number | null;
  speakerId: string | null;
};

export type TurnPhase = "start" | "eager_end" | "resume" | "end";

/**
 * Turn detection (when enabled). `eager_end` = the user has probably
 * finished (start only discardable work); `resume` cancels it; `end` is
 * final. `time` is the position in the audio stream, in seconds.
 */
export type TurnEvent = {
  type: "turn";
  phase: TurnPhase;
  time: number;
  /** Only on `end`: score-based ("threshold") or silence-based ("timeout"). */
  endReason?: "threshold" | "timeout";
};

/** Language detected by the transcriber (ISO 639-1, e.g. "fr"). */
export type LanguageEvent = { type: "language"; language: string };

export type TranscriptSegment = {
  text: string;
  start: number | null;
  end: number | null;
  speakerId: string | null;
};

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
  | TurnEvent
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
      const start: StartMessage = { type: "start", sampleRate, targetDelayMs };
      // Voxtral 3 session options: shape-checked here, validated in normalizeStart.
      const { language, contextBias, diarize, speakerReferences, turnDetection } = msg;
      if (language !== undefined) {
        if (typeof language !== "string") return null;
        start.language = language;
      }
      if (contextBias !== undefined) {
        if (!Array.isArray(contextBias) || !contextBias.every((t) => typeof t === "string")) return null;
        start.contextBias = contextBias;
      }
      if (diarize !== undefined) {
        if (typeof diarize !== "boolean") return null;
        start.diarize = diarize;
      }
      if (speakerReferences !== undefined) {
        if (!isStringRecord(speakerReferences)) return null;
        start.speakerReferences = speakerReferences;
      }
      if (turnDetection !== undefined) {
        if (typeof turnDetection !== "boolean" && !isNumberRecord(turnDetection)) return null;
        start.turnDetection = turnDetection as boolean | TurnDetectionOptions;
      }
      return start;
    }
    case "flush":
      return { type: "flush" };
    case "stop":
      return { type: "stop" };
    default:
      return null;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

export type StartParams = {
  sampleRate: SampleRate;
  targetDelayMs: number;
  language?: string;
  contextBias?: string[];
  diarize: boolean;
  speakerReferences?: Record<string, string>;
  /** Resolved tuning (all fields set); absent when turn detection is off. */
  turnDetection?: Required<TurnDetectionOptions>;
};

/** Clamp to [80, 2400] and snap the unsupported (1200, 2400) gap to its nearest bound. */
export function normalizeTargetDelay(requested: number): number {
  const clamped = Math.round(Math.min(MAX_TARGET_DELAY_MS, Math.max(MIN_TARGET_DELAY_MS, requested)));
  if (clamped <= MAX_CONTINUOUS_TARGET_DELAY_MS || clamped === MAX_TARGET_DELAY_MS) return clamped;
  const midpoint = (MAX_CONTINUOUS_TARGET_DELAY_MS + MAX_TARGET_DELAY_MS) / 2;
  return clamped < midpoint ? MAX_CONTINUOUS_TARGET_DELAY_MS : MAX_TARGET_DELAY_MS;
}

function resolveTurnDetection(
  options: TurnDetectionOptions,
): Required<TurnDetectionOptions> | { error: string } {
  const known = Object.keys(TURN_DEFAULTS);
  const unknown = Object.keys(options).filter((k) => !known.includes(k));
  if (unknown.length > 0) return { error: `Unknown turnDetection field(s): ${unknown.join(", ")}` };
  const t = { ...TURN_DEFAULTS, ...options };
  for (const key of ["startThreshold", "eagerEndThreshold", "endThreshold"] as const) {
    if (t[key] < 0 || t[key] > 1) return { error: `turnDetection.${key} must be between 0 and 1` };
  }
  for (const key of ["minSilenceMs", "endTimeoutMs"] as const) {
    if (!Number.isInteger(t[key]) || t[key] <= 0) {
      return { error: `turnDetection.${key} must be a positive integer (ms)` };
    }
  }
  if (!(t.startThreshold >= t.eagerEndThreshold && t.eagerEndThreshold > t.endThreshold)) {
    return { error: "turnDetection requires startThreshold >= eagerEndThreshold > endThreshold" };
  }
  if (t.endTimeoutMs < t.minSilenceMs) {
    return { error: "turnDetection requires endTimeoutMs >= minSilenceMs" };
  }
  return t;
}

/**
 * Validate and normalize a start message. Rejecting bad options here (rather
 * than letting Mistral error mid-session) closes with 4400, which clients
 * don't auto-reconnect on — retrying the same settings would fail again.
 */
export function normalizeStart(
  msg: StartMessage,
  defaultTargetDelayMs: number,
): StartParams | { error: string } {
  const sampleRate = msg.sampleRate ?? 16000;
  if (!(SAMPLE_RATES as readonly number[]).includes(sampleRate)) {
    return { error: `Unsupported sampleRate (use one of ${SAMPLE_RATES.join(", ")})` };
  }
  const params: StartParams = {
    sampleRate: sampleRate as SampleRate,
    targetDelayMs: normalizeTargetDelay(msg.targetDelayMs ?? defaultTargetDelayMs),
    diarize: msg.diarize === true,
  };

  if (msg.language !== undefined && msg.language !== "") {
    const language = msg.language.toLowerCase();
    if (!/^[a-z]{2}$/.test(language)) {
      return { error: "`language` must be a two-letter ISO 639-1 code (e.g. \"fr\")" };
    }
    params.language = language;
  }

  const contextBias = (msg.contextBias ?? []).map((t) => t.trim()).filter(Boolean);
  if (contextBias.length > 0) params.contextBias = contextBias;

  const references = Object.entries(msg.speakerReferences ?? {});
  if (references.length > 0) {
    if (references.length > MAX_SPEAKER_REFERENCES) {
      return { error: `At most ${MAX_SPEAKER_REFERENCES} speakerReferences are supported` };
    }
    if (references.some(([name, audio]) => !name.trim() || !audio)) {
      return { error: "speakerReferences needs non-empty names and base64 audio clips" };
    }
    params.speakerReferences = Object.fromEntries(references);
    params.diarize = true; // references are meaningless without diarization
  }

  if (msg.turnDetection !== undefined && msg.turnDetection !== false) {
    if (params.diarize) {
      return { error: "Diarization is not compatible with turn detection (use separate sessions)" };
    }
    const resolved = resolveTurnDetection(msg.turnDetection === true ? {} : msg.turnDetection);
    if ("error" in resolved) return resolved;
    params.turnDetection = resolved;
  }
  return params;
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
    case "turn":
    case "language":
    case "done":
    case "error":
      return value as ServerEvent;
    default:
      return null;
  }
}
