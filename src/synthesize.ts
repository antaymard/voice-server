import type { Context } from "hono";
import type { Mistral } from "@mistralai/mistralai";
import { CompleteAcceptEnum } from "@mistralai/mistralai/sdk/speech.js";
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

type ParsedRequest = {
  input: string;
  voice?: string;
  refAudio?: string;
  format: SpeechFormat;
  model?: string;
  stream: boolean;
};

class RequestError extends Error {}

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
  return {
    input,
    voice,
    refAudio,
    format: parseFormat(obj["format"], config.ttsFormat),
    model,
    stream,
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
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
              const data = next.value.data;
              if (data.type === "speech.audio.delta") {
                controller.enqueue(Buffer.from(data.audioData, "base64"));
              }
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
        // Client went away: stop pulling audio from Mistral.
        cancel: (reason) => void iterator.return?.(reason),
      });
      return c.body(body, 200, headers);
    } catch (err) {
      const { status, code, message } = mapUpstreamError(err);
      console.error(`[synthesize] upstream error (${status} ${code}):`, err);
      return c.json({ error: { code, message } }, status);
    }
  };
}
