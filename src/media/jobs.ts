/**
 * In-memory store of audio-parts jobs (`/v1/media/audio-parts`).
 *
 * A job downloads a source file, probes it, finds cut points in silences and
 * re-encodes it into ~`part_seconds` audio parts, one after another. Parts are
 * exposed as soon as each one is fully written, so the caller can start
 * transcribing part 0 while the next ones are produced.
 *
 * Jobs live in a Map and their files on local disk: this assumes a single
 * replica. The work dir is purged at startup (jobs from a previous instance
 * are lost; the caller handles the failure).
 */
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, rmSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Config } from "../config.ts";
import { computeCutPoints, parseSilenceDetect, roundMs, silenceMidpoints } from "./cutPoints.ts";
import { mediaBinariesAvailable, ProcessError, runFfmpeg, runFfprobe, summarizeProbe } from "./ffmpeg.ts";

export const MEDIA_FORMATS = {
  mp3: { codecArgs: ["-c:a", "libmp3lame", "-b:a", "32k", "-f", "mp3"], ext: "mp3", contentType: "audio/mpeg" },
  ogg: {
    codecArgs: ["-c:a", "libopus", "-b:a", "24k", "-application", "voip", "-f", "ogg"],
    ext: "ogg",
    contentType: "audio/ogg",
  },
} as const;
export type MediaFormat = keyof typeof MEDIA_FORMATS;

/** Guard against a misconfiguration producing parts the STT would refuse (25 MB cap). */
const MAX_PART_BYTES = 24 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 1000;
const JOB_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type JobStatus = "queued" | "downloading" | "probing" | "analyzing" | "splitting" | "done" | "error";

export type JobErrorCode =
  | "source_fetch_failed"
  | "source_too_large"
  | "unreadable_media"
  | "no_audio_stream"
  | "too_long"
  | "ffmpeg_failed"
  | "part_too_large"
  | "cancelled"
  | "internal_error";

export type PartView = {
  index: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  bytes: number;
  content_type: string;
};

export type JobView = {
  job_id: string;
  status: JobStatus;
  duration_sec: number | null;
  has_video: boolean | null;
  total_parts: number | null;
  parts: PartView[];
  error: { code: JobErrorCode; message: string } | null;
  created_at: string;
  expires_at: string;
};

type Job = {
  id: string;
  sourceUrl: string;
  partSeconds: number;
  format: MediaFormat;
  dir: string;
  status: JobStatus;
  durationSec: number | null;
  hasVideo: boolean | null;
  totalParts: number | null;
  parts: (PartView & { path: string })[];
  error: { code: JobErrorCode; message: string } | null;
  createdAt: number;
  expiresAt: number;
  abort: AbortController;
  /** Resolves when the background run has fully stopped (never rejects). */
  settled: Promise<void>;
};

export type CreateJobInput = { sourceUrl: string; partSeconds: number; format: MediaFormat };

export type MediaJobs = {
  /** false when no source host is allowlisted or ffmpeg/ffprobe are missing. */
  readonly enabled: boolean;
  /** Returns null when MEDIA_MAX_CONCURRENT_JOBS jobs are already active. */
  create: (input: CreateJobInput) => JobView | null;
  get: (id: string) => JobView | null;
  /** Only parts fully written to disk are returned. */
  getPartPath: (id: string, index: number) => { path: string; bytes: number; contentType: string } | null;
  /** Cancel (kill ffmpeg, abort download) and delete files. Idempotent. */
  remove: (id: string) => Promise<void>;
  activeCount: () => number;
  /** Drop expired jobs; runs every minute on its own. */
  sweepExpired: (now?: number) => Promise<void>;
  shutdown: () => Promise<void>;
};

export type MediaJobsDeps = {
  /** Overrides global fetch (tests serve sources locally). */
  fetch?: typeof fetch;
  /** Skips the ffmpeg/ffprobe startup probe (tests). */
  binariesAvailable?: boolean;
};

class JobError extends Error {
  readonly code: JobErrorCode;

