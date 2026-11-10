/**
 * The assistant's voice, behind one interface: text goes in as the LLM writes
 * it, audio comes out tagged with the piece of text it speaks (which is what
 * lets the conversation know how much was heard when it gets interrupted).
 */
import WebSocket from "ws";
import type { Mistral } from "@mistralai/mistralai";
import { CompleteAcceptEnum } from "@mistralai/mistralai/sdk/speech.js";
import type { Config } from "../config.ts";
import { createSentenceSplitter, toSpeakable } from "./sentences.ts";

/**
 * Mistral's speech request refuses to run without a voice; this is the one
 * its realtime speech session uses when none is given.
 */
const DEFAULT_VOICE = "voice_447";

/** Format of the audio every `Tts` yields: headerless PCM s16le mono. */
export const TTS_SAMPLE_RATE = 24000;
export const TTS_BYTES_PER_SECOND = TTS_SAMPLE_RATE * 2;

/**
 * Speech is produced in segments (sentences), numbered from 0, strictly in
 * order. `text` is the segment's text as known so far; an item with `done`
 * closes the segment.
 */
export type TtsItem = { segment: number; text: string; audio?: Buffer; done?: boolean };

export type TtsStream = {
  /** Feed reply text as it is generated (deltas, any size). */
  write: (text: string) => void;
  /** No more text. */
  end: () => void;
  items: AsyncIterable<TtsItem>;
  /** How this utterance is being spoken: streamed text, or one request per sentence. */
  via: () => "realtime" | "http";
};

/** Opens the voice for one utterance. Aborting the signal silences it. */
export type Tts = (opts: { voice?: string; signal: AbortSignal }) => TtsStream;

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  private error: unknown = null;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  /** Items already queued are still delivered, then the iteration throws. */
  fail(error: unknown): void {
    if (this.closed) return;
    this.error = error;
    this.close();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
      } else if (this.closed) {
        if (this.error) throw this.error;
        return;
      } else {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
  }
}

// --- Raw PCM normalization ----------------------------------------------------

/**
 * Mistral documents `pcm` output as mono 24 kHz without stating the sample
 * type (observed: 32-bit float), so it is detected from the data (16-bit
 * integers read as floats are almost never plausible samples) and
 * remembered. Everything leaves as s16le.
 */
export type PcmFormat = { encoding: "auto" | "s16le" | "f32le" };

const DETECT_MIN_WORDS = 64;
const DETECT_MAX_BYTES = 24_000;

function looksLikeFloat32(data: Buffer): boolean | null {
  let words = 0;
  let plausible = 0;
  for (let i = 0; i + 4 <= data.length; i += 4) {
    if (data.readUInt32LE(i) === 0) continue; // silence reads the same either way
    words += 1;
    const v = Math.abs(data.readFloatLE(i));
    if (v >= 1e-6 && v <= 1.5) plausible += 1;
  }
  if (words < DETECT_MIN_WORDS) return null;
  return plausible / words > 0.9;
}

function float32ToInt16(data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length / 2);
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.max(-1, Math.min(1, data.readFloatLE(i)));
    out.writeInt16LE(Math.round(v * 32767), i / 2);
  }
  return out;
}

/** Converts one audio stream to whole s16le samples; `flush` at its end. */
export function createPcmDecoder(format: PcmFormat): {
  push: (chunk: Buffer) => Buffer | null;
  flush: () => Buffer | null;
} {
  let pending: Buffer = Buffer.alloc(0);

  const convert = (final: boolean): Buffer | null => {
    if (format.encoding === "auto") {
      const verdict = looksLikeFloat32(pending);
      if (verdict !== null) format.encoding = verdict ? "f32le" : "s16le";
      else if (!final && pending.length < DETECT_MAX_BYTES) return null; // keep listening
    }
    // Still undecided (a very short or silent stream): 16-bit is the documented
    // input convention and what /v1/speak has always assumed.
    const width = format.encoding === "f32le" ? 4 : 2;
    const usable = pending.length - (pending.length % width);
    if (usable === 0) return null;
    const whole = pending.subarray(0, usable);
    pending = pending.subarray(usable);
    return width === 4 ? float32ToInt16(whole) : Buffer.from(whole);
  };

  return {
    push: (chunk) => {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      return convert(false);
    },
    flush: () => convert(true),
  };
}

