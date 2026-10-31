import type { Context } from "hono";
import type { Mistral } from "@mistralai/mistralai";
import type { Config } from "./config.ts";

/** Voxtral 3 dropped word-level timestamps; only segments remain. */
type TimestampGranularity = "segment";

/** Max known-speaker clips per request (Mistral limit). */
const MAX_SPEAKER_REFERENCES = 8;
/** Multipart file fields named `speaker_reference.<name>` carry reference clips. */
const SPEAKER_REFERENCE_FIELD = "speaker_reference.";

type ParsedRequest = {
  file?: { fileName: string; content: Blob };
  fileUrl?: string;
  model?: string;
  language?: string;
  timestampGranularities?: TimestampGranularity[];
  diarize?: boolean;
  contextBias?: string[];
  /** name -> base64 audio */
  speakerReferences?: Record<string, string>;
};

class RequestError extends Error {}

function parseTimestamps(value: unknown): TimestampGranularity[] {
  const items =
    typeof value === "string"
      ? value.split(",").map((s) => s.trim()).filter(Boolean)
      : Array.isArray(value)
        ? value
        : [];
  return items.map((item) => {
    if (item === "word") {
      throw new RequestError(
        "Word timestamps are not available with Voxtral 3 (use \"segment\")",
      );
    }
    if (item !== "segment") {
      throw new RequestError(`Invalid timestamps value "${String(item)}" (use "segment")`);
    }
    return item;
  });
}

function checkSpeakerReferences(refs: Record<string, string>): Record<string, string> | undefined {
  const entries = Object.entries(refs);
  if (entries.length === 0) return undefined;
  if (entries.length > MAX_SPEAKER_REFERENCES) {
    throw new RequestError(`At most ${MAX_SPEAKER_REFERENCES} speaker references are supported`);
  }
  if (entries.some(([name, audio]) => !name.trim() || !audio)) {
    throw new RequestError("Speaker references need a non-empty name and audio");
  }
  return refs;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseContextBias(values: unknown[]): string[] {
  return values
    .flatMap((v) => (typeof v === "string" ? v.split(",") : []))
    .map((s) => s.trim())
    .filter(Boolean);
}

async function parseMultipart(c: Context): Promise<ParsedRequest> {
  const form = await c.req.formData();
  const file = form.get("file");
  if (file !== null && !(file instanceof Blob)) {
    throw new RequestError("`file` must be an uploaded file");
  }
  const diarize = form.get("diarize");
  const speakerReferences: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith(SPEAKER_REFERENCE_FIELD)) continue;
    if (!(value instanceof Blob)) {
      throw new RequestError(`\`${key}\` must be an uploaded audio file`);
    }
    const name = key.slice(SPEAKER_REFERENCE_FIELD.length);
    speakerReferences[name] = Buffer.from(await value.arrayBuffer()).toString("base64");
  }
  return {
    file: file ? { fileName: (file instanceof File && file.name) || "audio", content: file } : undefined,
    fileUrl: optionalString(form.get("file_url")),
    model: optionalString(form.get("model")),
    language: optionalString(form.get("language")),
    timestampGranularities: parseTimestamps(form.get("timestamps") ?? undefined),
    diarize: diarize === "true" || diarize === "1",
    contextBias: parseContextBias(form.getAll("context_bias")),
    speakerReferences: checkSpeakerReferences(speakerReferences),
  };
}

function parseJson(body: unknown): ParsedRequest {
  if (typeof body !== "object" || body === null) {
    throw new RequestError("JSON body must be an object");
  }
  const obj = body as Record<string, unknown>;
  const refs = obj["speaker_references"];
  if (
    refs !== undefined &&
    (typeof refs !== "object" ||
      refs === null ||
      Array.isArray(refs) ||
      !Object.values(refs).every((v) => typeof v === "string"))
  ) {
    throw new RequestError("`speaker_references` must map speaker names to base64 audio strings");
  }
  return {
    fileUrl: optionalString(obj["file_url"]),
    model: optionalString(obj["model"]),
    language: optionalString(obj["language"]),
    timestampGranularities: parseTimestamps(obj["timestamp_granularities"]),
    diarize: obj["diarize"] === true,
    contextBias: parseContextBias(
      Array.isArray(obj["context_bias"]) ? obj["context_bias"] : [obj["context_bias"]],
    ),
    speakerReferences: checkSpeakerReferences((refs as Record<string, string> | undefined) ?? {}),
  };
}

type UpstreamErrorInfo = { status: 400 | 422 | 429 | 502; code: string; message: string };

function extractStatus(err: unknown): number | undefined {
  const anyErr = err as {
    statusCode?: unknown;
    status?: unknown;
    rawResponse?: { status?: unknown };
    httpMeta?: { response?: { status?: unknown } };
  };
  const candidates = [
    anyErr?.statusCode,
    anyErr?.status,
    anyErr?.rawResponse?.status,
    anyErr?.httpMeta?.response?.status,
  ];
  return candidates.find((v): v is number => typeof v === "number");
}

function extractMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export function mapUpstreamError(err: unknown): UpstreamErrorInfo {
  const status = extractStatus(err);
  if (status === 401 || status === 403) {
    return {
      status: 502,
      code: "upstream_auth",
      message: "Upstream authentication failed (check the server's MISTRAL_API_KEY)",
    };
  }
  if (status === 400 || status === 422) {
    return { status, code: "bad_request", message: extractMessage(err) };
  }
  if (status === 429) {
    return { status: 429, code: "rate_limited", message: "Upstream rate limit reached, retry later" };
  }
  return { status: 502, code: "upstream_error", message: extractMessage(err) };
}

export function createTranscribeHandler(batch: Mistral, config: Config) {
  return async (c: Context): Promise<Response> => {
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

    if (!parsed.file && !parsed.fileUrl) {
      return badRequest("Provide an audio `file` (multipart) or a `file_url`");
    }
    if (parsed.file && parsed.fileUrl) {
      return badRequest("Provide either `file` or `file_url`, not both");
    }
    // Reference clips only make sense with diarization, and Voxtral 3 only
    // diarizes with segment timestamps (422 otherwise): imply both so callers
    // can just ask for `diarize`.
    const diarize = parsed.diarize === true || parsed.speakerReferences !== undefined;
    const timestamps: TimestampGranularity[] =
      diarize ? ["segment"] : (parsed.timestampGranularities ?? []);

    try {
      const result = await batch.audio.transcriptions.complete({
        model: parsed.model ?? config.batchModel,
        ...(parsed.file ? { file: parsed.file } : { fileUrl: parsed.fileUrl }),
        ...(parsed.language ? { language: parsed.language } : {}),
        ...(timestamps.length ? { timestampGranularities: timestamps } : {}),
        ...(diarize ? { diarize: true } : {}),
        ...(parsed.contextBias?.length ? { contextBias: parsed.contextBias } : {}),
        ...(parsed.speakerReferences ? { speakerReferences: parsed.speakerReferences } : {}),
      });
      return c.json(result);
    } catch (err) {
      const { status, code, message } = mapUpstreamError(err);
      console.error(`[transcribe] upstream error (${status} ${code}):`, err);
      return c.json({ error: { code, message } }, status);
    }
  };
}
