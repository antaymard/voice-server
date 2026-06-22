import type { TranscriptSegment } from "./protocol.ts";

export type TranscribeFileOptions = {
  /** Base URL of voice-server, e.g. "https://voice.example.com". */
  serverUrl: string;
  /** The server's shared AUTH_TOKEN. */
  token: string;
  /** ISO 639-1 language hint (e.g. "fr"). Incompatible with `timestamps`. */
  language?: string;
  timestamps?: ("segment" | "word")[];
  diarize?: boolean;
  contextBias?: string[];
  signal?: AbortSignal;
};

export type TranscribeResult = {
  model: string;
  text: string;
  language: string | null;
  segments?: (TranscriptSegment & { speakerId?: string | null })[];
  usage?: unknown;
};

export class TranscribeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TranscribeError";
    this.status = status;
    this.code = code;
  }
}

/** Bulk transcription: upload a complete audio file, get the text back. */
export async function transcribeFile(
  file: Blob,
  options: TranscribeFileOptions,
): Promise<TranscribeResult> {
  const form = new FormData();
  form.append("file", file, file instanceof File ? file.name : "audio");
  if (options.language) form.append("language", options.language);
  if (options.timestamps?.length) form.append("timestamps", options.timestamps.join(","));
  if (options.diarize) form.append("diarize", "true");
  for (const term of options.contextBias ?? []) form.append("context_bias", term);

  const base = options.serverUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/v1/transcribe`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.token}` },
    body: form,
    signal: options.signal,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new TranscribeError(
      res.status,
      error?.code ?? "unknown",
      error?.message ?? `Transcription failed with HTTP ${res.status}`,
    );
  }
  return body as TranscribeResult;
}
