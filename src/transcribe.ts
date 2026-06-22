import type { Context } from "hono";
import type { Mistral } from "@mistralai/mistralai";
import type { Config } from "./config.ts";

const TIMESTAMP_VALUES = ["segment", "word"] as const;
type TimestampGranularity = (typeof TIMESTAMP_VALUES)[number];

type ParsedRequest = {
  file?: { fileName: string; content: Blob };
  fileUrl?: string;
  language?: string;
  timestampGranularities?: TimestampGranularity[];
  diarize?: boolean;
  contextBias?: string[];
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
    if (!(TIMESTAMP_VALUES as readonly unknown[]).includes(item)) {
      throw new RequestError(`Invalid timestamps value "${String(item)}" (use "segment" or "word")`);
    }
    return item as TimestampGranularity;
  });
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
  const fileUrl = form.get("file_url");
  const language = form.get("language");
  const diarize = form.get("diarize");
  return {
    file: file ? { fileName: (file instanceof File && file.name) || "audio", content: file } : undefined,
    fileUrl: typeof fileUrl === "string" && fileUrl ? fileUrl : undefined,
    language: typeof language === "string" && language ? language : undefined,
    timestampGranularities: parseTimestamps(form.get("timestamps") ?? undefined),
    diarize: diarize === "true" || diarize === "1",
    contextBias: parseContextBias(form.getAll("context_bias")),
  };
}

function parseJson(body: unknown): ParsedRequest {
  if (typeof body !== "object" || body === null) {
    throw new RequestError("JSON body must be an object");
  }
  const obj = body as Record<string, unknown>;
  const fileUrl = obj["file_url"];
  const language = obj["language"];
  return {
    fileUrl: typeof fileUrl === "string" && fileUrl ? fileUrl : undefined,
    language: typeof language === "string" && language ? language : undefined,
    timestampGranularities: parseTimestamps(obj["timestamp_granularities"]),
    diarize: obj["diarize"] === true,
    contextBias: parseContextBias(
      Array.isArray(obj["context_bias"]) ? obj["context_bias"] : [obj["context_bias"]],
    ),
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
    if (parsed.language && (parsed.timestampGranularities?.length ?? 0) > 0) {
      // Upstream limitation as of Voxtral Transcribe 2 — may be lifted later.
      return badRequest("`language` cannot be combined with timestamps (Mistral API limitation)");
    }

    try {
      const result = await batch.audio.transcriptions.complete({
        model: config.batchModel,
        ...(parsed.file ? { file: parsed.file } : { fileUrl: parsed.fileUrl }),
        ...(parsed.language ? { language: parsed.language } : {}),
        ...(parsed.timestampGranularities?.length
          ? { timestampGranularities: parsed.timestampGranularities }
          : {}),
        ...(parsed.diarize ? { diarize: true } : {}),
        ...(parsed.contextBias?.length ? { contextBias: parsed.contextBias } : {}),
      });
      return c.json(result);
    } catch (err) {
      const { status, code, message } = mapUpstreamError(err);
      console.error(`[transcribe] upstream error (${status} ${code}):`, err);
      return c.json({ error: { code, message } }, status);
    }
  };
}
