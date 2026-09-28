/**
 * `/v1/media/audio-parts`: prepare long recordings for transcription by
 * splitting their audio track into ~20 min parts (cut in silences). Media
 * processing only — no STT call happens here.
 *
 *   POST   /v1/media/audio-parts                    -> 202 { job_id, status }
 *   GET    /v1/media/audio-parts/:id                -> job state, ready parts
 *   GET    /v1/media/audio-parts/:id/parts/:index   -> part binary (streamed)
 *   DELETE /v1/media/audio-parts/:id                -> 204 (idempotent)
 */
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import type { Config } from "../config.ts";
import { MEDIA_FORMATS, type CreateJobInput, type MediaFormat, type MediaJobs } from "./jobs.ts";

export const PART_SECONDS_MIN = 300;
export const PART_SECONDS_MAX = 3600;
const PART_SECONDS_DEFAULT = 1200;

type Parsed = { ok: true; input: CreateJobInput } | { ok: false; status: 400 | 403; code: string; message: string };

export function parseAudioPartsRequest(body: unknown, allowedHosts: string[]): Parsed {
  const bad = (message: string): Parsed => ({ ok: false, status: 400, code: "bad_request", message });
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return bad("JSON body must be an object");
  }
  const obj = body as Record<string, unknown>;

  const rawUrl = obj["source_url"];
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return bad("`source_url` is required");
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return bad("`source_url` must be a valid URL");
  }
  if (url.protocol !== "https:") return bad("`source_url` must use https:");
  if (url.username || url.password) return bad("`source_url` must not contain credentials");
  if (!allowedHosts.includes(url.host) && !allowedHosts.includes(url.hostname)) {
    return {
      ok: false,
      status: 403,
      code: "source_not_allowed",
      message: `Host "${url.host}" is not in MEDIA_ALLOWED_SOURCE_HOSTS`,
    };
  }

  const partSeconds = obj["part_seconds"] ?? PART_SECONDS_DEFAULT;
  if (
    typeof partSeconds !== "number" ||
    !Number.isInteger(partSeconds) ||
    partSeconds < PART_SECONDS_MIN ||
    partSeconds > PART_SECONDS_MAX
  ) {
    return bad(`\`part_seconds\` must be an integer between ${PART_SECONDS_MIN} and ${PART_SECONDS_MAX}`);
  }

  const format = obj["format"] ?? "mp3";
  if (typeof format !== "string" || !Object.hasOwn(MEDIA_FORMATS, format)) {
    return bad(`\`format\` must be one of ${Object.keys(MEDIA_FORMATS).join(", ")}`);
  }

  return { ok: true, input: { sourceUrl: url.href, partSeconds, format: format as MediaFormat } };
}

export function registerMediaRoutes(app: Hono, config: Config, jobs: MediaJobs | null): void {
  const disabled = (c: Context): Response =>
    c.json(
      {
        error: {
          code: "media_disabled",
          message:
            "Media endpoints are disabled on this server (set MEDIA_ALLOWED_SOURCE_HOSTS and install ffmpeg)",
        },
      },
      503,
    );
  const notFound = (c: Context, message: string): Response =>
    c.json({ error: { code: "not_found", message } }, 404);

  app.post("/v1/media/audio-parts", async (c) => {
    if (!jobs?.enabled) return disabled(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "bad_request", message: "Body must be valid JSON" } }, 400);
    }
    const parsed = parseAudioPartsRequest(body, config.mediaAllowedSourceHosts);
    if (!parsed.ok) {
      return c.json({ error: { code: parsed.code, message: parsed.message } }, parsed.status);
    }
    const job = jobs.create(parsed.input);
    if (!job) {
      return c.json(
        {
          error: {
            code: "busy",
            message: `${config.mediaMaxConcurrentJobs} media jobs are already running; retry later`,
          },
        },
        429,
      );
    }
    return c.json({ job_id: job.job_id, status: job.status }, 202);
  });

  app.get("/v1/media/audio-parts/:id", (c) => {
    if (!jobs?.enabled) return disabled(c);
    const job = jobs.get(c.req.param("id"));
    return job ? c.json(job) : notFound(c, "Unknown or expired job");
  });

  app.get("/v1/media/audio-parts/:id/parts/:index", async (c) => {
    if (!jobs?.enabled) return disabled(c);
    const rawIndex = c.req.param("index");
    const part = /^\d{1,6}$/.test(rawIndex) ? jobs.getPartPath(c.req.param("id"), Number(rawIndex)) : null;
    if (!part) return notFound(c, "Unknown job or part not ready");
    // Open before answering so a concurrent DELETE can't turn this into a
    // half-sent body: an open fd keeps the (unlinked) file readable.
    let handle;
    try {
      handle = await open(part.path, "r");
    } catch {
      return notFound(c, "Unknown job or part not ready");
    }
    // Streamed from disk; the fd closes on end or when the client goes away.
    const body = Readable.toWeb(handle.createReadStream({ autoClose: true })) as unknown as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": part.contentType,
        "content-length": String(part.bytes),
        "cache-control": "no-store",
      },
    });
  });

  app.delete("/v1/media/audio-parts/:id", async (c) => {
    if (!jobs?.enabled) return disabled(c);
    await jobs.remove(c.req.param("id"));
    return c.body(null, 204);
  });
}
