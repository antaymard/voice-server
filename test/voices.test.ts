import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Hono } from "hono";
import { createApp } from "../src/http.ts";
import { createMistralClients } from "../src/mistral.ts";
import { startMockMistral, type MockMistral } from "./mock-mistral.ts";
import { makeConfig, TEST_TOKEN } from "./helpers.ts";

let mock: MockMistral;
let app: Hono;

function buildApp(apiKey = "mock-api-key"): Hono {
  const config = makeConfig({
    mistralApiKey: apiKey,
    mistralBaseUrl: mock.httpUrl,
    mistralWsUrl: mock.wsUrl,
  });
  const { batch } = createMistralClients(config);
  return createApp(config, { batch, gladia: null, activeSessions: () => 0 });
}

const authHeader = { authorization: `Bearer ${TEST_TOKEN}` };

before(async () => {
  mock = await startMockMistral();
  app = buildApp();
});

after(async () => {
  await mock.close();
});

test("requires the token", async () => {
  const res = await app.request("/v1/voices");
  assert.equal(res.status, 401);
});

test("lists voices with filters forwarded upstream", async () => {
  const res = await app.request(
    "/v1/voices?type=preset&language=fr&gender=female&query=Marie&page_size=10",
    { headers: authHeader },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    voices: [
      {
        id: "voice_592",
        name: "Marie",
        slug: null,
        type: "preset",
        languages: ["fr"],
        gender: "female",
        description: null,
        tags: [],
      },
    ],
    nextPageToken: null,
  });
  const query = new URLSearchParams(mock.received.voicesQuery ?? "");
  assert.equal(query.get("type"), "preset");
  assert.equal(query.get("language"), "fr");
  assert.equal(query.get("gender"), "female");
  assert.equal(query.get("query"), "Marie");
  assert.equal(query.get("page_size"), "10");
});

test("rejects invalid filters with 400", async () => {
  for (const qs of ["type=robot", "gender=other", "page_size=0", "page_size=abc"]) {
    const res = await app.request(`/v1/voices?${qs}`, { headers: authHeader });
    assert.equal(res.status, 400, qs);
    const body = await res.json();
    assert.equal(body.error.code, "bad_request");
  }
});

test("maps upstream 401 to 502 upstream_auth", async () => {
  const res = await buildApp("bad-key").request("/v1/voices", { headers: authHeader });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.code, "upstream_auth");
});
