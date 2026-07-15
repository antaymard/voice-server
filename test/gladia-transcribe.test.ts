import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Hono } from "hono";
import { createApp } from "../src/http.ts";
import { createGladiaClient } from "../src/gladia/client.ts";
import { createMistralClients } from "../src/mistral.ts";
import { GLADIA_RESULT_FIXTURE, GLADIA_SUMMARY_FIXTURE, startMockGladia, type MockGladia } from "./mock-gladia.ts";
import { makeConfig, TEST_TOKEN } from "./helpers.ts";

let mock: MockGladia;
let app: Hono;

function buildApp(gladiaApiKey = "mock-gladia-key", overrides = {}): Hono {
  const config = makeConfig({
    gladiaApiKey,
    gladiaBaseUrl: mock.httpUrl,
    ...overrides,
  });
  const { batch } = createMistralClients(config);
  const gladia = config.gladiaApiKey ? createGladiaClient(config) : null;
  return createApp(config, { batch, gladia, activeSessions: () => 0 });
}

function audioForm(extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(2048)], { type: "audio/wav" }), "test.wav");
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return form;
}

const authHeader = { authorization: `Bearer ${TEST_TOKEN}` };
const jsonHeaders = { ...authHeader, "content-type": "application/json" };

before(async () => {
  mock = await startMockGladia();
  app = buildApp();
});

after(async () => {
  await mock.close();
});

test("returns 503 not_configured when GLADIA_API_KEY is missing", async () => {
  const disabled = buildApp("");
  const post = await disabled.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ audio_url: "https://example.com/a.mp3" }),
  });
  assert.equal(post.status, 503);
  assert.equal((await post.json()).error.code, "not_configured");

  const get = await disabled.request("/v1/gladia/transcribe/some-id", { headers: authHeader });
  assert.equal(get.status, 503);
});

test("requires auth like the other /v1 routes", async () => {
  const res = await app.request("/v1/gladia/transcribe", { method: "POST", body: audioForm() });
  assert.equal(res.status, 401);
});

test("multipart upload: uploads to Gladia, polls until done, returns transcript", async () => {
  const uploadsBefore = mock.uploadCount();
  const res = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm({
      vocabulary: "Solaria, Voxtral",
      vocabulary_intensity: "0.6",
      context: "Réunion produit hebdomadaire",
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "done");
  assert.equal(body.text, GLADIA_RESULT_FIXTURE.transcription.full_transcript);
  assert.deepEqual(body.languages, ["fr"]);
  assert.equal(body.utterances.length, 1);
  assert.equal(body.metadata.audio_duration, 4.2);
  assert.equal(mock.uploadCount(), uploadsBefore + 1);

  const init = mock.initBodies.at(-1)!;
  assert.match(String(init["audio_url"]), /\/file\/mock-upload-/);
  assert.equal(init["model"], "solaria-1");
  assert.equal(init["custom_vocabulary"], true);
  assert.deepEqual(init["custom_vocabulary_config"], {
    vocabulary: ["Solaria", "Voxtral"],
    default_intensity: 0.6,
  });
  assert.equal(init["context_prompt"], "Réunion produit hebdomadaire");
});

test("JSON body: rich vocabulary, diarization and summary map to Gladia options", async () => {
  const res = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      audio_url: "https://example.com/meeting.mp3",
      language: "fr",
      vocabulary: [
        "Solaria",
        { value: "Salesforce", pronunciations: ["sell force"], intensity: 0.5, language: "en" },
      ],
      diarization: true,
      min_speakers: 2,
      max_speakers: 4,
      summarize: "bullet_points",
      sentences: true,
      subtitles: ["srt"],
      spelling: { SQL: ["sequel"] },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, GLADIA_RESULT_FIXTURE.transcription.full_transcript);
  assert.deepEqual(body.summarization, GLADIA_SUMMARY_FIXTURE);

  const init = mock.initBodies.at(-1)!;
  assert.equal(init["audio_url"], "https://example.com/meeting.mp3");
  assert.deepEqual(init["language_config"], { languages: ["fr"], code_switching: false });
  assert.deepEqual(init["custom_vocabulary_config"], {
    vocabulary: [
      "Solaria",
      { value: "Salesforce", pronunciations: ["sell force"], intensity: 0.5, language: "en" },
    ],
  });
  assert.equal(init["diarization"], true);
  assert.deepEqual(init["diarization_config"], { min_speakers: 2, max_speakers: 4 });
  assert.equal(init["summarization"], true);
  assert.deepEqual(init["summarization_config"], { type: "bullet_points" });
  assert.equal(init["sentences"], true);
  assert.deepEqual(init["subtitles_config"], { formats: ["srt"] });
  assert.deepEqual(init["custom_spelling_config"], { spelling_dictionary: { SQL: ["sequel"] } });
});

