import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { ConverseServerEvent, ConverseStartMessage } from "../client/src/converseProtocol.ts";
import { startServer, type RunningServer } from "../src/index.ts";
import { createSentenceSplitter, toSpeakable } from "../src/converse/sentences.ts";
import { classifyEcho } from "../src/converse/session.ts";
import { createPcmDecoder, type PcmFormat } from "../src/converse/tts.ts";
import { loadConfig } from "../src/config.ts";
import { startMockMistral, type MockMistral } from "./mock-mistral.ts";
import { startMockLlm, type MockLlm } from "./mock-llm.ts";
import { makeConfig, TEST_TOKEN } from "./helpers.ts";

let mistral: MockMistral;
let llm: MockLlm;
let server: RunningServer;
/** Same server, with a decision model configured. */
let deciding: RunningServer;

before(async () => {
  mistral = await startMockMistral();
  llm = await startMockLlm();
  server = await startServer(
    makeConfig({
      mistralBaseUrl: mistral.httpUrl,
      mistralWsUrl: mistral.wsUrl,
      llmProviders: {
        default: { baseUrl: llm.baseUrl, apiKey: "default-key" },
        other: { baseUrl: llm.baseUrl, apiKey: "other-key" },
      },
      llmAllowedModels: [{ provider: "other", model: "big-model" }],
    }),
  );
  deciding = await startServer(
    makeConfig({
      mistralBaseUrl: mistral.httpUrl,
      mistralWsUrl: mistral.wsUrl,
      llmProviders: { default: { baseUrl: llm.baseUrl, apiKey: "default-key" } },
      deciderUrl: llm.decisionsUrl,
      deciderApiKey: "decider-key",
    }),
  );
});

after(async () => {
  await deciding.close();
  await server.close();
  await llm.close();
  await mistral.close();
});

beforeEach(() => {
  llm.requests.length = 0;
  llm.decisions.length = 0;
  llm.onDecision = null;
});

type Client = {
  ws: WebSocket;
  events: ConverseServerEvent[];
  audio: Buffer[];
  closed: Promise<{ code: number; reason: string }>;
  next: <T extends ConverseServerEvent["type"]>(
    type: T,
    skip?: number,
  ) => Promise<Extract<ConverseServerEvent, { type: T }>>;
  /** Scripted mic input (see the mock): a transcript delta or a turn event. */
  say: (text: string) => void;
  turn: (phase: "start" | "eager_end" | "resume" | "end") => void;
  sendJson: (message: unknown) => void;
};

async function open(start: Omit<ConverseStartMessage, "type"> = {}, target: RunningServer = server): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${target.port}/v1/converse?token=${TEST_TOKEN}`);
  const events: ConverseServerEvent[] = [];
  const audio: Buffer[] = [];
  const listeners = new Set<() => void>();
  ws.on("message", (data, isBinary) => {
    if (isBinary) audio.push(data as Buffer);
    else events.push(JSON.parse(data.toString()) as ConverseServerEvent);
    for (const listener of listeners) listener();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const client: Client = {
    ws,
    events,
    audio,
    closed,
    next: (type, skip = 0) =>
      new Promise((resolve, reject) => {
        const check = (): boolean => {
          const found = events.filter((e) => e.type === type)[skip];
          if (!found) return false;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(found as never);
          return true;
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Timed out waiting for "${type}" #${skip}; got ${JSON.stringify(events)}`));
        }, 3000);
        if (!check()) listeners.add(check);
      }),
    say: (text) => ws.send(Buffer.from(`SAY:${text}`)),
    turn: (phase) => ws.send(Buffer.from(`TURN:${phase}`)),
    sendJson: (message) => ws.send(JSON.stringify(message)),
  };
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  client.sendJson({ type: "start", ...start });
  return client;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const messagesOf = (index: number): Array<Record<string, unknown>> =>
  llm.requests[index]?.body["messages"] as Array<Record<string, unknown>>;

