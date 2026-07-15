/**
 * Bulk transcription backed by Gladia (`POST /v1/gladia/transcribe`).
 *
 * Gladia's pre-recorded API is asynchronous (init -> poll), so this endpoint
 * runs the whole flow server-side and answers with the finished transcript by
 * default. Pass `wait=false` to get the job id immediately and poll it via
 * `GET /v1/gladia/transcribe/:id` (or let Gladia push it to `callback_url`).
 */
import type { Context } from "hono";
import {
  parseGladiaVocabulary,
  type GladiaVocabularyEntry,
} from "../../client/src/gladiaProtocol.ts";
import type { Config } from "../config.ts";
import { mapGladiaError, type GladiaClient, type GladiaJob } from "./client.ts";

const SUMMARY_TYPES = ["general", "bullet_points", "concise"] as const;
const SUBTITLE_FORMATS = ["srt", "vtt"] as const;

type ParsedRequest = {
  file?: { fileName: string; content: Blob };
  audioUrl?: string;
  language?: string;
  codeSwitching?: boolean;
  vocabulary: GladiaVocabularyEntry[];
  vocabularyIntensity?: number;
  context?: string;
  diarization?: boolean;
  speakers?: number;
  minSpeakers?: number;
  maxSpeakers?: number;
  spelling?: Record<string, string[]>;
  sentences?: boolean;
  subtitles: string[];
  summarize?: boolean | (typeof SUMMARY_TYPES)[number];
  chapters?: boolean;
  entities?: boolean;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  wait: boolean;
};

class RequestError extends Error {}

function parseBool(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function parseOptionalCount(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(num) || num < 1) {
    throw new RequestError(`\`${name}\` must be a positive integer`);
  }
  return num;
}

function parseIntensity(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(num) || num < 0 || num > 1) {
    throw new RequestError("`vocabulary_intensity` must be a number between 0 and 1");
  }
  return num;
}

function parseVocabulary(value: unknown): GladiaVocabularyEntry[] {
  const parsed = parseGladiaVocabulary(value);
  if (!parsed.ok) throw new RequestError(parsed.error);
  return parsed.vocabulary;
}

