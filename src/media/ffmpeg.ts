/**
 * Thin wrappers around the ffmpeg / ffprobe binaries. Everything goes through
 * `spawn(cmd, args[])` — never a shell — with a hard timeout (SIGKILL), an
 * abort signal, and the tail of stderr kept for error messages.
 */
import { spawn, spawnSync } from "node:child_process";

const STDERR_TAIL_CHARS = 4096;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

export class ProcessError extends Error {
  readonly reason: "exit" | "timeout" | "aborted" | "spawn";
  readonly stderrTail: string;

  constructor(message: string, reason: ProcessError["reason"], stderrTail: string) {
    super(message);
    this.name = "ProcessError";
    this.reason = reason;
    this.stderrTail = stderrTail;
  }
}

export type RunOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called for every stderr line (for parsers such as silencedetect). */
  onStderrLine?: (line: string) => void;
};

export type RunResult = { stdout: string; stderrTail: string };

export function runProcess(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new ProcessError(`${cmd} aborted`, "aborted", ""));
      return;
    }

    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = "";
    let lineBuf = "";
    let killedFor: "timeout" | "aborted" | null = null;
    let settled = false;

    const kill = (why: "timeout" | "aborted"): void => {
      if (killedFor) return;
      killedFor = why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("timeout"), opts.timeoutMs);
    const onAbort = (): void => kill("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (err: ProcessError | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderrTail });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < MAX_STDOUT_BYTES) stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
      if (opts.onStderrLine) {
        lineBuf += text;
        const lines = lineBuf.split(/\r\n|\r|\n/);
        lineBuf = lines.pop() ?? "";
        for (const line of lines) opts.onStderrLine(line);
      }
    });

    child.on("error", (err) => {
      finish(new ProcessError(`${cmd} could not be started: ${err.message}`, "spawn", stderrTail));
    });
    child.on("close", (code, signal) => {
      if (lineBuf && opts.onStderrLine) opts.onStderrLine(lineBuf);
      if (killedFor === "timeout") {
        finish(new ProcessError(`${cmd} timed out after ${opts.timeoutMs}ms`, "timeout", stderrTail));
      } else if (killedFor === "aborted") {
        finish(new ProcessError(`${cmd} aborted`, "aborted", stderrTail));
      } else if (code !== 0) {
        finish(new ProcessError(`${cmd} exited with ${code ?? signal}`, "exit", stderrTail));
      } else {
        finish(null);
      }
    });
  });
}

export function runFfmpeg(args: string[], opts: RunOptions): Promise<RunResult> {
  return runProcess("ffmpeg", args, opts);
}

export async function runFfprobe(path: string, opts: RunOptions): Promise<unknown> {
  const { stdout } = await runProcess(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    opts,
  );
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new ProcessError("ffprobe returned invalid JSON", "exit", "");
  }
}

export type ProbeSummary = {
  hasAudio: boolean;
  hasVideo: boolean;
  /** null when neither the container nor the first audio stream reports a usable duration. */
  durationSec: number | null;
};

function positiveNumber(value: unknown): number | null {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(num) && num > 0 ? num : null;
}

/** Interpret `ffprobe -show_format -show_streams` JSON. */
export function summarizeProbe(probe: unknown): ProbeSummary {
  const root = (typeof probe === "object" && probe !== null ? probe : {}) as Record<string, unknown>;
  const streams = Array.isArray(root["streams"]) ? (root["streams"] as Record<string, unknown>[]) : [];
  const format = (typeof root["format"] === "object" && root["format"] !== null ? root["format"] : {}) as Record<
    string,
    unknown
  >;
  const audio = streams.filter((s) => s?.["codec_type"] === "audio");
  // Album art in audio files shows up as a video stream flagged attached_pic.
  const hasVideo = streams.some((s) => {
    if (s?.["codec_type"] !== "video") return false;
    const disposition = s["disposition"] as Record<string, unknown> | undefined;
    return disposition?.["attached_pic"] !== 1;
  });
  const durationSec = positiveNumber(format["duration"]) ?? positiveNumber(audio[0]?.["duration"]);
  return { hasAudio: audio.length > 0, hasVideo, durationSec };
}

/** Startup check: are both binaries on PATH and runnable? */
export function mediaBinariesAvailable(): boolean {
  return ["ffmpeg", "ffprobe"].every((cmd) => {
    const res = spawnSync(cmd, ["-version"], { stdio: "ignore", timeout: 10_000 });
    return !res.error && res.status === 0;
  });
}
