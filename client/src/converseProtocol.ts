/**
 * Wire protocol of the voice-server `/v1/converse` WebSocket endpoint: a live
 * voice conversation (speech in, speech out) with tool calls executed by the
 * client app. Single source of truth: the server imports these types.
 *
 * Transport rules:
 * - Client -> server: one `start` text frame first, then raw binary frames of
 *   PCM s16le mono mic audio at the declared sample rate, plus the optional
 *   text frames below (`tool_result`, `text`, `interrupt`, `stop`).
 * - Server -> client: JSON text frames (`ConverseServerEvent`) and binary
 *   frames of assistant speech (PCM s16le mono, rate given in `ready.audio`).
 *   Binary frames always belong to the response announced by the latest
 *   `response_start`; after an `interrupt` event, drop any queued audio.
 */
import {
  normalizeStart,
  type SampleRate,
  type TurnDetectionOptions,
  type TurnPhase,
} from "./protocol.ts";

export const MAX_TOOLS = 32;
export const MAX_INSTRUCTIONS_CHARS = 20_000;
export const MAX_HISTORY_MESSAGES = 100;
export const MAX_TOOL_OUTPUT_CHARS = 50_000;
export const MAX_TEXT_CHARS = 8_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
export const MAX_TOOL_TIMEOUT_MS = 120_000;

/** A function the model may call; the client app executes it. */
export type ToolDefinition = {
  /** Letters, digits, `_` and `-` (max 64). */
  name: string;
  description?: string;
  /** JSON Schema of the arguments object. Default: no arguments. */
  parameters?: Record<string, unknown>;
  /**
   * Safe to run before the user's turn is confirmed (read-only, no side
   * effects). Such calls can be sent while the user is still finishing their
   * sentence, and may be followed by `tool_cancel`. Default false: the call is
   * only sent once the turn is final.
   */
  speculative?: boolean;
  /**
   * May run while the user is still in the middle of their sentence, as soon
   * as that part of the request is clear ("turn the page red, and then…" —
   * the page turns red while they go on). Unlike `speculative`, this is for
   * tools with visible effects, and nothing undoes them if the user changes
   * their mind: keep it for actions that are cheap to correct. Default false.
   */
  immediate?: boolean;
};

export type HistoryMessage = { role: "user" | "assistant"; content: string };

export type ConverseStartMessage = {
  type: "start";
  /** Sample rate of the mic PCM frames. Default 16000. */
  sampleRate?: number;
  /** Transcription latency/accuracy tradeoff (see the realtime protocol). */
  targetDelayMs?: number;
  /** Pin the spoken language (ISO 639-1); omit to auto-detect. */
  language?: string;
  /** Names and terms to spell correctly in the transcript. */
  contextBias?: string[];
  /** Turn detection tuning; omitted fields use Mistral's defaults. */
  turnDetection?: TurnDetectionOptions;
  /** System prompt: who the assistant is and what it should do. */
  instructions?: string;
  tools?: ToolDefinition[];
  /** Earlier turns, to resume a conversation. */
  history?: HistoryMessage[];
  /** LLM provider name (server-configured); omit for the default one. */
  provider?: string;
  /** LLM model; must be allowed by the server. Omit for the default. */
  model?: string;
  /** Voice id for the assistant's speech; omit for the server default. */
  voice?: string;
  /**
   * Let the user interrupt the assistant by speaking. Default true. The
   * server ignores the assistant's own voice picked up by the mic; `false`
   * ignores the mic entirely while the assistant speaks.
   */
  bargeIn?: boolean;
  /**
   * Start thinking as soon as the user has *probably* finished (`eager_end`),
   * discarding the work if they resume. Default true.
   */
  speculate?: boolean;
  /**
   * Consult the model while the user is still speaking, so it can call
   * `immediate` and `speculative` tools mid-sentence. Costs extra LLM calls
   * (a few per long sentence); has no effect without such tools. Default true.
   */
  actEarly?: boolean;
  /**
   * Use the server's fast decision model (when configured) to tell an
   * interruption from an acknowledgement or an echo, to notice a sentence
   * left hanging, and to judge when to act mid-sentence. Default true;
   * `false` falls back to simple rules.
   */
  decide?: boolean;
  /** How long a response waits for a `tool_result` before moving on. */
  toolTimeoutMs?: number;
};

/**
 * Outcome of a tool call. May arrive after the response moved on (timeout or
 * interruption): the result is then added to the conversation and, when
 * nobody is speaking, the assistant reports it.
 */
export type ToolResultMessage = {
  type: "tool_result";
  callId: string;
  /** What the model should know about the outcome (text or JSON string). */
  output: string;
  isError?: boolean;
};

/** A typed user message: handled like a finished spoken turn. */
export type TextMessage = { type: "text"; text: string };

/** Stop the assistant's current response (e.g. a "stop" button). */
export type InterruptMessage = { type: "interrupt" };

/** End the session. */
export type ConverseStopMessage = { type: "stop" };

