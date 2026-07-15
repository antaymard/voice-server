import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { GladiaServerEvent } from "../client/src/gladiaProtocol.ts";
import { startServer, type RunningServer } from "../src/index.ts";
import { startMockGladia, type MockGladia } from "./mock-gladia.ts";
import { makeConfig, TEST_TOKEN } from "./helpers.ts";
import type { Config } from "../src/config.ts";

let mock: MockGladia;
let server: RunningServer;

function serverConfig(overrides: Partial<Config> = {}): Config {
  return makeConfig({
    gladiaBaseUrl: mock.httpUrl,
    ...overrides,
  });
}

type Watched = {
  ws: WebSocket;
  events: GladiaServerEvent[];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  next: (predicate: (ev: GladiaServerEvent) => boolean, timeoutMs?: number) => Promise<GladiaServerEvent>;
};

function connect(port: number, { token = TEST_TOKEN }: { token?: string | null } = {}): Watched {
  const query = token === null ? "" : `?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/gladia/realtime${query}`);

  const events: GladiaServerEvent[] = [];
  const waiters: Array<{
    predicate: (ev: GladiaServerEvent) => boolean;
    resolve: (ev: GladiaServerEvent) => void;
  }> = [];
  ws.on("message", (data) => {
    const event = JSON.parse(data.toString()) as GladiaServerEvent;
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i]!;
      if (waiter.predicate(event)) {
        waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  });

  const opened = new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });

  const next = (
    predicate: (ev: GladiaServerEvent) => boolean,
    timeoutMs = 3000,
  ): Promise<GladiaServerEvent> => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for event; got: ${JSON.stringify(events)}`)),
        timeoutMs,
      );
      waiters.push({
        predicate,
        resolve: (ev) => {
          clearTimeout(timer);
          resolve(ev);
        },
      });
    });
  };

  return { ws, events, opened, closed, next };
}

const pcmFrame = (bytes = 3200): Buffer => Buffer.alloc(bytes, 7);

before(async () => {
  mock = await startMockGladia();
  server = await startServer(serverConfig());
});

after(async () => {
  await server.close();
  await mock.close();
});

test("happy path: start -> ready -> partials + utterances -> stop -> done -> close 1000", async () => {
  const client = connect(server.port);
  await client.opened;
  client.ws.send(
    JSON.stringify({
      type: "start",
      sampleRate: 16000,
      languages: ["fr"],
      vocabulary: ["Solaria", { value: "Salesforce", pronunciations: ["sell force"] }],
      endpointing: 0.2,
    }),
  );

  const ready = await client.next((ev) => ev.type === "ready");
  assert.equal((ready as { sessionId: string }).sessionId.startsWith("mock-live-"), true);
  assert.equal((ready as { sampleRate: number }).sampleRate, 16000);

  client.ws.send(pcmFrame());
  client.ws.send(pcmFrame());
  client.ws.send(pcmFrame());
  client.ws.send(pcmFrame());

  await client.next((ev) => ev.type === "partial" && ev.text === "p1");
  await client.next((ev) => ev.type === "utterance" && ev.text === "f2");

  client.ws.send(JSON.stringify({ type: "stop" }));
  const done = await client.next((ev) => ev.type === "done");
  assert.equal((done as { text: string }).text, "f1 f2");
  assert.equal((done as { utterances: unknown[] }).utterances.length, 2);

  const close = await client.closed;
  assert.equal(close.code, 1000);

  // The init call carried the Gladia-specific options.
  const init = mock.liveInitBodies.at(-1)!;
  assert.equal(init["encoding"], "wav/pcm");
  assert.equal(init["sample_rate"], 16000);
  assert.equal(init["bit_depth"], 16);
  assert.equal(init["channels"], 1);
  assert.equal(init["endpointing"], 0.2);
  assert.deepEqual(init["language_config"], { languages: ["fr"], code_switching: false });
  assert.deepEqual(init["realtime_processing"], {
    custom_vocabulary: true,
    custom_vocabulary_config: {
      vocabulary: ["Solaria", { value: "Salesforce", pronunciations: ["sell force"] }],
    },
  });
});

test("partials=false disables partial transcripts upstream and client-side", async () => {
  const client = connect(server.port);
  await client.opened;
  client.ws.send(JSON.stringify({ type: "start", partials: false }));
  await client.next((ev) => ev.type === "ready");

  client.ws.send(pcmFrame());
  client.ws.send(pcmFrame());
  await client.next((ev) => ev.type === "utterance" && ev.text === "f1");
  assert.ok(client.events.every((ev) => ev.type !== "partial"));

  const init = mock.liveInitBodies.at(-1)!;
  const messages = init["messages_config"] as Record<string, unknown>;
  assert.equal(messages["receive_partial_transcripts"], false);

  client.ws.send(JSON.stringify({ type: "stop" }));
  await client.closed;
});

test("gladia not configured -> upgrade rejected with 503", async () => {
  const disabled = await startServer(serverConfig({ gladiaApiKey: "" }));
  try {
    const client = connect(disabled.port);
    const status = await new Promise<number>((resolve, reject) => {
      client.ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      client.ws.on("open", () => reject(new Error("connection should have been rejected")));
    });
    assert.equal(status, 503);
  } finally {
    await disabled.close();
  }
});

test("missing token is rejected at upgrade with 401", async () => {
  const client = connect(server.port, { token: null });
  const status = await new Promise<number>((resolve, reject) => {
    client.ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    client.ws.on("open", () => reject(new Error("connection should have been rejected")));
  });
  assert.equal(status, 401);
});

test("invalid start options -> error + close 4400", async () => {
  const client = connect(server.port);
  await client.opened;
  client.ws.send(JSON.stringify({ type: "start", sampleRate: 22050 }));
  const error = await client.next((ev) => ev.type === "error");
  assert.equal((error as { code: string }).code, "bad_message");
  const close = await client.closed;
  assert.equal(close.code, 4400);
});

test("binary before start -> error + close 4400", async () => {
  const client = connect(server.port);
  await client.opened;
  client.ws.send(pcmFrame());
  const close = await client.closed;
  assert.equal(close.code, 4400);
});

test("bad Gladia key -> upstream_error + close 4502", async () => {
  const badKey = await startServer(serverConfig({ gladiaApiKey: "bad-key" }));
  try {
    const client = connect(badKey.port);
    await client.opened;
    client.ws.send(JSON.stringify({ type: "start" }));
    const error = await client.next((ev) => ev.type === "error");
    assert.equal((error as { code: string }).code, "upstream_error");
    const close = await client.closed;
    assert.equal(close.code, 4502);
  } finally {
    await badKey.close();
  }
});

test("upstream death mid-session -> error + close 4502", async () => {
  const client = connect(server.port);
  await client.opened;
  client.ws.send(JSON.stringify({ type: "start" }));
  await client.next((ev) => ev.type === "ready");
  client.ws.send(Buffer.from("KILL"));
  const error = await client.next((ev) => ev.type === "error");
  assert.equal((error as { code: string }).code, "upstream_error");
  const close = await client.closed;
  assert.equal(close.code, 4502);
});

test("mistral and gladia realtime endpoints coexist on the same server", async () => {
  // /v1/realtime still routes to the Mistral bridge (which cannot reach its
  // mock here and reports an upstream error rather than a protocol error).
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/v1/realtime?token=${encodeURIComponent(TEST_TOKEN)}`,
  );
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.send(JSON.stringify({ type: "start" }));
  const event = await new Promise<{ type: string; code?: string }>((resolve) => {
    ws.on("message", (data) => resolve(JSON.parse(data.toString())));
  });
  assert.equal(event.type, "error");
  assert.equal(event.code, "upstream_error");
  ws.close();
});
