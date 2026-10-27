import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Hono } from "hono";
import { createApp } from "../src/http.ts";
import { createMistralClients } from "../src/mistral.ts";
import { BATCH_FIXTURE, startMockMistral, type MockMistral } from "./mock-mistral.ts";
import { makeConfig, TEST_TOKEN } from "./helpers.ts";

let mock: MockMistral;
let app: Hono;

function buildApp(apiKey = "mock-api-key", overrides = {}): Hono {
  const config = makeConfig({
    mistralApiKey: apiKey,
    mistralBaseUrl: mock.httpUrl,
    mistralWsUrl: mock.wsUrl,
    ...overrides,
  });
  const { batch } = createMistralClients(config);
  return createApp(config, { batch, gladia: null, activeSessions: () => 0 });
}

function audioForm(extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(2048)], { type: "audio/wav" }), "test.wav");
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return form;
}

const authHeader = { authorization: `Bearer ${TEST_TOKEN}` };

before(async () => {
  mock = await startMockMistral();
  app = buildApp();
});

after(async () => {
  await mock.close();
});

test("healthz responds without auth", async () => {
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.activeSessions, "number");
});

test("rejects missing and invalid tokens", async () => {
  const noAuth = await app.request("/v1/transcribe", { method: "POST", body: audioForm() });
  assert.equal(noAuth.status, 401);
  const badAuth = await app.request("/v1/transcribe", {
    method: "POST",
    headers: { authorization: "Bearer wrong" },
    body: audioForm(),
  });
  assert.equal(badAuth.status, 401);
});

test("transcribes a multipart upload", async () => {
  const res = await app.request("/v1/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm(),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, BATCH_FIXTURE.text);
  assert.equal(body.language, BATCH_FIXTURE.language);
});

test("transcribes from a JSON file_url", async () => {
  const res = await app.request("/v1/transcribe", {
    method: "POST",
    headers: { ...authHeader, "content-type": "application/json" },
    body: JSON.stringify({ file_url: "https://example.com/audio.mp3" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, BATCH_FIXTURE.text);
});

test("requires exactly one of file / file_url", async () => {
  const neither = await app.request("/v1/transcribe", {
    method: "POST",
    headers: { ...authHeader, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(neither.status, 400);

  const both = await app.request("/v1/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm({ file_url: "https://example.com/audio.mp3" }),
  });
  assert.equal(both.status, 400);
});

test("defaults to Voxtral Mini Transcribe 3 and forwards language with timestamps", async () => {
  const res = await app.request("/v1/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm({ language: "fr", timestamps: "segment" }),
  });
  assert.equal(res.status, 200);
  const sent = mock.received.transcription!;
  assert.deepEqual(sent["model"], ["voxtral-mini-transcribe-3-0"]);
  assert.deepEqual(sent["language"], ["fr"]);
  assert.deepEqual(sent["timestamp_granularities"], ["segment"]);
});

test("per-request model override (e.g. Voxtral Small Transcribe 3)", async () => {
  const res = await app.request("/v1/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm({ model: "voxtral-small-transcribe-3-0" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(mock.received.transcription!["model"], ["voxtral-small-transcribe-3-0"]);
  const body = await res.json();
  assert.equal(body.model, "voxtral-small-transcribe-3-0");
});

test("word timestamps are rejected with a Voxtral 3 hint", async () => {
  const res = await app.request("/v1/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm({ timestamps: "segment,word" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /Voxtral 3.*segment/);
});

test("diarize implies segment timestamps", async () => {
  const res = await app.request("/v1/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm({ diarize: "true" }),
  });
  assert.equal(res.status, 200);
  const sent = mock.received.transcription!;
  assert.deepEqual(sent["diarize"], ["true"]);
  assert.deepEqual(sent["timestamp_granularities"], ["segment"]);
});

test("speaker reference files are forwarded as named references and imply diarize", async () => {
  const form = audioForm();
  form.append("speaker_reference.Alice", new Blob([new Uint8Array(16).fill(65)]), "alice.wav");
  const res = await app.request("/v1/transcribe", { method: "POST", headers: authHeader, body: form });
  assert.equal(res.status, 200);
  const sent = mock.received.transcription!;
  assert.deepEqual(sent["diarize"], ["true"]);
  // The SDK serializes the map as JSON in a single multipart field.
  const refs = JSON.parse(sent["speaker_references"]![0]!) as Record<string, string>;
  assert.equal(refs["Alice"], Buffer.alloc(16, 65).toString("base64"));
});

test("JSON speaker_references are validated", async () => {
  const tooMany = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, "QUFB"]));
  for (const [refs, pattern] of [
    [tooMany, /At most 8/],
    [{ Alice: 42 }, /base64 audio strings/],
    [["QUFB"], /base64 audio strings/],
  ] as const) {
    const res = await app.request("/v1/transcribe", {
      method: "POST",
      headers: { ...authHeader, "content-type": "application/json" },
      body: JSON.stringify({ file_url: "https://example.com/a.mp3", speaker_references: refs }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, pattern);
  }
});

test("rejects invalid timestamps values", async () => {
  const res = await app.request("/v1/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm({ timestamps: "sentence" }),
  });
  assert.equal(res.status, 400);
});

test("maps upstream 401 to 502 upstream_auth", async () => {
  const badKeyApp = buildApp("bad-key");
  const res = await badKeyApp.request("/v1/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm(),
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.code, "upstream_auth");
});

test("passes through upstream 400", async () => {
  const key400App = buildApp("key-400");
  const res = await key400App.request("/v1/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm(),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "bad_request");
});

test("rejects oversized uploads with 413", async () => {
  const smallApp = buildApp("mock-api-key", { maxUploadBytes: 1024 });
  const res = await smallApp.request("/v1/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm(), // 2048-byte file
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error.code, "payload_too_large");
});

test("CORS: disallowed origin gets no allow-origin header, allowed origin does", async () => {
  const corsApp = buildApp("mock-api-key", { allowedOrigins: ["https://app.example.com"] });
  const allowed = await corsApp.request("/v1/transcribe", {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example.com",
      "access-control-request-method": "POST",
    },
  });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example.com");

  const denied = await corsApp.request("/v1/transcribe", {
    method: "OPTIONS",
    headers: {
      origin: "https://evil.example.com",
      "access-control-request-method": "POST",
    },
  });
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});