function parseSpelling(value: unknown): Record<string, string[]> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("`spelling` must map correct spellings to arrays of misspellings");
  }
  const out: Record<string, string[]> = {};
  for (const [correct, raw] of Object.entries(value as Record<string, unknown>)) {
    const variants = typeof raw === "string" ? [raw] : raw;
    if (
      !Array.isArray(variants) ||
      variants.length === 0 ||
      variants.some((v) => typeof v !== "string" || !v.trim())
    ) {
      throw new RequestError(`\`spelling\` entry "${correct}" must be a non-empty list of strings`);
    }
    out[correct] = variants.map((v: string) => v.trim());
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseSubtitles(value: unknown): string[] {
  const items =
    typeof value === "string"
      ? value.split(",").map((s) => s.trim()).filter(Boolean)
      : Array.isArray(value)
        ? value
        : [];
  return items.map((item) => {
    if (!(SUBTITLE_FORMATS as readonly unknown[]).includes(item)) {
      throw new RequestError(`Invalid subtitles format "${String(item)}" (use "srt" or "vtt")`);
    }
    return item as string;
  });
}

function parseSummarize(value: unknown): ParsedRequest["summarize"] {
  if (value === undefined || value === null || value === "" || value === false || value === "false") {
    return undefined;
  }
  if (value === true || value === "true" || value === "1") return true;
  if ((SUMMARY_TYPES as readonly unknown[]).includes(value)) {
    return value as (typeof SUMMARY_TYPES)[number];
  }
  throw new RequestError(`\`summarize\` must be true or one of ${SUMMARY_TYPES.join(", ")}`);
}

function parseJsonField<T>(raw: string, name: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new RequestError(`\`${name}\` must be valid JSON`);
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function parseMultipart(c: Context): Promise<ParsedRequest> {
  const form = await c.req.formData();
  const file = form.get("file");
  if (file !== null && !(file instanceof Blob)) {
    throw new RequestError("`file` must be an uploaded file");
  }

  // Plain terms come as repeatable/comma-separated `vocabulary` fields; rich
  // entries (pronunciations, per-term intensity) ride in `vocabulary_json`.
  const plainTerms = form
    .getAll("vocabulary")
    .flatMap((v) => (typeof v === "string" ? v.split(",") : []))
    .map((s) => s.trim())
    .filter(Boolean);
  const vocabularyJson = form.get("vocabulary_json");
  const richTerms =
    typeof vocabularyJson === "string" && vocabularyJson
      ? parseVocabulary(parseJsonField(vocabularyJson, "vocabulary_json"))
      : [];

  const spellingJson = form.get("spelling_json");
  const wait = form.get("wait");

  return {
    file: file
      ? { fileName: (file instanceof File && file.name) || "audio", content: file }
      : undefined,
    audioUrl: optionalString(form.get("audio_url")),
    language: optionalString(form.get("language")),
    codeSwitching: parseBool(form.get("code_switching")),
    vocabulary: [...plainTerms, ...richTerms],
    vocabularyIntensity: parseIntensity(form.get("vocabulary_intensity")),
    context: optionalString(form.get("context")),
    diarization: parseBool(form.get("diarization")),
    speakers: parseOptionalCount(form.get("speakers"), "speakers"),
    minSpeakers: parseOptionalCount(form.get("min_speakers"), "min_speakers"),
    maxSpeakers: parseOptionalCount(form.get("max_speakers"), "max_speakers"),
    spelling:
      typeof spellingJson === "string" && spellingJson
        ? parseSpelling(parseJsonField(spellingJson, "spelling_json"))
        : undefined,
    sentences: parseBool(form.get("sentences")),
    subtitles: parseSubtitles(form.get("subtitles") ?? undefined),
    summarize: parseSummarize(form.get("summarize") ?? undefined),
    chapters: parseBool(form.get("chapters")),
    entities: parseBool(form.get("entities")),
    callbackUrl: optionalString(form.get("callback_url")),
    wait: !(wait === "false" || wait === "0"),
  };
}

function parseJson(body: unknown): ParsedRequest {
  if (typeof body !== "object" || body === null) {
    throw new RequestError("JSON body must be an object");
  }
  const obj = body as Record<string, unknown>;
  const metadata = obj["metadata"];
  if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
    throw new RequestError("`metadata` must be an object");
  }
  return {
    audioUrl: optionalString(obj["audio_url"]),
    language: optionalString(obj["language"]),
    codeSwitching: parseBool(obj["code_switching"]),
    vocabulary: parseVocabulary(obj["vocabulary"]),
    vocabularyIntensity: parseIntensity(obj["vocabulary_intensity"]),
    context: optionalString(obj["context"]),
    diarization: parseBool(obj["diarization"]),
    speakers: parseOptionalCount(obj["speakers"], "speakers"),
    minSpeakers: parseOptionalCount(obj["min_speakers"], "min_speakers"),
    maxSpeakers: parseOptionalCount(obj["max_speakers"], "max_speakers"),
    spelling: parseSpelling(obj["spelling"]),
    sentences: parseBool(obj["sentences"]),
    subtitles: parseSubtitles(obj["subtitles"]),
    summarize: parseSummarize(obj["summarize"]),
    chapters: parseBool(obj["chapters"]),
    entities: parseBool(obj["entities"]),
    callbackUrl: optionalString(obj["callback_url"]),
    metadata: metadata as Record<string, unknown> | undefined,
    wait: obj["wait"] !== false,
  };
}

/** Translate our request shape into a Gladia /v2/pre-recorded init body. */
export function buildGladiaInitBody(parsed: ParsedRequest, audioUrl: string): Record<string, unknown> {
  const body: Record<string, unknown> = { audio_url: audioUrl };
  if (parsed.language) {
    body["language"] = parsed.language;
    body["detect_language"] = false;
  }
  if (parsed.codeSwitching) body["enable_code_switching"] = true;
  if (parsed.vocabulary.length > 0) {
    body["custom_vocabulary"] = true;
    body["custom_vocabulary_config"] = {
      vocabulary: parsed.vocabulary,
      ...(parsed.vocabularyIntensity !== undefined
        ? { default_intensity: parsed.vocabularyIntensity }
        : {}),
    };
  }
  if (parsed.context) body["context_prompt"] = parsed.context;
  if (parsed.diarization) {
    body["diarization"] = true;
    const diarizationConfig: Record<string, unknown> = {};
    if (parsed.speakers !== undefined) diarizationConfig["number_of_speakers"] = parsed.speakers;
    if (parsed.minSpeakers !== undefined) diarizationConfig["min_speakers"] = parsed.minSpeakers;
    if (parsed.maxSpeakers !== undefined) diarizationConfig["max_speakers"] = parsed.maxSpeakers;
    if (Object.keys(diarizationConfig).length > 0) body["diarization_config"] = diarizationConfig;
  }
  if (parsed.spelling) {
    body["custom_spelling"] = true;
    body["custom_spelling_config"] = { spelling_dictionary: parsed.spelling };
  }
  if (parsed.sentences) body["sentences"] = true;
  if (parsed.subtitles.length > 0) {
    body["subtitles"] = true;
    body["subtitles_config"] = { formats: parsed.subtitles };
  }
  if (parsed.summarize) {
    body["summarization"] = true;
    if (typeof parsed.summarize === "string") {
      body["summarization_config"] = { type: parsed.summarize };
    }
  }
  if (parsed.chapters) body["chapterization"] = true;
  if (parsed.entities) body["named_entity_recognition"] = true;
  if (parsed.callbackUrl) {
    body["callback"] = true;
    body["callback_config"] = { url: parsed.callbackUrl, method: "POST" };
  }
  if (parsed.metadata) body["custom_metadata"] = parsed.metadata;
  return body;
}

/**
 * Flatten a Gladia job into the response envelope: transcript fields at the
 * top level, requested add-ons passed through under their own keys.
 */
export function mapJobToResponse(job: GladiaJob): Record<string, unknown> {
  const base: Record<string, unknown> = { id: job.id, status: job.status };
  if (job.status === "error") {
    if (job.errorCode !== undefined) base["error_code"] = job.errorCode;
    return base;
  }
  if (job.status !== "done" || !job.result) return base;

  const result = job.result;
  const transcription =
    typeof result["transcription"] === "object" && result["transcription"] !== null
      ? (result["transcription"] as Record<string, unknown>)
      : {};
  base["text"] = typeof transcription["full_transcript"] === "string" ? transcription["full_transcript"] : "";
  base["languages"] = Array.isArray(transcription["languages"]) ? transcription["languages"] : [];
  base["utterances"] = Array.isArray(transcription["utterances"]) ? transcription["utterances"] : [];
  if (transcription["subtitles"] !== undefined) base["subtitles"] = transcription["subtitles"];
  if (result["metadata"] !== undefined) base["metadata"] = result["metadata"];
  if (result["summarization"] !== undefined) base["summarization"] = result["summarization"];
  if (result["chapterization"] !== undefined) base["chapters"] = result["chapterization"];
  if (result["named_entity_recognition"] !== undefined) {
    base["entities"] = result["named_entity_recognition"];
  }
  if (result["sentences"] !== undefined) base["sentences"] = result["sentences"];
  return base;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntilSettled(
  gladia: GladiaClient,
  id: string,
  config: Config,
): Promise<GladiaJob | "timeout"> {
  const deadline = Date.now() + config.gladiaPollTimeoutMs;
  for (;;) {
    const job = await gladia.getTranscription(id);
    if (job.status === "done" || job.status === "error") return job;
    if (Date.now() >= deadline) return "timeout";
    await sleep(config.gladiaPollIntervalMs);
  }
}

const notConfigured = (c: Context): Response =>
  c.json(
    {
      error: {
        code: "not_configured",
        message: "Gladia endpoints are disabled on this server (set GLADIA_API_KEY)",
      },
    },
    503,
  );

export function createGladiaTranscribeHandler(gladia: GladiaClient | null, config: Config) {
  return async (c: Context): Promise<Response> => {
    if (!gladia) return notConfigured(c);
    const badRequest = (message: string) =>
      c.json({ error: { code: "bad_request", message } }, 400);

    let parsed: ParsedRequest;
    try {
      const contentType = c.req.header("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        parsed = await parseMultipart(c);
      } else if (contentType.includes("application/json")) {
        parsed = parseJson(await c.req.json());
      } else {
        return badRequest("Content-Type must be multipart/form-data or application/json");
      }
    } catch (err) {
      return badRequest(err instanceof RequestError ? err.message : "Malformed request body");
    }

    if (!parsed.file && !parsed.audioUrl) {
      return badRequest("Provide an audio `file` (multipart) or an `audio_url`");
    }
    if (parsed.file && parsed.audioUrl) {
      return badRequest("Provide either `file` or `audio_url`, not both");
    }

    try {
      const audioUrl = parsed.file
        ? await gladia.upload(parsed.file.fileName, parsed.file.content)
        : (parsed.audioUrl as string);
      const id = await gladia.initTranscription(buildGladiaInitBody(parsed, audioUrl));

      if (!parsed.wait) {
        return c.json({ id, status: "queued" }, 202);
      }

      const job = await pollUntilSettled(gladia, id, config);
      if (job === "timeout") {
        return c.json(
          {
            error: {
              code: "poll_timeout",
              message:
                `Transcription ${id} is still processing after ${config.gladiaPollTimeoutMs}ms; ` +
                `poll GET /v1/gladia/transcribe/${id} for the result`,
            },
          },
          504,
        );
      }
      if (job.status === "error") {
        console.error(`[gladia] transcription ${id} failed (error_code ${String(job.errorCode)})`);
        return c.json(
          {
            error: {
              code: "transcription_failed",
              message: `Gladia could not transcribe this audio (error_code ${String(job.errorCode ?? "unknown")})`,
            },
          },
          502,
        );
      }
      return c.json(mapJobToResponse(job));
    } catch (err) {
      const { status, code, message } = mapGladiaError(err);
      console.error(`[gladia] upstream error (${status} ${code}):`, err);
      return c.json({ error: { code, message } }, status);
    }
  };
}

/** Poll endpoint for `wait=false` jobs: returns job state as data, even "error". */
export function createGladiaResultHandler(gladia: GladiaClient | null) {
  return async (c: Context): Promise<Response> => {
    if (!gladia) return notConfigured(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ error: { code: "bad_request", message: "Missing transcription id" } }, 400);
    }
    try {
      const job = await gladia.getTranscription(id);
      return c.json(mapJobToResponse(job));
    } catch (err) {
      const { status, code, message } = mapGladiaError(err);
      console.error(`[gladia] result fetch error (${status} ${code}):`, err);
      return c.json({ error: { code, message } }, status);
    }
  };
}
