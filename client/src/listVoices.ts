export type Voice = {
  /** Pass this as `voice` to `synthesizeSpeech`. */
  id: string;
  name: string;
  slug: string | null;
  /** "preset" (Mistral's) or "custom" (saved in the server's workspace). */
  type: string;
  languages: string[];
  gender: string | null;
  description: string | null;
  tags: string[];
};

export type ListVoicesOptions = {
  /** Base URL of voice-server, e.g. "https://voice.example.com". */
  serverUrl: string;
  /** The server's shared AUTH_TOKEN. */
  token: string;
  type?: "all" | "preset" | "custom";
  /** Language filter, e.g. ["fr"]. */
  language?: string[];
  gender?: ("female" | "male" | "neutral")[];
  /** Free-text search. */
  query?: string;
  /** 1-100. */
  pageSize?: number;
  /** `nextPageToken` from the previous page. */
  pageToken?: string;
  signal?: AbortSignal;
};

export type VoicePage = { voices: Voice[]; nextPageToken: string | null };

export class VoicesError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "VoicesError";
    this.status = status;
    this.code = code;
  }
}

/** One page of the voices `synthesizeSpeech` can use. */
export async function listVoices(options: ListVoicesOptions): Promise<VoicePage> {
  const params = new URLSearchParams();
  if (options.type) params.set("type", options.type);
  if (options.language?.length) params.set("language", options.language.join(","));
  if (options.gender?.length) params.set("gender", options.gender.join(","));
  if (options.query) params.set("query", options.query);
  if (options.pageSize) params.set("page_size", String(options.pageSize));
  if (options.pageToken) params.set("page_token", options.pageToken);

  const base = options.serverUrl.replace(/\/$/, "");
  const query = params.toString();
  const res = await fetch(`${base}/v1/voices${query ? `?${query}` : ""}`, {
    headers: { authorization: `Bearer ${options.token}` },
    signal: options.signal,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new VoicesError(
      res.status,
      error?.code ?? "unknown",
      error?.message ?? `Listing voices failed with HTTP ${res.status}`,
    );
  }
  return body as VoicePage;
}
