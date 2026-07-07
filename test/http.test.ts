import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hono } from "hono";
import { createApp } from "../src/http.ts";
import { createMistralClients } from "../src/mistral.ts";
import { makeConfig } from "./helpers.ts";

// Whatever goes wrong, clients must always get the JSON error envelope —
// plain-text bodies (Hono's defaults) fail silently in apps that parse JSON.

function buildApp(): Hono {
  const config = makeConfig();
  const { batch } = createMistralClients(config);
  return createApp(config, { batch, activeSessions: () => 0 });
}

test("unknown routes return the JSON error envelope", async () => {
  const app = buildApp();
  const res = await app.request("/no/such/route");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "not_found");
  assert.match(body.error.message, /GET \/no\/such\/route/);
});

test("uncaught handler exceptions return the JSON error envelope", async () => {
  const app = buildApp();
  app.get("/boom", () => {
    throw new Error("boom");
  });
  const res = await app.request("/boom");
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error.code, "internal_error");
  // The exception text stays in the server log; clients get a generic message.
  assert.doesNotMatch(body.error.message, /boom/);
});
