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
    targetDelayMs: 480, // 80 = fastest … 1200, or 2400 = most accurate
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

`onDone` and `onError` callbacks fire alongside the state updates.

### Voxtral 3 session options

All optional, sent once when the session starts (Mistral locks them when
audio begins — changing them means `stop()` then `start()` again):

```tsx
import { TURN_DETECTION_PRESETS, useRealtimeTranscription } from "./voice/index.ts";

const voice = useRealtimeTranscription({
  serverUrl, token,
  language: "fr",                       // pin the language (default: auto-detect)
  contextBias: ["Nolênor", "Voxtral"],  // spellings to get right
  turnDetection: true,                  // or TURN_DETECTION_PRESETS.aggressive, or { minSilenceMs: 300, … }
  onTurn: (turn) => {
    if (turn.phase === "eager_end") prefetchAnswer();   // discardable work only
    if (turn.phase === "resume") cancelPrefetch();      // the user kept talking
    if (turn.phase === "end") submit(voice.text);       // final: safe to act
  },
});
```

**Turn detection** tells a voice UI when the user has finished speaking:
`start` → (`eager_end` → `resume`)* → `end` (`endReason`: `threshold` or
`timeout`). Eager ends are frequent; only `end` is final. A few deltas can
still arrive after `end`.

**Speaker labels**: `diarize: true` (or `speakerReferences: { Alice: base64Clip }`
to name known voices, 3–15 s each, up to 8) switches the server to
speaker-labelled `segment` events. The hook appends them to `segments`
(`{ text, speakerId, start: null, end: null }` — realtime segments have no
timestamps) and mirrors their text into `text`; `onSegment` fires for each.
Diarization and turn detection can't run in the same session.

Invalid options (e.g. both `diarize` and `turnDetection`) end the session
with a `bad_message` error and no auto-reconnect.

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
      // language: "fr",                           // pin (default: auto-detect)
      // timestamps: ["segment"],                  // word timestamps are gone in Voxtral 3
      // diarize: true,                            // who is speaking (adds segment timestamps)
      // speakerReferences: { Alice: aliceClip },  // name known speakers (Blob, 3-15 s)
      // contextBias: ["Voxtral", "PCM"],          // guide tricky spellings
      // model: "voxtral-small-transcribe-3-0",    // higher quality
    });
    console.log(result.text, result.language);
    // With diarize: result.segments = [{ text, start, end, speakerId }, …]
    // (segments can overlap when people talk over each other).
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
      // voice: "voice_592",        // preset/saved voice id (see listVoices)
      // expressiveness: 2,         // 1-5, stronger delivery
      // phonemeHints: { tomato: ["t", "ə", "m", "ɑ", "t", "oʊ"] }, // custom pronunciation (IPA)
    });
    const url = URL.createObjectURL(await res.blob());
    await new Audio(url).play();
  } catch (err) {
    if (err instanceof SpeechError) console.error(err.status, err.code, err.message);
    throw err;
  }
}
```

**Emotion and pace** (Voxtral 3): put tags in the text itself —
`synthesizeSpeech("[emotion=excited]C'est livré ! [emotion=calm][pace=slow]Voici le détail.", …)`.
34 emotions (`happy`, `warm`, `calm`, `apologetic`, `urgent`, `sad`, …) and
paces `very-slow`, `slow`, `moderate`, `fast`, `very-fast`; the full list is
in the main README. Tags are not spoken.

**Voice agents**: pass `conversationHistory` (prior user/assistant turns as
base64 audio, ending with the user's turn) with a Voxtral 3 preset `voice`, and
the reply's tone follows the conversation.

**Picking a voice**:

```ts
import { listVoices } from "./voice/index.ts";

const { voices } = await listVoices({ serverUrl, token, type: "preset", language: ["fr"] });
// -> [{ id: "voice_592", name: "Marie", languages: ["fr"], gender: "female", … }, …]
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