test("a spoken turn gets a spoken reply", async () => {
  llm.script({ text: ["Bonjour ", "à toi. ", "Comment ça va ?"] });
  const c = await open({ instructions: "Tu es Nole.", voice: "voice_592", language: "fr" });
  const ready = await c.next("ready");
  assert.equal(ready.llmModel, "mock-llm");
  assert.deepEqual(ready.audio, { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 });

  c.turn("start");
  c.say("salut ");
  c.say("toi");
  c.turn("end");

  assert.equal((await c.next("user_turn")).text, "salut toi");
  const done = await c.next("response_done");
  assert.equal(done.text, "Bonjour à toi. Comment ça va ?");
  // The text is streamed into the realtime voice, one generation per
  // sentence; the mock yields 9 bytes each, relayed as whole 16-bit samples.
  assert.equal(Buffer.concat(c.audio).toString(), "MOCKAUDIMOCKAUDI");
  assert.deepEqual(mistral.received.speechRealtime, {
    session: { response_format: "pcm", streaming_mode: "responsive", voice: "voice_592" },
    generations: ["Bonjour à toi. ", "Comment ça va ?"],
  });
  assert.ok(mistral.received.realtimeSession?.["turn_detection"]);

  const messages = messagesOf(0);
  assert.equal(messages[0]?.["role"], "system");
  assert.match(String(messages[0]?.["content"]), /Tu es Nole\.$/);
  assert.deepEqual(messages[1], { role: "user", content: "salut toi" });
  assert.equal(llm.requests[0]?.authorization, "Bearer default-key");
  assert.equal(llm.requests[0]?.body["model"], "mock-llm");
  c.ws.close();
});

test("it keeps listening turn after turn", async () => {
  llm.script({ text: ["Un."] }, { text: ["Deux."] });
  const c = await open();
  await c.next("ready");
  c.turn("start");
  c.say("premier tour");
  c.turn("end");
  assert.equal((await c.next("response_done")).text, "Un.");
  c.say(" ?"); // punctuation trailing in after the turn was answered
  await sleep(350); // the reply has finished playing
  c.turn("start");
  c.say("deuxième tour");
  c.turn("end");
  assert.equal((await c.next("user_turn", 1)).text, "deuxième tour");
  assert.equal((await c.next("response_done", 1)).text, "Deux.");
  c.ws.close();
});

test("speculation: work starts on eager_end, stays hidden, and is dropped on resume", async () => {
  llm.script({ text: ["Réponse trop tôt."] }, { text: ["Bonne réponse."] });
  const c = await open();
  await c.next("ready");
  c.turn("start");
  c.say("quelle heure");
  c.turn("eager_end");
  await sleep(150); // the first reply is fully generated by now…
  assert.equal(llm.requests.length, 1);
  assert.equal(c.events.some((e) => e.type === "response_start"), false); // …but not shown
  assert.equal(c.audio.length, 0);

  c.turn("resume");
  c.say(" est-il à Tokyo");
  c.turn("end");
  const done = await c.next("response_done");
  assert.equal(done.text, "Bonne réponse.");
  assert.equal(c.events.filter((e) => e.type === "response_start").length, 1);
  assert.deepEqual(messagesOf(llm.requests.length - 1)[1], {
    role: "user",
    content: "quelle heure est-il à Tokyo",
  });
  c.ws.close();
});

test("speculation: a confirmed guess is reused, not recomputed", async () => {
  llm.script({ text: ["Il est midi."] });
  const c = await open();
  await c.next("ready");
  c.turn("start");
  c.say("quelle heure est-il");
  c.turn("eager_end");
  await sleep(100);
  c.turn("end");
  assert.equal((await c.next("response_done")).text, "Il est midi.");
  assert.equal(llm.requests.length, 1);
  c.ws.close();
});

