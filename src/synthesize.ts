import type { Context } from "hono";
import type { Mistral } from "@mistralai/mistralai";
import { CompleteAcceptEnum } from "@mistralai/mistralai/sdk/speech.js";
import { IPAPhoneme } from "@mistralai/mistralai/models/components";
import type { Config, SpeechFormat } from "./config.ts";
import { SPEECH_FORMATS } from "./config.ts";
import { mapUpstreamError } from "./transcribe.ts";

/**
 * Content type + (for raw PCM) descriptive headers per output format. Mistral
 * emits mono 24 kHz audio; for `pcm` it is headerless little-endian s16, so we
 * advertise the parameters the consumer needs to play it back. The other
 * formats are self-describing containers.
 */
const SAMPLE_RATE = 24000;
const FORMAT_HEADERS: Record<SpeechFormat, Record<string, string>> = {
  pcm: {
    "content-type": "audio/pcm",
    "x-sample-rate": String(SAMPLE_RATE),
    "x-audio-channels": "1",
    "x-audio-encoding": "pcm_s16le",
  },
  wav: { "content-type": "audio/wav" },
  mp3: { "content-type": "audio/mpeg" },
  flac: { "content-type": "audio/flac" },
  opus: { "content-type": "audio/ogg" },
};

type HistoryTurn =
  | { role: "user"; audio: { data: string } }
  | { role: "assistant"; text: string; audio: { data: string } };

type ParsedRequest = {
  input: string;
  voice?: string;
  refAudio?: string;
  format: SpeechFormat;
  model?: string;
  stream: boolean;
  expressiveness?: number;
  phonemeHints?: Record<string, IPAPhoneme[]>;
  conversationHistory?: HistoryTurn[];
};

class RequestError extends Error {}

/** Voxtral 3 documents expressiveness in [1.0, 5.0]; >= 1 trades voice similarity for delivery. */
const MIN_EXPRESSIVENESS = 1;
const MAX_EXPRESSIVENESS = 5;
const PHONEMES: ReadonlySet<string> = new Set(Object.values(IPAPhoneme));

function parseExpressiveness(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < MIN_EXPRESSIVENESS ||
    value > MAX_EXPRESSIVENESS
  ) {
    throw new RequestError(
      `\`expressiveness\` must be a number between ${MIN_EXPRESSIVENESS} and ${MAX_EXPRESSIVENESS}`,
    );
  }
  return value;
}

/**
 * Checked here because the SDK validates phonemes client-side: an unknown one
 * would otherwise surface as an opaque 502 instead of a fixable 400.
 */
function parsePhonemeHints(value: unknown): Record<string, IPAPhoneme[]> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("`phoneme_hints` must map words to arrays of IPA phonemes");
  }
  const hints = Object.entries(value as Record<string, unknown>);
  if (hints.length === 0) return undefined;
  for (const [word, phonemes] of hints) {
    if (!Array.isArray(phonemes) || phonemes.length === 0) {
      throw new RequestError(`\`phoneme_hints.${word}\` must be a non-empty array of phonemes`);
    }
    const invalid = phonemes.filter((ph) => typeof ph !== "string" || !PHONEMES.has(ph));
    if (invalid.length > 0) {
      throw new RequestError(
        `Unsupported phoneme(s) for "${word}": ${invalid.map(String).join(" ")} ` +
          `(one IPA symbol per item; supported: ${[...PHONEMES].join(" ")})`,
      );
    }
  }
  return Object.fromEntries(hints) as Record<string, IPAPhoneme[]>;
}

/**
 * Accepts `{ role, text?, audio: "<base64>" }` turns (audio as a plain
 * string, flatter than Mistral's `{ data }`). Ordering rules (alternating,
 * ending with `user`) are left to Mistral, whose 4xx passes through.
 */
function parseConversationHistory(value: unknown): HistoryTurn[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new RequestError("`conversation_history` must be a non-empty array of turns");
  }
  return value.map((turn, i) => {
    const t = (typeof turn === "object" && turn !== null ? turn : {}) as Record<string, unknown>;
    const audio = t["audio"];
    if (typeof audio !== "string" || !audio) {
      throw new RequestError(`\`conversation_history[${i}].audio\` must be base64 audio`);
    }
    if (t["role"] === "user") return { role: "user", audio: { data: audio } };
    if (t["role"] === "assistant") {
      const text = t["text"];
      if (typeof text !== "string" || !text) {
        throw new RequestError(`\`conversation_history[${i}].text\` is required for assistant turns`);
      }
      return { role: "assistant", text, audio: { data: audio } };
    }
    throw new RequestError(`\`conversation_history[${i}].role\` must be "user" or "assistant"`);
  });
}

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RequestError(`\`${field}\` must be a string`);
  return value;
}

