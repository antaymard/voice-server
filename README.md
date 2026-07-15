# voice-server

Minimal speech-to-text backend for React apps, powered by the
[Mistral (Voxtral)](https://docs.mistral.ai/studio-api/audio/speech_to_text) API,
with optional [Gladia](https://docs.gladia.io)-backed alternatives.

- **Realtime**: browser streams mic audio over a WebSocket, the server bridges
  it to Mistral's realtime transcription and streams text deltas back
  (sub-second latency, tunable).
- **Bulk**: upload a complete audio file (or pass a URL), get the transcript
  back as JSON.
- **Text to speech**: POST text, stream back raw audio (Mistral Voxtral TTS),
  latency-tuned (`pcm` streaming for the fastest time-to-first-audio).
- **Gladia alternatives** (`/v1/gladia/*`, opt-in via `GLADIA_API_KEY`):
  live and bulk STT with business vocabulary biasing, context prompts,
  speaker-count-aware diarization, summaries/chapters/subtitles, and async
  jobs with callbacks. Mistral endpoints are untouched — apps migrate (or
  not) one call site at a time.
- One shared token for all your apps + an origin allowlist; your
  `MISTRAL_API_KEY`/`GLADIA_API_KEY` never leave the server.
- Ships a copyable **React kit** (`client/`) — mic capture worklet,
  `useRealtimeTranscription` hook, `transcribeFile` helper — and a built-in
  demo page.

## Quick start

```bash
cp .env.example .env   # fill MISTRAL_API_KEY, AUTH_TOKEN, ALLOWED_ORIGINS
npm install
npm run dev            # http://localhost:3000 -> demo page
```

Requires Node >= 22.18 (runs TypeScript natively; `npm run build` emits plain
JS for production).

Without a Mistral key you can still exercise everything against the bundled
mock:

```bash
npm run mock           # mock Mistral API on :9099
MISTRAL_BASE_URL=http://127.0.0.1:9099 MISTRAL_WS_URL=ws://127.0.0.1:9099 npm run dev
```

## HTTP API

All `/v1/*` endpoints require `Authorization: Bearer <AUTH_TOKEN>`.
Errors use a uniform envelope: `{ "error": { "code", "message" } }` — this
includes unknown routes (`404 not_found`) and unexpected server failures
(`500 internal_error`), so a client can always parse the body as JSON when
the status is not 2xx. Blocked CORS origins and rejected WebSocket upgrades
are logged server-side (the browser only shows an opaque network error).

### `POST /v1/transcribe` — bulk transcription

`multipart/form-data` fields:

| Field | Required | Notes |
|---|---|---|
| `file` | yes* | the audio file (mp3, wav, m4a, …) |
| `file_url` | yes* | alternative to `file` (exactly one of the two) |
| `language` | no | ISO 639-1 hint, e.g. `fr` |
| `timestamps` | no | `segment`, `word` or `segment,word` — incompatible with `language` (Mistral limitation) |
| `diarize` | no | `true` to label speakers |
| `context_bias` | no | repeatable; words/phrases to bias spelling (max 100) |

Or `application/json`: `{ "file_url", "language?", "timestamp_granularities?": ["segment"], "diarize?", "context_bias?": [] }`.

```bash
curl -X POST https://your-server/v1/transcribe \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -F file=@meeting.mp3
# -> { "model": "...", "text": "…", "language": "fr", "segments": [], "usage": {...} }
```

Responses are passed through from Mistral. Uploads above `MAX_UPLOAD_BYTES`
get `413`; upstream auth problems surface as `502 upstream_auth` (it's the
server's key, not yours).

### `POST /v1/speak` — text to speech

Powered by Mistral's [Voxtral TTS](https://docs.mistral.ai/studio-api/audio/text_to_speech).
`application/json` body:

| Field | Required | Default | Notes |
|---|---|---|---|
| `input` | yes | — | text to synthesize (≤ `MAX_TTS_CHARS`) |
| `format` | no | `pcm` | `pcm`, `wav`, `mp3`, `flac` or `opus` |
| `voice` | no | `TTS_VOICE` | preset or saved voice id; omit for the Mistral default |
| `ref_audio` | no | — | base64 audio for one-off zero-shot voice cloning |
| `model` | no | `TTS_MODEL` | override the synthesis model |
| `stream` | no | `true` | stream audio as it is generated (lowest latency) |

The response body is the **raw audio bytes** (not base64/JSON) with a matching
`Content-Type`, streamed chunk-by-chunk via chunked transfer when `stream` is
true. `pcm` is headerless, so the parameters needed to play it back ride along
on response headers: `X-Sample-Rate: 24000`, `X-Audio-Channels: 1`,
`X-Audio-Encoding: pcm_s16le`.

Upstream failures that happen before any audio is produced return a JSON
error (`4xx`/`502`) even in streaming mode — the first audio chunk is awaited
before the `200` is committed. If the upstream dies *mid*-stream, the only
remaining signal is an aborted response body: a robust client should treat a
truncated read as an error, not as a short clip.

```bash
curl -X POST https://your-server/v1/speak \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":"Bonjour le monde","format":"mp3"}' \
  --output hello.mp3
```

**Latency:** streaming + `pcm` minimizes time-to-first-audio (~0.8 s
end-to-end from Mistral, vs ~3 s for `mp3`, which is encoded before it streams).
Pick `pcm` for live playback and `mp3`/`opus` when you want a self-describing
file you can drop straight into an `<audio>` element.

### `POST /v1/gladia/transcribe` — bulk transcription (Gladia)

Same job as `/v1/transcribe`, backed by [Gladia](https://docs.gladia.io)
instead of Mistral, and deliberately **not** API-compatible: it exposes what
Gladia does better. Requires `GLADIA_API_KEY` (otherwise `503
not_configured`). Send `multipart/form-data` (file upload) or
`application/json` (hosted `audio_url`):

| Field | Type | Notes |
|---|---|---|
| `file` | file | multipart only; exactly one of `file` / `audio_url` |
| `audio_url` | string | publicly fetchable audio URL |
| `model` | `solaria-1` \| `solaria-3` | overrides `GLADIA_BULK_MODEL` for this request, see below |
| `language` | string | ISO 639-1; disables auto-detect. Omit to auto-detect. **Required** for `solaria-3` |
| `code_switching` | bool | allow several languages in the same audio (`solaria-1` only) |
| `vocabulary` | strings / objects | business vocabulary biasing, see below |
| `vocabulary_intensity` | number 0..1 | default replacement intensity |
| `context` | string | free-text context prompt (topic, product names…) |
| `diarization` | bool | label speakers |
| `speakers` / `min_speakers` / `max_speakers` | int | speaker-count hints for diarization |
| `spelling` | object | exact spelling fixes: `{ "SQL": ["sequel"] }` (JSON body; `spelling_json` in multipart) |
| `sentences` | bool | sentence-level segmentation in the result |
| `subtitles` | `srt`, `vtt` | comma list / array; adds subtitle renders |
| `summarize` | bool or `general` \| `bullet_points` \| `concise` | add a summary |
| `chapters` | bool | chapterization |
| `entities` | bool | named-entity recognition |
| `callback_url` | string | Gladia POSTs the finished result there |
| `metadata` | object | JSON body only; echoed back by Gladia (correlate callbacks) |
| `wait` | bool, default `true` | `false` -> `202 {id}` immediately, poll the GET below |

**Vocabulary** is the headline feature: it phonetically biases transcription
toward your domain terms. Plain strings work (`-F "vocabulary=Solaria,Voxtral"`
in multipart, `"vocabulary": ["Solaria"]` in JSON), and the object form tunes
matching per term — in multipart put the JSON array in `vocabulary_json`:

```json
{
  "audio_url": "https://example.com/standup.mp3",
  "vocabulary": [
    "Kubernetes",
    { "value": "Salesforce", "pronunciations": ["sell force"], "intensity": 0.5, "language": "en" }
  ],
  "context": "Daily standup of a French dev team; product names stay in English"
}
```

**Model** (`GLADIA_BULK_MODEL`, default `solaria-1`, override per-request with
`model`):

| | `solaria-1` (default) | `solaria-3` |
|---|---|---|
| Best on | clean/quiet, formal, read speech | noisy, real-world, production audio (call centers, accents) |
| Languages | 100+, auto-detect, code-switching | exactly one of `en`/`fr`/`de`/`es`/`it` — `language` is **required**, `code_switching` rejected |
| Live support | yes (also the realtime endpoint's model) | no, pre-recorded only |

Default is `solaria-1`: it wins on clean/quiet audio (the common case) and
keeps behavior consistent with `/v1/gladia/realtime`, which has no
`solaria-3` equivalent. Reach for `solaria-3` only for genuinely messy
production audio in one of its five languages.

Response (`200`, `wait=true`): `{ "id", "status": "done", "text", "languages",
"utterances": [{ text, start, end, language, confidence, channel, speaker?,
words }], "metadata", ...add-ons }` — `summarization`, `chapters`, `entities`,
`sentences`, `subtitles` appear when requested. Gladia processes async
server-side; this endpoint polls for you (`GLADIA_POLL_*`) and returns `504
poll_timeout` (with the job id) if the audio outlasts the budget.

### `GET /v1/gladia/transcribe/:id` — poll an async job

For `wait=false` (or after a `poll_timeout`): returns the same envelope with
`status` `queued` | `processing` | `done` | `error`. Unknown ids give `404`.

```bash
curl -X POST https://your-server/v1/gladia/transcribe \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -F file=@meeting.mp3 -F "vocabulary=Solaria,Voxtral" -F wait=false
# -> 202 { "id": "...", "status": "queued" }
curl https://your-server/v1/gladia/transcribe/<id> -H "Authorization: Bearer $AUTH_TOKEN"
```

### `GET /healthz`

No auth. `{ "ok": true, "uptime": 123, "activeSessions": 0 }`.

### `GET /`

Demo page (mic realtime + file upload). Static and public; API calls made from
it still need the token.

## Realtime WebSocket — `GET /v1/realtime`

Connect to `wss://your-server/v1/realtime?token=<AUTH_TOKEN>` (browsers can't
set headers on WebSockets; non-browser clients may use the `Authorization`
header instead). If an `Origin` header is present it must be allowlisted.

Client → server:

1. First frame (text): `{"type":"start","sampleRate":16000,"targetDelayMs":480}`
   — `sampleRate` ∈ {8000, 16000, 22050, 44100, 48000}; `targetDelayMs`
   clamped to [240, 2400] (lower = faster, higher = more accurate).
2. Binary frames: raw **PCM s16le mono** at the declared rate (~100 ms per
   frame recommended; max 1 MiB per frame).
3. `{"type":"flush"}` (optional): force early processing of buffered audio.
4. `{"type":"stop"}`: finalize — remaining deltas and `done` follow, then the
   socket closes normally.

Server → client (JSON text frames):

| Event | Payload | Meaning |
|---|---|---|
| `ready` | `requestId, model, sampleRate, targetDelayMs` | session is live, send audio |
| `delta` | `text` | committed transcript text (append-only) |
| `segment` | `text, start, end` | finalized segment with timestamps (s) |
| `language` | `language` | detected language (`fr`, `en`, …) |
| `done` | `text, language, segments[], usage` | final transcript, then close `1000` |
| `error` | `code, message` | see codes below, then close |

Error codes: `bad_message`, `idle_timeout`, `session_too_long`,
`upstream_error`, `backpressure`, `server_shutdown`, `server_error`.

Close codes: `1000` done · `1001` server shutdown · `1009` frame too large ·
`1011` internal · `4400` protocol violation · `4408` idle timeout · `4413` max
session duration · `4502` upstream failure.

Notes: realtime auto-detects the language (no language parameter upstream) and
does not support `diarize`. The server pings every 30 s; sessions are capped
by `MAX_SESSION_MS` (a graceful finalize is attempted first) and reaped after
`IDLE_TIMEOUT_MS` without client frames.

## Gladia realtime WebSocket — `GET /v1/gladia/realtime`

The Gladia-backed alternative to `/v1/realtime` (requires `GLADIA_API_KEY`,
otherwise the upgrade is rejected with `503`). Same transport and auth
(`?token=`, origin allowlist, binary PCM s16le mono frames), **different
protocol** — Gladia transcribes utterance-by-utterance with voice-activity
endpointing instead of a rolling delta stream, and accepts per-session
options Mistral has no equivalent for. Shared types live in
[`client/src/gladiaProtocol.ts`](client/src/gladiaProtocol.ts).

First frame (text), everything optional:

```json
{
  "type": "start",
  "sampleRate": 16000,
  "languages": ["fr", "en"],
  "codeSwitching": true,
  "vocabulary": ["Solaria", { "value": "Salesforce", "pronunciations": ["sell force"] }],
  "vocabularyIntensity": 0.5,
  "endpointing": 0.05,
  "maxDurationWithoutEndpointing": 15,
  "audioEnhancer": false,
  "partials": true
}
```

- `sampleRate` ∈ {8000, 16000, 32000, 44100, 48000} (note: 32 kHz yes,
  22.05 kHz no — this differs from the Mistral endpoint).
- `languages`: none = auto-detect, one = forced, several = detection
  restricted to the list (+ `codeSwitching` to switch mid-conversation).
- `vocabulary`: same biasing as the bulk endpoint, applied live.
- `endpointing` / `maxDurationWithoutEndpointing`: seconds of silence that
  finalize an utterance / hard cap without silence (clamped to Gladia's
  bounds).
- `partials`: set `false` if you only render committed text.

Then binary PCM frames; `{"type":"stop"}` finalizes (no `flush` — endpointing
plays that role). Server → client events:

| Event | Payload | Meaning |
|---|---|---|
| `ready` | `sessionId, sampleRate, partials` | session is live, send audio |
| `partial` | `text, language?, confidence?` | hypothesis for the **current** utterance; each one **replaces** the previous (render as ephemeral text) |
| `utterance` | `text, start, end, language?, confidence?, words?` | committed utterance, never rewritten |
| `done` | `text, utterances[]` | full-session transcript after `stop`, then close `1000` |
| `error` | `code, message` | same codes as `/v1/realtime`, then close |

Close codes and error codes are shared with the Mistral endpoint. The final
`done.text` comes from Gladia's post-processing pass (slightly cleaner than
the concatenated utterances); if that pass fails to report, the server falls
back to the utterances it already relayed.

## React usage

See [`client/README.md`](client/README.md). Short version:

```tsx
const { status, text, start, stop } = useRealtimeTranscription({
  serverUrl: "https://voice.example.com",
  token: VOICE_TOKEN,
});
```

```ts
const { text } = await transcribeFile(file, { serverUrl, token });
```

```ts
const res = await synthesizeSpeech("Bonjour le monde", { serverUrl, token, format: "mp3" });
new Audio(URL.createObjectURL(await res.blob())).play();
```

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `MISTRAL_API_KEY` | yes | — | Mistral API key (server-side only) |
| `AUTH_TOKEN` | yes | — | shared bearer token for your apps (use `openssl rand -hex 32`) |
| `ALLOWED_ORIGINS` | yes | — | comma-separated origins; `*` disables the check (dev only) |
| `PORT` | no | `3000` | injected by Railway |
| `BATCH_MODEL` | no | `voxtral-mini-latest` | bulk transcription model |
| `REALTIME_MODEL` | no | `voxtral-mini-transcribe-realtime-2602` | realtime model |
| `TTS_MODEL` | no | `voxtral-mini-tts-2603` | text-to-speech model |
| `TTS_VOICE` | no | — | default voice id (empty = Mistral's default) |
| `TTS_FORMAT` | no | `pcm` | default output format when the request omits one |
| `MAX_TTS_CHARS` | no | `8000` | max characters per `/v1/speak` request |
| `MAX_UPLOAD_BYTES` | no | `26214400` (25 MB) | bulk upload cap |
| `MAX_SESSIONS` | no | `20` | concurrent realtime sessions |
| `MAX_SESSION_MS` | no | `600000` (10 min) | per-session duration cap |
| `IDLE_TIMEOUT_MS` | no | `60000` | close sessions with no client frames |
| `DEFAULT_TARGET_DELAY_MS` | no | `480` | default latency/accuracy tradeoff |
| `MISTRAL_BASE_URL` | no | `https://api.mistral.ai` | upstream override (tests/mock) |
| `MISTRAL_WS_URL` | no | `wss://api.mistral.ai` | upstream override (tests/mock) |
| `GLADIA_API_KEY` | no | — | enables `/v1/gladia/*`; empty = those endpoints answer 503 |
| `GLADIA_BULK_MODEL` | no | `solaria-1` | bulk model: `solaria-1` (clean/quiet, 100+ langs) or `solaria-3` (noisy, single language) |
| `GLADIA_LIVE_MODEL` | no | — | live model override (empty = Gladia's default, solaria-1 — the only model live supports) |
| `GLADIA_REGION` | no | — | live session region: `eu-west` or `us-west` (empty = Gladia default) |
| `GLADIA_POLL_INTERVAL_MS` | no | `1000` | bulk: cadence of result polling |
| `GLADIA_POLL_TIMEOUT_MS` | no | `300000` (5 min) | bulk: max wait before `504 poll_timeout` |
| `GLADIA_BASE_URL` | no | `https://api.gladia.io` | upstream override (tests/mock) |

## Deploying to Railway

1. Push this repo to GitHub and create a Railway service from it — the
   `Dockerfile` is picked up automatically (`railway.json` wires the
   `/healthz` healthcheck).
2. Set `MISTRAL_API_KEY`, `AUTH_TOKEN` and `ALLOWED_ORIGINS` in the service
   variables. Railway injects `PORT`.
3. Deploy; WebSockets work through Railway's proxy out of the box.
4. In each React app, set the server URL + token and use the kit.

> **Healthcheck stuck on "service unavailable"?** Open the **Deploy Logs** tab
> (not the Healthcheck log) to see why the container never came up. Two common
> causes:
>
> - `Configuration error: Missing required environment variables: …` — a
>   required variable (`MISTRAL_API_KEY`, `AUTH_TOKEN`, `ALLOWED_ORIGINS`) is
>   not set, so the server refuses to boot and crash-loops. Set it and redeploy.
> - `sh: 1: tsc: not found` (or `npm error … Could not read package.json`)
>   repeating on every restart — the container is being launched with the wrong
>   command: a **Custom Start Command** in the service settings that runs
>   `npm run build`/`npm start` at *runtime*, against the production image whose
>   devDependencies (`tsc` included) were pruned. `railway.json` pins
>   `startCommand` to `node dist/src/index.js`, and config-as-code overrides the
>   dashboard, so redeploying from this repo neutralizes a stray custom start
>   command. If you genuinely need a custom start, edit `startCommand` in
>   `railway.json`, not the dashboard.

## Development

```bash
npm run dev        # watch mode, reads .env
npm test           # protocol + auth + batch + full WS bridges against the mocks
npm run typecheck
npm run build && npm start
```

The test suite needs no API keys: `test/mock-mistral.ts` emulates the Mistral
batch endpoint and realtime WebSocket, `test/mock-gladia.ts` the Gladia
upload/pre-recorded/live surface (`npm run mock:gladia` to run it standalone
on :9098 with `GLADIA_API_KEY=any GLADIA_BASE_URL=http://127.0.0.1:9098`).

## Known limitations

- Realtime (Mistral): language is auto-detected (no hint parameter upstream);
  `diarize` is batch-only. The Gladia realtime endpoint accepts language
  hints and vocabulary if you need them live.
- Gladia bulk: `sentiment_analysis`, `moderation`, translation and
  `audio_to_llm` add-ons are not exposed yet (easy to add in
  `src/gladia/transcribe.ts` if needed); the demo page only exercises the
  Mistral endpoints.
- Bulk: `timestamps` cannot be combined with `language` (current Mistral
  limitation).
- `@mistralai/mistralai` is pinned to exactly `2.2.5`: the published SDK does
  not expose `target_streaming_delay_ms` yet, so the server sends that
  `session.update` frame itself (`src/mistral.ts`). Revisit on SDK updates.
- The batch SSE streaming variant is not exposed (bulk responses return in one
  shot).