  constructor(code: JobErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const isActive = (job: Job): boolean => job.status !== "done" && job.status !== "error";

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
  return `${err.message}${cause}`;
}

function ffmpegFailed(err: unknown): unknown {
  if (!(err instanceof ProcessError) || err.reason === "aborted") return err;
  const tail = err.stderrTail.trim().slice(-500);
  return new JobError("ffmpeg_failed", tail ? `${err.message}: ${tail}` : err.message);
}

function toView(job: Job): JobView {
  return {
    job_id: job.id,
    status: job.status,
    duration_sec: job.durationSec,
    has_video: job.hasVideo,
    total_parts: job.totalParts,
    parts: job.parts.map(({ path: _path, ...part }) => part),
    error: job.error,
    created_at: new Date(job.createdAt).toISOString(),
    expires_at: new Date(job.expiresAt).toISOString(),
  };
}

/** Delete leftover job dirs from a previous instance (only uuid-named entries, never the dir itself). */
function purgeWorkDir(workDir: string): void {
  mkdirSync(workDir, { recursive: true });
  for (const entry of readdirSync(workDir)) {
    if (JOB_DIR_RE.test(entry)) rmSync(join(workDir, entry), { recursive: true, force: true });
  }
}

export function createMediaJobs(config: Config, deps: MediaJobsDeps = {}): MediaJobs {
  const fetchImpl = deps.fetch ?? fetch;
  const jobs = new Map<string, Job>();

  let enabled = config.mediaAllowedSourceHosts.length > 0;
  if (enabled && !(deps.binariesAvailable ?? mediaBinariesAvailable())) {
    console.warn("[media] ffmpeg/ffprobe not found on PATH — /v1/media/* endpoints are disabled (503)");
    enabled = false;
  }
  if (enabled) {
    try {
      purgeWorkDir(config.mediaWorkDir);
    } catch (err) {
      console.warn(`[media] work dir ${config.mediaWorkDir} is not usable — /v1/media/* disabled:`, err);
      enabled = false;
    }
  }

  const sweeper = enabled ? setInterval(() => void sweepExpired(), SWEEP_INTERVAL_MS) : null;
  sweeper?.unref();

  const ffOpts = (job: Job) => ({ timeoutMs: config.mediaFfmpegTimeoutMs, signal: job.abort.signal });

  function setStatus(job: Job, status: JobStatus): void {
    job.abort.signal.throwIfAborted();
    job.status = status;
  }

  async function download(job: Job, dest: string): Promise<void> {
    const max = config.mediaMaxSourceBytes;
    const signal = job.abort.signal;
    let res: Response;
    try {
      // A redirect could leave the allowlist, so it is an error.
      res = await fetchImpl(job.sourceUrl, { redirect: "error", signal });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new JobError("source_fetch_failed", `Could not fetch source: ${describeError(err)}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new JobError("source_fetch_failed", `Source responded with HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel().catch(() => {});
      throw new JobError("source_too_large", `Source is ${declared} bytes (max ${max})`);
    }
    if (!res.body) throw new JobError("source_fetch_failed", "Source response has no body");

    // Content-Length may be missing or lie: count while streaming.
    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        received += chunk.length;
        if (received > max) callback(new JobError("source_too_large", `Source exceeds ${max} bytes`));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>),
        counter,
        createWriteStream(dest),
        { signal },
      );
    } catch (err) {
      if (err instanceof JobError || signal.aborted) throw err;
      // Local disk errors (ENOSPC, …) are ours, not the source's.
      if (err instanceof Error && "syscall" in err) throw err;
      throw new JobError("source_fetch_failed", `Download interrupted: ${describeError(err)}`);
    }
  }

  async function probe(job: Job, source: string) {
    let raw: unknown;
    try {
      raw = await runFfprobe(source, ffOpts(job));
    } catch (err) {
      if (err instanceof ProcessError && err.reason === "aborted") throw err;
      const tail = err instanceof ProcessError ? err.stderrTail.trim().slice(-500) : "";
      throw new JobError("unreadable_media", `Could not read the media file${tail ? `: ${tail}` : ""}`);
    }
    const summary = summarizeProbe(raw);
    if (!summary.hasAudio) throw new JobError("no_audio_stream", "The file has no audio track");
    if (summary.durationSec === null) {
      throw new JobError("unreadable_media", "Could not determine the media duration");
    }
    if (summary.durationSec > config.mediaMaxDurationSec) {
      throw new JobError(
        "too_long",
        `Media lasts ${Math.round(summary.durationSec)}s (max ${config.mediaMaxDurationSec}s)`,
      );
    }
    return { durationSec: summary.durationSec, hasVideo: summary.hasVideo };
  }

  async function detectSilences(job: Job, source: string): Promise<number[]> {
    const lines: string[] = [];
    await runFfmpeg(
      [
        "-nostdin", "-hide_banner", "-nostats",
        "-i", source,
        "-map", "0:a:0", "-vn", "-ac", "1",
        "-af", `silencedetect=noise=${config.mediaSilenceNoiseDb}dB:d=${config.mediaSilenceMinSec}`,
        "-f", "null", "-",
      ],
      { ...ffOpts(job), onStderrLine: (line) => line.includes("silence_") && lines.push(line) },
    ).catch((err: unknown) => {
      throw ffmpegFailed(err);
    });
    return silenceMidpoints(parseSilenceDetect(lines.join("\n")));
  }

  async function encodePart(job: Job, source: string, index: number, start: number, end: number, isLast: boolean) {
    const format = MEDIA_FORMATS[job.format];
    const finalPath = join(job.dir, `part-${String(index).padStart(3, "0")}.${format.ext}`);
    const tmpPath = `${finalPath}.tmp`;
    // Input-side -ss is a fast seek and stays exact since we transcode. The
    // last part runs to end of file so nothing is lost to duration rounding.
    const range = ["-ss", start.toFixed(3), ...(isLast ? [] : ["-to", end.toFixed(3)])];
    await runFfmpeg(
      [
        "-nostdin", "-hide_banner", "-nostats", "-y",
        ...range, "-i", source,
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
        "-ac", "1", "-ar", "16000",
        ...format.codecArgs,
        tmpPath,
      ],
      ffOpts(job),
    ).catch((err: unknown) => {
      throw ffmpegFailed(err);
    });
    const { size } = await stat(tmpPath);
    if (size > MAX_PART_BYTES) {
      throw new JobError("part_too_large", `Part ${index} is ${size} bytes (max ${MAX_PART_BYTES})`);
    }
    job.abort.signal.throwIfAborted();
    await rename(tmpPath, finalPath);
    job.parts.push({
      index,
      start_sec: start,
      end_sec: end,
      // The computed bounds (not the encoded file's duration) are what the
      // caller uses to shift timestamps.
      duration_sec: roundMs(end - start),
      bytes: size,
      content_type: format.contentType,
      path: finalPath,
    });
  }

  async function run(job: Job): Promise<void> {
    const source = join(job.dir, "source.bin");
    try {
      await mkdir(job.dir, { recursive: true });

      setStatus(job, "downloading");
      await download(job, source);

      setStatus(job, "probing");
      const probed = await probe(job, source);
      const duration = roundMs(probed.durationSec);
      job.durationSec = duration;
      job.hasVideo = probed.hasVideo;

      setStatus(job, "analyzing");
      const cuts =
        duration <= job.partSeconds
          ? [0]
          : computeCutPoints(
              duration,
              await detectSilences(job, source),
              job.partSeconds,
              config.mediaSilenceWindowSec,
              config.mediaMinLastPartSec,
            );

      setStatus(job, "splitting");
      job.totalParts = cuts.length;
      for (let i = 0; i < cuts.length; i++) {
        const isLast = i === cuts.length - 1;
        await encodePart(job, source, i, cuts[i] as number, isLast ? duration : (cuts[i + 1] as number), isLast);
      }

      await rm(source, { force: true });
      setStatus(job, "done");
    } catch (err) {
      // Cancelled by remove()/shutdown(): status and cleanup are handled there.
      if (!isActive(job)) return;
      let error: NonNullable<Job["error"]>;
      if (job.abort.signal.aborted) {
        error = { code: "cancelled", message: "Job was cancelled" };
      } else if (err instanceof JobError) {
        // ffmpeg/ffprobe messages quote file paths: keep server paths private.
        error = { code: err.code, message: err.message.replaceAll(`${job.dir}/`, "") };
        console.warn(`[media] job ${job.id} failed (${error.code}): ${error.message}`);
      } else {
        console.error(`[media] job ${job.id} crashed:`, err);
        error = { code: "internal_error", message: "Internal error while processing the media" };
      }
      // The entry stays until expiry so the caller can read the error; the
      // files go now, before the error is visible.
      job.parts = [];
      await rm(job.dir, { recursive: true, force: true }).catch(() => {});
      if (!isActive(job)) return; // cancelled meanwhile
      job.error = error;
      job.status = "error";
    }
  }

  function create(input: CreateJobInput): JobView | null {
    if (activeCount() >= config.mediaMaxConcurrentJobs) return null;
    const id = randomUUID();
    const now = Date.now();
    const job: Job = {
      id,
      sourceUrl: input.sourceUrl,
      partSeconds: input.partSeconds,
      format: input.format,
      dir: join(config.mediaWorkDir, id),
      status: "queued",
      durationSec: null,
      hasVideo: null,
      totalParts: null,
      parts: [],
      error: null,
      createdAt: now,
      expiresAt: now + config.mediaJobTtlMs,
      abort: new AbortController(),
      settled: Promise.resolve(),
    };
    jobs.set(id, job);
    job.settled = new Promise<void>((resolve) => setImmediate(resolve)).then(() => run(job));
    return toView(job);
  }

  function get(id: string): JobView | null {
    const job = jobs.get(id);
    return job ? toView(job) : null;
  }

  function getPartPath(id: string, index: number) {
    const job = jobs.get(id);
    if (!job || (job.status !== "splitting" && job.status !== "done")) return null;
    const part = job.parts.find((p) => p.index === index);
    return part ? { path: part.path, bytes: part.bytes, contentType: part.content_type } : null;
  }

  async function remove(id: string): Promise<void> {
    const job = jobs.get(id);
    if (!job) return;
    if (isActive(job)) {
      job.status = "error";
      job.error = { code: "cancelled", message: "Job was cancelled" };
      job.parts = [];
    }
    job.abort.abort();
    await job.settled;
    await rm(job.dir, { recursive: true, force: true }).catch(() => {});
    jobs.delete(id);
  }

  function activeCount(): number {
    let count = 0;
    for (const job of jobs.values()) if (isActive(job)) count++;
    return count;
  }

  async function sweepExpired(now = Date.now()): Promise<void> {
    const expired = [...jobs.values()].filter((job) => job.expiresAt <= now);
    await Promise.all(expired.map((job) => remove(job.id)));
  }

  async function shutdown(): Promise<void> {
    if (sweeper) clearInterval(sweeper);
    await Promise.all([...jobs.keys()].map((id) => remove(id)));
  }

  return {
    get enabled() {
      return enabled;
    },
    create,
    get,
    getPartPath,
    remove,
    activeCount,
    sweepExpired,
    shutdown,
  };
}