function parseFormat(value: unknown, fallback: SpeechFormat): SpeechFormat {
  const raw = asString(value, "format");
  if (raw === undefined || raw === "") return fallback;
  const normalized = raw.toLowerCase();
  if (!(SPEECH_FORMATS as readonly string[]).includes(normalized)) {
    throw new RequestError(`Invalid format "${raw}" (use one of ${SPEECH_FORMATS.join(", ")})`);
  }
  return normalized as SpeechFormat;
}

function parseRequest(body: unknown, config: Config): ParsedRequest {
  if (typeof body !== "object" || body === null) {
    throw new RequestError("JSON body must be an object");
  }
  const obj = body as Record<string, unknown>;
  const input = asString(obj["input"], "input")?.trim();
  if (!input) throw new RequestError("Provide non-empty `input` text to synthesize");
  if (input.length > config.maxTtsChars) {
    throw new RequestError(`\`input\` exceeds ${config.maxTtsChars} characters`);
  }
  const voice = asString(obj["voice"], "voice") || config.ttsVoice || undefined;
  const refAudio = asString(obj["ref_audio"], "ref_audio") || undefined;
  const model = asString(obj["model"], "model") || undefined;
  // Streaming (the default) gives the lowest time-to-first-byte; opt out with
  // `stream: false` to receive the whole clip in one response.
  const stream = obj["stream"] === undefined ? true : obj["stream"] === true;
  const conversationHistory = parseConversationHistory(obj["conversation_history"]);
  if (conversationHistory && refAudio) {
    throw new RequestError("`conversation_history` needs a preset `voice` and cannot be combined with `ref_audio`");
  }
  return {
    input,
    voice,
    refAudio,
    format: parseFormat(obj["format"], config.ttsFormat),
    model,
    stream,
    expressiveness: parseExpressiveness(obj["expressiveness"]),
    phonemeHints: parsePhonemeHints(obj["phoneme_hints"]),
    conversationHistory,
  };
}

export function createSynthesizeHandler(batch: Mistral, config: Config) {
  return async (c: Context): Promise<Response> => {
    const badRequest = (message: string) =>
      c.json({ error: { code: "bad_request", message } }, 400);

    let parsed: ParsedRequest;
    try {
      parsed = parseRequest(await c.req.json(), config);
    } catch (err) {
      if (err instanceof RequestError) return badRequest(err.message);
      return badRequest("Malformed JSON body");
    }

    const headers = FORMAT_HEADERS[parsed.format];
    const request = {
      model: parsed.model ?? config.ttsModel,
      input: parsed.input,
      responseFormat: parsed.format,
      ...(parsed.voice ? { voiceId: parsed.voice } : {}),
      ...(parsed.refAudio ? { refAudio: parsed.refAudio } : {}),
      ...(parsed.expressiveness !== undefined ? { expressiveness: parsed.expressiveness } : {}),
      ...(parsed.phonemeHints ? { phonemeHints: parsed.phonemeHints } : {}),
      ...(parsed.conversationHistory ? { conversationHistory: parsed.conversationHistory } : {}),
    };

    try {
      if (!parsed.stream) {
        const result = await batch.audio.speech.complete({ ...request, stream: false });
        const audio = Buffer.from(result.audioData, "base64");
        return c.body(audio, 200, headers);
      }

      // Force SSE: the SDK's default Accept header deprioritizes the event
      // stream (q=0), which can make the upstream answer with a single JSON blob.
      const events = await batch.audio.speech.complete(
        { ...request, stream: true },
        { acceptHeaderOverride: CompleteAcceptEnum.textEventStream },
      );
      const iterator = events[Symbol.asyncIterator]();
      // Pull the first event before committing to a 200: upstream failures
      // that happen before any audio flows become proper JSON errors instead
      // of an empty body with a success status the client can't distinguish
      // from a short clip.
      const first = await iterator.next();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for (let next = first; !next.done; next = await iterator.next()) {
              const data = next.value.data;
              if (data.type === "speech.audio.delta") {
                controller.enqueue(Buffer.from(data.audioData, "base64"));
              }
            }
            controller.close();
          } catch (err) {
            // The 200 is already on the wire; aborting the body is the only
            // signal left for the client, so keep a server-side trace too.
            console.error("[synthesize] upstream stream failed mid-response:", err);
            controller.error(err);
          }
        },
        // Client went away: stop pulling audio from Mistral.
        cancel: () => void iterator.return?.(),
      });
      return c.body(body, 200, headers);
    } catch (err) {
      const { status, code, message } = mapUpstreamError(err);
      console.error(`[synthesize] upstream error (${status} ${code}):`, err);
      return c.json({ error: { code, message } }, status);
    }
  };
}
