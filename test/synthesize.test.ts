import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Hono } from "hono";
import { createApp } from "../src/http.ts";
import { createMistralClients } from "../src/mistral.ts";
import { SPEECH_FIXTURE_BYTES, startMockMistral, type MockMistral } from "./mock-mistral.ts";
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
  return createApp(config, { batch, activeSessions: () => 0 });
}

const authHeader = { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" };

function speak(body: unknown, headers = authHeader): Promise<Response> {
  return Promise.resolve(
    app.request("/v1/speak", { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

before(async () => {
  mock = await startMockMistral();
  app = buildApp();
});

after(async () => {
  await mock.close();
});

test("rejects missing token", async () => {
  const res = await app.request("/v1/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello" }),
  });
  assert.equal(res.status, 401);
});

test("streams raw audio bytes by default", async () => {
  const res = await speak({ input: "hello world" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/pcm");
  // PCM is headerless, so the consumer needs these to play it back.
  assert.equal(res.headers.get("x-sample-rate"), "24000");
  assert.equal(res.headers.get("x-audio-encoding"), "pcm_s16le");
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(bytes, SPEECH_FIXTURE_BYTES);
});

test("non-streaming returns the whole clip in one body", async () => {
  const res = await speak({ input: "hello", stream: false });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/pcm");
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(bytes, SPEECH_FIXTURE_BYTES);
});

test("format maps to the right content type", async () => {
  const res = await speak({ input: "hello", format: "mp3" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  // mp3 is self-describing — no PCM hint headers.
  assert.equal(res.headers.get("x-sample-rate"), null);
});

test("rejects empty input", async () => {
  const res = await speak({ input: "   " });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "bad_request");
  assert.match(body.error.message, /input/);
});

test("rejects input over the character cap", async () => {
  const small = buildApp("mock-api-key", { maxTtsChars: 5 });
  const res = await small.request("/v1/speak", {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({ input: "way too long" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /exceeds/);
});

test("rejects an unknown format", async () => {
  const res = await speak({ input: "hello", format: "aac" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /format/);
});

test("maps upstream 401 to 502 upstream_auth", async () => {
  const badKey = buildApp("bad-key");
  const res = await badKey.request("/v1/speak", {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({ input: "hello" }),
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.code, "upstream_auth");
});

test("stream failing before any audio returns a JSON error, not an empty 200", async () => {
  const dying = buildApp("key-stream-error");
  const res = await dying.request("/v1/speak", {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({ input: "hello" }),
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.code, "upstream_error");
});

test("passes through upstream 400", async () => {
  const key400 = buildApp("key-400");
  const res = await key400.request("/v1/speak", {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({ input: "hello" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "bad_request");
});