export type ConverseClientMessage =
  | ConverseStartMessage
  | ToolResultMessage
  | TextMessage
  | InterruptMessage
  | ConverseStopMessage;

export type ConverseReadyEvent = {
  type: "ready";
  requestId: string;
  sttModel: string;
  ttsModel: string;
  llmProvider: string;
  llmModel: string;
  /** Decision model in use for this conversation, or null. */
  deciderModel: string | null;
  /** Format of the binary frames the server sends. */
  audio: { encoding: "pcm_s16le"; sampleRate: number; channels: 1 };
};

/** Live transcript of the user's speech, append-only. */
export type TranscriptEvent = { type: "transcript"; text: string };

export type ConverseTurnEvent = { type: "turn"; phase: TurnPhase };

/** The user's finished turn, as given to the model. */
export type UserTurnEvent = { type: "user_turn"; text: string };

export type ResponseStartEvent = { type: "response_start"; responseId: string };

/** Text of the assistant's reply, as it is generated (ahead of the audio). */
export type AssistantDeltaEvent = { type: "assistant_delta"; responseId: string; text: string };

/** Run this tool and answer with a `tool_result` carrying the same `callId`. */
export type ToolCallEvent = {
  type: "tool_call";
  /** null for a call made while the user was still speaking (`early`). */
  responseId: string | null;
  callId: string;
  name: string;
  /** Arguments as a JSON string (as produced by the model: validate it). */
  arguments: string;
  /** Sent before the user's turn was final; a `tool_cancel` may follow. */
  speculative: boolean;
  /** Decided mid-sentence, while the user was still speaking. */
  early: boolean;
};

/** A speculative call is no longer needed: its result will be ignored. */
export type ToolCancelEvent = { type: "tool_cancel"; callId: string };

export type ResponseDoneEvent = { type: "response_done"; responseId: string; text: string };

/**
 * The response was cut short (the user spoke, or sent `interrupt`): stop
 * playback and drop queued audio. `heardText` is the server's estimate of
 * what was played, which is what the model remembers having said.
 */
export type InterruptEvent = { type: "interrupt"; responseId: string; heardText: string };

/** A response failed; the session goes on. */
export type ResponseErrorEvent = {
  type: "response_error";
  responseId: string;
  code: "llm_error" | "tts_error";
  message: string;
};

export type ConverseErrorCode =
  | "bad_message"
  | "idle_timeout"
  | "session_too_long"
  | "upstream_error"
  | "backpressure"
  | "server_shutdown"
  | "server_error";

/** Fatal: the socket closes right after. */
export type ConverseErrorEvent = { type: "error"; code: ConverseErrorCode; message: string };

export type ConverseServerEvent =
  | ConverseReadyEvent
  | TranscriptEvent
  | ConverseTurnEvent
  | UserTurnEvent
  | ResponseStartEvent
  | AssistantDeltaEvent
  | ToolCallEvent
  | ToolCancelEvent
  | ResponseDoneEvent
  | InterruptEvent
  | ResponseErrorEvent
  | ConverseErrorEvent;

export type ConverseStartParams = {
  sampleRate: SampleRate;
  targetDelayMs: number;
  language?: string;
  contextBias?: string[];
  turnDetection: Required<TurnDetectionOptions>;
  instructions: string;
  tools: Required<ToolDefinition>[];
  history: HistoryMessage[];
  provider?: string;
  model?: string;
  voice?: string;
  bargeIn: boolean;
  speculate: boolean;
  actEarly: boolean;
  decide: boolean;
  toolTimeoutMs: number;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const optionalBoolean = (value: unknown): value is boolean | undefined =>
  value === undefined || typeof value === "boolean";

/** Shape check only; `normalizeConverseStart` validates the values. */
export function parseConverseClientMessage(raw: string): ConverseClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(msg)) return null;
  switch (msg["type"]) {
    case "start":
      return msg as ConverseStartMessage;
    case "tool_result":
      if (typeof msg["callId"] !== "string" || typeof msg["output"] !== "string") return null;
      if (!optionalBoolean(msg["isError"])) return null;
      return { type: "tool_result", callId: msg["callId"], output: msg["output"], isError: msg["isError"] };
    case "text":
      return typeof msg["text"] === "string" ? { type: "text", text: msg["text"] } : null;
    case "interrupt":
      return { type: "interrupt" };
    case "stop":
      return { type: "stop" };
    default:
      return null;
  }
}

