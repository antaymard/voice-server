/**
 * "System One" decisions: instead of writing text, a decision model reads a
 * state and answers typed questions (yes/no, one of several choices, a score)
 * with probabilities, in tens of milliseconds. Backed by OpenRouter's
 * Decisions API, which serves many such models (Jev, d1, Decider, …) behind
 * one contract, so the model is a configuration choice.
 */
import type { Context } from "hono";
import type { Config } from "./config.ts";

type Guidance = string | Record<string, unknown> | unknown[];

export type DecisionQuestion =
  /** Yes/no. `criteria` says what each answer means. */
  | { type: "noul"; instructions?: Guidance; criteria?: { true?: Guidance; false?: Guidance } }
  /** One of the keys of `criteria`. */
  | { type: "choice"; instructions?: Guidance; criteria: Record<string, Guidance> }
  /** A position on the ordered scale `criteria` describes (lowest first). */
  | { type: "score"; instructions?: Guidance; criteria: Guidance[] };

export type DecisionAnswer =
  /** `noul` = probability that the answer is yes. */
  | { type: "noul"; noul: number; confidence?: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: "score"; score: number; probabilities?: Record<string, number>; confidence?: number }
  | { type: "refusal" };

export type DecisionRequest = {
  /** Defaults to the server's DECIDER_MODEL. */
  model?: string;
  /** What the questions are about: text or JSON. */
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
};

export type DecisionResult = {
  answers: Record<string, DecisionAnswer>;
  model: string;
  provider?: string;
  usage?: unknown;
  /** Round trip as seen from this server. */
  latencyMs: number;
};

export type Decider = (request: DecisionRequest) => Promise<DecisionResult>;

export class DeciderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** null when no key is configured. */
export function createDecider(config: Config): Decider | null {
  if (!config.deciderApiKey) return null;
  return async ({ model, state, questions, signal }) => {
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(config.deciderUrl, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${config.deciderApiKey}` },
        body: JSON.stringify({ model: model || config.deciderModel, state, questions }),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new DeciderError(502, `Could not reach the decision service: ${String(err)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new DeciderError(response.status, `Decision service answered ${response.status}: ${text.slice(0, 500)}`);
    }
    let body: { answers?: Record<string, DecisionAnswer>; model?: string; provider?: string; usage?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      throw new DeciderError(502, "Decision service returned a non-JSON body");
    }
    return {
      answers: body.answers ?? {},
      model: body.model ?? model ?? config.deciderModel,
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.usage !== undefined ? { usage: body.usage } : {}),
      latencyMs: Math.round(performance.now() - started),
    };
  };
}

/** `POST /v1/decide`: ask a decision model typed questions about a state. */
export function createDecideHandler(decider: Decider | null) {
  return async (c: Context): Promise<Response> => {
    if (!decider) {
      return c.json(
        { error: { code: "decide_disabled", message: "Set OPENROUTER_API_KEY (or DECIDER_API_KEY) to enable decisions" } },
        503,
      );
    }
    const badRequest = (message: string) => c.json({ error: { code: "bad_request", message } }, 400);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await c.req.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return badRequest("Body must be a JSON object");
    }
    const { model, state, questions } = body;
    if (model !== undefined && typeof model !== "string") return badRequest("`model` must be a string");
    if (state === undefined) return badRequest("Provide `state`: the text or JSON the questions are about");
    if (typeof questions !== "object" || questions === null || Array.isArray(questions) || Object.keys(questions).length === 0) {
      return badRequest("Provide `questions`: an object of { type: \"noul\" | \"choice\" | \"score\", instructions, criteria }");
    }
    try {
      const result = await decider({
        ...(model ? { model } : {}),
        state,
        questions: questions as Record<string, DecisionQuestion>,
      });
      return c.json(result);
    } catch (err) {
      const status = err instanceof DeciderError ? err.status : 502;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[decide] upstream error (${status}):`, message);
      // The caller's request was wrong (4xx other than auth) or the upstream failed.
      if (status === 400 || status === 404 || status === 413) return c.json({ error: { code: "bad_request", message } }, 400);
      if (status === 401 || status === 403 || status === 402) return c.json({ error: { code: "upstream_auth", message } }, 502);
      return c.json({ error: { code: "upstream_error", message } }, 502);
    }
  };
}
