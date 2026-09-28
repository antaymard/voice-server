import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { Hono } from "hono";
import type { Config } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { createMediaJobs, type MediaJobs, type MediaJobsDeps } from "../src/media/jobs.ts";
import { createMistralClients } from "../src/mistral.ts";
import { makeConfig, TEST_TOKEN } from "./helpers.ts";

const authHeader = { authorization: `Bearer ${TEST_TOKEN}` };
const jsonHeaders = { ...authHeader, "content-type": "application/json" };
const created: MediaJobs[] = [];

/** A fetch that never answers until aborted: keeps jobs in `downloading`. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

function buildApp(
  overrides: Partial<Config> = {},
  deps: MediaJobsDeps = { binariesAvailable: true, fetch: hangingFetch },
): { app: Hono; media: MediaJobs } {
  const config = makeConfig({ mediaAllowedSourceHosts: ["files.example.com"], ...overrides });
  const { batch } = createMistralClients(config);
  const media = createMediaJobs(config, deps);
  created.push(media);
  return { app: createApp(config, { batch, gladia: null, activeSessions: () => 0, media }), media };
}

function post(app: Hono, body: unknown, headers: Record<string, string> = jsonHeaders) {
  return app.request("/v1/media/audio-parts", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

after(async () => {
  await Promise.all(created.map((m) => m.shutdown()));
});

test("requires the bearer token like the other /v1 routes", async () => {
  const { app } = buildApp();
  const res = await post(app, { source_url: "https://files.example.com/a.m4a" }, { "content-type": "application/json" });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "unauthorized");
  assert.equal((await app.request("/v1/media/audio-parts/x", { method: "DELETE" })).status, 401);
});

test("400 on invalid bodies", async () => {
  const { app } = buildApp();
  const cases: unknown[] = [
    "{not json",
    [],
    {},
    { source_url: 42 },
    { source_url: "not a url" },
    { source_url: "http://files.example.com/a.m4a" },
    { source_url: "https://user:pw@files.example.com/a.m4a" },
    { source_url: "https://files.example.com/a.m4a", part_seconds: 299 },
    { source_url: "https://files.example.com/a.m4a", part_seconds: 3601 },
    { source_url: "https://files.example.com/a.m4a", part_seconds: 600.5 },
    { source_url: "https://files.example.com/a.m4a", part_seconds: "1200" },
    { source_url: "https://files.example.com/a.m4a", format: "wav" },
  ];
  for (const body of cases) {
    const res = await post(app, body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    const json = await res.json();
    assert.equal(json.error.code, "bad_request");
    assert.equal(typeof json.error.message, "string");
  }
});

test("403 when the source host is not allowlisted", async () => {
  const { app } = buildApp();
  for (const url of ["https://evil.example.com/a.m4a", "https://files.example.com.evil.net/a.m4a"]) {
    const res = await post(app, { source_url: url });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "source_not_allowed");
  }
});

test("503 media_disabled when no host is allowlisted or ffmpeg is missing", async () => {
  for (const { app } of [
    buildApp({ mediaAllowedSourceHosts: [] }),
    buildApp({}, { binariesAvailable: false }),
  ]) {
    const res = await post(app, { source_url: "https://files.example.com/a.m4a" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "media_disabled");
    assert.equal((await app.request("/v1/media/audio-parts/x", { headers: authHeader })).status, 503);
    const health = await (await app.request("/healthz")).json();
    assert.deepEqual(health.media, { enabled: false, activeJobs: 0 });
  }
});

test("media routes answer 503 when createApp gets no media module", async () => {
  const config = makeConfig();
  const { batch } = createMistralClients(config);
  const app = createApp(config, { batch, gladia: null, activeSessions: () => 0 });
  const res = await post(app, { source_url: "https://files.example.com/a.m4a" });
  assert.equal(res.status, 503);
});

test("404 on unknown jobs and parts", async () => {
  const { app } = buildApp();
  for (const path of [
    "/v1/media/audio-parts/00000000-0000-4000-8000-000000000000",
    "/v1/media/audio-parts/nope/parts/0",
  ]) {
    const res = await app.request(path, { headers: authHeader });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
  }
});

test("202 then state polling; parts 404 until ready; DELETE is idempotent", async () => {
  const { app, media } = buildApp();
  const res = await post(app, { source_url: "https://files.example.com/a.m4a" });
  assert.equal(res.status, 202);
  const { job_id, status } = await res.json();
  assert.equal(status, "queued");
  assert.match(job_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  await new Promise((r) => setTimeout(r, 20));
  const state = await (await app.request(`/v1/media/audio-parts/${job_id}`, { headers: authHeader })).json();
  assert.equal(state.status, "downloading");
  assert.equal(state.duration_sec, null);
  assert.equal(state.has_video, null);
  assert.equal(state.total_parts, null);
  assert.deepEqual(state.parts, []);
  assert.equal(state.error, null);
  assert.equal(Date.parse(state.expires_at) - Date.parse(state.created_at), 60 * 60 * 1000);
  assert.equal(media.activeCount(), 1);

  const part = await app.request(`/v1/media/audio-parts/${job_id}/parts/0`, { headers: authHeader });
  assert.equal(part.status, 404);

  for (let i = 0; i < 2; i++) {
    const del = await app.request(`/v1/media/audio-parts/${job_id}`, { method: "DELETE", headers: authHeader });
    assert.equal(del.status, 204);
  }
  const unknown = await app.request("/v1/media/audio-parts/never-existed", { method: "DELETE", headers: authHeader });
  assert.equal(unknown.status, 204);
  assert.equal(media.activeCount(), 0);
  assert.equal((await app.request(`/v1/media/audio-parts/${job_id}`, { headers: authHeader })).status, 404);
});

test("429 busy once MEDIA_MAX_CONCURRENT_JOBS jobs are active", async () => {
  const { app } = buildApp({ mediaMaxConcurrentJobs: 1 });
  const first = await post(app, { source_url: "https://files.example.com/a.m4a" });
  assert.equal(first.status, 202);
  const busy = await post(app, { source_url: "https://files.example.com/b.m4a" });
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).error.code, "busy");

  const health = await (await app.request("/healthz")).json();
  assert.deepEqual(health.media, { enabled: true, activeJobs: 1 });

  const { job_id } = await first.json();
  await app.request(`/v1/media/audio-parts/${job_id}`, { method: "DELETE", headers: authHeader });
  assert.equal((await post(app, { source_url: "https://files.example.com/b.m4a" })).status, 202);
});

test("fetch failures surface as job errors, kept until expiry", async () => {
  const failingFetch: typeof fetch = async () => new Response("nope", { status: 404 });
  const { app, media } = buildApp({}, { binariesAvailable: true, fetch: failingFetch });
  const { job_id } = await (await post(app, { source_url: "https://files.example.com/a.m4a" })).json();
  let state;
  for (let i = 0; i < 50; i++) {
    state = await (await app.request(`/v1/media/audio-parts/${job_id}`, { headers: authHeader })).json();
    if (state.status === "error") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(state.status, "error");
  assert.equal(state.error.code, "source_fetch_failed");
  assert.match(state.error.message, /404/);
  assert.equal(media.activeCount(), 0);

  await media.sweepExpired(Date.now() + 60 * 60 * 1000);
  assert.equal((await app.request(`/v1/media/audio-parts/${job_id}`, { headers: authHeader })).status, 404);
});

test("a declared Content-Length over the limit fails with source_too_large", async () => {
  const bigFetch: typeof fetch = async () =>
    new Response("x", { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } });
  const { app } = buildApp({ mediaMaxSourceBytes: 1024 }, { binariesAvailable: true, fetch: bigFetch });
  const { job_id } = await (await post(app, { source_url: "https://files.example.com/a.m4a" })).json();
  let state;
  for (let i = 0; i < 50; i++) {
    state = await (await app.request(`/v1/media/audio-parts/${job_id}`, { headers: authHeader })).json();
    if (state.status === "error") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(state.error.code, "source_too_large");
});

test("loadConfig parses the media settings", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const base = { MISTRAL_API_KEY: "k", AUTH_TOKEN: TEST_TOKEN, ALLOWED_ORIGINS: "https://app.example.com" };

  const defaults = loadConfig(base);
  assert.deepEqual(defaults.mediaAllowedSourceHosts, []);
  assert.equal(defaults.mediaSilenceNoiseDb, -35);
  assert.equal(defaults.mediaSilenceMinSec, 0.4);
  assert.equal(defaults.mediaMaxSourceBytes, 629145600);
  assert.match(defaults.mediaWorkDir, /media-jobs$/);

  const custom = loadConfig({
    ...base,
    MEDIA_ALLOWED_SOURCE_HOSTS: " files.example.com , https://Cdn.Example.com/path/ ",
    MEDIA_SILENCE_NOISE_DB: "-42",
    MEDIA_SILENCE_MIN_SEC: "0.25",
  });
  assert.deepEqual(custom.mediaAllowedSourceHosts, ["files.example.com", "cdn.example.com"]);
  assert.equal(custom.mediaSilenceNoiseDb, -42);
  assert.equal(custom.mediaSilenceMinSec, 0.25);

  assert.throws(() => loadConfig({ ...base, MEDIA_SILENCE_NOISE_DB: "35" }), /MEDIA_SILENCE_NOISE_DB/);
  assert.throws(() => loadConfig({ ...base, MEDIA_SILENCE_MIN_SEC: "-1" }), /MEDIA_SILENCE_MIN_SEC/);
  assert.throws(() => loadConfig({ ...base, MEDIA_MAX_CONCURRENT_JOBS: "0" }), /MEDIA_MAX_CONCURRENT_JOBS/);
});
