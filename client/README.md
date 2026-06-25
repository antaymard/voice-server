# voice-server React kit

Plain TypeScript files (no build step in this repo) for consuming voice-server
from a React app. Copy `client/src/` into your app, or add the repo as a
`file:`/git dependency — any Vite/Next toolchain compiles them as-is.

Requires React 18+ and a browser context served over **HTTPS** (or
`localhost`): `getUserMedia` and `AudioWorklet` are unavailable on insecure
origins.

## Realtime microphone transcription

```tsx
import { useRealtimeTranscription } from "./voice/index.ts"; // wherever you copied client/src

function Dictation() {
  const { status, text, language, error, start, stop } = useRealtimeTranscription({
    serverUrl: import.meta.env.VITE_VOICE_SERVER_URL, // e.g. "https://voice.example.com"
    token: import.meta.env.VITE_VOICE_SERVER_TOKEN,
    targetDelayMs: 480, // 240 = fastest, 2400 = most accurate
  });

  return (
    <div>
      <button onClick={() => (status === "listening" ? stop() : start())}>
        {status === "listening" ? "Stop" : "Dictate"}
      </button>
      <p>{text || "…"}</p>
      <small>
        {status}
        {language ? ` · ${language}` : ""}
        {error ? ` · ${error.code}: ${error.message}` : ""}
      </small>
    </div>
  );
}
```

What the hook does for you:

- Captures the mic with `getUserMedia` (mono, echo cancellation, noise
  suppression, auto gain), pipes it through an AudioWorklet that downmixes,
  resamples to 16 kHz and emits 16-bit PCM chunks (~100 ms).
- Buffers audio until the server session is ready, so the first word is never
  clipped.
- Accumulates committed text deltas in `text` (append-only); `done` replaces
  it with the server's authoritative final transcript.
- `stop()` flushes the worklet tail, asks the server to finalize, and resolves
  with the final text (10 s safety timeout).
- Auto-reconnects (3 attempts, backoff) on unexpected disconnects while
  listening, keeping the mic open and accumulating the transcript across
  sessions. Disable with `reconnect: false`.
- `start()` must be called from a user gesture (iOS requires it to unlock the
  `AudioContext`). Setup failures surface in `error`/`status`, not as throws.

`segments` collects finalized segments with timestamps; `onSegment`, `onDone`
and `onError` callbacks fire alongside the state updates. Timestamps restart
from zero after a reconnect.

If your CSP forbids `blob:` workers, serve `public/pcm-worklet.js` yourself
and pass its URL via `workletUrl`.

## Bulk file transcription

```ts
import { transcribeFile, TranscribeError } from "./voice/index.ts";

async function onFilePicked(file: File) {
  try {
    const result = await transcribeFile(file, {
      serverUrl: import.meta.env.VITE_VOICE_SERVER_URL,
      token: import.meta.env.VITE_VOICE_SERVER_TOKEN,
      // language: "fr",                  // optional hint
      // timestamps: ["segment"],         // incompatible with `language`
      // diarize: true,                   // who is speaking
      // contextBias: ["Voxtral", "PCM"], // guide tricky spellings
    });
    console.log(result.text, result.language);
  } catch (err) {
    if (err instanceof TranscribeError) console.error(err.status, err.code, err.message);
    throw err;
  }
}
```

## Text to speech

```ts
import { synthesizeSpeech, SpeechError } from "./voice/index.ts";

async function say(text: string) {
  try {
    // mp3 plays directly in an <audio>; pcm has the lowest latency (see below).
    const res = await synthesizeSpeech(text, {
      serverUrl: import.meta.env.VITE_VOICE_SERVER_URL,
      token: import.meta.env.VITE_VOICE_SERVER_TOKEN,
      format: "mp3",
      // voice: "neutral_female",  // preset/saved voice, optional
    });
    const url = URL.createObjectURL(await res.blob());
    await new Audio(url).play();
  } catch (err) {
    if (err instanceof SpeechError) console.error(err.status, err.code, err.message);
    throw err;
  }
}
```

`synthesizeSpeech` returns the raw `fetch` Response, so the body streams
chunk-by-chunk. For the lowest end-to-end latency, request `format: "pcm"`
(24 kHz mono s16le, advertised on the `X-Sample-Rate` / `X-Audio-Encoding`
response headers) and feed `res.body` into the Web Audio API as chunks arrive
instead of awaiting the whole `.blob()`.

## Security note

The token is visible to anyone who can read your app's bundle; the server's
origin allowlist (`ALLOWED_ORIGINS`) is what keeps other websites from using
it from a browser. Treat the pair as "good enough for personal apps", not as
user-level auth.
