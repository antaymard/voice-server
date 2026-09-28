/**
 * Pure helpers for choosing where to split a long recording. Cutting in the
 * middle of a word degrades the transcript on both sides of the seam, so cuts
 * land in detected silences whenever one is close enough to the target.
 */

export type Silence = { start: number; end: number };

/** Round seconds to the millisecond (every number in the API is rounded this way). */
export function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Extract closed silences from ffmpeg `silencedetect` stderr. A silence still
 * open at end of file (no `silence_end`) is ignored.
 */
export function parseSilenceDetect(stderr: string): Silence[] {
  const silences: Silence[] = [];
  let openStart: number | null = null;
  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi;
  for (const match of stderr.matchAll(re)) {
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (match[1]?.toLowerCase() === "start") {
      openStart = value;
    } else if (openStart !== null) {
      silences.push({ start: Math.max(0, openStart), end: value });
      openStart = null;
    }
  }
  return silences;
}

export function silenceMidpoints(silences: Silence[]): number[] {
  return silences.map((s) => (s.start + s.end) / 2);
}

/**
 * Choose cut points: every `partSeconds`, cut at the silence midpoint closest
 * to the target within ±`windowSec`, or hard-cut at the target when there is
 * none. A trailing part shorter than `minLastPartSec` is merged into the
 * previous one. Returns strictly increasing cuts starting at 0 (rounded to the
 * millisecond); parts are `[cuts[i], cuts[i+1] ?? duration]`.
 */
export function computeCutPoints(
  durationSec: number,
  silenceMidpoints: number[],
  partSeconds: number,
  windowSec: number,
  minLastPartSec = 30,
): number[] {
  if (!(partSeconds > 0)) throw new RangeError("partSeconds must be positive");
  const cuts = [0];
  let last = 0;
  while (durationSec - last > partSeconds) {
    const target = last + partSeconds;
    let best: number | null = null;
    for (const mid of silenceMidpoints) {
      if (mid < target - windowSec || mid > target + windowSec) continue;
      // Keep cuts strictly increasing and strictly inside the file (also
      // guards against a window wider than a part).
      if (roundMs(mid) <= last || roundMs(mid) >= roundMs(durationSec)) continue;
      if (best === null || Math.abs(mid - target) < Math.abs(best - target)) best = mid;
    }
    const cut = roundMs(best ?? target);
    cuts.push(cut);
    last = cut;
  }
  if (cuts.length > 1 && durationSec - last < minLastPartSec) cuts.pop();
  return cuts;
}