// --- One HTTP speech request per sentence --------------------------------------

export function createHttpTts(batch: Mistral, config: Config, format: PcmFormat): Tts {
  return ({ voice, signal }) => {
    const splitter = createSentenceSplitter();
    const sentences = new AsyncQueue<string>();
    const voiceId = voice || config.ttsVoice || DEFAULT_VOICE;
    signal.addEventListener("abort", () => sentences.close());

    async function* items(): AsyncGenerator<TtsItem> {
      let segment = 0;
      for await (const raw of sentences) {
        const text = raw.trim();
        const speakable = toSpeakable(text);
        if (speakable && !signal.aborted) {
          const decoder = createPcmDecoder(format);
          // SSE is forced for the same reason as in /v1/speak (see synthesize.ts).
          const events = await batch.audio.speech.complete(
            {
              model: config.ttsModel,
              input: speakable,
              responseFormat: "pcm",
              stream: true,
              voiceId,
            },
            { acceptHeaderOverride: CompleteAcceptEnum.textEventStream, signal },
          );
          for await (const event of events) {
            if (event.data.type !== "speech.audio.delta") continue;
            const audio = decoder.push(Buffer.from(event.data.audioData, "base64"));
            if (audio) yield { segment, text, audio };
          }
          const tail = decoder.flush();
          if (tail) yield { segment, text, audio: tail };
        }
        yield { segment, text, done: true };
        segment += 1;
      }
    }

    return {
      write: (text) => {
        for (const sentence of splitter.push(text)) sentences.push(sentence);
      },
      end: () => {
        for (const sentence of splitter.flush()) sentences.push(sentence);
        sentences.close();
      },
      items: items(),
      via: () => "http",
    };
  };
}

// --- Mistral realtime speech (text streamed in over a WebSocket) ---------------

const RT_CONNECT_TIMEOUT_MS = 10_000;
const HAS_SPEECH = /[\p{L}\p{N}]/u;

type Generation = { text: string; speakable: boolean; decoder: ReturnType<typeof createPcmDecoder> };

/**
 * The reply's text is forwarded delta by delta, so speech can start before a
 * sentence is even finished, over one warm connection. Each sentence is
 * flushed as its own generation: that keeps a known text for every stretch
 * of audio (the protocol has no timestamps), at the cost of prosody not
 * carrying across sentences. There is no cancel message: closing the socket
 * is how speech stops.
 */
