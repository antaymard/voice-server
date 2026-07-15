/**
 * Wire protocol between browser clients and the voice-server
 * `/v1/gladia/realtime` WebSocket endpoint (Gladia-powered live STT).
 * Single source of truth: the server imports these types from here, and the
 * React kit ships them to consuming apps.
 *
 * This is intentionally NOT the same protocol as `/v1/realtime` (Mistral):
 * Gladia transcribes utterance-by-utterance with voice-activity endpointing,
 * supports language hints and business vocabulary, and distinguishes mutable
 * `partial` hypotheses from committed `utterance` results — the protocol
 * exposes those differences instead of hiding them.
 *
 * Transport rules:
 * - Client -> server: one `start` text frame first, then raw binary frames of
 *   PCM s16le mono audio at the declared sample rate. `stop` is an optional
 *   text frame (there is no `flush`; endpointing finalizes utterances).
 * - Server -> client: JSON text frames (`GladiaServerEvent`).
 */

import type { ServerErrorCode } from "./protocol.ts";

/** Sample rates accepted by Gladia live (note: 32000 yes, 22050 no). */
export const GLADIA_SAMPLE_RATES = [8000, 16000, 32000, 44100, 48000] as const;
export type GladiaSampleRate = (typeof GLADIA_SAMPLE_RATES)[number];

/** Silence (seconds) that ends an utterance; clamped to Gladia's bounds. */
export const MIN_ENDPOINTING_S = 0.01;
export const MAX_ENDPOINTING_S = 10;
/** Cap (seconds) on utterance length when no silence occurs. */
export const MIN_FORCED_ENDPOINTING_S = 5;
export const MAX_FORCED_ENDPOINTING_S = 60;

/**
 * One business-vocabulary entry. A bare string is a plain term; the object
 * form adds phonetic hints:
 * - `pronunciations`: how the term sounds when spoken ("sell force" for
 *   "Salesforce"), for phoneme matching.
 * - `intensity`: 0..1, how aggressively near-matches are replaced (Gladia
 *   default 0.5-ish; raise if terms are missed, lower on false positives).
 * - `language`: ISO 639-1 code of the term itself (an English brand name in
 *   an otherwise French transcript, for example).
 */
export type GladiaVocabularyTerm = {
  value: string;
  pronunciations?: string[];
  intensity?: number;
  language?: string;
};
export type GladiaVocabularyEntry = string | GladiaVocabularyTerm;

export type GladiaStartMessage = {
  type: "start";
  /** Sample rate of the PCM binary frames. Default 16000. */
  sampleRate?: number;
  /**
   * Candidate languages (ISO 639-1). Omitted/empty = full auto-detect;
   * exactly one = forced; several = detection restricted to the list.
   */
  languages?: string[];
  /** Allow switching languages mid-stream (multilingual conversations). */
  codeSwitching?: boolean;
  /** Business vocabulary to bias the transcription with. */
  vocabulary?: GladiaVocabularyEntry[];
  /** Default replacement intensity (0..1) for entries that don't set one. */
  vocabularyIntensity?: number;
  /** Seconds of silence that finalize an utterance (Gladia default 0.05). */
  endpointing?: number;
  /** Seconds after which an utterance is finalized even without silence. */
  maxDurationWithoutEndpointing?: number;
  /** Denoise the input before transcription (adds a little latency). */
  audioEnhancer?: boolean;
  /** Emit mutable `partial` events between committed utterances. Default true. */
  partials?: boolean;
};

/** End the session gracefully: remaining utterances and a `done` event follow. */
export type GladiaStopMessage = { type: "stop" };

export type GladiaClientMessage = GladiaStartMessage | GladiaStopMessage;

export type GladiaReadyEvent = {
  type: "ready";
  /** Gladia live session id (safe to log / correlate with Gladia's console). */
  sessionId: string;
  sampleRate: number;
  partials: boolean;
};

export type GladiaWord = { word: string; start: number; end: number; confidence: number };

/**
 * In-progress hypothesis for the CURRENT utterance. Each `partial` replaces
 * the previous one (it is NOT append-only); render it as ephemeral text.
 */
export type GladiaPartialEvent = {
  type: "partial";
  text: string;
  language?: string;
  confidence?: number;
};

/** A committed utterance: final text, never rewritten afterwards. */
export type GladiaUtteranceEvent = {
  type: "utterance";
  text: string;
  start: number;
  end: number;
  language?: string;
  confidence?: number;
  words?: GladiaWord[];
};

export type GladiaFinalUtterance = {
  text: string;
  start: number;
  end: number;
  language?: string;
  confidence?: number;
};

export type GladiaDoneEvent = {
  type: "done";
  /** Full transcript of the session. */
  text: string;
  utterances: GladiaFinalUtterance[];
};

/** Same error codes and close codes as the Mistral realtime endpoint. */
export type GladiaErrorEvent = { type: "error"; code: ServerErrorCode; message: string };

export type GladiaServerEvent =
  | GladiaReadyEvent
  | GladiaPartialEvent
  | GladiaUtteranceEvent
  | GladiaDoneEvent
  | GladiaErrorEvent;

export type GladiaVocabularyParse =
  | { ok: true; vocabulary: GladiaVocabularyEntry[] }
  | { ok: false; error: string };

/**
 * Validate a user-supplied vocabulary list into clean entries (unknown keys
 * stripped — the result is forwarded verbatim to Gladia). Shared by the
 * realtime bridge and the bulk endpoint.
 */
