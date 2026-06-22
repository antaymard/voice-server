import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TARGET_DELAY_MS,
  MIN_TARGET_DELAY_MS,
  normalizeStart,
  parseClientMessage,
  parseServerEvent,
} from "../client/src/protocol.ts";

test("parseClientMessage accepts valid messages", () => {
  assert.deepEqual(parseClientMessage('{"type":"start"}'), {
    type: "start",
    sampleRate: undefined,
    targetDelayMs: undefined,
  });
  assert.deepEqual(parseClientMessage('{"type":"start","sampleRate":16000,"targetDelayMs":300}'), {
    type: "start",
    sampleRate: 16000,
    targetDelayMs: 300,
  });
  assert.deepEqual(parseClientMessage('{"type":"flush"}'), { type: "flush" });
  assert.deepEqual(parseClientMessage('{"type":"stop"}'), { type: "stop" });
});

test("parseClientMessage rejects junk", () => {
  assert.equal(parseClientMessage("not json"), null);
  assert.equal(parseClientMessage("42"), null);
  assert.equal(parseClientMessage('{"type":"unknown"}'), null);
  assert.equal(parseClientMessage('{"type":"start","sampleRate":"16000"}'), null);
  assert.equal(parseClientMessage('{"type":"start","targetDelayMs":"fast"}'), null);
});

test("normalizeStart applies defaults and clamps the delay", () => {
  assert.deepEqual(normalizeStart({ type: "start" }, 480), {
    sampleRate: 16000,
    targetDelayMs: 480,
  });
  assert.deepEqual(normalizeStart({ type: "start", targetDelayMs: 1 }, 480), {
    sampleRate: 16000,
    targetDelayMs: MIN_TARGET_DELAY_MS,
  });
  assert.deepEqual(normalizeStart({ type: "start", targetDelayMs: 99999 }, 480), {
    sampleRate: 16000,
    targetDelayMs: MAX_TARGET_DELAY_MS,
  });
  assert.deepEqual(normalizeStart({ type: "start", sampleRate: 48000, targetDelayMs: 300 }, 480), {
    sampleRate: 48000,
    targetDelayMs: 300,
  });
});

test("normalizeStart rejects unsupported sample rates", () => {
  assert.equal(normalizeStart({ type: "start", sampleRate: 12345 }, 480), null);
  assert.equal(normalizeStart({ type: "start", sampleRate: 0 }, 480), null);
});

test("parseServerEvent round-trips known events and rejects junk", () => {
  assert.deepEqual(parseServerEvent('{"type":"delta","text":"hello "}'), {
    type: "delta",
    text: "hello ",
  });
  assert.equal(parseServerEvent('{"type":"nope"}'), null);
  assert.equal(parseServerEvent("garbage"), null);
});