export function createRealtimeTts(config: Config, format: PcmFormat): Tts {
  return ({ voice, signal }) => {
    const out = new AsyncQueue<TtsItem>();
    const splitter = createSentenceSplitter();
    const voiceId = voice || config.ttsVoice;
    const url = `${config.mistralWsUrl}/v1/audio/speech/realtime?model=${encodeURIComponent(config.ttsModel)}`;
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${config.mistralApiKey}` },
      handshakeTimeout: RT_CONNECT_TIMEOUT_MS,
    });

    let open = false;
    const outbox: string[] = [];
    const sendMessage = (message: unknown): void => {
      const raw = JSON.stringify(message);
      if (open) ws.send(raw);
      else outbox.push(raw);
    };
    sendMessage({
      type: "session.update",
      session: { response_format: "pcm", streaming_mode: "responsive", ...(voiceId ? { voice: voiceId } : {}) },
    });

    /** Generations not fully voiced yet, oldest first; the last may still be open. */
    const generations: Generation[] = [];
    let openGeneration: Generation | null = null;
    let firstSegment = 0; // segment number of generations[0]
    let appended = 0; // chars of the unfinished sentence already sent
    let ended = false;

    const append = (raw: string): void => {
      // The server speaks what it gets: keep stray markdown out of its mouth.
      const text = raw.replace(/[*_`#]+/g, "");
      if (!text) return;
      if (!openGeneration) {
        openGeneration = { text: "", speakable: false, decoder: createPcmDecoder(format) };
        generations.push(openGeneration);
      }
      openGeneration.text += text;
      if (HAS_SPEECH.test(text)) openGeneration.speakable = true;
      sendMessage({ type: "input_text.append", text });
    };

    const closeSentence = (): void => {
      // Nothing pronounceable yet ("…", a list bullet): let it ride with the next sentence.
      if (!openGeneration?.speakable) return;
      sendMessage({ type: "input_text.flush" });
      openGeneration = null;
    };

    const finishIfDrained = (): void => {
      if (ended && generations.length === 0) {
        out.close();
        ws.close();
      }
    };

    ws.on("open", () => {
      open = true;
      for (const raw of outbox.splice(0)) ws.send(raw);
    });
    ws.on("message", (data) => {
      let event: { type?: string; audio_data?: string; error?: { message?: unknown } };
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      const head = generations[0];
      if (event.type === "speech.audio.delta" && head && typeof event.audio_data === "string") {
        const audio = head.decoder.push(Buffer.from(event.audio_data, "base64"));
        if (audio) out.push({ segment: firstSegment, text: head.text.trim(), audio });
      } else if (event.type === "speech.audio.done" && head) {
        const tail = head.decoder.flush();
        if (tail) out.push({ segment: firstSegment, text: head.text.trim(), audio: tail });
        out.push({ segment: firstSegment, text: head.text.trim(), done: true });
        generations.shift();
        if (openGeneration === head) openGeneration = null;
        firstSegment += 1;
        finishIfDrained();
      } else if (event.type === "error") {
        out.fail(new Error(`Realtime speech error: ${String(event.error?.message ?? "unknown")}`));
        ws.terminate();
      }
    });
    ws.on("error", (err) => out.fail(new Error(`Realtime speech connection failed: ${err.message}`)));
    ws.on("close", () => {
      if (ended && generations.every((g) => !g.speakable)) out.close();
      else out.fail(new Error("Realtime speech connection closed before the audio was complete"));
    });
    signal.addEventListener("abort", () => {
      out.close();
      ws.terminate();
    });

    return {
      write: (delta) => {
        for (const sentence of splitter.push(delta)) {
          append(sentence.slice(appended));
          appended = 0;
          closeSentence();
        }
        const rest = splitter.pending();
        append(rest.slice(appended));
        appended = rest.length;
      },
      end: () => {
        for (const sentence of splitter.flush()) append(sentence.slice(appended));
        ended = true;
        openGeneration = null;
        // Voices what is left, then the server closes the connection.
        sendMessage({ type: "input_text.end" });
        finishIfDrained();
      },
      items: out,
      via: () => "realtime",
    };
  };
}

// --- Fallback -------------------------------------------------------------------

const FALLBACK_COOLDOWN_MS = 60_000;

/**
 * Uses `primary`; if it fails before producing anything, replays the text
 * through `fallback` and stays on it for a minute (so a broken primary costs
 * one failed attempt, not one per reply).
 */
export function withFallback(primary: Tts, fallback: Tts): Tts {
  let primaryDownUntil = 0;
  return (opts) => {
    if (Date.now() < primaryDownUntil) return fallback(opts);
    const written: string[] = [];
    let ended = false;
    let active = primary(opts);

    async function* items(): AsyncGenerator<TtsItem> {
      let produced = false;
      try {
        for await (const item of active.items) {
          produced = true;
          yield item;
        }
        return;
      } catch (err) {
        if (opts.signal.aborted || produced) throw err;
        console.warn("[converse] realtime speech unavailable, using per-sentence speech:", err);
        primaryDownUntil = Date.now() + FALLBACK_COOLDOWN_MS;
      }
      active = fallback(opts);
      for (const text of written) active.write(text);
      if (ended) active.end();
      yield* active.items;
    }

    return {
      write: (text) => {
        written.push(text);
        active.write(text);
      },
      end: () => {
        ended = true;
        active.end();
      },
      items: items(),
      via: () => active.via(),
    };
  };
}

export function createVoxtralTts(batch: Mistral, config: Config): Tts {
  const format: PcmFormat = { encoding: config.ttsPcmEncoding };
  const http = createHttpTts(batch, config, format);
  return config.converseTts === "realtime" ? withFallback(createRealtimeTts(config, format), http) : http;
}