export function parseGladiaVocabulary(value: unknown): GladiaVocabularyParse {
  if (value === undefined || value === null) return { ok: true, vocabulary: [] };
  if (!Array.isArray(value)) return { ok: false, error: "`vocabulary` must be an array" };
  const vocabulary: GladiaVocabularyEntry[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) vocabulary.push(trimmed);
      continue;
    }
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: "vocabulary entries must be strings or { value, ... } objects" };
    }
    const raw = item as Record<string, unknown>;
    const term = raw["value"];
    if (typeof term !== "string" || !term.trim()) {
      return { ok: false, error: "vocabulary objects need a non-empty string `value`" };
    }
    const entry: GladiaVocabularyTerm = { value: term.trim() };
    const pronunciations = raw["pronunciations"];
    if (pronunciations !== undefined) {
      if (
        !Array.isArray(pronunciations) ||
        pronunciations.some((p) => typeof p !== "string" || !p.trim())
      ) {
        return { ok: false, error: "`pronunciations` must be an array of non-empty strings" };
      }
      entry.pronunciations = pronunciations.map((p: string) => p.trim());
    }
    const intensity = raw["intensity"];
    if (intensity !== undefined) {
      if (typeof intensity !== "number" || Number.isNaN(intensity) || intensity < 0 || intensity > 1) {
        return { ok: false, error: "vocabulary `intensity` must be a number between 0 and 1" };
      }
      entry.intensity = intensity;
    }
    const language = raw["language"];
    if (language !== undefined) {
      if (typeof language !== "string" || !language.trim()) {
        return { ok: false, error: "vocabulary `language` must be a non-empty string" };
      }
      entry.language = language.trim();
    }
    vocabulary.push(entry);
  }
  return { ok: true, vocabulary };
}

export function parseGladiaClientMessage(raw: string): GladiaClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const msg = value as Record<string, unknown>;
  switch (msg["type"]) {
    case "start":
      return value as GladiaStartMessage;
    case "stop":
      return { type: "stop" };
    default:
      return null;
  }
}

export type GladiaStartParams = {
  sampleRate: GladiaSampleRate;
  languages: string[];
  codeSwitching: boolean;
  vocabulary: GladiaVocabularyEntry[];
  vocabularyIntensity?: number;
  endpointing?: number;
  maxDurationWithoutEndpointing?: number;
  audioEnhancer: boolean;
  partials: boolean;
};

export type GladiaStartParse =
  | { ok: true; params: GladiaStartParams }
  | { ok: false; error: string };

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Validate and normalize a start message (field-by-field error messages). */
export function normalizeGladiaStart(msg: GladiaStartMessage): GladiaStartParse {
  const sampleRate = msg.sampleRate ?? 16000;
  if (!(GLADIA_SAMPLE_RATES as readonly number[]).includes(sampleRate)) {
    return { ok: false, error: `Unsupported sampleRate (use one of ${GLADIA_SAMPLE_RATES.join(", ")})` };
  }

  const rawLanguages = msg.languages ?? [];
  if (!Array.isArray(rawLanguages) || rawLanguages.some((l) => typeof l !== "string" || !l.trim())) {
    return { ok: false, error: "`languages` must be an array of ISO 639-1 codes" };
  }
  const languages = rawLanguages.map((l) => l.trim());

  const vocab = parseGladiaVocabulary(msg.vocabulary);
  if (!vocab.ok) return { ok: false, error: vocab.error };

  const params: GladiaStartParams = {
    sampleRate: sampleRate as GladiaSampleRate,
    languages,
    codeSwitching: msg.codeSwitching === true,
    vocabulary: vocab.vocabulary,
    audioEnhancer: msg.audioEnhancer === true,
    partials: msg.partials !== false,
  };

  if (msg.vocabularyIntensity !== undefined) {
    if (typeof msg.vocabularyIntensity !== "number" || Number.isNaN(msg.vocabularyIntensity)) {
      return { ok: false, error: "`vocabularyIntensity` must be a number between 0 and 1" };
    }
    params.vocabularyIntensity = clamp(msg.vocabularyIntensity, 0, 1);
  }
  if (msg.endpointing !== undefined) {
    if (typeof msg.endpointing !== "number" || Number.isNaN(msg.endpointing)) {
      return { ok: false, error: "`endpointing` must be a number (seconds)" };
    }
    params.endpointing = clamp(msg.endpointing, MIN_ENDPOINTING_S, MAX_ENDPOINTING_S);
  }
  if (msg.maxDurationWithoutEndpointing !== undefined) {
    if (
      typeof msg.maxDurationWithoutEndpointing !== "number" ||
      Number.isNaN(msg.maxDurationWithoutEndpointing)
    ) {
      return { ok: false, error: "`maxDurationWithoutEndpointing` must be a number (seconds)" };
    }
    params.maxDurationWithoutEndpointing = clamp(
      msg.maxDurationWithoutEndpointing,
      MIN_FORCED_ENDPOINTING_S,
      MAX_FORCED_ENDPOINTING_S,
    );
  }
  return { ok: true, params };
}

export function parseGladiaServerEvent(raw: string): GladiaServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  switch ((value as Record<string, unknown>)["type"]) {
    case "ready":
    case "partial":
    case "utterance":
    case "done":
    case "error":
      return value as GladiaServerEvent;
    default:
      return null;
  }
}
