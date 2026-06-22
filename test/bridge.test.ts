import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { ServerEvent } from "../client/src/protocol.ts";
import { startServer, type RunningServer } from "../src/index.ts";
import { startMockMistral, type MockMistral } from "./mock-mistral.ts";
import { makeConfig, TEST_TOKEN } from "./helpers.ts";
import type { Config } from "../src/config.ts";

let mock: MockMistral;
let server: RunningServer;

function serverConfig(overrides: Partial<Config> = {}): Config {
  return makeConfig({
    mistralBaseUrl: mock.httpUrl,
    mistralWsUrl: mock.wsUrl,
    ...overrides,
  });
}

type Watched = {
  ws: WebSocket;
  events: ServerEvent[];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  next: (predicate: (ev: ServerEvent) => boolean, timeoutMs?: number) => Promise<ServerEvent>;
};

function connect(
  port: number,
  { token = TEST_TOKEN, origin }: { token?: string | null; origin?: string } = {},
): Watched {
  const query = token === null ? "" : `?token=${encodeURIComponent(token)}`;
  const headers: Record<string, string> = {};
  if (origin) headers["origin"] = origin;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime${query}`, { headers });

  const events: ServerEvent[] = [];
  const waiters: Array<{ predicate: (ev: ServerEvent) => boolean; resolve: (ev: ServerEvent) => void }> = [];
  ws.on("message", (data) => {
    const event = JSON.parse(data.toString()) as ServerEvent;
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

  const next = (predicate: (ev: ServerEvent) => boolean, timeoutMs = 3000): Promise<ServerEvent> => {
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
  mock = await startMockMistral();
  server = await startServer(serverConfig());
});

after(async () => {
  await server.close();
  await mock.close();
});

test("happy path: start -> ready -> audio deltas -> stop -> done -> close 1000", async () => {
  const client = connect(server.port);
  await client.opened;
  client.ws.send(JSON.stringify({ type: "start", sampleRate: 16000, targetDelayMs: 300 }));

  const ready = await client.next((ev) => ev.type === "ready");
  assert.equal(ready.type, "ready");
  assert.equal((ready as { requestId: string }).requestId, "mock-req-1");
  assert.equal((ready as { targetDelayMs: number }).targetDelayMs, 300);

  client.ws.send(pcmFrame());
  client.ws.send(pcmFrame());
  client.ws.send(pcmFrame());

  await client.next((ev) => ev.type === "delta" && ev.text === "p3 ");
  await client.next((ev) => ev.type === "language" && ev.language === "fr");

  client.ws.send(JSON.stringify({ type: "stop" }));
  const done = await client.next((ev) => ev.type === "done");
  assert.equal((done as { text: string }).text, "p1 p2 p3");

  const close = await client.closed;
  assert.equal(close.code, 1000);
});

test("missing or wrong token is rejected at upgrade with 401", async () => {
  for (const token of [null, "wrong-token"]) {
    const client = connect(server.port, { token });
    const status = await new Promise<number>((resolve, reject) => {
      client.ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      client.ws.on("open", () => reject(new Error("connection should have been rejected")));
    });
    assert.equal(status, 401);
  }
});

test("disallowed origin is rejected at upgrade with 403", async () => {
  const restricted = await startServer(
    serverConfig({ allowedOrigins: ["https://app.example.com"] }),
  );
  try {
    const denied = connect(restricted.port, { origin: "https://evil.example.com" });
    const status = await new Promise<number>((resolve, reject) => {
      denied.ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      denied.ws.on("open", () => reject(new Error("connection should have been rejected")));
    });
    assert.equal(status, 403);

    const allowed = connect(restricted.port, { origin: "https://app.example.com" });
    await allowed.opened;
    allowed.ws.close();
    await allowed.closed;
  } finally {
    await restricted.close();
  }
});

test("binary before start -> error + close 4400", async () => {
  const client = connect(server.port);
  await client.opened;
  client.ws.send(pcmFrame());
  const error = await client.next((ev) => ev.type === "error");
  assert.equal((error as { code: string }).code, "bad_message");
  const close = await client.closed;
  assert.equal(close.code, 4400);
});

test("unparseable control message -> close 4400", async () => {
  const client = connect(server.port);
  await client.opened;
  client.ws.send("this is not json");
  const close = await client.closed;
  assert.equal(close.code, 4400);
});

test("duplicate start -> close 4400", async () => {
  const client = connect(server.port);
  await client.opened;
  client.ws.send(JSON.stringify({ type: "start" }));
  await client.next((ev) => ev.type === "ready");
  client.ws.send(JSON.stringify({ type: "start" }));
  const close = await client.closed;
  assert.equal(close.code, 4400);
});

test("idle timeout -> error + close 4408", async () => {
  const sleepy = await startServer(serverConfig({ idleTimeoutMs: 200 }));
  try {
    const client = connect(sleepy.port);
    await client.opened;
    client.ws.send(JSON.stringify({ type: "start" }));
    await client.next((ev) => ev.type === "ready");
    const error = await client.next((ev) => ev.type === "error", 2000);
    assert.equal((error as { code: string }).code, "idle_timeout");
    const close = await client.closed;
    assert.equal(close.code, 4408);
  } finally {
    await sleepy.close();
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

test("session cap -> upgrade rejected with 429", async () => {
  const tiny = await startServer(serverConfig({ maxSessions: 1 }));
  try {
    const first = connect(tiny.port);
    await first.opened;
    const second = connect(tiny.port);
    const status = await new Promise<number>((resolve, reject) => {
      second.ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      second.ws.on("open", () => reject(new Error("connection should have been rejected")));
    });
    assert.equal(status, 429);
    first.ws.close();
    await first.closed;
  } finally {
    await tiny.close();
  }
});

test("server shutdown closes active sessions with 1001", async () => {
  const ephemeral = await startServer(serverConfig());
  const client = connect(ephemeral.port);
  await client.opened;
  client.ws.send(JSON.stringify({ type: "start" }));
  await client.next((ev) => ev.type === "ready");
  await ephemeral.close();
  const close = await client.closed;
  assert.equal(close.code, 1001);
  assert.ok(client.events.some((ev) => ev.type === "error" && ev.code === "server_shutdown"));
});
