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

test("rejects language combined with timestamps", async () => {
  const res = await app.request("/v1/transcribe", {
    method: "POST",
    headers: authHeader,
    body: audioForm({ language: "fr", timestamps: "segment" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /language/);
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
