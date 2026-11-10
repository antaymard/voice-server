# voice-server

Minimal speech-to-text backend for React apps, powered by the
[Mistral Voxtral 3](https://docs.mistral.ai/studio/audio/overview) API,
with optional [Gladia](https://docs.gladia.io)-backed alternatives.

> **Upgrading a client app from Voxtral 2?** Read
> [`docs/voxtral-3.md`](docs/voxtral-3.md): what changed, what's new, and
> what (little) you need to touch.

- **Realtime**: browser streams mic audio over a WebSocket, the server bridges
  it to Mistral's realtime transcription and streams text deltas back
  (80 ms–2.4 s latency, tunable). Voxtral 3 adds **turn detection** (know when
  the user stopped talking), live **speaker labels**, a language pin and
  vocabulary biasing.
- **Bulk**: upload a complete audio file (or pass a URL), get the transcript
  back as JSON — speaker labels, **known-speaker references**, vocabulary
  biasing, and an optional higher-quality model (Voxtral Small Transcribe 3).
- **Text to speech**: POST text, stream back raw audio (Voxtral TTS 3),
  latency-tuned (`pcm` streaming for the fastest time-to-first-audio), with
  inline **emotion/pace tags**, an expressiveness dial, custom pronunciation
  and conversation-aware delivery. `GET /v1/voices` lists the 36 preset voices.
- **Live conversation** (`/v1/converse`): talk to a model that answers out
  loud and **acts while you speak** — Voxtral listens and speaks, and the
  model in between is **any chat-completions LLM**, swappable per
  conversation. Interruptible, starts thinking before you finish, and its
  tools run in your app. See [Live conversation](#live-conversation-websocket--get-v1converse).
- **Fast decisions** (`/v1/decide`, opt-in via `OPENROUTER_API_KEY`): ask a
  "System One" decision model (Jev, Liquid d1, Perplexity Decider, …) typed
  questions about a state — yes/no, one of several choices, a score — and
  get probabilities back in tens of milliseconds. The live conversation uses
  it for its own judgment calls.
- **Gladia alternatives** (`/v1/gladia/*`, opt-in via `GLADIA_API_KEY`):
  live and bulk STT with business vocabulary biasing, context prompts,
  speaker-count-aware diarization, summaries/chapters/subtitles, and async
  jobs with callbacks. Mistral endpoints are untouched — apps migrate (or
  not) one call site at a time.
- **Long-file preparation** (`/v1/media/audio-parts`, opt-in via
  `MEDIA_ALLOWED_SOURCE_HOSTS`): extracts the audio track of a long
  recording (audio or video, up to hours), re-encodes it to light mono mp3/ogg
  and splits it into ~20 min parts cut in silences, so a 25 MB-capped STT
  can transcribe it part by part. Pure media processing (ffmpeg) — no STT.
- One server token for your backends, short-lived scoped **session tokens**
  for browsers (`/v1/tokens`), and an origin allowlist; your
  `MISTRAL_API_KEY`/`GLADIA_API_KEY` never leave the server.
- Ships a copyable **React kit** (`client/`) — mic capture worklet,
  `useRealtimeTranscription` hook, `transcribeFile`, `synthesizeSpeech` and
  `listVoices` helpers — and a built-in demo page.

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

## API overview

Everything the server exposes, in one place. Each line links to its details.

**HTTP** — JSON in, JSON out unless noted.

| Endpoint | What it does | Needs |
|---|---|---|
| [`POST /v1/transcribe`](#post-v1transcribe--bulk-transcription) | Transcribe a complete audio file or URL (speaker labels, vocabulary biasing) | — |
| [`POST /v1/speak`](#post-v1speak--text-to-speech) | Text to speech; the response body is the raw audio, streamed | — |
| [`GET /v1/voices`](#get-v1voices--list-tts-voices) | List the voices `/v1/speak` and `/v1/converse` can use | — |
| [`POST /v1/decide`](#post-v1decide--fast-typed-decisions) | Ask a decision model typed questions (yes/no, choice, score) about a state | `OPENROUTER_API_KEY` |
| [`POST /v1/gladia/transcribe`](#post-v1gladiatranscribe--bulk-transcription-gladia) | Bulk transcription through Gladia (summaries, subtitles, async jobs) | `GLADIA_API_KEY` |
| [`GET /v1/gladia/transcribe/:id`](#get-v1gladiatranscribeid--poll-an-async-job) | Poll an async Gladia job | `GLADIA_API_KEY` |
| [`POST /v1/media/audio-parts`](#post-v1mediaaudio-parts--prepare-a-long-file-for-transcription) | Start a job that extracts and splits a long recording into STT-sized parts | `MEDIA_ALLOWED_SOURCE_HOSTS` |
| `GET /v1/media/audio-parts/:id` | Job status and the list of parts | same |
| `GET /v1/media/audio-parts/:id/parts/:index` | Download one part (audio bytes) | same |
| `DELETE /v1/media/audio-parts/:id` | Cancel a job and delete its files | same |
| [`POST /v1/tokens`](#post-v1tokens--session-tokens-for-browsers) | Mint a short-lived, scoped token for a browser (server token only) | — |
| [`GET /healthz`](#get-healthz) | Liveness and counters; no auth | — |
| `GET /`, `/converse.html` | Demo pages (transcription, live conversation); static and public | — |

**WebSocket** — the client sends one JSON `start` frame, then binary
frames of mic audio (PCM s16le mono); the server answers with JSON events.

| Endpoint | What it does | Needs |
|---|---|---|
| [`/v1/realtime`](#realtime-websocket--get-v1realtime) | Live transcription: text deltas, turn detection, speaker labels | — |
| [`/v1/converse`](#live-conversation-websocket--get-v1converse) | Live voice conversation: the server listens, has an LLM decide and call your tools, and sends the spoken reply back as binary audio | — (`OPENROUTER_API_KEY` adds fast decisions and OpenRouter models) |
| [`/v1/gladia/realtime`](#gladia-realtime-websocket--get-v1gladiarealtime) | Live transcription through Gladia | `GLADIA_API_KEY` |

**Rules that apply everywhere**

- **Auth**: HTTP sends `Authorization: Bearer <token>`; WebSockets pass it as
  `?token=<token>` (browsers can't set headers on a WebSocket). The token is
  either the server's `AUTH_TOKEN` — for your backends only: it never expires
  and opens everything — or a [session token](#post-v1tokens--session-tokens-for-browsers)
  your backend mints for a browser: one hour, limited to the features you name.
- **Origins**: a browser request must come from an origin listed in
  `ALLOWED_ORIGINS` (the server's own pages always pass). Requests without
  an `Origin` header (servers, curl, native apps) rely on the token alone.
- **Errors**: HTTP errors are always `{ "error": { "code", "message" } }`.
  A WebSocket sends `{ "type": "error", "code", "message" }` and then closes;
  close codes `1000`, `1001` and `4400` mean "don't reconnect".
- **Disabled features** answer `503` (HTTP) or refuse the upgrade with `503`
  (WebSocket) until their variable in the "Needs" column is set.
- **Types**: the wire formats of the WebSocket endpoints are TypeScript files
  you can copy into an app — [`client/src/protocol.ts`](client/src/protocol.ts)
  (`/v1/realtime`), [`client/src/converseProtocol.ts`](client/src/converseProtocol.ts)
  (`/v1/converse`), [`client/src/gladiaProtocol.ts`](client/src/gladiaProtocol.ts).

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
| `model` | no | override `BATCH_MODEL`, e.g. `voxtral-small-transcribe-3-0` for higher quality |
| `language` | no | ISO 639-1, e.g. `fr`; omit to auto-detect |
| `timestamps` | no | `segment` (word timestamps no longer exist in Voxtral 3 → `400`) |
| `diarize` | no | `true` to label speakers (implies `timestamps=segment`) |
| `context_bias` | no | repeatable; names, multi-word terms, or a one-line description of the recording |
| `speaker_reference.<Name>` | no | audio file of a known speaker (3–15 s, mostly speech, WAV best; up to 8). `<Name>` becomes their `speaker_id`. Implies `diarize` |

Or `application/json`: `{ "file_url", "model?", "language?", "timestamp_granularities?": ["segment"], "diarize?", "context_bias?": [], "speaker_references?": { "Alice": "<base64 audio>" } }`.

```bash
curl -X POST https://your-server/v1/transcribe \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -F file=@meeting.mp3 \
  -F diarize=true \
  -F speaker_reference.Alice=@alice.wav \
  -F "context_bias=Voxtral" -F "context_bias=Weekly product sync of a French startup"
# -> { "model": "voxtral-mini-transcribe-3-0", "text": "…", "language": null,
#      "segments": [ { "type": "transcription_segment", "text": " Bonjour…", "start": 0.4,
#                      "end": 3.1, "speakerId": "Alice" }, … ], "usage": {...} }
```

Responses are passed through from Mistral. Diarized segments **can overlap**
(two people talking at once); speakers without a reference are labelled
`speaker_1`, `speaker_2`… (stable within one response only). Vocabulary
entries share the model's context window with the audio: keep the list short
on long recordings (too long → `400` from Mistral). Uploads above
`MAX_UPLOAD_BYTES` get `413`; upstream auth problems surface as `502
upstream_auth` (it's the server's key, not yours).

### `POST /v1/tokens` — session tokens for browsers

A browser needs a token to open a WebSocket here, and whatever reaches a
browser can be copied out of it. So don't hand it `AUTH_TOKEN`: have your
backend mint a session token for the signed-in user and pass that along.
Only `AUTH_TOKEN` can call this endpoint.

| Field | Required | Notes |
|---|---|---|
| `scopes` | yes | what the token may use: `stt` (`/v1/transcribe`, `/v1/realtime`, `/v1/gladia/*`), `tts` (`/v1/speak`, `/v1/voices`), `converse`, `decide`, `media` |
| `subject` | no | who it is for (your user id); written to the server log when a WebSocket opens |
| `ttl_seconds` | no | lifetime, default and maximum `SESSION_TOKEN_MAX_TTL_SEC` (one hour) |

```bash
curl -X POST https://your-server/v1/tokens \
  -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{ "scopes": ["stt"], "subject": "user_42" }'
# -> { "token": "vs_s_eyJzdWIi…", "expires_at": "2026-11-10T14:00:00.000Z",
#      "scopes": ["stt"], "subject": "user_42" }
```

The browser uses `token` exactly where `AUTH_TOKEN` went. Outside its scopes
it gets `403 forbidden`; once expired, `401 token_expired` (a WebSocket
upgrade is refused with `401`): ask your backend for a new one. Expiry is
checked when a connection opens, so a session in progress is not cut.

Tokens are signed with a key derived from `AUTH_TOKEN`, not stored: they
survive restarts, a single one cannot be revoked before it expires, and
rotating `AUTH_TOKEN` invalidates them all.

### `POST /v1/decide` — fast typed decisions

Relays to [OpenRouter's Decisions API](https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README.md)
(requires `OPENROUTER_API_KEY`; otherwise `503 decide_disabled`). The model
doesn't write text: it answers each question with a typed value and its
probability. `application/json` body:

| Field | Required | Notes |
|---|---|---|
| `state` | yes | what the questions are about: a string or any JSON |
| `questions` | yes | object of questions, keyed by the name you want the answer under |
| `model` | no | any OpenRouter decision model; default `DECIDER_MODEL` |

Question types: `noul` (yes/no; `criteria: { true, false }` says what each
means), `choice` (`criteria: { <option>: <when to pick it> }`), `score`
(`criteria: [<lowest>, …, <highest>]`). Each takes optional `instructions`.

```bash
curl -X POST https://your-server/v1/decide \
  -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{ "state": { "user_said": "je voudrais que tu" },
        "questions": { "finished": { "type": "noul", "instructions": "Has the user finished their sentence?" } } }'
# -> { "answers": { "finished": { "type": "noul", "noul": 0.04, "confidence": 0.93 } },
#      "model": "typesafe/jev-1.13", "provider": "TypeSafe", "usage": {...}, "latencyMs": 112 }
```

`noul` is the probability of "yes". `latencyMs` is the round trip seen from
the server, handy to compare models. A question the model declines comes
back as `{ "type": "refusal" }`.

### `POST /v1/speak` — text to speech

Powered by Mistral's [Voxtral TTS](https://docs.mistral.ai/studio-api/audio/text_to_speech).
`application/json` body:

| Field | Required | Default | Notes |
|---|---|---|---|
| `input` | yes | — | text to synthesize (≤ `MAX_TTS_CHARS`), may contain emotion/pace tags (below) |
| `format` | no | `pcm` | `pcm`, `wav`, `mp3`, `flac` or `opus` |
| `voice` | no | `TTS_VOICE` | preset or saved voice id (see `GET /v1/voices`); omit for the Mistral default |
| `ref_audio` | no | — | base64 audio for one-off zero-shot voice cloning |
| `model` | no | `TTS_MODEL` | override the synthesis model |
| `stream` | no | `true` | stream audio as it is generated (lowest latency) |
| `expressiveness` | no | Mistral's | 1.0–5.0: stronger emotional delivery, at the cost of similarity to the voice |
| `phoneme_hints` | no | — | custom pronunciation: `{ "tomato": ["t","ə","m","ɑ","t","oʊ"] }` — one IPA symbol per item; unknown symbols → `400` listing the supported ones |
| `conversation_history` | no | — | prior turns, oldest first, alternating and ending with `user`: `[{ "role": "user", "audio": "<b64>" }, { "role": "assistant", "text": "…", "audio": "<b64>" }, …]` — the reply's tone fits the conversation. Needs a Voxtral 3 preset `voice`; not with `ref_audio` |

**Emotion and pace tags** (Voxtral 3) go inline in `input`, before the text
they apply to, and are not spoken: `"[emotion=happy]We passed the audit!
[emotion=calm][pace=slow]Now, the details."` — 34 emotions (`amused`,
`angry`, `anxious`, `apologetic`, `appreciative`, `assertive`, `bored`,
`calm`, `confident`, `confused`, `critical`, `curious`, `determined`,
`disappointed`, `disgusted`, `excited`, `frustrated`, `grateful`, `happy`,
`hopeful`, `playful`, `proud`, `reflective`, `resigned`, `sad`, `sarcastic`,
`skeptical`, `somber`, `surprised`, `tense`, `tired`, `urgent`, `warm`,
`wistful`) and 5 paces (`very-slow`, `slow`, `moderate`, `fast`,
`very-fast`). Documented for English, expected to work in fr/de/es/it/pt/hi;
unknown values are silently ignored. Voxtral 2 per-emotion presets (e.g.
`gb_jane_sad`) still work. The request body is capped at `MAX_UPLOAD_BYTES`
(it may carry base64 audio).

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

### `GET /v1/voices` — list TTS voices

Mistral's preset voices plus the voices saved in the server's Mistral
workspace. Query parameters (all optional): `type` (`all` | `preset` |
`custom`), `language` (comma list, e.g. `fr,en`), `gender` (`female`,
`male`, `neutral`), `query` (free text), `page_size` (1–100), `page_token`.

```bash
curl "https://your-server/v1/voices?type=preset&language=fr" -H "Authorization: Bearer $AUTH_TOKEN"
# -> { "voices": [ { "id": "voice_592", "name": "Marie", "slug": null, "type": "preset",
#                    "languages": ["fr"], "gender": "female", "description": null, "tags": [] }, … ],
#      "nextPageToken": null }
```

Pass a voice's `id` as `voice` to `/v1/speak`. Voxtral 3 ships 36 presets
across 22 languages (French: Marie `voice_592`, Manon `voice_3137`, Lea
`voice_589`, Camille `voice_3141`).

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

### `POST /v1/media/audio-parts` — prepare a long file for transcription

Media processing only: **no STT call, no provider key, no storage write**. The
server downloads a public file, extracts its audio track (audio *or* video
sources: m4a/AAC, webm/opus, mp4, mov, …), re-encodes it to mono 16 kHz
(what Whisper-style models consume anyway) and splits it into parts of about
`part_seconds`, cutting in silences when one is found within ±60 s of the
target (hard cut otherwise). The caller transcribes each part with its own
STT, shifts the timestamps by the part's `start_sec`, and concatenates.

Disabled (`503 media_disabled`) unless `MEDIA_ALLOWED_SOURCE_HOSTS` is set and
`ffmpeg`/`ffprobe` are on `PATH` (the Docker image ships them). Jobs are
async, in the style of the Gladia `wait=false` flow:

| Route | Result |
|---|---|
| `POST /v1/media/audio-parts` | `202 { "job_id", "status": "queued" }` |
| `GET /v1/media/audio-parts/:id` | job state + the parts ready so far |
| `GET /v1/media/audio-parts/:id/parts/:index` | the part's bytes (streamed, exact `Content-Length`, `Cache-Control: no-store`) |
| `DELETE /v1/media/audio-parts/:id` | `204`, always (idempotent): cancels (kills ffmpeg, aborts the download) and deletes the files |

Request body (`application/json`):

| Field | Default | Constraints |
|---|---|---|
| `source_url` | — (required) | `https:` only; host must be in `MEDIA_ALLOWED_SOURCE_HOSTS` (SSRF guard); redirects are refused |
| `part_seconds` | `1200` | integer, 300–3600: target part length |
| `format` | `"mp3"` | `"mp3"` (libmp3lame 32 kbit/s, `audio/mpeg`, ≈14 MB/h — accepted by every Whisper provider) or `"ogg"` (libopus 24 kbit/s, `audio/ogg`, ≈11 MB/h) |

Errors on `POST`: `400 bad_request` (bad JSON/field), `403
source_not_allowed`, `429 busy` (`MEDIA_MAX_CONCURRENT_JOBS` jobs already
queued or running — there is no queue, retry later), `503 media_disabled`.

```bash
curl -X POST https://your-server/v1/media/audio-parts \
  -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{ "source_url": "https://files.example.com/u123/interview.m4a" }'
# -> 202 { "job_id": "3f0c…", "status": "queued" }

curl https://your-server/v1/media/audio-parts/3f0c… -H "Authorization: Bearer $AUTH_TOKEN"
# -> { "job_id": "3f0c…", "status": "splitting", "duration_sec": 25211.84,
#      "has_video": false, "total_parts": 21,
#      "parts": [ { "index": 0, "start_sec": 0, "end_sec": 1193.42, "duration_sec": 1193.42,
#                   "bytes": 4773680, "content_type": "audio/mpeg" } ],
#      "error": null, "created_at": "…", "expires_at": "…" }

curl -o part-0.mp3 https://your-server/v1/media/audio-parts/3f0c…/parts/0 \
  -H "Authorization: Bearer $AUTH_TOKEN"
curl -X DELETE https://your-server/v1/media/audio-parts/3f0c… -H "Authorization: Bearer $AUTH_TOKEN"
```

`status` goes `queued` → `downloading` → `probing` → `analyzing` →
`splitting` → `done` (or `error`). Rules the caller can rely on:

- `duration_sec`, `has_video` (true for real video tracks, not album art) and
  `total_parts` are `null` until known; `total_parts` is set from `splitting`.
- `parts` only lists parts fully written to disk, sorted by `index`, and grows
  during `splitting`: start transcribing part 0 while the rest is produced.
  A part not ready yet answers `404` on download.
- `parts[0].start_sec === 0`, `parts[i].start_sec === parts[i-1].end_sec`,
  indexes are consecutive from 0, and the last `end_sec` equals
  `duration_sec`. All seconds are floats rounded to the millisecond; a part's
  `duration_sec` is `end_sec - start_sec` (the computed cut, which is what
  timestamp shifting needs).
- `error` is non-null only when `status === "error"`:
  `{ "code", "message" }` with `code` one of `source_fetch_failed` (non-2xx,
  network error, redirect), `source_too_large`, `unreadable_media`,
  `no_audio_stream`, `too_long`, `ffmpeg_failed` (message ends with ffmpeg's
  stderr), `part_too_large` (>24 MB — a misconfiguration guard),
  `cancelled`, `internal_error`. The files of a failed job are deleted
  immediately; the job itself stays readable until `expires_at`.
- Jobs expire `MEDIA_JOB_TTL_MS` after creation (files + state purged every
  minute). Call `DELETE` when you are done, success or failure; the TTL is
  only a safety net. Unknown/expired ids give `404 not_found`.

**Single replica only.** Jobs live in process memory and their files on the
container's local disk, so every call for a job must reach the same instance
(Railway's default single replica). Scaling out would need shared storage.
The work dir is purged at startup: jobs in flight during a redeploy are lost
(`404`), and the caller should retry.

### `GET /healthz`

No auth. `{ "ok": true, "uptime": 123, "activeSessions": 0, "media": { "enabled": true, "activeJobs": 0 } }`.

### `GET /`

Demo page (mic realtime + file upload). Static and public; API calls made from
it still need the token. `/converse.html` is the live-conversation demo.

## Realtime WebSocket — `GET /v1/realtime`

Connect to `wss://your-server/v1/realtime?token=<AUTH_TOKEN>` (browsers can't
set headers on WebSockets; non-browser clients may use the `Authorization`
header instead). If an `Origin` header is present it must be allowlisted.

Client → server:

1. First frame (text): `{"type":"start","sampleRate":16000,"targetDelayMs":480}`
   — `sampleRate` ∈ {8000, 16000, 22050, 44100, 48000}; `targetDelayMs`
   80–1200 or 2400 (lower = faster, higher = more accurate; out-of-range
   values are clamped, values between 1200 and 2400 snap to the nearest).
   Optional Voxtral 3 fields, all applied before any audio (Mistral locks
   them once audio starts):

   | Field | Type | Meaning |
   |---|---|---|
   | `language` | string | ISO 639-1 pin, e.g. `"fr"`; omit to auto-detect |
   | `contextBias` | string[] | names, terms or a short description, to fix spellings |
   | `diarize` | bool | speaker labels: `segment` events replace `delta` events |
   | `speakerReferences` | `{ name: base64 }` | known speakers (3–15 s clips, ≤ 8; keep the frame under 1 MiB — prefer Opus/MP3). Implies `diarize` |
   | `turnDetection` | `true` \| object | emit `turn` events. Object = tuning: `startThreshold` (0.5), `eagerEndThreshold` (0.5), `endThreshold` (0.33), `minSilenceMs` (500), `endTimeoutMs` (3000). "Aggressive" preset (ends turns sooner): `0.5 / 0.4 / 0.33 / 300 / 2500` |

   `diarize` and `turnDetection` cannot be combined. Invalid options get an
   `error` (`bad_message`) and close `4400`, before anything is sent upstream.
2. Binary frames: raw **PCM s16le mono** at the declared rate (~100 ms per
   frame recommended; max 1 MiB per frame).
3. `{"type":"flush"}` (optional): transcribe what is buffered now. On
   Voxtral 3 this **finalizes the session** (a `done` event follows and the
   socket closes), like `stop`.
4. `{"type":"stop"}`: finalize — remaining deltas and `done` follow, then the
   socket closes normally.

Server → client (JSON text frames):

| Event | Payload | Meaning |
|---|---|---|
| `ready` | `requestId, model, sampleRate, targetDelayMs, language, diarize, turnDetection` | session is live, send audio (echoes the applied settings) |
| `delta` | `text` | committed transcript text (append-only); not sent when diarizing |
| `segment` | `text, start, end, speakerId` | diarized text, labelled `speaker_1`… or a reference name; `start`/`end` are `null` in realtime |
| `turn` | `phase, time, endReason?` | turn detection: `phase` ∈ `start`, `eager_end` (probably done — start only discardable work), `resume` (cancels the eager end), `end` (final; `endReason` = `threshold` \| `timeout`). `time` = seconds into the stream |
| `language` | `language` | detected language (`fr`, `en`, …) |
| `done` | `text, language, segments[], usage` | final transcript, then close `1000` |
| `error` | `code, message` | see codes below, then close |

Error codes: `bad_message`, `idle_timeout`, `session_too_long`,
`upstream_error`, `backpressure`, `server_shutdown`, `server_error`.

Close codes: `1000` done · `1001` server shutdown · `1009` frame too large ·
`1011` internal · `4400` protocol violation · `4408` idle timeout · `4413` max
session duration · `4502` upstream failure.

Notes: deltas can still arrive after a `turn.end`; wait for `turn` `end`
(not `eager_end`) before anything irreversible. The server pings every 30 s; sessions are capped
by `MAX_SESSION_MS` (a graceful finalize is attempted first) and reaped after
`IDLE_TIMEOUT_MS` without client frames.

## Live conversation WebSocket — `GET /v1/converse`

A voice loop built from three replaceable parts: Voxtral realtime
transcription (with turn detection) → an LLM that decides and calls tools →
Voxtral TTS, sentence by sentence. Connect to
`wss://your-server/v1/converse?token=<AUTH_TOKEN>`; types and validation
live in [`client/src/converseProtocol.ts`](client/src/converseProtocol.ts),
and [`public/converse.js`](public/converse.js) is a complete plain-JS client
(mic, gapless playback, tools).

What the server does for you:

- **Thinks ahead.** On `eager_end` (the user has probably finished) the reply
  starts being prepared, but nothing is sent until `end` confirms the turn;
  if the user resumes, the work is thrown away.
- **Acts while the user speaks.** In the middle of a sentence, the model is
  shown what has been said so far (at each clause, or every ten words) and
  may already call the tools you declared `immediate` — "turn the page red,
  and then…": the page is red before the sentence ends. Tools declared
  `speculative` (read-only) can also run then, and during the "probably
  finished" phase. Everything else waits for the turn to be final. What was
  done early is handed to the reply, so nothing runs twice.
- **Can be interrupted — without headphones.** When the user speaks over the
  assistant, generation and speech stop, and the model's memory keeps only
  what was actually heard. A turn that starts while the assistant is audible
  only counts once it carries words that aren't the assistant's own: its voice
  leaking back through the mic, a cough or a door slam don't cut it off.
  (Keep the browser's `echoCancellation` on as the first line of defense.)
- **Decides fast.** With a decision model configured (`OPENROUTER_API_KEY`),
  three judgment calls go to it instead of a rule of thumb: whether speech
  over the assistant is an interruption, a mere "yes, ok" (it keeps talking)
  or its own echo; whether the user, at a pause, has finished — judged on the
  recent exchange, the whole turn and its last segment: a sentence left
  hanging keeps the turn open up to 1.2 s instead of being answered
  half-said, and a clearly finished one is answered at once, without waiting
  out the pause; and whether there is
  already something to act on mid-sentence (the LLM is only woken then, and
  the check runs every two words instead of at each clause). If the model is
  slow (`DECIDER_TIMEOUT_MS`) or fails, the rules of thumb take over.
- **Speaks as it writes.** The reply's text is streamed into Voxtral's
  realtime speech WebSocket word by word, so audio can start before the first
  sentence is finished. If that connection fails, the server falls back to
  one speech request per sentence.
- **Hears from your app.** An `event` message brings in what happens outside
  the conversation (a long-running agent finishing, a question to relay);
  the assistant speaks up about it when the moment is right.
- **Doesn't block on slow tools.** A call that outlives `toolTimeoutMs` (or an
  interruption) keeps running in your app; the model says it's in progress,
  and reports the result when your `tool_result` arrives.

**Client → server**

1. A `start` text frame — every field optional:

   | Field | Default | Notes |
   |---|---|---|
   | `sampleRate`, `targetDelayMs`, `language`, `contextBias`, `turnDetection` | as `/v1/realtime` | transcription settings (turn detection is always on) |
   | `instructions` | — | system prompt (the server adds "you are speaking: no markdown, be brief") |
   | `tools` | `[]` | `[{ name, description?, parameters? (JSON Schema), speculative?, immediate? }]`, max 32. `speculative`: read-only, may run before the turn is final and be cancelled. `immediate`: has effects, may run mid-sentence and is never undone — keep it for actions that are cheap to correct |
   | `actEarly` | `true` | consult the model mid-sentence (extra LLM calls: a few per long sentence; none without `immediate`/`speculative` tools) |
   | `history` | `[]` | `[{ role: "user" \| "assistant", content }]` to resume a conversation |
   | `provider`, `model` | server default | which LLM to use; must be allowed by the server (see below) |
   | `voice` | `TTS_VOICE` | voice id for the replies |
   | `bargeIn` | `true` | let the user interrupt by speaking. `false` ignores the mic entirely while the assistant speaks |
   | `speculate` | `true` | prepare the reply on `eager_end` |
   | `decide` | `true` | use the server's decision model for the judgment calls above (`false`: rules of thumb) |
   | `toolTimeoutMs` | `15000` | how long a response waits for a `tool_result` |

2. Binary frames of mic audio (PCM s16le mono, as `/v1/realtime`).
3. Optional text frames: `{ "type": "tool_result", "callId", "output", "isError?" }`,
   `{ "type": "text", "text" }` (a typed user message),
   `{ "type": "event", "text", "speak?" }` (something happened in your app, see below),
   `{ "type": "interrupt" }` (a "stop talking" button), `{ "type": "stop" }`.

**App events.** `event` tells the assistant something the user did not say:
a background job progressed or finished, another agent has a question, the
user selected something. The text joins the conversation marked as coming
from the app. `speak` sets what the assistant may do with it: `"when_idle"`
(default) — tell the user as soon as nobody is talking, or stay silent if
it judges the news not worth saying; `"now"` — same, but it cuts its own
speech short to do so (never the user's); `"never"` — background
information only, used in later replies, with no LLM call now.

**Server → client** — JSON text frames, plus **binary frames of the
assistant's speech** (PCM s16le mono 24 kHz, see `ready.audio`):

| Event | Fields | Meaning |
|---|---|---|
| `ready` | `requestId, sttModel, ttsModel, llmProvider, llmModel, deciderModel, audio` | start sending audio (`deciderModel` is `null` without a decision model) |
| `transcript` | `text` | live transcript of the user, append-only |
| `turn` | `phase` | `start` / `eager_end` / `resume` / `end` |
| `user_turn` | `text` | the finished turn, as given to the model |
| `response_start` | `responseId` | binary frames that follow belong to this response |
| `assistant_delta` | `responseId, text` | reply text (arrives ahead of its audio) |
| `tool_call` | `responseId, callId, name, arguments, speculative, early` | run it, answer with `tool_result`. `arguments` is a JSON string written by the model: validate it. `early`: decided mid-sentence (`responseId` is then `null`) |
| `tool_cancel` | `callId` | a speculative call is no longer needed |
| `response_done` | `responseId, text` | the reply is complete |
| `interrupt` | `responseId, heardText` | **stop playback and drop queued audio** |
| `response_error` | `responseId, code, message` | `llm_error` / `tts_error`; the session goes on |
| `error` | `code, message` | fatal, same codes as `/v1/realtime`, then close |

**Choosing the LLM.** Any endpoint that speaks the OpenAI chat-completions
protocol with streaming and tool calls works. The default is Mistral
(`mistral-small-latest`, with your `MISTRAL_API_KEY`).

A voice conversation needs a fast first word more than depth, hence a small
direct model by default (measured here: about 0.1 s to the first word with
`mistral-small-latest`, about 0.75 s with Claude Haiku 5.5 through
OpenRouter). To try another model, `OPENROUTER_API_KEY` adds an `openrouter`
provider: `LLM_MODEL=openrouter:<vendor>/<model>` makes one the default, or
list some in `LLM_MODELS` and let apps pick per conversation.

To swap or add other endpoints:

```bash
# Change the default endpoint/model
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=...
LLM_MODEL=llama-3.3-70b-versatile

# Or keep Mistral as default and add named providers apps can pick per conversation
LLM_PROVIDER_GROQ_BASE_URL=https://api.groq.com/openai/v1
LLM_PROVIDER_GROQ_API_KEY=...
LLM_MODELS=mistral-large-latest,groq:llama-3.3-70b-versatile   # or * for any
```

A client then sends `{ "type": "start", "provider": "groq", "model": "llama-3.3-70b-versatile" }`.
Models outside `LLM_MODELS` are refused (close `4400`), so a leaked app token
can't run up a bill on your most expensive model.

Speech in and out go through two small interfaces as well (`Tts` in
`src/converse/tts.ts`, `Llm` in `src/converse/llm.ts`); the orchestration is
in `src/converse/session.ts`. Listening reuses the transcription connection of
`/v1/realtime` (`src/realtime/upstream.ts`).

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
| `ALLOWED_ORIGINS` | yes | — | comma-separated origins of your apps; `*` disables the check (dev only). The server's own demo pages are always allowed |
| `SESSION_TOKEN_MAX_TTL_SEC` | no | `3600` | longest lifetime `/v1/tokens` grants a session token |
| `PORT` | no | `3000` | injected by Railway |
| `BATCH_MODEL` | no | `voxtral-mini-transcribe-3-0` | bulk transcription model (`voxtral-small-transcribe-3-0` = higher quality) |
| `REALTIME_MODEL` | no | `voxtral-mini-transcribe-realtime-3-0` | realtime model |
| `TTS_MODEL` | no | `voxtral-mini-tts-3-0` | text-to-speech model |
| `TTS_VOICE` | no | — | default voice id (empty = Mistral's default) |
| `TTS_FORMAT` | no | `pcm` | default output format when the request omits one |
| `MAX_TTS_CHARS` | no | `8000` | max characters per `/v1/speak` request |
| `MAX_UPLOAD_BYTES` | no | `26214400` (25 MB) | bulk upload cap (also caps `/v1/speak` bodies) |
| `MAX_SESSIONS` | no | `20` | concurrent realtime sessions |
| `MAX_SESSION_MS` | no | `600000` (10 min) | per-session duration cap |
| `IDLE_TIMEOUT_MS` | no | `60000` | close sessions with no client frames |
| `DEFAULT_TARGET_DELAY_MS` | no | `480` | default latency/accuracy tradeoff (80–1200 or 2400) |
| `MISTRAL_BASE_URL` | no | `https://api.mistral.ai` | upstream override (tests/mock) |
| `MISTRAL_WS_URL` | no | `wss://api.mistral.ai` | upstream override (tests/mock) |
| `LLM_BASE_URL` | no | Mistral (`…/v1`) | `/v1/converse`: default chat-completions endpoint |
| `LLM_API_KEY` | no | `MISTRAL_API_KEY` | key for that endpoint |
| `OPENROUTER_API_KEY` | no | — | enables `/v1/decide` and the conversation's fast decisions; adds the `openrouter` LLM provider (not the default: see `LLM_MODEL`) |
| `LLM_MODEL` | no | `mistral-small-latest` | default conversation model: `model` or `provider:model` (e.g. `openrouter:anthropic/claude-haiku-5.5`) |
| `LLM_PROVIDER_<NAME>_BASE_URL` / `_API_KEY` | no | — | extra named LLM endpoints |
| `LLM_MODELS` | no | — | models clients may pick: `model` or `provider:model`, comma-separated; `*` = any |
| `DECIDER_MODEL` | no | `typesafe/jev-1.13` | decision model for `/v1/decide` and the conversation (any OpenRouter decision model) |
| `DECIDER_API_KEY` | no | `OPENROUTER_API_KEY` | key for the decision service; empty disables it |
| `DECIDER_URL` | no | OpenRouter Decisions API | decision service endpoint |
| `DECIDER_TIMEOUT_MS` | no | `400` | how long a conversation waits for a decision before using its rule of thumb |
| `CONVERSE_TTS` | no | `realtime` | how `/v1/converse` speaks: `realtime` (text streamed into Mistral's speech WebSocket, falls back to `http` on failure) or `http` (one request per sentence) |
| `TTS_PCM_ENCODING` | no | `auto` | sample type of Mistral's raw `pcm` output for `/v1/converse`: `auto` (detected), `s16le` or `f32le` |
| `CONVERSE_SETTLE_MS` | no | `150` | after a turn ends, wait for late transcript text before answering |
| `GLADIA_API_KEY` | no | — | enables `/v1/gladia/*`; empty = those endpoints answer 503 |
| `GLADIA_BULK_MODEL` | no | `solaria-1` | bulk model: `solaria-1` (clean/quiet, 100+ langs) or `solaria-3` (noisy, single language) |
| `GLADIA_LIVE_MODEL` | no | — | live model override (empty = Gladia's default, solaria-1 — the only model live supports) |
| `GLADIA_REGION` | no | — | live session region: `eu-west` or `us-west` (empty = Gladia default) |
| `GLADIA_POLL_INTERVAL_MS` | no | `1000` | bulk: cadence of result polling |
| `GLADIA_POLL_TIMEOUT_MS` | no | `300000` (5 min) | bulk: max wait before `504 poll_timeout` |
| `GLADIA_BASE_URL` | no | `https://api.gladia.io` | upstream override (tests/mock) |
| `MEDIA_ALLOWED_SOURCE_HOSTS` | no | — | comma-separated hosts `source_url` may use (e.g. your R2 public host `files.example.com`); empty = `/v1/media/*` answer 503 |
| `MEDIA_WORK_DIR` | no | `<os tmpdir>/media-jobs` | per-job scratch dirs (purged at startup) |
| `MEDIA_MAX_SOURCE_BYTES` | no | `629145600` (600 MB) | max source size (checked on `Content-Length` and while streaming) |
| `MEDIA_MAX_DURATION_SEC` | no | `28800` (8 h) | max source duration |
| `MEDIA_MAX_CONCURRENT_JOBS` | no | `2` | active jobs (queued or running); beyond → `429 busy` |
| `MEDIA_JOB_TTL_MS` | no | `3600000` (1 h) | job lifetime (state + files) |
| `MEDIA_FFMPEG_TIMEOUT_MS` | no | `900000` (15 min) | timeout of each ffmpeg/ffprobe run (SIGKILL) |
| `MEDIA_SILENCE_NOISE_DB` | no | `-35` | silence threshold in dB (negative integer) |
| `MEDIA_SILENCE_MIN_SEC` | no | `0.4` | minimum silence length, in seconds |
| `MEDIA_SILENCE_WINDOW_SEC` | no | `60` | half-width of the window searched for a silence around each target cut |
| `MEDIA_MIN_LAST_PART_SEC` | no | `30` | a shorter trailing part is merged into the previous one |

## Deploying to Railway

1. Push this repo to GitHub and create a Railway service from it — the
   `Dockerfile` is picked up automatically (`railway.json` wires the
   `/healthz` healthcheck).
2. Set `MISTRAL_API_KEY`, `AUTH_TOKEN` and `ALLOWED_ORIGINS` in the service
   variables. Railway injects `PORT`.
3. Deploy; WebSockets work through Railway's proxy out of the box.
4. In each React app, set the server URL + token and use the kit.
5. Optional, for `/v1/media/audio-parts`: set `MEDIA_ALLOWED_SOURCE_HOSTS`
   to the host of your public file storage (e.g. the host of `R2_PUBLIC_URL`).
   The image already contains ffmpeg. Keep a **single replica**, give the
   service at least 1 vCPU / 1 GB RAM, and count on ephemeral disk for
   `MEDIA_MAX_CONCURRENT_JOBS × (source + parts)` — about 1.5 GB worst case
   with the defaults. If ffmpeg were missing, the server still boots (live STT
   is unaffected) and logs a warning; `/healthz` reports `media.enabled`.

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
npm test           # protocol + auth + batch + full WS bridges against the mocks,
                   # plus media e2e (skipped when ffmpeg is not installed)
npm run typecheck
npm run build && npm start
```

CI (`.github/workflows/ci.yml`) runs the typecheck, the build, the tests
(with ffmpeg, so the media end-to-end tests run) and a Docker image build on
every push.

The test suite needs no API keys: `test/mock-mistral.ts` emulates the Mistral
batch endpoint and realtime WebSocket, `test/mock-gladia.ts` the Gladia
upload/pre-recorded/live surface (`npm run mock:gladia` to run it standalone
on :9098 with `GLADIA_API_KEY=any GLADIA_BASE_URL=http://127.0.0.1:9098`).

## Known limitations

- Voxtral 3 is in **public preview** at Mistral. To roll back, set
  `BATCH_MODEL=voxtral-mini-2602`, `REALTIME_MODEL=voxtral-mini-transcribe-realtime-2602`,
  `TTS_MODEL=voxtral-mini-tts-2603` (the Voxtral 3–only options then fail upstream).
- Realtime (Mistral): `diarize` and `turnDetection` are mutually exclusive
  (Mistral limitation); realtime segments carry no timestamps.
- Live conversation is a first version: no React hook yet (use
  `public/converse.js` as the reference client). Interrupting waits for the
  first transcribed word, so it lags by about `targetDelayMs`; a short
  interjection made only of words the assistant just said ("oui" over a
  reply containing "oui") is taken for echo and ignored. "What was heard" is
  estimated from audio timing (the speech API has no timestamps). Each
  sentence is its own speech generation, so intonation doesn't carry across
  sentences.
- Not exposed yet: Voxtral TTS Realtime 3 (`voxtral-mini-tts-realtime-3-0`,
  a live-conversation speech stream), TTS style instructions (not available
  at Mistral's launch), and Mistral's managed Voice Agents.
- Gladia bulk: `sentiment_analysis`, `moderation`, translation and
  `audio_to_llm` add-ons are not exposed yet (easy to add in
  `src/gladia/transcribe.ts` if needed); the demo page only exercises the
  Mistral endpoints.
- `@mistralai/mistralai` is pinned to exactly `3.3.0`: its realtime client
  only sets the audio format and doesn't model turn events, so the server
  sends the full `session.update` frame itself and reads `turn.*` events raw
  (`src/mistral.ts`, `src/realtime/upstream.ts`). Revisit on SDK updates.
- The batch SSE streaming variant is not exposed (bulk responses return in one
  shot).
