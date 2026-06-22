/**
 * Inline AudioWorklet processor source, loaded via a Blob URL so consuming
 * apps need no extra static asset.
 *
 * KEEP IN SYNC with public/pcm-worklet.js (same code as a plain file, used by
 * the server's demo page).
 */
export const PCM_PROCESSOR_SOURCE = String.raw`
class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetSampleRate || 16000;
    this.chunkSamples = Math.max(1, Math.round((this.targetRate * (opts.chunkMs || 100)) / 1000));
    this.out = new Int16Array(this.chunkSamples);
    this.outOffset = 0;
    this.carry = new Float32Array(0); // unconsumed source samples
    this.srcPos = 0; // fractional read position into carry+block
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "flush") {
        this.flush();
        this.port.postMessage({ type: "flushed" });
        this.stopped = true;
      }
    };
  }

  flush() {
    if (this.outOffset > 0) {
      const tail = this.out.slice(0, this.outOffset);
      this.port.postMessage(tail.buffer, [tail.buffer]);
      this.outOffset = 0;
    }
  }

  pushSample(value) {
    const v = Math.max(-1, Math.min(1, value));
    this.out[this.outOffset++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    if (this.outOffset === this.chunkSamples) {
      const full = this.out;
      this.port.postMessage(full.buffer, [full.buffer]);
      this.out = new Int16Array(this.chunkSamples);
      this.outOffset = 0;
    }
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true;

    const frames = input[0].length;
    let mono;
    if (input.length === 1) {
      mono = input[0];
    } else {
      mono = new Float32Array(frames);
      for (let ch = 0; ch < input.length; ch++) {
        const data = input[ch];
        for (let i = 0; i < frames; i++) mono[i] += data[i];
      }
      for (let i = 0; i < frames; i++) mono[i] /= input.length;
    }

    // sampleRate is the AudioWorkletGlobalScope rate (the context rate).
    if (sampleRate === this.targetRate) {
      for (let i = 0; i < frames; i++) this.pushSample(mono[i]);
      return true;
    }

    const buf = new Float32Array(this.carry.length + frames);
    buf.set(this.carry, 0);
    buf.set(mono, this.carry.length);
    const ratio = sampleRate / this.targetRate;
    let pos = this.srcPos;
    while (pos + 1 < buf.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      this.pushSample(buf[i] * (1 - frac) + buf[i + 1] * frac);
      pos += ratio;
    }
    const consumed = Math.floor(pos);
    this.srcPos = pos - consumed;
    this.carry = buf.slice(consumed);
    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
`;

let cachedUrl: string | null = null;

/** Blob URL for the worklet module. Pass `workletUrl` to the hook instead if your CSP forbids blob: workers. */
export function createPcmWorkletUrl(): string {
  if (!cachedUrl) {
    cachedUrl = URL.createObjectURL(
      new Blob([PCM_PROCESSOR_SOURCE], { type: "application/javascript" }),
    );
  }
  return cachedUrl;
}
