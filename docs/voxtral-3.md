# Voxtral 3 — upgrade guide for client apps

voice-server now runs on **Mistral Voxtral 3** (released 2026-10-20, public
preview at Mistral). This page is for developers of the apps that call
voice-server: what changed under you, what you must check, and the new
features you can opt into.

**TL;DR:** most apps need no change. If you request **word timestamps**, or
your TypeScript reads `segment.start`/`end` as always-numbers, see
[Breaking changes](#breaking-changes). Everything else is opt-in.

| | Before (Voxtral 2) | Now (Voxtral 3) |
|---|---|---|
| Bulk transcription | `voxtral-mini-latest` | `voxtral-mini-transcribe-3-0` (or `voxtral-small-transcribe-3-0` per request) |
| Realtime transcription | `voxtral-mini-transcribe-realtime-2602` | `voxtral-mini-transcribe-realtime-3-0` |
| Text to speech | `voxtral-mini-tts-2603` | `voxtral-mini-tts-3-0` |

Endpoints, auth, error envelope and close codes are unchanged.

---

## Breaking changes

### 1. Word timestamps are gone (bulk)

Voxtral 3 only returns **segment** timestamps. `timestamps=word` (or
`segment,word`) now gets:

```json
400 { "error": { "code": "bad_request", "message": "Word timestamps are not available with Voxtral 3 (use \"segment\")" } }
```

**Fix:** request `timestamps=segment`. In the React kit, `timestamps` is now
typed `"segment"[]`, so the compiler points at affected calls.

### 2. Segment shape in the React kit (`TranscriptSegment`)

If you copied `client/src/` into your app, refresh the copy. The type
changed:

```ts
// before
type TranscriptSegment = { text: string; start: number; end: number };
// now
type TranscriptSegment = { text: string; start: number | null; end: number | null; speakerId: string | null };
```

`start`/`end` are `null` for **realtime** segments (Voxtral 3 sends no
timestamps live). Bulk segments (`transcribeFile`) still always have numbers.

### 3. Diarized segments can overlap (bulk)

When two people talk at once, Voxtral 3 returns both segments with
overlapping time ranges. If your UI assumes a strict timeline (e.g. one
caption at a time), handle overlaps instead of dropping one.

### 4. Realtime delay range

`targetDelayMs` now accepts **80–1200 ms, or 2400 ms** (was 240–2400).
Values between 1200 and 2400 snap to the nearest of the two. If you used
e.g. `1000`, nothing changes; `1500` now becomes `1200`.

### 5. Re-check transcripts, voices and latency

New models produce different (better on average) output. Before shipping,
re-run a few real recordings, listen to your TTS voices, and re-measure
latency from your app. Voxtral 2 voice ids (e.g. `gb_jane_neutral`,
`gb_jane_sad`) still work.

### Relaxed, not broken

- `language` can now be combined with `timestamps` in bulk requests:
  voice-server no longer rejects it upfront. If Mistral refuses a
  combination, you get its `400 bad_request` message verbatim.
- `diarize=true` alone is enough: voice-server adds the segment timestamps
  Voxtral 3 requires for diarization.
- `/v1/speak` bodies are now capped at `MAX_UPLOAD_BYTES` (25 MB by default),
  since they can carry base64 audio. Normal text requests are far below it.

---

## New features

### Speech to text — bulk (`POST /v1/transcribe`, `transcribeFile`)

**Pick the bigger model when quality matters.** Voxtral Small Transcribe 3 is
slower and slightly pricier, but more accurate. Try it when `context_bias`
alone doesn't fix the errors:

```ts
await transcribeFile(file, { serverUrl, token, model: "voxtral-small-transcribe-3-0" });
```

**Name known speakers.** Give up to 8 short clips (3–15 s, mostly speech,
WAV is best) and their names replace `speaker_1`, `speaker_2`… in the
segments. Unknown voices still get numbered labels.

```ts
const result = await transcribeFile(meeting, {
  serverUrl, token,
  speakerReferences: { Alice: aliceClip, Bob: bobClip }, // Blobs; implies diarize
});
// result.segments -> [{ text: " On commence ?", start: 0.4, end: 1.6, speakerId: "Alice" }, …]
```

```bash
curl -X POST https://your-server/v1/transcribe -H "Authorization: Bearer $AUTH_TOKEN" \
  -F file=@meeting.mp3 -F speaker_reference.Alice=@alice.wav -F speaker_reference.Bob=@bob.wav
```

**Better vocabulary biasing.** `context_bias` entries can now be multi-word
names ("Alder Creek Design") or a one-line description of the recording
("Weekly product sync of a French SaaS startup"). Put every term that must be
spelled exactly as its own entry; the description helps with the overall
topic. Keep the list short on long files: it shares the model's context
window with the audio.

**More languages, auto-detected.** Omit `language` to let the model detect
it; pin it when you know it.

### Speech to text — realtime (`/v1/realtime`, `useRealtimeTranscription`)

All of these are set when the session starts and **locked once audio
begins** (that's Mistral's rule). To change them, stop and start a new
session.

**Turn detection: know when the user has finished speaking.** This is the
building block for voice assistants and hands-free forms.

```tsx
const voice = useRealtimeTranscription({
  serverUrl, token,
  turnDetection: true, // Mistral defaults; or TURN_DETECTION_PRESETS.aggressive
  onTurn: (turn) => {
    switch (turn.phase) {
      case "start":     showListening(); break;
      case "eager_end": prefetchAnswer(); break; // probably done: only start work you can discard
      case "resume":    cancelPrefetch(); break; // false alarm, the user kept talking
      case "end":       submit(voice.text); break; // final: safe for irreversible actions
    }
  },
});
```

Events on the wire: `{ "type": "turn", "phase": "start" | "eager_end" | "resume" | "end", "time": 3.42, "endReason"?: "threshold" | "timeout" }`
(`time` = seconds into the stream). Eager ends are frequent; only `end` is
final, and a few transcript deltas can still arrive just after it.

Tuning (all optional, defaults shown): `startThreshold` 0.5,
`eagerEndThreshold` 0.5, `endThreshold` 0.33, `minSilenceMs` 500,
`endTimeoutMs` 3000. To end turns sooner use the `aggressive` preset
(0.5 / 0.4 / 0.33 / 300 / 2500). Change one value at a time and test with
real users' recordings.

**Live speaker labels.** `diarize: true` (or `speakerReferences` with base64
clips — keep them small, e.g. Opus/MP3, the start frame is capped at 1 MiB)
makes the server send speaker-labelled `segment` events instead of `delta`
events:

```json
{ "type": "segment", "text": " Bonjour à tous", "start": null, "end": null, "speakerId": "speaker_1" }
```

The hook collects them in `segments` and mirrors their text into `text`.
**Diarization and turn detection can't be combined** in one session.

**Language pin and vocabulary, live.** `language: "fr"` and
`contextBias: ["Nolênor", "Voxtral"]` now work in realtime too (Voxtral 2
could only auto-detect).

**Lower latency floor.** `targetDelayMs` can go down to 80 ms (less accurate);
480 ms remains the recommended default.

The `ready` event now echoes the applied settings:
`{ "type": "ready", …, "language": "fr" | null, "diarize": false, "turnDetection": true }`.

Invalid options (e.g. `diarize` + `turnDetection`, a 3-letter language code,
inconsistent thresholds) end the session immediately with an `error`
(`bad_message`) and close code `4400`, which the hook does **not**
auto-reconnect on.

### Text to speech (`POST /v1/speak`, `synthesizeSpeech`)

**Emotion and pace tags, inline.** Put tags in the text, before the part they
apply to; they are not spoken and last until the next tag:

```ts
await synthesizeSpeech(
  "[emotion=excited]C'est livré ! [emotion=calm][pace=slow]Voici le détail de la commande.",
  { serverUrl, token, voice: "voice_592", format: "mp3" },
);
```

- 34 emotions: amused, angry, anxious, apologetic, appreciative, assertive,
  bored, calm, confident, confused, critical, curious, determined,
  disappointed, disgusted, excited, frustrated, grateful, happy, hopeful,
  playful, proud, reflective, resigned, sad, sarcastic, skeptical, somber,
  surprised, tense, tired, urgent, warm, wistful.
- 5 paces: very-slow, slow, moderate, fast, very-fast.
- One emotion and one pace tag can be combined (`[emotion=calm][pace=slow]`).
- Documented for English; expected to work in French, German, Spanish,
  Italian, Portuguese and Hindi. Unknown values are silently ignored, so
  check your spelling by ear.

**Expressiveness.** `expressiveness: 1.0–5.0` — higher gives a stronger
delivery but drifts further from the original voice.

**Custom pronunciation.** Fix how a word is said with IPA phonemes, one symbol
per item. Send the hints on every request that contains the word.

```ts
await synthesizeSpeech("I say tomato.", {
  serverUrl, token,
  phonemeHints: { tomato: ["t", "ə", "m", "ɑ", "t", "oʊ"] },
});
```

Use `ɹ` (not `r`) for the English r and plain `g`; write diphthongs and
affricates (`oʊ`, `tʃ`, `dʒ`) as single items; no stress or length marks.
An unknown symbol gets a `400` whose message lists every supported one.

**Conversation-aware delivery (voice agents).** Pass the previous turns —
what the user said and what your assistant said, as base64 audio — and the
reply's tone fits the conversation:

```ts
await synthesizeSpeech(replyText, {
  serverUrl, token,
  voice: "voice_592", // must be a Voxtral 3 preset
  conversationHistory: [
    { role: "user", audio: userTurn1 },
    { role: "assistant", text: "Bien sûr, je regarde.", audio: assistantTurn1 },
    { role: "user", audio: userTurn2 }, // must end with the user
  ],
});
```

Turns must alternate and end with a `user` turn. Not combinable with
`refAudio`.

**36 new preset voices, discoverable.** `GET /v1/voices` (or `listVoices` in
the kit) lists presets and the workspace's saved voices, filterable by
`type`, `language`, `gender` and free-text `query`:

```ts
const { voices } = await listVoices({ serverUrl, token, type: "preset", language: ["fr"] });
// French presets: Marie voice_592, Manon voice_3137, Lea voice_589, Camille voice_3141
```

Pass the `id` as `voice`. Voice cloning from a one-off clip (`refAudio`)
works as before.

---

## Not available yet

- **Realtime TTS** (`voxtral-mini-tts-realtime-3-0`, a live speech stream for
  conversations) and **TTS style instructions** (announced, not live at
  Mistral's launch).
- **Mistral Voice Agents** (Mistral's managed STT → LLM → TTS pipeline) —
  voice-server stays a building block; the turn detection + conversation
  history features above are what you need to build one yourself.

Ask the voice-server maintainer if you need one of these.

## Checklist

1. Search your app for `"word"` in transcription timestamps → use `"segment"`.
2. Refresh your copy of `client/src/` and fix any type errors around
   `TranscriptSegment` (`start`/`end` nullable, new `speakerId`).
3. If you diarize, make sure overlapping segments render sensibly.
4. Listen to your TTS voices and re-test a few real recordings.
5. Re-measure latency from your app (and try `targetDelayMs` below 240 if
   speed matters more than accuracy).
6. Opt into what helps: turn detection for voice UIs, speaker references
   for meetings, emotion tags for TTS.