test("model defaults to config.gladiaBulkModel and omits language_config when no language given", async () => {
  const res = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ audio_url: "https://example.com/a.mp3" }),
  });
  assert.equal(res.status, 200);
  const init = mock.initBodies.at(-1)!;
  assert.equal(init["model"], "solaria-1");
  assert.equal(init["language_config"], undefined);
});

test("model=solaria-3 with a supported single language succeeds", async () => {
  const res = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ audio_url: "https://example.com/a.mp3", model: "solaria-3", language: "fr" }),
  });
  assert.equal(res.status, 200);
  const init = mock.initBodies.at(-1)!;
  assert.equal(init["model"], "solaria-3");
  assert.deepEqual(init["language_config"], { languages: ["fr"], code_switching: false });
});

test("model=solaria-3 without a language is rejected", async () => {
  const res = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ audio_url: "https://example.com/a.mp3", model: "solaria-3" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /requires a single `language`/);
});

test("model=solaria-3 with code_switching is rejected", async () => {
  const res = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      audio_url: "https://example.com/a.mp3",
      model: "solaria-3",
      language: "fr",
      code_switching: true,
    }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /does not support `code_switching`/);
});

test("model=solaria-3 with an unsupported language is rejected", async () => {
  const res = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ audio_url: "https://example.com/a.mp3", model: "solaria-3", language: "ja" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /only supports language one of/);
});

test("per-request model overrides the server default", async () => {
  const solariaOneApp = buildApp("mock-gladia-key", { gladiaBulkModel: "solaria-3" });
  const res = await solariaOneApp.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ audio_url: "https://example.com/a.mp3", model: "solaria-1" }),
  });
  assert.equal(res.status, 200);
  const init = mock.initBodies.at(-1)!;
  assert.equal(init["model"], "solaria-1");
});

test("rejects an invalid model value with 400", async () => {
  const res = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ audio_url: "https://example.com/a.mp3", model: "solaria-2" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Invalid `model`/);
});

test("wait=false returns 202 immediately; GET polls the job to completion", async () => {
  const res = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ audio_url: "https://example.com/long.mp3", wait: false }),
  });
  assert.equal(res.status, 202);
  const { id, status } = await res.json();
  assert.equal(status, "queued");
  assert.ok(id);

  const first = await app.request(`/v1/gladia/transcribe/${id}`, { headers: authHeader });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, "processing");

  const second = await app.request(`/v1/gladia/transcribe/${id}`, { headers: authHeader });
  const body = await second.json();
  assert.equal(body.status, "done");
  assert.equal(body.text, GLADIA_RESULT_FIXTURE.transcription.full_transcript);
});

test("GET with unknown id returns 404", async () => {
  const res = await app.request("/v1/gladia/transcribe/nope", { headers: authHeader });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "not_found");
});

test("requires exactly one of file / audio_url", async () => {
  const neither = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(neither.status, 400);

  const both = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm({ audio_url: "https://example.com/a.mp3" }),
  });
  assert.equal(both.status, 400);
});

test("rejects invalid options with 400", async () => {
  const badVocab = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ audio_url: "https://example.com/a.mp3", vocabulary: [{ intensity: 2 }] }),
  });
  assert.equal(badVocab.status, 400);

  const badIntensity = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      audio_url: "https://example.com/a.mp3",
      vocabulary: ["ok"],
      vocabulary_intensity: 3,
    }),
  });
  assert.equal(badIntensity.status, 400);

  const badSummary = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ audio_url: "https://example.com/a.mp3", summarize: "haiku" }),
  });
  assert.equal(badSummary.status, 400);

  const badSubtitles = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm({ subtitles: "ass" }),
  });
  assert.equal(badSubtitles.status, 400);
});

test("maps upstream 401 to 502 upstream_auth", async () => {
  const badKeyApp = buildApp("bad-key");
  const res = await badKeyApp.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm(),
  });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "upstream_auth");
});

test("failed Gladia job surfaces as 502 transcription_failed", async () => {
  const res = await app.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ audio_url: "https://example.com/fail.mp3" }),
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.code, "transcription_failed");
});

test("polling that exceeds the timeout returns 504 with the job id", async () => {
  const impatient = buildApp("mock-gladia-key", { gladiaPollTimeoutMs: 50, gladiaPollIntervalMs: 10 });
  const res = await impatient.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ audio_url: "https://example.com/slow.mp3" }),
  });
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.equal(body.error.code, "poll_timeout");
  assert.match(body.error.message, /\/v1\/gladia\/transcribe\/mock-job-/);
});

test("rejects oversized uploads with 413", async () => {
  const small = buildApp("mock-gladia-key", { maxUploadBytes: 1024 });
  const res = await small.request("/v1/gladia/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm(), // 2048-byte file
  });
  assert.equal(res.status, 413);
});
