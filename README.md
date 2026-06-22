# voice-server

Minimal speech-to-text backend for React apps, powered by the
[Mistral (Voxtral)](https://docs.mistral.ai/studio-api/audio/speech_to_text) API.

- **Realtime**: browser streams mic audio over a WebSocket, the server bridges
  it to Mistral's realtime transcription and streams text deltas back
  (sub-second latency, tunable).
- **Bulk**: upload a complete audio file (or pass a URL), get the transcript
  back as JSON.
- One shared token for all your apps + an origin allowlist; your
  `MISTRAL_API_KEY` never leaves the server.
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
Errors use a uniform envelope: `{ "error": { "code", "message" } }`.

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

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `MISTRAL_API_KEY` | yes | — | Mistral API key (server-side only) |
| `AUTH_TOKEN` | yes | — | shared bearer token for your apps (use `openssl rand -hex 32`) |
| `ALLOWED_ORIGINS` | yes | — | comma-separated origins; `*` disables the check (dev only) |
| `PORT` | no | `3000` | injected by Railway |
| `BATCH_MODEL` | no | `voxtral-mini-latest` | bulk transcription model |
| `REALTIME_MODEL` | no | `voxtral-mini-transcribe-realtime-2602` | realtime model |
| `MAX_UPLOAD_BYTES` | no | `26214400` (25 MB) | bulk upload cap |
| `MAX_SESSIONS` | no | `20` | concurrent realtime sessions |
| `MAX_SESSION_MS` | no | `600000` (10 min) | per-session duration cap |
| `IDLE_TIMEOUT_MS` | no | `60000` | close sessions with no client frames |
| `DEFAULT_TARGET_DELAY_MS` | no | `480` | default latency/accuracy tradeoff |
| `MISTRAL_BASE_URL` | no | `https://api.mistral.ai` | upstream override (tests/mock) |
| `MISTRAL_WS_URL` | no | `wss://api.mistral.ai` | upstream override (tests/mock) |

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
> - `npm error … Could not read package.json … /app/package.json` — the
>   container is being launched with an `npm` command (e.g. a **Custom Start
>   Command** in the service settings that overrides the Dockerfile `CMD`).
>   Either clear that custom start command so the image's `CMD`
>   (`node dist/src/index.js`) runs, or keep `npm start` — the image ships
>   `package.json` so both work.

## Development

```bash
npm run dev        # watch mode, reads .env
npm test           # protocol + auth + batch + full WS bridge against the mock
npm run typecheck
npm run build && npm start
```

The test suite needs no Mistral key: `test/mock-mistral.ts` emulates both the
batch endpoint and the realtime WebSocket.

## Known limitations

- Realtime: language is auto-detected (no hint parameter upstream);
  `diarize` is batch-only.
- Bulk: `timestamps` cannot be combined with `language` (current Mistral
  limitation).
- `@mistralai/mistralai` is pinned to exactly `2.2.5`: the published SDK does
  not expose `target_streaming_delay_ms` yet, so the server sends that
  `session.update` frame itself (`src/mistral.ts`). Revisit on SDK updates.
- The batch SSE streaming variant is not exposed (bulk responses return in one
  shot).
