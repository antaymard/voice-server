/**
 * Cuts a stream of LLM text into chunks worth sending to the speech model:
 * whole sentences, so the voice keeps a natural prosody, emitted as soon as
 * each one is complete so audio starts before the reply is fully written —
 * and, for the very first chunk, as soon as a clause is.
 */

/** Below this, a "sentence" is glued to the next one ("Oui. Bien sûr."). */
const MIN_CHARS = 12;
/** A sentence running longer than this is cut at a comma or a space. */
const MAX_CHARS = 240;

/**
 * The first chunk of an utterance may stop at a clause (a comma) once it is
 * this long: the voice starts on "Je regarde ça," instead of waiting for the
 * end of a long opening sentence. Later chunks are already queued behind
 * audio, so they stay whole sentences, which sound better.
 */
const FIRST_CLAUSE_MIN_CHARS = 20;

// End punctuation (plus closing quotes/brackets) followed by whitespace, or a line break.
const BOUNDARY = /[.!?…]+["'»)\]]*\s+|\n+/g;
// A clause break: comma, semicolon or colon followed by whitespace, or a spaced dash.
const CLAUSE = /[,;:]\s+|\s[—–]\s+/g;

export type SentenceSplitter = {
  /**
   * Feed a text delta; returns the sentences it completes, with their
   * original spacing (the returned sentences plus `pending()` always add up
   * to the text pushed so far).
   */
  push: (delta: string) => string[];
  /** The unfinished sentence so far. */
  pending: () => string;
  /** Returns whatever is left (call once the text is complete). */
  flush: () => string[];
};

export function createSentenceSplitter(): SentenceSplitter {
  let buffer = "";
  let started = false;

  const take = (end: number): string => {
    const chunk = buffer.slice(0, end);
    buffer = buffer.slice(end);
    return chunk;
  };

  const drain = (): string[] => {
    const out: string[] = [];
    for (;;) {
      let cut = -1;
      BOUNDARY.lastIndex = 0;
      for (let m = BOUNDARY.exec(buffer); m; m = BOUNDARY.exec(buffer)) {
        const end = m.index + m[0].length;
        if (buffer.slice(0, end).trim().length >= MIN_CHARS) {
          cut = end;
          break;
        }
      }
      if (!started) {
        const limit = cut < 0 ? buffer.length : cut;
        CLAUSE.lastIndex = 0;
        for (let m = CLAUSE.exec(buffer); m; m = CLAUSE.exec(buffer)) {
          const end = m.index + m[0].length;
          if (end >= limit) break;
          if (buffer.slice(0, end).trim().length >= FIRST_CLAUSE_MIN_CHARS) {
            cut = end;
            break;
          }
        }
      }
      if (cut < 0 && buffer.length > MAX_CHARS) {
        const head = buffer.slice(0, MAX_CHARS);
        const soft = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "));
        cut = soft > MIN_CHARS ? soft + 2 : head.lastIndexOf(" ") + 1 || MAX_CHARS;
      }
      if (cut < 0) return out;
      const chunk = take(cut);
      if (chunk.trim()) {
        out.push(chunk);
        started = true;
      }
    }
  };

  return {
    push: (delta) => {
      buffer += delta;
      return drain();
    },
    pending: () => buffer,
    flush: () => {
      const rest = buffer;
      buffer = "";
      return rest.trim() ? [rest] : [];
    },
  };
}

/**
 * Text as it should be spoken: markdown markup removed (a model told to speak
 * plainly still slips sometimes). Returns "" when nothing is pronounceable.
 */
export function toSpeakable(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>|~]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(plain) ? plain : "";
}
