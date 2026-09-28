/**
 * End-to-end audio-parts pipeline against the real ffmpeg/ffprobe binaries.
 * Skipped when ffmpeg is not installed (it is in the Docker image).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { Config } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { mediaBinariesAvailable } from "../src/media/ffmpeg.ts";
import { createMediaJobs, type JobView, type MediaJobs } from "../src/media/jobs.ts";
import { createMistralClients } from "../src/mistral.ts";
import { makeConfig, TEST_TOKEN } from "./helpers.ts";

const hasFfmpeg = mediaBinariesAvailable();
const e2e = hasFfmpeg ? test : test.skip;
const authHeader = { authorization: `Bearer ${TEST_TOKEN}` };

// The API only accepts https: sources on allowlisted hosts. Tests keep that
// contract and route the allowlisted host to a local plain-HTTP server.
const SOURCE_HOST = "media.test";

let dir: string;
let sourceServer: Server;
let sourceOrigin: string;
let apiServer: ReturnType<typeof serve> | null = null;
let apiOrigin: string;
let config: Config;
let media: MediaJobs;
const extraMedia: MediaJobs[] = [];

const localFetch: typeof fetch = (input, init) =>
  fetch(String(input).replace(`https://${SOURCE_HOST}`, sourceOrigin), init);

function ffprobeDuration(path: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  return Number(out.toString().trim());
}

function ffprobeCodecTypes(path: string): string[] {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path]);
  return out.toString().trim().split(/\s+/);
}

async function waitFor(
  jobs: MediaJobs,
  id: string,
  until: (job: JobView) => boolean,
  timeoutMs = 60_000,
): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = jobs.get(id);
    assert.ok(job, `job ${id} disappeared`);
    if (until(job)) return job;
    if (Date.now() > deadline) assert.fail(`timed out waiting on job ${id} (status ${job.status})`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function runningFfmpegFor(path: string): string[] {
  return execFileSync("ps", ["-eo", "args"])
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("ffmpeg") && line.includes(path));
}

before(async () => {
  if (!hasFfmpeg) return;
  dir = mkdtempSync(join(tmpdir(), "media-e2e-"));
  // 150 s of 440 Hz sine with silences at 58–62 s and 123–127 s.
  execFileSync("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi",
    "-i", "aevalsrc='if(between(t,58,62)+between(t,123,127),0,0.5*sin(2*PI*440*t))':s=44100:d=150",
    "-c:a", "aac", "-b:a", "64k", join(dir, "source.m4a"),
  ]);
  // 12 s video with an audio track.
  execFileSync("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-c:v", "mpeg4", "-c:a", "aac", "-shortest", join(dir, "video.mp4"),
  ]);
  writeFileSync(join(dir, "not-media.bin"), "definitely not audio");

  sourceServer = createServer((req, res) => {
    const name = (req.url ?? "/").slice(1);
    if (name === "redirect") {
      res.writeHead(302, { location: "/source.m4a" }).end();
    } else if (name === "endless") {
      // No Content-Length: the size limit must be enforced while streaming.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const chunk = Buffer.alloc(64 * 1024);
      const pump = (): void => {
        while (!res.destroyed && res.write(chunk));
        if (!res.destroyed) res.once("drain", pump);
      };
      res.on("close", () => res.removeAllListeners("drain"));
      pump();
    } else if (/^[\w.-]+$/.test(name) && existsSync(join(dir, name))) {
      res.writeHead(200, { "content-length": statSync(join(dir, name)).size });
      createReadStream(join(dir, name)).pipe(res);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => sourceServer.listen(0, "127.0.0.1", r));
  sourceOrigin = `http://127.0.0.1:${(sourceServer.address() as AddressInfo).port}`;

  config = makeConfig({
    mediaAllowedSourceHosts: [SOURCE_HOST],
    mediaWorkDir: join(dir, "work"),
    mediaMinLastPartSec: 10,
  });
  media = createMediaJobs(config, { fetch: localFetch });
  const { batch } = createMistralClients(config);
  const app = createApp(config, { batch, gladia: null, activeSessions: () => 0, media });
  await new Promise<void>((resolve) => {
    apiServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      apiOrigin = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (!hasFfmpeg) return;
  await media.shutdown();
  await Promise.all(extraMedia.map((m) => m.shutdown()));
  await new Promise<void>((r) => apiServer?.close(() => r()));
  await new Promise<void>((r) => sourceServer.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

e2e("splits a long m4a into parts cut in silences, served over HTTP", async () => {
  // part_seconds=60 is below the API minimum (300) so the fixture stays
  // small: create through the store, then use the HTTP API for the rest.
  const created = media.create({ sourceUrl: `https://${SOURCE_HOST}/source.m4a`, partSeconds: 60, format: "mp3" });
  assert.ok(created);
  const id = created.job_id;

  const job = await waitFor(media, id, (j) => j.status === "done" || j.status === "error");
  assert.equal(job.error, null, JSON.stringify(job.error));
  const res = await fetch(`${apiOrigin}/v1/media/audio-parts/${id}`, { headers: authHeader });
  assert.equal(res.status, 200);
  const state = (await res.json()) as JobView;
  assert.equal(state.status, "done");
  assert.equal(state.has_video, false);
  assert.ok(Math.abs((state.duration_sec as number) - 150) < 0.1, `duration ${state.duration_sec}`);

  // Contract invariants (§ 2.2).
  const parts = state.parts;
  assert.equal(state.total_parts, 3);
  assert.equal(parts.length, 3);
  assert.equal(parts[0]?.start_sec, 0);
  parts.forEach((part, i) => {
    assert.equal(part.index, i);
    if (i > 0) assert.equal(part.start_sec, parts[i - 1]?.end_sec);
    assert.equal(part.duration_sec, Math.round((part.end_sec - part.start_sec) * 1000) / 1000);
    assert.equal(part.content_type, "audio/mpeg");
  });
  assert.ok(Math.abs((parts.at(-1)?.end_sec as number) - (state.duration_sec as number)) <= 0.5);

  // Cuts land inside the silences, not at the hard targets (60, 120).
  const cut1 = parts[1]?.start_sec as number;
  const cut2 = parts[2]?.start_sec as number;
  assert.ok(cut1 > 58 && cut1 < 62, `cut1=${cut1}`);
  assert.ok(cut2 > 123 && cut2 < 127, `cut2=${cut2}`);

  for (const part of parts) {
    const partRes = await fetch(`${apiOrigin}/v1/media/audio-parts/${id}/parts/${part.index}`, {
      headers: authHeader,
    });
    assert.equal(partRes.status, 200);
    assert.equal(partRes.headers.get("content-type"), "audio/mpeg");
    assert.equal(partRes.headers.get("content-length"), String(part.bytes));
    assert.equal(partRes.headers.get("cache-control"), "no-store");
    const bytes = Buffer.from(await partRes.arrayBuffer());
    assert.equal(bytes.length, part.bytes);
    const local = join(dir, `downloaded-${part.index}.mp3`);
    writeFileSync(local, bytes);
    const probed = ffprobeDuration(local);
    assert.ok(Math.abs(probed - part.duration_sec) <= 0.1, `part ${part.index}: ffprobe ${probed} vs ${part.duration_sec}`);
  }
  assert.equal(
    (await fetch(`${apiOrigin}/v1/media/audio-parts/${id}/parts/3`, { headers: authHeader })).status,
    404,
  );

  const jobDir = join(config.mediaWorkDir, id);
  assert.ok(existsSync(jobDir));
  assert.ok(!existsSync(join(jobDir, "source.bin")), "source is deleted once done");
  const del = await fetch(`${apiOrigin}/v1/media/audio-parts/${id}`, { method: "DELETE", headers: authHeader });
  assert.equal(del.status, 204);
  assert.ok(!existsSync(jobDir), "DELETE removes the job files");
  assert.equal((await fetch(`${apiOrigin}/v1/media/audio-parts/${id}`, { headers: authHeader })).status, 404);
});

e2e("a video source yields audio-only parts (POST through the API, ogg)", async () => {
  const res = await fetch(`${apiOrigin}/v1/media/audio-parts`, {
    method: "POST",
    headers: { ...authHeader, "content-type": "application/json" },
    body: JSON.stringify({ source_url: `https://${SOURCE_HOST}/video.mp4`, format: "ogg" }),
  });
  assert.equal(res.status, 202);
  const { job_id } = (await res.json()) as { job_id: string };
  const job = await waitFor(media, job_id, (j) => j.status === "done" || j.status === "error");
  assert.equal(job.error, null, JSON.stringify(job.error));
  assert.equal(job.has_video, true);
  assert.equal(job.total_parts, 1);
  assert.deepEqual(job.parts.map((p) => [p.start_sec, p.end_sec, p.content_type]), [[0, job.duration_sec, "audio/ogg"]]);

  const part = await fetch(`${apiOrigin}/v1/media/audio-parts/${job_id}/parts/0`, { headers: authHeader });
  assert.equal(part.headers.get("content-type"), "audio/ogg");
  const local = join(dir, "video-part.ogg");
  writeFileSync(local, Buffer.from(await part.arrayBuffer()));
  assert.deepEqual(ffprobeCodecTypes(local), ["audio"]);
  assert.ok(Math.abs(ffprobeDuration(local) - (job.duration_sec as number)) <= 0.1);
  await media.remove(job_id);
});

e2e("source errors: redirect, HTTP error, unreadable media", async () => {
  const cases = [
    ["redirect", "source_fetch_failed"],
    ["missing.m4a", "source_fetch_failed"],
    ["not-media.bin", "unreadable_media"],
  ] as const;
  for (const [name, code] of cases) {
    const created = media.create({ sourceUrl: `https://${SOURCE_HOST}/${name}`, partSeconds: 1200, format: "mp3" });
    assert.ok(created);
    const job = await waitFor(media, created.job_id, (j) => j.status === "error" || j.status === "done");
    assert.equal(job.error?.code, code, `${name}: ${JSON.stringify(job.error)}`);
    assert.ok(!existsSync(join(config.mediaWorkDir, created.job_id)), "files are deleted on error");
    await media.remove(created.job_id);
  }
});

e2e("a source without Content-Length is cut off at MEDIA_MAX_SOURCE_BYTES", async () => {
  const small = createMediaJobs(
    { ...config, mediaWorkDir: join(dir, "work-small"), mediaMaxSourceBytes: 1024 * 1024 },
    { fetch: localFetch },
  );
  extraMedia.push(small);
  const created = small.create({ sourceUrl: `https://${SOURCE_HOST}/endless`, partSeconds: 1200, format: "mp3" });
  assert.ok(created);
  const job = await waitFor(small, created.job_id, (j) => j.status === "error" || j.status === "done", 10_000);
  assert.equal(job.error?.code, "source_too_large");
  assert.ok(!existsSync(join(dir, "work-small", created.job_id)));
});

e2e("DELETE while splitting kills ffmpeg and removes the files", async () => {
  const created = media.create({ sourceUrl: `https://${SOURCE_HOST}/source.m4a`, partSeconds: 60, format: "mp3" });
  assert.ok(created);
  const jobDir = join(config.mediaWorkDir, created.job_id);
  await waitFor(media, created.job_id, (j) => j.status === "splitting" || j.status === "done");

  const del = await fetch(`${apiOrigin}/v1/media/audio-parts/${created.job_id}`, {
    method: "DELETE",
    headers: authHeader,
  });
  assert.equal(del.status, 204);
  assert.ok(!existsSync(jobDir));
  assert.deepEqual(runningFfmpegFor(jobDir), []);
  assert.equal(media.get(created.job_id), null);
  assert.equal(media.activeCount(), 0);
});

e2e("expired jobs are swept with their files", async () => {
  const created = media.create({ sourceUrl: `https://${SOURCE_HOST}/video.mp4`, partSeconds: 1200, format: "mp3" });
  assert.ok(created);
  await waitFor(media, created.job_id, (j) => j.status === "done");
  const jobDir = join(config.mediaWorkDir, created.job_id);
  assert.ok(existsSync(jobDir));
  await media.sweepExpired(Date.parse(created.expires_at));
  assert.equal(media.get(created.job_id), null);
  assert.ok(!existsSync(jobDir));
});
