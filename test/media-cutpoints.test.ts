import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeCutPoints, parseSilenceDetect, silenceMidpoints } from "../src/media/cutPoints.ts";
import { summarizeProbe } from "../src/media/ffmpeg.ts";

function assertStrictlyIncreasingFromZero(cuts: number[]): void {
  assert.equal(cuts[0], 0);
  for (let i = 1; i < cuts.length; i++) {
    assert.ok((cuts[i] as number) > (cuts[i - 1] as number), `cuts not increasing: ${cuts.join(", ")}`);
  }
}

test("a file no longer than part_seconds is a single part", () => {
  assert.deepEqual(computeCutPoints(900, [300, 600], 1200, 60), [0]);
  assert.deepEqual(computeCutPoints(1200, [], 1200, 60), [0]);
});

test("cuts on the silence closest to the target, within the window", () => {
  // Targets: 1200 then (cut + 1200). 1150 and 1230 are both in [1140, 1260];
  // 1230 is closer. 1500 is outside the window.
  const cuts = computeCutPoints(3000, [1150, 1230, 1500, 2410.5], 1200, 60);
  assert.deepEqual(cuts, [0, 1230, 2410.5]);
});

test("hard cut at the target when no silence is in the window", () => {
  const cuts = computeCutPoints(3000, [100, 1500], 1200, 60);
  assert.deepEqual(cuts, [0, 1200, 2400]);
});

test("a too-short trailing part is merged into the previous one", () => {
  // 2410 - 2400 = 10 s left < 30 s: the last cut is dropped.
  assert.deepEqual(computeCutPoints(2410, [], 1200, 60), [0, 1200]);
  // 40 s left is kept.
  assert.deepEqual(computeCutPoints(2440, [], 1200, 60, 30), [0, 1200, 2400]);
  // Threshold is configurable.
  assert.deepEqual(computeCutPoints(2440, [], 1200, 60, 60), [0, 1200]);
});

test("cuts are strictly increasing, start at 0 and stay inside the file", () => {
  const silences = [5, 290, 310, 590, 601, 899, 1190, 1195, 1210, 1490];
  const cuts = computeCutPoints(1512.345, silences, 300, 60);
  assertStrictlyIncreasingFromZero(cuts);
  assert.ok(cuts.every((c) => c < 1512.345));
  // A window wider than a part must still never go backwards.
  const wide = computeCutPoints(1000, [10, 20, 30, 250, 260], 300, 400);
  assertStrictlyIncreasingFromZero(wide);
  // Long file with no silence at all.
  const hard = computeCutPoints(25211.84, [], 1200, 60);
  assertStrictlyIncreasingFromZero(hard);
  assert.equal(hard.length, 21);
});

test("cut points are rounded to the millisecond", () => {
  const cuts = computeCutPoints(3000, [1200.123456], 1200, 60);
  assert.deepEqual(cuts, [0, 1200.123, 2400.123]);
});

test("parseSilenceDetect reads real ffmpeg stderr", () => {
  const stderr = readFileSync(new URL("./fixtures/silencedetect-stderr.txt", import.meta.url), "utf8");
  const silences = parseSilenceDetect(stderr);
  // The first silence_start shares a line with the progress output.
  assert.deepEqual(silences, [
    { start: 10, end: 12.0001 },
    { start: 20.5, end: 21.3001 },
    { start: 33, end: 40 },
  ]);
  assert.deepEqual(silenceMidpoints(silences), [11.00005, 20.90005, 36.5]);
});

test("parseSilenceDetect ignores a silence left open at end of file", () => {
  const stderr = [
    "[silencedetect @ 0x1] silence_start: -0.00125",
    "[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.50125",
    "[silencedetect @ 0x1] silence_start: 42.25",
  ].join("\n");
  assert.deepEqual(parseSilenceDetect(stderr), [{ start: 0, end: 1.5 }]);
});

test("summarizeProbe: duration, audio and video detection", () => {
  const audioWithCover = summarizeProbe({
    format: { duration: "25211.840000" },
    streams: [
      { codec_type: "audio", duration: "25211.8" },
      { codec_type: "video", disposition: { attached_pic: 1 } },
    ],
  });
  assert.deepEqual(audioWithCover, { hasAudio: true, hasVideo: false, durationSec: 25211.84 });

  const video = summarizeProbe({
    format: {},
    streams: [{ codec_type: "video", disposition: { attached_pic: 0 } }, { codec_type: "audio", duration: "12.5" }],
  });
  assert.deepEqual(video, { hasAudio: true, hasVideo: true, durationSec: 12.5 });

  assert.deepEqual(summarizeProbe({ format: { duration: "N/A" }, streams: [{ codec_type: "audio" }] }), {
    hasAudio: true,
    hasVideo: false,
    durationSec: null,
  });
  assert.equal(summarizeProbe({ streams: [{ codec_type: "video" }] }).hasAudio, false);
  assert.equal(summarizeProbe(null).durationSec, null);
});