test("tool calls are run by the client and feed the reply", async () => {
  llm.script(
    { text: ["Je regarde. "], toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' }] },
    { text: ["Il fait beau à Paris."] },
  );
  const c = await open({
    tools: [{ name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
  });
  await c.next("ready");
  c.sendJson({ type: "text", text: "quel temps à Paris ?" });
  const call = await c.next("tool_call");
  assert.deepEqual(
    { name: call.name, arguments: call.arguments, speculative: call.speculative },
    { name: "get_weather", arguments: '{"city":"Paris"}', speculative: false },
  );
  c.sendJson({ type: "tool_result", callId: call.callId, output: '{"sky":"clear"}' });
  const done = await c.next("response_done");
  assert.equal(done.text, "Je regarde. Il fait beau à Paris.");

  const tools = llm.requests[0]?.body["tools"] as Array<{ function: { name: string } }>;
  assert.equal(tools[0]?.function.name, "get_weather");
  const second = messagesOf(1);
  assert.equal((second[2]?.["tool_calls"] as unknown[]).length, 1);
  assert.deepEqual(second[3], { role: "tool", tool_call_id: "call_1", name: "get_weather", content: '{"sky":"clear"}' });
  c.ws.close();
});

test("speculative tools run before the turn is final and can be cancelled; others wait", async () => {
  const tools = [
    { name: "search", speculative: true },
    { name: "send_email" },
  ];
  llm.script({
    toolCalls: [
      { id: "s1", name: "search", arguments: "{}" },
      { id: "e1", name: "send_email", arguments: "{}" },
    ],
  });
  const c = await open({ tools });
  await c.next("ready");
  c.turn("start");
  c.say("cherche et envoie");
  c.turn("eager_end");
  const early = await c.next("tool_call");
  assert.deepEqual([early.name, early.speculative], ["search", true]);
  await sleep(80);
  assert.equal(c.events.filter((e) => e.type === "tool_call").length, 1); // send_email held back

  c.turn("resume");
  assert.equal((await c.next("tool_cancel")).callId, "s1");
  assert.equal(c.events.some((e) => e.type === "user_turn"), false);
  c.ws.close();
});

test("it acts in the middle of the user's sentence, and the reply knows what was done", async () => {
  const tools = [{ name: "set_color", immediate: true }, { name: "send_email" }];
  llm.script(
    { toolCalls: [{ id: "early_1", name: "set_color", arguments: '{"color":"red"}' }] },
    { text: ["C'est rouge, et bonjour !"] },
  );
  const c = await open({ tools });
  await c.next("ready");
  c.turn("start");
  c.say("mets la page en rouge");
  await sleep(60);
  assert.equal(llm.requests.length, 0); // no clause boundary yet: the model is not bothered
  c.say(",");

  const call = await c.next("tool_call");
  assert.deepEqual(
    { name: call.name, early: call.early, responseId: call.responseId },
    { name: "set_color", early: true, responseId: null },
  );
  assert.equal(c.events.some((e) => e.type === "user_turn"), false); // still mid-sentence
  const early = llm.requests[0]?.body as { messages: Array<Record<string, unknown>>; tools: Array<{ function: { name: string } }> };
  assert.match(String(early.messages[0]?.["content"]), /LISTENING MODE/);
  assert.deepEqual(early.messages.at(-1), { role: "user", content: "mets la page en rouge," });
  assert.deepEqual(early.tools.map((t) => t.function.name), ["set_color"]); // send_email must wait
  c.sendJson({ type: "tool_result", callId: call.callId, output: '{"ok":true}' });

  c.say(" et dis bonjour");
  c.turn("end");
  assert.equal((await c.next("response_done")).text, "C'est rouge, et bonjour !");
  assert.equal(c.events.filter((e) => e.type === "tool_call").length, 1);
  const final = messagesOf(llm.requests.length - 1);
  assert.doesNotMatch(String(final[0]?.["content"]), /LISTENING MODE/);
  assert.deepEqual(final[1], { role: "user", content: "mets la page en rouge, et dis bonjour" });
  assert.equal((final[2]?.["tool_calls"] as Array<{ id: string }>)[0]?.id, "early_1");
  assert.deepEqual(final[3], { role: "tool", tool_call_id: "early_1", name: "set_color", content: '{"ok":true}' });
  c.ws.close();
});

test("without tools allowed to run early, the model is only consulted once the user is done", async () => {
  llm.script({ text: ["D'accord."] });
  const c = await open({ tools: [{ name: "send_email" }] });
  await c.next("ready");
  c.turn("start");
  c.say("écris à Paul pour lui dire que,");
  c.say(" finalement, je viens demain matin avec les documents signés");
  await sleep(80);
  assert.equal(llm.requests.length, 0);
  c.turn("end");
  await c.next("response_done");
  assert.equal(llm.requests.length, 1);
  c.ws.close();
});

test("barge-in cuts the reply and the model remembers only what was heard", async () => {
  llm.script({ text: ["Première phrase. ", "Deuxième phrase jamais"], hangMs: 2000 }, { text: ["D'accord."] });
  const c = await open();
  await c.next("ready");
  c.sendJson({ type: "text", text: "raconte" });
  await c.next("assistant_delta", 1);
  while (c.audio.length === 0) await sleep(10);

  // A turn opening is not enough (it could be a cough): words are.
  c.turn("start");
  await sleep(60);
  assert.equal(c.events.some((e) => e.type === "interrupt" || e.type === "turn"), false);
  c.say("attends ");
  c.say("stop");
  const cut = await c.next("interrupt");
  assert.equal(cut.heardText, "Première phrase.");
  assert.equal((await c.next("turn")).phase, "start"); // held events are released
  c.turn("end");
  await c.next("response_done");
  assert.deepEqual(messagesOf(1).slice(1), [
    { role: "user", content: "raconte" },
    { role: "assistant", content: "Première phrase." },
    { role: "user", content: "attends stop" },
  ]);
  c.ws.close();
});

test("the assistant's own voice coming back through the mic does not interrupt it", async () => {
  llm.script({ text: ["Voici la première phrase. ", "Et la suite arrive"], hangMs: 400 }, { text: ["Oui ?"] });
  const c = await open();
  await c.next("ready");
  c.sendJson({ type: "text", text: "raconte" });
  while (c.audio.length === 0) await sleep(10);

  c.turn("start");
  c.say("voici la ");
  c.say("première phrase");
  c.turn("end");
  const done = await c.next("response_done");
  assert.equal(done.text, "Voici la première phrase. Et la suite arrive");
  assert.equal(c.events.some((e) => ["interrupt", "transcript", "turn"].includes(e.type)), false);
  assert.equal(c.events.filter((e) => e.type === "user_turn").length, 1); // only the typed one

  // Once it has finished speaking, the user is heard normally again.
  await sleep(350);
  c.turn("start");
  c.say("première phrase");
  c.turn("end");
  assert.equal((await c.next("user_turn", 1)).text, "première phrase");
  c.ws.close();
});

test("speech falls back to per-sentence requests when the realtime voice is down", async () => {
  mistral.failSpeechRealtime = true;
  try {
    llm.script({ text: ["Première. Deuxième phrase ici."] });
    const c = await open({ voice: "voice_592" });
    await c.next("ready");
    c.sendJson({ type: "text", text: "salut" });
    await c.next("response_done");
    assert.equal(Buffer.concat(c.audio).toString(), "MOCKAUDI");
    assert.equal(mistral.received.speech?.["voice_id"], "voice_592");
    assert.equal(mistral.received.speech?.["input"], "Première. Deuxième phrase ici.");
    assert.equal(c.events.some((e) => e.type === "response_error"), false);
    c.ws.close();
  } finally {
    mistral.failSpeechRealtime = false;
  }
});

test("a tool slower than its response reports back when it finishes", async () => {
  llm.script(
    { toolCalls: [{ id: "slow_1", name: "export", arguments: "{}" }] },
    { text: ["C'est en cours."] },
    { text: ["L'export est prêt."] },
  );
  const c = await open({ tools: [{ name: "export" }], toolTimeoutMs: 40 });
  await c.next("ready");
  c.sendJson({ type: "text", text: "exporte" });
  const call = await c.next("tool_call");
  assert.equal((await c.next("response_done")).text, "C'est en cours.");
  assert.match(String(messagesOf(1)[3]?.["content"]), /pending/);

  c.sendJson({ type: "tool_result", callId: call.callId, output: "42 lignes" });
  assert.equal((await c.next("response_done", 1)).text, "L'export est prêt.");
  const last = messagesOf(2).at(-1);
  assert.equal(last?.["role"], "user");
  assert.match(String(last?.["content"]), /"export".*has finished[\s\S]*42 lignes/);
  c.ws.close();
});

test("the LLM is chosen per conversation, within what the server allows", async () => {
  const ok = await open({ provider: "other", model: "big-model" });
  assert.equal((await ok.next("ready")).llmProvider, "other");
  ok.sendJson({ type: "text", text: "salut" });
  await ok.next("response_done");
  assert.equal(llm.requests[0]?.authorization, "Bearer other-key");
  assert.equal(llm.requests[0]?.body["model"], "big-model");
  ok.ws.close();

  const refused = await open({ model: "not-allowed" });
  assert.equal((await refused.next("error")).code, "bad_message");
  assert.equal((await refused.closed).code, 4400);
});

test("an LLM failure ends the response, not the session", async () => {
  llm.script({ status: 500 }, { text: ["Me revoilà."] });
  const c = await open();
  await c.next("ready");
  c.sendJson({ type: "text", text: "un" });
  assert.equal((await c.next("response_error")).code, "llm_error");
  await c.next("response_done");
  c.sendJson({ type: "text", text: "deux" });
  assert.equal((await c.next("response_done", 1)).text, "Me revoilà.");
  c.ws.close();
});

test("invalid start options are rejected", async () => {
  const c = await open({ tools: [{ name: "bad name" }] });
  assert.equal((await c.closed).code, 4400);
});

test("sentence splitter emits complete sentences and glues tiny ones", () => {
  const s = createSentenceSplitter();
  assert.deepEqual(s.push("Oui. Bien sûr, je m'en"), []);
  assert.deepEqual(s.push(" occupe ! Ensuite"), ["Oui. Bien sûr, je m'en occupe ! "]);
  assert.equal(s.pending(), "Ensuite");
  assert.deepEqual(s.flush(), ["Ensuite"]);
  assert.equal(toSpeakable("**Voici** le `code` :"), "Voici le code :");
  assert.equal(toSpeakable("---"), "");
});

test("LLM providers and allowed models come from the environment", () => {
  const config = loadConfig({
    MISTRAL_API_KEY: "m",
    AUTH_TOKEN: "x".repeat(32),
    ALLOWED_ORIGINS: "http://localhost",
    LLM_PROVIDER_GROQ_BASE_URL: "https://api.groq.com/openai/v1/",
    LLM_PROVIDER_GROQ_API_KEY: "g",
    LLM_MODELS: "mistral-large-latest, groq:llama3:8b",
  });
  assert.deepEqual(config.llmProviders, {
    default: { baseUrl: "https://api.mistral.ai/v1", apiKey: "m" },
    groq: { baseUrl: "https://api.groq.com/openai/v1", apiKey: "g" },
  });
  assert.deepEqual(config.llmAllowedModels, [
    { provider: "default", model: "mistral-large-latest" },
    { provider: "groq", model: "llama3:8b" },
  ]);
});

test("echo is told apart from someone talking over the assistant", () => {
  const said = "Il fait beau à Paris aujourd'hui, avec vingt degrés.";
  assert.equal(classifyEcho("il fait beau a paris", said), "echo");
  assert.equal(classifyEcho("fait beau à Paris aujourd'hui vingt", said), "echo"); // garbled, still mostly it
  assert.equal(classifyEcho("non attends", said), "speech");
  assert.equal(classifyEcho("stop", said), "speech");
  assert.equal(classifyEcho("Paris", said), "echo");
  assert.equal(classifyEcho(" … ", said), "unknown");
});

test("raw pcm is recognized as 16-bit or float and always leaves as 16-bit", () => {
  const samples = Array.from({ length: 400 }, (_, i) => Math.sin(i / 5) * 0.5);
  const asFloat = Buffer.alloc(samples.length * 4);
  const asInt = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => {
    asFloat.writeFloatLE(v, i * 4);
    asInt.writeInt16LE(Math.round(v * 32767), i * 2);
  });

  const floatFormat: PcmFormat = { encoding: "auto" };
  const floatDecoder = createPcmDecoder(floatFormat);
  // Split mid-sample: the decoder must reassemble it.
  const out = [floatDecoder.push(asFloat.subarray(0, 401)), floatDecoder.push(asFloat.subarray(401)), floatDecoder.flush()];
  assert.equal(floatFormat.encoding, "f32le");
  assert.deepEqual(Buffer.concat(out.filter((b): b is Buffer => b !== null)), asInt);

  const intFormat: PcmFormat = { encoding: "auto" };
  const intDecoder = createPcmDecoder(intFormat);
  const kept = [intDecoder.push(asInt), intDecoder.flush()];
  assert.equal(intFormat.encoding, "s16le");
  assert.deepEqual(Buffer.concat(kept.filter((b): b is Buffer => b !== null)), asInt);
});

test("an OpenRouter key alone selects OpenRouter; LLM_MODEL still decides when set", () => {
  const base = { MISTRAL_API_KEY: "m", AUTH_TOKEN: "x".repeat(32), ALLOWED_ORIGINS: "*", OPENROUTER_API_KEY: "or-key" };
  const auto = loadConfig(base);
  assert.deepEqual(auto.llmProviders["openrouter"], { baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-key" });
  assert.deepEqual([auto.llmDefaultProvider, auto.llmModel], ["openrouter", "anthropic/claude-haiku-5.5"]);

  const pinned = loadConfig({ ...base, LLM_MODEL: "openrouter:openai/gpt-x" });
  assert.deepEqual([pinned.llmDefaultProvider, pinned.llmModel], ["openrouter", "openai/gpt-x"]);

  const mistral = loadConfig({ ...base, LLM_MODEL: "mistral-large-latest" });
  assert.deepEqual([mistral.llmDefaultProvider, mistral.llmModel], ["default", "mistral-large-latest"]);

  const none = loadConfig({ ...base, OPENROUTER_API_KEY: undefined });
  assert.deepEqual([none.llmDefaultProvider, none.llmModel], ["default", "mistral-small-latest"]);
});

// --- With a decision ("System One") model -----------------------------------

const noul = (p: number) => ({ type: "noul", noul: p, confidence: 0.9 });

test("decider: an acknowledgement does not cut the assistant off, an objection does", async () => {
  llm.onDecision = (_id, question, state) =>
    question.type === "choice"
      ? { type: "choice", choice: String(state["microphone_heard"]).includes("attends") ? "interrupt" : "backchannel" }
      : noul(0.9);
  llm.script({ text: ["Voici une longue explication. ", "Elle continue encore"], hangMs: 1500 }, { text: ["Oui ?"] });
  const c = await open({}, deciding);
  assert.equal((await c.next("ready")).deciderModel, "mock-decider");
  c.sendJson({ type: "text", text: "explique" });
  while (c.audio.length === 0) await sleep(10);

  // The word-overlap rule alone would take this for the user cutting in.
  c.turn("start");
  c.say("ok d'accord");
  c.turn("end");
  await sleep(150);
  assert.equal(c.events.some((e) => e.type === "interrupt"), false);
  assert.deepEqual(llm.decisions[0]?.state, {
    assistant_is_saying: "Voici une longue explication. Elle continue encore",
    microphone_heard: "ok d'accord",
  });

  c.turn("start");
  c.say("non attends");
  await c.next("interrupt");
  c.turn("end");
  assert.equal((await c.next("user_turn", 1)).text, "non attends");
  await c.next("response_done");
  c.ws.close();
});

test("decider: a sentence left hanging is given time to be finished", async () => {
  llm.onDecision = (_id, _q, state) => noul(String(state["user_said"]).endsWith("que tu") ? 0.05 : 0.95);
  llm.script({ text: ["C'est fait."] });
  const c = await open({ speculate: false }, deciding);
  await c.next("ready");
  c.turn("start");
  c.say("je voudrais que tu");
  c.turn("end");
  await sleep(250);
  assert.equal(c.events.some((e) => e.type === "user_turn"), false); // held open, not answered
  assert.equal(llm.requests.length, 0);

  c.turn("start");
  c.say(" changes la couleur");
  c.turn("end");
  assert.equal((await c.next("user_turn")).text, "je voudrais que tu changes la couleur");
  await c.next("response_done");
  assert.equal(llm.requests.length, 1);
  c.ws.close();
});

test("decider: a hanging sentence is still answered if the user does not go on", async () => {
  llm.onDecision = () => noul(0.05);
  const c = await open({ speculate: false }, deciding);
  await c.next("ready");
  c.turn("start");
  c.say("et puis euh");
  c.turn("end");
  const started = Date.now();
  assert.equal((await c.next("user_turn")).text, "et puis euh");
  assert.ok(Date.now() - started >= 1000, "should have waited before answering");
  await c.next("response_done");
  c.ws.close();
});

test("decider: the LLM is only woken mid-sentence once there is something to act on", async () => {
  llm.onDecision = (_id, _q, state) => noul(String(state["user_is_saying"]).includes("rouge") ? 0.9 : 0.1);
  llm.script({ toolCalls: [{ id: "g1", name: "set_color", arguments: '{"color":"red"}' }] }, { text: ["Voilà."] });
  const c = await open({ tools: [{ name: "set_color", description: "Change the color", immediate: true }] }, deciding);
  await c.next("ready");
  c.turn("start");
  c.say("mets la page");
  await sleep(100);
  assert.equal(llm.decisions.length, 1, JSON.stringify(llm.decisions));
  assert.equal(llm.requests.length, 0); // "nothing to do yet": the LLM was not called
  c.say(" en rouge");
  const call = await c.next("tool_call");
  assert.equal(call.early, true);
  assert.deepEqual(llm.decisions.at(-1)?.state, {
    user_is_saying: "mets la page en rouge",
    tools: [{ name: "set_color", description: "Change the color" }],
    already_done: [],
  });
  c.ws.close();
});

test("decider: when it fails, the conversation falls back on its rules of thumb", async () => {
  llm.onDecision = () => "fail";
  llm.script({ text: ["Une phrase pour commencer. ", "Puis une autre"], hangMs: 1500 }, { text: ["Oui ?"] });
  const c = await open({}, deciding);
  await c.next("ready");
  c.sendJson({ type: "text", text: "raconte" });
  while (c.audio.length === 0) await sleep(10);
  c.turn("start");
  c.say("attends stop");
  await c.next("interrupt");
  c.turn("end");
  assert.equal((await c.next("user_turn", 1)).text, "attends stop");
  c.ws.close();
});

test("POST /v1/decide relays typed questions to the decision model", async () => {
  llm.onDecision = (id) => (id === "urgent" ? noul(0.8) : { type: "choice", choice: "billing" });
  const ask = (target: RunningServer, body: unknown) =>
    fetch(`http://127.0.0.1:${target.port}/v1/decide`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const body = {
    model: "liquid/d1.1",
    state: { ticket: "Je n'arrive plus à payer" },
    questions: {
      urgent: { type: "noul", instructions: "Is it urgent?" },
      team: { type: "choice", criteria: { billing: "Payments", tech: "Bugs" } },
    },
  };
  const ok = await ask(deciding, body);
  assert.equal(ok.status, 200);
  const result = (await ok.json()) as { answers: Record<string, unknown>; model: string; latencyMs: number };
  assert.deepEqual(result.answers, { urgent: noul(0.8), team: { type: "choice", choice: "billing" } });
  assert.equal(result.model, "liquid/d1.1");
  assert.equal(typeof result.latencyMs, "number");
  assert.equal(llm.decisions[0]?.model, "liquid/d1.1");

  assert.equal((await ask(deciding, { state: "x" })).status, 400);
  assert.equal((await ask(server, body)).status, 503); // no key configured there
});