function normalizeTools(value: unknown): Required<ToolDefinition>[] | { error: string } {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return { error: "`tools` must be an array" };
  if (value.length > MAX_TOOLS) return { error: `At most ${MAX_TOOLS} tools are supported` };
  const tools: Required<ToolDefinition>[] = [];
  for (const tool of value) {
    if (!isObject(tool) || typeof tool["name"] !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool["name"])) {
      return { error: "Each tool needs a `name` made of letters, digits, `_` or `-` (max 64)" };
    }
    const name = tool["name"];
    if (tools.some((t) => t.name === name)) return { error: `Duplicate tool name "${name}"` };
    if (!optionalString(tool["description"])) return { error: `Tool "${name}": \`description\` must be a string` };
    if (tool["parameters"] !== undefined && !isObject(tool["parameters"])) {
      return { error: `Tool "${name}": \`parameters\` must be a JSON Schema object` };
    }
    if (!optionalBoolean(tool["speculative"])) return { error: `Tool "${name}": \`speculative\` must be a boolean` };
    if (!optionalBoolean(tool["immediate"])) return { error: `Tool "${name}": \`immediate\` must be a boolean` };
    tools.push({
      name,
      description: tool["description"] ?? "",
      parameters: (tool["parameters"] as Record<string, unknown>) ?? { type: "object", properties: {} },
      speculative: tool["speculative"] === true,
      immediate: tool["immediate"] === true,
    });
  }
  return tools;
}

function normalizeHistory(value: unknown): HistoryMessage[] | { error: string } {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return { error: "`history` must be an array" };
  if (value.length > MAX_HISTORY_MESSAGES) {
    return { error: `\`history\` holds at most ${MAX_HISTORY_MESSAGES} messages` };
  }
  const history: HistoryMessage[] = [];
  for (const entry of value) {
    if (
      !isObject(entry) ||
      (entry["role"] !== "user" && entry["role"] !== "assistant") ||
      typeof entry["content"] !== "string" ||
      !entry["content"]
    ) {
      return { error: "`history` entries need a `role` (user/assistant) and non-empty `content`" };
    }
    history.push({ role: entry["role"], content: entry["content"] });
  }
  return history;
}

/**
 * Validate a start message. Bad options are rejected here (close 4400, which
 * clients don't retry) rather than failing mid-conversation.
 */
export function normalizeConverseStart(
  msg: ConverseStartMessage,
  defaultTargetDelayMs: number,
): ConverseStartParams | { error: string } {
  const raw = msg as unknown as Record<string, unknown>;
  for (const key of ["sampleRate", "targetDelayMs", "toolTimeoutMs"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "number") return { error: `\`${key}\` must be a number` };
  }
  for (const key of ["language", "instructions", "provider", "model", "voice"]) {
    if (!optionalString(raw[key])) return { error: `\`${key}\` must be a string` };
  }
  for (const key of ["bargeIn", "speculate", "actEarly", "decide"]) {
    if (!optionalBoolean(raw[key])) return { error: `\`${key}\` must be a boolean` };
  }
  if (raw["contextBias"] !== undefined) {
    const bias = raw["contextBias"];
    if (!Array.isArray(bias) || !bias.every((t) => typeof t === "string")) {
      return { error: "`contextBias` must be an array of strings" };
    }
  }
  if (raw["turnDetection"] !== undefined) {
    const turn = raw["turnDetection"];
    if (!isObject(turn) || !Object.values(turn).every((v) => typeof v === "number" && Number.isFinite(v))) {
      return { error: "`turnDetection` must be an object of numbers" };
    }
  }

  // Audio/transcription options follow the realtime protocol's rules.
  const stt = normalizeStart(
    {
      type: "start",
      sampleRate: msg.sampleRate,
      targetDelayMs: msg.targetDelayMs,
      language: msg.language,
      contextBias: msg.contextBias,
      turnDetection: msg.turnDetection ?? true,
    },
    defaultTargetDelayMs,
  );
  if ("error" in stt) return stt;

  const instructions = msg.instructions ?? "";
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
    return { error: `\`instructions\` exceeds ${MAX_INSTRUCTIONS_CHARS} characters` };
  }
  const tools = normalizeTools(raw["tools"]);
  if ("error" in tools) return tools;
  const history = normalizeHistory(raw["history"]);
  if ("error" in history) return history;

  const toolTimeoutMs = msg.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs <= 0 || toolTimeoutMs > MAX_TOOL_TIMEOUT_MS) {
    return { error: `\`toolTimeoutMs\` must be an integer between 1 and ${MAX_TOOL_TIMEOUT_MS}` };
  }

  return {
    sampleRate: stt.sampleRate,
    targetDelayMs: stt.targetDelayMs,
    ...(stt.language ? { language: stt.language } : {}),
    ...(stt.contextBias ? { contextBias: stt.contextBias } : {}),
    turnDetection: stt.turnDetection as Required<TurnDetectionOptions>,
    instructions,
    tools,
    history,
    ...(msg.provider ? { provider: msg.provider } : {}),
    ...(msg.model ? { model: msg.model } : {}),
    ...(msg.voice ? { voice: msg.voice } : {}),
    bargeIn: msg.bargeIn !== false,
    speculate: msg.speculate !== false,
    actEarly: msg.actEarly !== false,
    decide: msg.decide !== false,
    toolTimeoutMs,
  };
}

export function parseConverseServerEvent(raw: string): ConverseServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value["type"] !== "string") return null;
  return value as ConverseServerEvent;
}
