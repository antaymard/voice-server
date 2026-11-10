import type { Mistral } from "@mistralai/mistralai";
import { CompleteAcceptEnum } from "@mistralai/mistralai/sdk/speech.js";
import type { Config } from "../config.ts";

/** Format of the audio every `Tts` yields: headerless PCM s16le mono. */
export const TTS_SAMPLE_RATE = 24000;
export const TTS_BYTES_PER_SECOND = TTS_SAMPLE_RATE * 2;

/** Speaks one chunk of text, yielding audio as it is generated. */
export type Tts = (text: string, opts: { voice?: string; signal: AbortSignal }) => AsyncIterable<Buffer>;

export function createVoxtralTts(batch: Mistral, config: Config): Tts {
  return async function* (text, { voice, signal }) {
    const voiceId = voice || config.ttsVoice;
    // SSE is forced for the same reason as in /v1/speak (see synthesize.ts).
    const events = await batch.audio.speech.complete(
      {
        model: config.ttsModel,
        input: text,
        responseFormat: "pcm",
        stream: true,
        ...(voiceId ? { voiceId } : {}),
      },
      { acceptHeaderOverride: CompleteAcceptEnum.textEventStream, signal },
    );
    for await (const event of events) {
      if (event.data.type === "speech.audio.delta") yield Buffer.from(event.data.audioData, "base64");
    }
  };
}
