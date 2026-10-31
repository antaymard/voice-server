import type { TranscriptSegment } from "./protocol.ts";

export type TranscribeFileOptions = {
  /** Base URL of voice-server, e.g. "https://voice.example.com". */
  serverUrl: string;
  /** The server's shared AUTH_TOKEN. */
  token: string;
  /**
   * Override the server's model, e.g. "voxtral-small-transcribe-3-0" for
   * higher quality when `contextBias` alone doesn't fix the errors.
   */
  model?: string;
  /** ISO 639-1 language (e.g. "fr"); omit to auto-detect. */
  language?: string;
  /** Segment timestamps. Word timestamps no longer exist with Voxtral 3. */
  timestamps?: "segment"[];
  /** Label speakers (implies segment timestamps). */
  diarize?: boolean;
  /** Names, terms, or a short description of the recording. */
  contextBias?: string[];
  /**
   * Known speakers: name -> audio clip (3-15 s, mostly speech, up to 8). The
   * name becomes the segments' `speakerId`. Implies `diarize`.
   */
  speakerReferences?: Record<string, Blob>;
  signal?: AbortSignal;
};

export type TranscribeResult = {
  model: string;
  text: string;
  language: string | null;
  /** Diarized segments may overlap (two people talking at once). */
  segments?: (Omit<TranscriptSegment, "start" | "end"> & { start: number; end: number })[];
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
  if (options.model) form.append("model", options.model);
  if (options.language) form.append("language", options.language);
  if (options.timestamps?.length) form.append("timestamps", options.timestamps.join(","));
  if (options.diarize) form.append("diarize", "true");
  for (const term of options.contextBias ?? []) form.append("context_bias", term);
  for (const [name, clip] of Object.entries(options.speakerReferences ?? {})) {
    form.append(`speaker_reference.${name}`, clip, `${name}.audio`);
  }

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
