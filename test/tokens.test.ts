import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { authorize, mintSessionToken, readSessionToken } from "../src/auth.ts";
import { startServer, type RunningServer } from "../src/index.ts";
import { startMockMistral, type MockMistral } from "./mock-mistral.ts";
import { makeConfig, TEST_TOKEN } from "./helpers.ts";

let mistral: MockMistral;
let server: RunningServer;

before(async () => {
  mistral = await startMockMistral();
  server = await startServer(makeConfig({ mistralBaseUrl: mistral.httpUrl, mistralWsUrl: mistral.wsUrl }));
});

after(async () => {
  await server.close();
  await mistral.close();
});

const call = (path: string, token: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });

const mint = async (body: unknown, token = TEST_TOKEN) =>
  call("/v1/tokens", token, { method: "POST", body: JSON.stringify(body) });

/** Resolves with 101 when the socket opens, or the HTTP status that refused it. */
const upgradeStatus = (path: string, token: string): Promise<number> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}?token=${encodeURIComponent(token)}`);
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => {});
  });

test("a session token opens what it was minted for, and nothing else", async () => {
  const res = await mint({ scopes: ["tts", "stt"], subject: "user_42" });
  assert.equal(res.status, 200);
  const minted = (await res.json()) as { token: string; expires_at: string; scopes: string[]; subject: string };
  assert.match(minted.token, /^vs_s_/);
  assert.deepEqual([minted.scopes, minted.subject], [["tts", "stt"], "user_42"]);
  const lifetime = Date.parse(minted.expires_at) - Date.now();
  assert.ok(lifetime > 3590_000 && lifetime <= 3600_000, `one hour by default, got ${lifetime}ms`);

  assert.equal((await call("/v1/voices", minted.token)).status, 200); // tts
  assert.equal(await upgradeStatus("/v1/realtime", minted.token), 101); // stt

  const denied = await call("/v1/decide", minted.token, { method: "POST", body: "{}" });
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as { error: { code: string } }).error.code, "forbidden");
  assert.equal(await upgradeStatus("/v1/converse", minted.token), 403);
});

test("only the server token can mint", async () => {
  const session = ((await (await mint({ scopes: ["stt", "tts", "converse", "decide", "media"] })).json()) as { token: string }).token;
  const res = await mint({ scopes: ["stt"] }, session);
  assert.equal(res.status, 403);
  assert.equal((await mint({ scopes: ["stt"] }, "wrong-token")).status, 401);
});

test("minting validates its input", async () => {
  assert.equal((await mint({})).status, 400);
  assert.equal((await mint({ scopes: [] })).status, 400);
  assert.equal((await mint({ scopes: ["admin"] })).status, 400);
  assert.equal((await mint({ scopes: ["stt"], ttl_seconds: 7200 })).status, 400); // above the cap
  const short = (await (await mint({ scopes: ["stt"], ttl_seconds: 60 })).json()) as { expires_at: string };
  assert.ok(Date.parse(short.expires_at) - Date.now() <= 60_000);
});

test("an expired token is refused with a code that says so", async () => {
  const expired = mintSessionToken(
    { subject: "user_42", scopes: ["tts"], expiresAt: Math.floor(Date.now() / 1000) - 5 },
    TEST_TOKEN,
  );
  const res = await call("/v1/voices", expired);
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "token_expired");
  assert.equal(await upgradeStatus("/v1/realtime", expired), 401);
});

test("a token that was altered, or signed by another server, is not one of ours", () => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const token = mintSessionToken({ subject: "u", scopes: ["stt"], expiresAt: exp }, TEST_TOKEN);
  assert.deepEqual(readSessionToken(token, TEST_TOKEN), { subject: "u", scopes: ["stt"], expiresAt: exp });

  // Swap the payload for one that grants more, keeping the signature.
  const forged = mintSessionToken({ subject: "u", scopes: ["stt", "converse"], expiresAt: exp }, TEST_TOKEN);
  const tampered = `${forged.split(".")[0]}.${token.split(".")[1]}`;
  assert.equal(readSessionToken(tampered, TEST_TOKEN), null);
  assert.equal(readSessionToken(token, "another-server-token"), null);
  assert.equal(authorize(tampered, TEST_TOKEN, "stt").ok, false);

  // The server token still opens everything, including minting.
  assert.deepEqual(authorize(TEST_TOKEN, TEST_TOKEN, "master"), { ok: true, master: true, subject: null });
});
