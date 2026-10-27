import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TARGET_DELAY_MS,
  MIN_TARGET_DELAY_MS,
  TURN_DETECTION_PRESETS,
  normalizeStart,
  normalizeTargetDelay,
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
    diarize: false,
  });
  assert.deepEqual(normalizeStart({ type: "start", targetDelayMs: 1 }, 480), {
    sampleRate: 16000,
    targetDelayMs: MIN_TARGET_DELAY_MS,
    diarize: false,
  });
  assert.deepEqual(normalizeStart({ type: "start", targetDelayMs: 99999 }, 480), {
    sampleRate: 16000,
    targetDelayMs: MAX_TARGET_DELAY_MS,
    diarize: false,
  });
  assert.deepEqual(normalizeStart({ type: "start", sampleRate: 48000, targetDelayMs: 300 }, 480), {
    sampleRate: 48000,
    targetDelayMs: 300,
    diarize: false,
  });
});

test("normalizeTargetDelay snaps the unsupported 1200-2400 gap", () => {
  assert.equal(normalizeTargetDelay(80), 80);
  assert.equal(normalizeTargetDelay(1200), 1200);
  assert.equal(normalizeTargetDelay(1500), 1200);
  assert.equal(normalizeTargetDelay(2000), 2400);
  assert.equal(normalizeTargetDelay(2400), 2400);
});

test("normalizeStart rejects unsupported sample rates", () => {
  for (const sampleRate of [12345, 0]) {
    const result = normalizeStart({ type: "start", sampleRate }, 480);
    assert.ok("error" in result);
    assert.match(result.error, /sampleRate/);
  }
});

test("parseClientMessage keeps Voxtral 3 session options and rejects bad shapes", () => {
  assert.deepEqual(
    parseClientMessage(
      JSON.stringify({
        type: "start",
        language: "fr",
        contextBias: ["Voxtral"],
        diarize: false,
        speakerReferences: { Alice: "QUFB" },
        turnDetection: { minSilenceMs: 300 },
      }),
    ),
    {
      type: "start",
      sampleRate: undefined,
      targetDelayMs: undefined,
      language: "fr",
      contextBias: ["Voxtral"],
      diarize: false,
      speakerReferences: { Alice: "QUFB" },
      turnDetection: { minSilenceMs: 300 },
    },
  );
  assert.equal(parseClientMessage('{"type":"start","language":42}'), null);
  assert.equal(parseClientMessage('{"type":"start","contextBias":"Voxtral"}'), null);
  assert.equal(parseClientMessage('{"type":"start","diarize":"yes"}'), null);
  assert.equal(parseClientMessage('{"type":"start","speakerReferences":{"A":1}}'), null);
  assert.equal(parseClientMessage('{"type":"start","turnDetection":"aggressive"}'), null);
});

test("normalizeStart resolves session options", () => {
  const params = normalizeStart(
    {
      type: "start",
      language: "FR",
      contextBias: [" Voxtral ", ""],
      turnDetection: TURN_DETECTION_PRESETS.aggressive,
    },
    480,
  );
  assert.ok(!("error" in params));
  assert.equal(params.language, "fr");
  assert.deepEqual(params.contextBias, ["Voxtral"]);
  assert.deepEqual(params.turnDetection, {
    startThreshold: 0.5,
    eagerEndThreshold: 0.4,
    endThreshold: 0.33,
    minSilenceMs: 300,
    endTimeoutMs: 2500,
  });

  const defaults = normalizeStart({ type: "start", turnDetection: true }, 480);
  assert.ok(!("error" in defaults));
  assert.equal(defaults.turnDetection?.endTimeoutMs, 3000);

  const refs = normalizeStart({ type: "start", speakerReferences: { Alice: "QUFB" } }, 480);
  assert.ok(!("error" in refs));
  assert.equal(refs.diarize, true, "speaker references imply diarization");
});

test("normalizeStart rejects invalid session options", () => {
  const cases: Array<[Parameters<typeof normalizeStart>[0], RegExp]> = [
    [{ type: "start", language: "french" }, /ISO 639-1/],
    [{ type: "start", diarize: true, turnDetection: true }, /not compatible/],
    [{ type: "start", speakerReferences: { A: "x" }, turnDetection: true }, /not compatible/],
    [{ type: "start", turnDetection: { endThreshold: 0.9 } }, /eagerEndThreshold > endThreshold/],
    [{ type: "start", turnDetection: { minSilenceMs: 5000 } }, /endTimeoutMs >= minSilenceMs/],
    [{ type: "start", turnDetection: { startThreshold: 2 } }, /between 0 and 1/],
    [{ type: "start", turnDetection: { bogus: 1 } as never }, /Unknown turnDetection/],
    [
      {
        type: "start",
        speakerReferences: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, "x"])),
      },
      /At most 8/,
    ],
  ];
  for (const [msg, pattern] of cases) {
    const result = normalizeStart(msg, 480);
    assert.ok("error" in result, `expected an error for ${JSON.stringify(msg)}`);
    assert.match(result.error, pattern);
  }
});

test("parseServerEvent round-trips known events and rejects junk", () => {
  assert.deepEqual(parseServerEvent('{"type":"delta","text":"hello "}'), {
    type: "delta",
    text: "hello ",
  });
  assert.deepEqual(parseServerEvent('{"type":"turn","phase":"end","time":1.5,"endReason":"timeout"}'), {
    type: "turn",
    phase: "end",
    time: 1.5,
    endReason: "timeout",
  });
  assert.equal(parseServerEvent('{"type":"nope"}'), null);
  assert.equal(parseServerEvent("garbage"), null);
});
