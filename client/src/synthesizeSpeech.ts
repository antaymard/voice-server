export type SpeechFormat = "pcm" | "wav" | "mp3" | "flac" | "opus";

/**
 * One turn of a voice conversation, oldest first, used to condition how the
 * next reply sounds. `audio` is base64 (what was actually heard/spoken).
 */
export type ConversationTurn =
  | { role: "user"; audio: string }
  | { role: "assistant"; text: string; audio: string };

export type SynthesizeOptions = {
  /** Base URL of voice-server, e.g. "https://voice.example.com". */
  serverUrl: string;
  /** The server's shared AUTH_TOKEN. */
  token: string;
  /** Preset or saved voice id (see `listVoices`). Omit to use the server default. */
  voice?: string;
  /** Base64 audio for one-off zero-shot voice cloning (overrides `voice`). */
  refAudio?: string;
  /**
   * Output format. `pcm` (default) has the lowest time-to-first-audio but is
   * headerless 24 kHz mono s16le; `mp3`/`opus`/`wav`/`flac` are self-describing
   * and play directly in an `<audio>` element.
   */
  format?: SpeechFormat;
  /** Override the server's TTS model. */
  model?: string;
  /** Stream the audio as it is generated (default true; lowest latency). */
  stream?: boolean;
  /**
   * Voxtral 3: strength of expressive delivery, 1.0-5.0. Higher values give
   * stronger emotion at the cost of similarity to the voice.
   */
  expressiveness?: number;
  /**
   * Voxtral 3: custom pronunciation, word -> IPA phonemes (one symbol per
   * item), e.g. `{ tomato: ["t", "ə", "m", "ɑ", "t", "oʊ"] }`.
   */
  phonemeHints?: Record<string, string[]>;
  /**
   * Voxtral 3: prior turns (alternating, ending with a `user` turn) so the
   * reply's delivery fits the conversation. Needs a Voxtral 3 preset `voice`;
   * not combinable with `refAudio`.
   */
  conversationHistory?: ConversationTurn[];
  signal?: AbortSignal;
};

export class SpeechError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SpeechError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Text-to-speech: returns the raw `fetch` Response carrying the audio bytes.
 * The body streams chunk-by-chunk, so you can pipe `res.body` into the Web
 * Audio API for the lowest latency, or call `.blob()` for a one-shot clip.
 *
 * Voxtral 3 reads inline tags in `input`: `[emotion=happy]` (34 emotions) and
 * `[pace=slow]` (very-slow, slow, moderate, fast, very-fast). Tags are not spoken.
 *
 * ```ts
 * const res = await synthesizeSpeech("[emotion=warm]Bonjour le monde", { serverUrl, token, format: "mp3" });
 * const url = URL.createObjectURL(await res.blob());
 * new Audio(url).play();
 * ```
 */
export async function synthesizeSpeech(
  input: string,
  options: SynthesizeOptions,
): Promise<Response> {
  const base = options.serverUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/v1/speak`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      input,
      ...(options.voice ? { voice: options.voice } : {}),
      ...(options.refAudio ? { ref_audio: options.refAudio } : {}),
      ...(options.format ? { format: options.format } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.stream === false ? { stream: false } : {}),
      ...(options.expressiveness !== undefined ? { expressiveness: options.expressiveness } : {}),
      ...(options.phonemeHints ? { phoneme_hints: options.phonemeHints } : {}),
      ...(options.conversationHistory ? { conversation_history: options.conversationHistory } : {}),
    }),
    signal: options.signal,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new SpeechError(
      res.status,
      body?.error?.code ?? "unknown",
      body?.error?.message ?? `Speech synthesis failed with HTTP ${res.status}`,
    );
  }
  return res;
}
