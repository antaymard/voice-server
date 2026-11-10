/**
 * One live voice conversation: listens (Voxtral realtime + turn detection),
 * thinks (any chat-completions LLM, with tool calls run by the client app)
 * and speaks (Voxtral TTS, sentence by sentence).
 *
 * What makes it feel live:
 * - Speculation: the reply starts being prepared on `eager_end` (the user
 *   has probably finished) and is held back until `end` confirms it; a
 *   `resume` throws it away. Nothing reaches the client before the turn is
 *   final, except calls to tools declared `speculative`.
 * - Barge-in: when the user speaks over the assistant, generation and speech
 *   stop, and the conversation history keeps only what was actually heard.
 *   A turn that starts while the assistant is audible only counts once it
 *   carries words that are not the assistant's own (echo from the speakers,
 *   a cough or a door slam don't cut it off).
 * - Acting mid-sentence: while the user is still speaking, the model is
 *   shown what they have said so far and may already call the tools declared
 *   `immediate` (or `speculative`). What it did is handed to the reply that
 *   follows, so nothing is done twice.
 * - Fast decisions: when a decision ("System One") model is configured, it
 *   settles in tens of milliseconds the calls that are judgment rather than
 *   writing: is this an interruption, an acknowledgement or an echo; was the
 *   sentence left hanging; is there already something to act on. Each has a
 *   rule of thumb to fall back on if the model is absent, slow or failing.
 * - Tools don't block the conversation: a call that outlives its response
 *   (timeout or interruption) keeps running client-side, and its result is
 *   picked up when it arrives.
 */
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { RealtimeTranscription } from "@mistralai/mistralai/extra/realtime";
import {
  MAX_TEXT_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  normalizeConverseStart,
  parseConverseClientMessage,
  type ConverseErrorCode,
  type ConverseServerEvent,
  type ConverseStartParams,
} from "../../client/src/converseProtocol.ts";
import {
  CLOSE_BAD_MESSAGE,
  CLOSE_DONE,
  CLOSE_IDLE_TIMEOUT,
  CLOSE_INTERNAL,
  CLOSE_SESSION_TOO_LONG,
  CLOSE_UPSTREAM_ERROR,
  type TurnPhase,
} from "../../client/src/protocol.ts";
import type { Config } from "../config.ts";
import type { Decider, DecisionAnswer, DecisionQuestion } from "../decide.ts";
import { toSessionUpdate } from "../realtime/bridge.ts";
import { connectTranscription, rawDataToBuffer, type Transcription } from "../realtime/upstream.ts";
import { resolveLlm, type ChatMessage, type Llm, type ToolCall } from "./llm.ts";
import { TTS_BYTES_PER_SECOND, TTS_SAMPLE_RATE, type Tts, type TtsStream } from "./tts.ts";

export type ConverseDeps = {
  realtime: RealtimeTranscription;
  llm: Llm;
  tts: Tts;
  /** null: no decision model configured, the session uses its rules of thumb. */
  decider: Decider | null;
};

const MAX_CLIENT_BUFFERED_BYTES = 8 * 1024 * 1024;
/** LLM turns per response (each tool round-trip costs one). */
const MAX_ROUNDS = 6;
/** Oldest turns are dropped past the first figure, down to the second. */
const HISTORY_HIGH_WATER = 120;
const HISTORY_LOW_WATER = 80;
/** Used to guess the length of a sentence whose audio is still being generated. */
const EST_BYTES_PER_CHAR = TTS_BYTES_PER_SECOND / 15;
/** The client plays slightly behind our clock (network, its jitter buffer). */
const PLAYBACK_MARGIN_MS = 250;
/** Share of the user's word pairs found in the assistant's speech that marks an echo. */
const ECHO_MATCH_RATIO = 0.6;

const VOICE_PREAMBLE =
  "You are a voice assistant in a live spoken conversation. Everything you write is read aloud: " +
  "use plain spoken sentences, with no markdown, lists, emojis or code. Keep replies short and natural, " +
  "and answer in the user's language. The user's words come from live speech recognition and may " +
  "contain transcription errors. If you were interrupted, your previous message only holds what the " +
  "user actually heard. A tool result marked as pending is still running: say so briefly and carry on; " +
  "its result will be given to you when it arrives.";

const LISTENING_PREAMBLE =
  "LISTENING MODE. The user is still speaking: their last message is unfinished and may stop " +
  "mid-sentence. Do not reply to them and do not ask anything. If a part of what they have said " +
  "so far is complete and unambiguous, and can be carried out with the available tools, call " +
  "those tools now; do not repeat a call already made. If nothing can be done yet, output nothing.";

/** A look at the unfinished sentence needs this many new words… */
const EARLY_MIN_NEW_WORDS = 4;
/** …and a clause boundary, or this many words without one. */
const EARLY_MAX_NEW_WORDS = 10;
const CLAUSE_BOUNDARY = /[,;:.!?…]/;
/** With a decision model as gatekeeper, looking is cheap: do it this often. */
const GATED_MIN_NEW_WORDS = 2;
/** Below this probability of "the user has finished", the turn is held open… */
const UNFINISHED_BELOW = 0.3;
/** Above this one, the reply starts at once instead of waiting out the pause. */
const FINISHED_ABOVE = 0.85;
/** Recent messages shown to the decision model for context. */
const DECISION_CONTEXT_MESSAGES = 4;
/** …for this long, in case they pick their sentence back up. */
const HOLD_OPEN_MS = 1200;

const INTENT_QUESTION: DecisionQuestion = {
  type: "choice",
  instructions:
    "A voice assistant is speaking out loud. Its microphone picked up `microphone_heard` meanwhile. What is it?",
  criteria: {
    interrupt:
      "The user is talking to the assistant: a new request, a question, a correction, a disagreement, or asking it to stop or wait.",
    backchannel:
      "The user is only showing they are listening (yes, ok, right, I see, mm-hm): the assistant should keep talking.",
    echo: "The microphone caught the assistant's own voice: the words repeat part of `assistant_is_saying`.",
  },
};

const FINISHED_QUESTION: DecisionQuestion = {
  type: "noul",
  instructions:
    "In a spoken conversation (`conversation` is how it went so far), the user has just paused. `user_said` is " +
    "everything they said this turn, `last_segment` the part since their previous pause. Have they finished what " +
    "they wanted to say, so that the assistant should start preparing its reply now?",
  criteria: {
    true: "The utterance is complete: a whole request, question, answer or remark that can be responded to.",
    false:
      "The sentence is left hanging: it stops mid-phrase, ends on a filler or a connective (and, but, so, uh…), or is missing the part that would make it actionable.",
  },
};

const ACTIONABLE_QUESTION: DecisionQuestion = {
  type: "noul",
  instructions:
    "The user is still speaking; `user_is_saying` is their sentence so far. Does it already contain a complete, unambiguous instruction that one of `tools` can carry out right now, and that is not in `already_done`?",
  criteria: {
    true: "Yes: a specific action is fully stated (what to do and with which values), whatever the user says next.",
    false: "No: nothing to do yet, the instruction is still incomplete or ambiguous, or it was already done.",
  },
};

const PENDING_TOOL_OUTPUT = JSON.stringify({
  status: "pending",
  note: "Still running. The result will be provided later in the conversation.",
});

/** One sentence handed to the speech model, and when its audio was sent. */
type Segment = {
  text: string;
  bytes: number;
  complete: boolean;
  /** `at` = estimated wall-clock time (ms) the chunk starts playing. */
  chunks: { at: number; bytes: number }[];
};

type Outgoing = { event: ConverseServerEvent } | { audio: Buffer; segment: Segment };

type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

type ResponseState = {
  id: string;
  abort: AbortController;
  /** False while the user's turn is not final: output is held in `outbox`. */
  committed: boolean;
  userText: string | null;
  outbox: Outgoing[];
  /** Messages produced before commit (they join the history on commit). */
  buffered: ChatMessage[];
  phase: "llm" | "tools" | "done";
  /** Text of the LLM turn being generated, and all turns so far. */
  roundText: string;
  text: string;
  /** Sentences of the current LLM turn, in speaking order. */
  segments: Segment[];
  /** The closing message, once written: trimmed if playback is interrupted. */
  finalMessage: AssistantMessage | null;
  ttsChain: Promise<void>;
  ttsFailed: boolean;
  /** Estimated time (ms) the audio sent so far finishes playing. */
  playhead: number;
  onCommit: Array<() => void>;
  clearTimer: NodeJS.Timeout | null;
};

type ToolWaiter = {
  response: ResponseState;
  call: ToolCall;
  resolve: (result: { output: string; isError: boolean } | null) => void;
};

/** How much of a sentence had been played at `now`, cut at a word boundary. */
function heardPart(segment: Segment, now: number): { text: string; whole: boolean } {
  let played = 0;
  for (const chunk of segment.chunks) {
    const elapsed = ((now - chunk.at) / 1000) * TTS_BYTES_PER_SECOND;
    played += Math.max(0, Math.min(chunk.bytes, elapsed));
  }
  const total = segment.complete
    ? segment.bytes
    : Math.max(segment.bytes, segment.text.length * EST_BYTES_PER_CHAR);
  const fraction = total > 0 ? played / total : 0;
  if (segment.complete && fraction >= 0.98) return { text: segment.text, whole: true };
  const cut = segment.text.slice(0, Math.floor(segment.text.length * fraction));
  return { text: cut.slice(0, Math.max(0, cut.lastIndexOf(" "))).trim(), whole: false };
}

function heardText(segments: Segment[], now: number): string {
  const parts: string[] = [];
  for (const segment of segments) {
    const { text, whole } = heardPart(segment, now);
    if (text) parts.push(text);
    if (!whole) break;
  }
  return parts.join(" ");
}

const HAS_WORDS = /[\p{L}\p{N}]/u;

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Is what the mic picked up the assistant's own voice coming back? Echo
 * repeats the assistant's words in order, so it shows up as shared word
 * pairs; a person talking over it says something else. "unknown" = no words.
 */
export function classifyEcho(heard: string, assistantSaid: string): "echo" | "speech" | "unknown" {
  const heardWords = wordsOf(heard);
  if (heardWords.length === 0) return "unknown";
  const said = wordsOf(assistantSaid);
  if (heardWords.length === 1) return said.includes(heardWords[0] as string) ? "echo" : "speech";
  const pairs = new Set<string>();
  for (let i = 0; i + 1 < said.length; i += 1) pairs.add(`${said[i]} ${said[i + 1]}`);
  let matches = 0;
  for (let i = 0; i + 1 < heardWords.length; i += 1) {
    if (pairs.has(`${heardWords[i]} ${heardWords[i + 1]}`)) matches += 1;
  }
  return matches / (heardWords.length - 1) >= ECHO_MATCH_RATIO ? "echo" : "speech";
}

/** Providers reject two user messages in a row: merge them. */
function mergeUserMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (message.role === "user" && last?.role === "user") {
      out[out.length - 1] = { role: "user", content: `${last.content}\n${message.content}` };
    } else {
      out.push(message);
    }
  }
  return out;
}

export function runConverseSession(
  ws: WebSocket,
  deps: ConverseDeps,
  config: Config,
  onClose: () => void,
): void {
  let upstream: Transcription | null = null;
  let params: ConverseStartParams | null = null;
  let llm: { name: string; provider: { baseUrl: string; apiKey: string }; model: string } | null = null;
  let finished = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let sessionTimer: NodeJS.Timeout | null = null;

  // Conversation state.
  const history: ChatMessage[] = [];
  let systemPrompt = VOICE_PREAMBLE;
  let userBuffer = "";
  let turnOpen = false;
  let settleTimer: NodeJS.Timeout | null = null;
  let settleDeadline = 0;
  let current: ResponseState | null = null;
  /**
   * The open user turn began while the assistant was audible: it is held
   * back (not shown, not acted on) until it proves to be the user speaking.
   */
  let suspect = false;
  let heldEvents: ConverseServerEvent[] = [];
  const waiters = new Map<string, ToolWaiter>();
  /** Calls whose response moved on; value = tool name. */
  const lateCalls = new Map<string, string>();
  /** Results of such calls, waiting to be shown to the model on its next turn. */
  let lateResults: string[] = [];
  /** Tool calls made while the user was still speaking, for the turn in progress. */
  let turnActions: { call: ToolCall; result: string | null }[] = [];
  /** The look at the unfinished sentence that is under way, if any. */
  let earlyPass: AbortController | null = null;
  /** Words of the turn the model has already looked at. */
  let wordsSeenEarly = 0;
  /** Same, for the last look that actually went to the LLM. */
  let wordsSeenByLlm = 0;
  /** A decision on the held (suspect) turn is in flight; a turn end waits for it. */
  let reviewing = false;
  let commitAfterReview = false;
  /** "Has the user finished?", asked ahead of the turn's end, for a given text. */
  let completeness: { text: string; verdict: Promise<number | null> } | null = null;
  /** The turn's end was put off once already, waiting for the user to go on. */
  let heldOpen = false;
  /** The user has paused (eager end) and has not resumed since. */
  let pausing = false;
  /** Length of the turn's transcript when the user last resumed after a pause. */
  let segmentStart = 0;
  let deciderWarned = false;

  const deciding = (): boolean => deps.decider !== null && params?.decide === true;

  /** One decision, or null when there is no decider, it is slow, or it failed. */
  const ask = async (question: DecisionQuestion, state: unknown): Promise<DecisionAnswer | null> => {
    if (!deps.decider || !deciding()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.deciderTimeoutMs);
    try {
      const { answers } = await deps.decider({ state, questions: { q: question }, signal: controller.signal });
      return answers["q"] ?? null;
    } catch (err) {
      if (!deciderWarned) {
        deciderWarned = true; // once per conversation is enough
        console.warn(
          `[converse] decision model ${controller.signal.aborted ? `slower than ${config.deciderTimeoutMs}ms` : "failed"}; using rules of thumb:`,
          controller.signal.aborted ? "" : err,
        );
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const finish = (code: number, reason: string): void => {
    if (finished) return;
    finished = true;
    for (const t of [idleTimer, sessionTimer, settleTimer, current?.clearTimer]) if (t) clearTimeout(t);
    current?.abort.abort();
    for (const waiter of waiters.values()) waiter.resolve(null);
    waiters.clear();
    onClose();
    upstream?.close();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    }
  };

  const writable = (): boolean => {
    if (finished || ws.readyState !== ws.OPEN) return false;
    if (ws.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
      finish(CLOSE_INTERNAL, "client_too_slow");
      return false;
    }
    return true;
  };

  const send = (event: ConverseServerEvent): void => {
    if (writable()) ws.send(JSON.stringify(event));
  };

  const fail = (code: ConverseErrorCode, message: string, closeCode: number): void => {
    if (finished) return;
    console.warn(`[converse] session error (${code}, close ${closeCode}): ${message}`);
    send({ type: "error", code, message });
    finish(closeCode, code);
  };

  const resetIdle = (): void => {
    if (finished) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => fail("idle_timeout", `No client frames for ${config.idleTimeoutMs}ms`, CLOSE_IDLE_TIMEOUT),
      config.idleTimeoutMs,
    );
  };

  // --- Output of a response -------------------------------------------------

  const sendAudio = (response: ResponseState, segment: Segment, audio: Buffer): void => {
    if (!writable()) return;
    const at = Math.max(response.playhead, Date.now());
    segment.chunks.push({ at, bytes: audio.length });
    response.playhead = at + (audio.length / TTS_BYTES_PER_SECOND) * 1000;
    ws.send(audio, { binary: true });
  };

  const emit = (response: ResponseState, item: Outgoing): void => {
    if (response.abort.signal.aborted) return;
    if (!response.committed) response.outbox.push(item);
    else if ("event" in item) send(item.event);
    else sendAudio(response, item.segment, item.audio);
  };

  const record = (response: ResponseState, message: ChatMessage): void => {
    (response.committed ? history : response.buffered).push(message);
  };

  /** Called when a response becomes real: its context joins the history. */
  const openTurn = (userText: string | null): void => {
    for (const content of lateResults) history.push({ role: "user", content });
    lateResults = [];
    if (userText) {
      history.push({ role: "user", content: userText });
      // What was already done mid-sentence follows the user's words, as if
      // the assistant had answered them with those calls.
      history.push(...takeTurnActions());
    }
    trimHistory();
  };

  const actionMessages = (): ChatMessage[] =>
    turnActions.length === 0
      ? []
      : [
          { role: "assistant", content: null, tool_calls: turnActions.map((a) => a.call) },
          ...turnActions.map((a) => toolMessage(a.call, a.result ?? PENDING_TOOL_OUTPUT)),
        ];

  /** The turn is final: its early actions leave the "in progress" state. */
  const takeTurnActions = (): ChatMessage[] => {
    earlyPass?.abort();
    earlyPass = null;
    wordsSeenEarly = 0;
    wordsSeenByLlm = 0;
    const messages = actionMessages();
    // Still running: their results will come in as late results.
    for (const action of turnActions) {
      if (action.result === null) lateCalls.set(action.call.id, action.call.function.name);
    }
    turnActions = [];
    return messages;
  };

  const trimHistory = (): void => {
    if (history.length <= HISTORY_HIGH_WATER) return;
    let drop = history.length - HISTORY_LOW_WATER;
    // Start on a user message so tool calls keep their results.
    while (drop < history.length && history[drop]?.role !== "user") drop += 1;
    history.splice(0, drop);
  };

  const buildMessages = (response: ResponseState): ChatMessage[] => {
    const pending: ChatMessage[] = response.committed
      ? []
      : [
          ...lateResults.map((content) => ({ role: "user" as const, content })),
          ...(response.userText ? [{ role: "user" as const, content: response.userText }] : []),
          ...(response.userText ? actionMessages() : []),
          ...response.buffered,
        ];
    return [{ role: "system", content: systemPrompt }, ...mergeUserMessages([...history, ...pending])];
  };

  /** Free the "assistant is speaking" slot once the audio has played out. */
  const scheduleClear = (response: ResponseState): void => {
    response.clearTimer = setTimeout(
      () => {
        if (current === response) current = null;
        if (suspect && !turnOpen && !settleTimer) dropTurn();
        followUpIfIdle();
      },
      Math.max(0, response.playhead - Date.now()) + PLAYBACK_MARGIN_MS,
    );
  };

  /** Relay one utterance's audio, after the previous utterances of the response. */
  const pumpSpeech = (response: ResponseState, stream: TtsStream, segments: Segment[]): void => {
    response.ttsChain = response.ttsChain.then(async () => {
      const { signal } = response.abort;
      try {
        for await (const item of stream.items) {
          if (signal.aborted) return;
          const segment = (segments[item.segment] ??= { text: "", bytes: 0, complete: false, chunks: [] });
          segment.text = item.text;
          if (item.audio) {
            segment.bytes += item.audio.length;
            emit(response, { audio: item.audio, segment });
          }
          if (item.done) segment.complete = true;
        }
      } catch (err) {
        if (signal.aborted) return;
        console.error("[converse] speech synthesis failed:", err);
        if (!response.ttsFailed) {
          response.ttsFailed = true;
          emit(response, {
            event: { type: "response_error", responseId: response.id, code: "tts_error", message: String(err) },
          });
        }
      }
    });
  };

  // --- Tools ----------------------------------------------------------------

  const toolMessage = (call: ToolCall, content: string): ChatMessage => ({
    role: "tool",
    tool_call_id: call.id,
    name: call.function.name,
    content,
  });

  const runTool = async (response: ResponseState, call: ToolCall): Promise<void> => {
    const tool = params?.tools.find((t) => t.name === call.function.name);
    if (!tool) {
      record(response, toolMessage(call, `Error: unknown tool "${call.function.name}"`));
      return;
    }
    if (!response.committed && !tool.speculative) {
      // Side effects wait for the user's turn to be final.
      await new Promise<void>((resolve) => response.onCommit.push(resolve));
      if (response.abort.signal.aborted) return;
    }
    send({
      type: "tool_call",
      responseId: response.id,
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      speculative: !response.committed,
      early: false,
    });
    let timer: NodeJS.Timeout | null = null;
    const result = await new Promise<{ output: string; isError: boolean } | null>((resolve) => {
      waiters.set(call.id, { response, call, resolve });
      timer = setTimeout(() => resolve(null), params?.toolTimeoutMs);
    });
    if (timer) clearTimeout(timer);
    // On abort, whoever aborted has already settled this call's bookkeeping.
    if (response.abort.signal.aborted) return;
    waiters.delete(call.id);
    if (result) {
      record(response, toolMessage(call, (result.isError ? "Error: " : "") + result.output));
    } else {
      lateCalls.set(call.id, call.function.name);
      record(response, toolMessage(call, PENDING_TOOL_OUTPUT));
    }
  };

  // --- Response lifecycle ---------------------------------------------------

  const runResponse = async (response: ResponseState): Promise<void> => {
    const { signal } = response.abort;
    const active = llm;
    if (!active || !params) return;
    let speech: TtsStream | null = null;
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        response.phase = "llm";
        response.roundText = "";
        response.segments = [];
        // Opened before the first word exists, so the voice is ready when it does.
        const voice = deps.tts({ voice: params.voice, signal });
        speech = voice;
        pumpSpeech(response, voice, response.segments);
        const calls: ToolCall[] = [];
        const stream = deps.llm({
          provider: active.provider,
          model: active.model,
          messages: buildMessages(response),
          tools: params.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
          signal,
        });
        for await (const chunk of stream) {
          if (signal.aborted) return;
          if (chunk.type === "tool_call") {
            calls.push(chunk.call);
            continue;
          }
          response.roundText += chunk.text;
          response.text += chunk.text;
          emit(response, { event: { type: "assistant_delta", responseId: response.id, text: chunk.text } });
          voice.write(chunk.text);
        }
        if (signal.aborted) return;
        voice.end();
        speech = null;

        const message: AssistantMessage = {
          role: "assistant",
          content: response.roundText || null,
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        };
        if (calls.length === 0) {
          if (response.roundText) {
            record(response, message);
            response.finalMessage = message;
          }
          break;
        }
        record(response, message);
        response.phase = "tools";
        await Promise.all(calls.map((call) => runTool(response, call)));
        if (signal.aborted) return;
      }
    } catch (err) {
      if (signal.aborted) return;
      console.error("[converse] LLM turn failed:", err);
      speech?.end(); // say what was written before the failure, then stop
      if (response.phase === "llm" && response.roundText) {
        record(response, { role: "assistant", content: response.roundText });
      }
      emit(response, {
        event: {
          type: "response_error",
          responseId: response.id,
          code: "llm_error",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
    response.phase = "done";
    await response.ttsChain;
    if (signal.aborted) return;
    emit(response, { event: { type: "response_done", responseId: response.id, text: response.text } });
    if (response.committed) scheduleClear(response);
  };

  /** Drop a response the user never saw (their turn was not final yet). */
  const discardSpeculative = (response: ResponseState): void => {
    response.abort.abort();
    for (const [callId, waiter] of waiters) {
      if (waiter.response !== response) continue;
      waiters.delete(callId);
      send({ type: "tool_cancel", callId });
      waiter.resolve(null);
    }
    for (const resolve of response.onCommit) resolve();
    if (current === response) current = null;
  };

  /** Cut a response the user was hearing; the history keeps what they heard. */
  const interrupt = (response: ResponseState): void => {
    const heard = heardText(response.segments, Date.now());
    response.abort.abort();
    if (response.clearTimer) clearTimeout(response.clearTimer);
    if (response.phase === "llm") {
      if (heard) history.push({ role: "assistant", content: heard });
    } else if (response.phase === "tools") {
      // The tools keep running client-side; their results will come later.
      for (const [callId, waiter] of waiters) {
        if (waiter.response !== response) continue;
        waiters.delete(callId);
        lateCalls.set(callId, waiter.call.function.name);
        history.push(toolMessage(waiter.call, PENDING_TOOL_OUTPUT));
        waiter.resolve(null);
      }
    } else if (response.finalMessage) {
      if (heard) response.finalMessage.content = heard;
      else {
        const index = history.indexOf(response.finalMessage);
        if (index >= 0) history.splice(index, 1);
      }
    }
    send({ type: "interrupt", responseId: response.id, heardText: heard });
    if (current === response) current = null;
  };

  const stopCurrent = (): void => {
    if (!current) return;
    if (current.committed) interrupt(current);
    else discardSpeculative(current);
  };

  const startResponse = (userText: string | null, committed: boolean): void => {
    stopCurrent();
    // From here the reply handles the request: no second opinion in parallel.
    earlyPass?.abort();
    earlyPass = null;
    const response: ResponseState = {
      id: randomUUID(),
      abort: new AbortController(),
      committed,
      userText,
      outbox: [],
      buffered: [],
      phase: "llm",
      roundText: "",
      text: "",
      segments: [],
      finalMessage: null,
      ttsChain: Promise.resolve(),
      ttsFailed: false,
      playhead: 0,
      onCommit: [],
      clearTimer: null,
    };
    current = response;
    if (committed) {
      openTurn(userText);
      audible = response;
    }
    emit(response, { event: { type: "response_start", responseId: response.id } });
    void runResponse(response);
  };

  /** The user's turn is final: release what was prepared for it. */
  const commit = (response: ResponseState): void => {
    response.committed = true;
    openTurn(response.userText);
    audible = response;
    history.push(...response.buffered);
    for (const item of response.outbox) {
      if ("event" in item) send(item.event);
      else sendAudio(response, item.segment, item.audio);
    }
    response.outbox = [];
    for (const resolve of response.onCommit) resolve();
    response.onCommit = [];
    if (response.phase === "done") scheduleClear(response);
  };

  const isIdle = (): boolean => !current && !turnOpen && !settleTimer && !userBuffer.trim();

  /** A late tool result landed while nobody was speaking: report it. */
  function followUpIfIdle(): void {
    if (!finished && isIdle() && lateResults.length > 0) startResponse(null, true);
  }

  // --- User side ------------------------------------------------------------

  /** Without barge-in, whatever the mic hears while we speak is ignored. */
  const deaf = (): boolean => params?.bargeIn === false && current?.committed === true;

  /** Text the assistant is (or was just) saying out loud. */
  let audible: ResponseState | null = null;

  /** To the client, unless the turn is still under suspicion. */
  const tell = (event: ConverseServerEvent): void => {
    if (suspect) heldEvents.push(event);
    else send(event);
  };

  /** The held turn is the user after all: show it and let it interrupt. */
  const confirmTurn = (): void => {
    suspect = false;
    for (const event of heldEvents.splice(0)) send(event);
    if (current?.committed) interrupt(current);
  };

  /** The held turn was echo or noise: forget it. */
  const dropTurn = (): void => {
    suspect = false;
    heldEvents = [];
    userBuffer = "";
    wordsSeenEarly = 0;
    wordsSeenByLlm = 0;
  };

  /** Tools the model may use before the user has finished speaking. */
  const earlyTools = (): ConverseStartParams["tools"] =>
    params?.actEarly ? params.tools.filter((t) => t.immediate || t.speculative) : [];

  /** Show the model the unfinished sentence, in case it can already act on it. */
  const lookEarly = async (): Promise<void> => {
    const active = llm;
    const tools = earlyTools();
    if (!active) return;
    const controller = new AbortController();
    earlyPass = controller;
    const text = userBuffer.trim();
    wordsSeenEarly = wordsOf(text).length;
    wordsSeenByLlm = wordsSeenEarly;
    try {
      const calls: ToolCall[] = [];
      const stream = deps.llm({
        provider: active.provider,
        model: active.model,
        messages: [
          { role: "system", content: `${systemPrompt}\n\n${LISTENING_PREAMBLE}` },
          ...mergeUserMessages([
            ...history,
            ...lateResults.map((content) => ({ role: "user" as const, content })),
            { role: "user", content: text },
          ]),
          ...actionMessages(),
        ],
        tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === "tool_call") calls.push(chunk.call); // any text is ignored: it must not talk
      }
      if (controller.signal.aborted || finished) return;
      for (const call of calls) {
        const known = tools.some((t) => t.name === call.function.name);
        const repeated = turnActions.some(
          (a) => a.call.function.name === call.function.name && a.call.function.arguments === call.function.arguments,
        );
        if (!known || repeated) continue;
        turnActions.push({ call, result: null });
        send({
          type: "tool_call",
          responseId: null,
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
          speculative: true,
          early: true,
        });
      }
    } catch (err) {
      if (!controller.signal.aborted) console.warn("[converse] early look failed:", err);
    } finally {
      if (earlyPass === controller) {
        earlyPass = null;
        considerEarlyLook(""); // words kept coming meanwhile
      }
    }
  };

  /** Ask the decision model whether there is something to act on; wake the LLM only if so. */
  const gateEarlyLook = async (): Promise<void> => {
    const controller = new AbortController();
    earlyPass = controller;
    const total = wordsOf(userBuffer).length;
    wordsSeenEarly = total;
    const answer = await ask(ACTIONABLE_QUESTION, {
      user_is_saying: userBuffer.trim(),
      tools: earlyTools().map(({ name, description }) => ({ name, description })),
      already_done: turnActions.map((a) => `${a.call.function.name}(${a.call.function.arguments})`),
    });
    if (controller.signal.aborted || finished) return;
    earlyPass = null;
    const go =
      answer?.type === "noul"
        ? answer.noul >= 0.5
        : total - wordsSeenByLlm >= EARLY_MAX_NEW_WORDS; // no verdict: fall back to looking now and then
    if (go && !current && !suspect) void lookEarly();
    else considerEarlyLook("");
  };

  function considerEarlyLook(delta: string): void {
    if (finished || suspect || current || earlyPass || earlyTools().length === 0) return;
    const fresh = wordsOf(userBuffer).length - wordsSeenEarly;
    if (deciding()) {
      if (fresh >= GATED_MIN_NEW_WORDS) void gateEarlyLook();
    } else if (fresh >= EARLY_MAX_NEW_WORDS || (fresh >= EARLY_MIN_NEW_WORDS && CLAUSE_BOUNDARY.test(delta))) {
      void lookEarly();
    }
  }

  /** Is the held turn the user speaking to us? */
  const reviewSuspect = (): void => {
    if (!suspect) return;
    const said = audible?.text ?? "";
    const rule = classifyEcho(userBuffer, said);
    if (rule === "unknown") return; // no words yet
    if (!deciding()) {
      if (rule === "speech") confirmTurn();
      return;
    }
    if (reviewing) return; // re-checked when the pending decision lands
    const heard = userBuffer;
    reviewing = true;
    void ask(INTENT_QUESTION, { assistant_is_saying: said, microphone_heard: heard.trim() }).then((answer) => {
      reviewing = false;
      if (finished) return;
      if (suspect) {
        const interrupts =
          answer?.type === "choice"
            ? answer.choice === "interrupt"
            : classifyEcho(userBuffer, audible?.text ?? "") === "speech";
        if (interrupts) confirmTurn();
        else if (userBuffer !== heard) reviewSuspect(); // more words came in meanwhile
      }
      if (commitAfterReview && !reviewing) {
        commitAfterReview = false;
        commitTurn();
      }
    });
  };

  /** Ask ahead whether the user's sentence, as it stands, is complete. */
  const askCompleteness = (): void => {
    const text = userBuffer.trim();
    if (!deciding() || suspect || !text || completeness?.text === text) return;
    // The same words can be complete or not depending on what came before
    // ("red" answers "which color?"), so the model gets the recent exchange.
    const conversation = history
      .filter((m): m is Extract<ChatMessage, { role: "user" | "assistant" }> & { content: string } =>
        (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content !== "",
      )
      .slice(-DECISION_CONTEXT_MESSAGES)
      .map((m) => ({ role: m.role, said: m.content }));
    const lastSegment = userBuffer.slice(Math.min(segmentStart, userBuffer.length)).trim();
    completeness = {
      text,
      verdict: ask(FINISHED_QUESTION, { conversation, user_said: text, last_segment: lastSegment || text }).then(
        (answer) => (answer?.type === "noul" ? answer.noul : null),
      ),
    };
    void completeness.verdict.then((finishedProbability) => {
      // Clearly complete: no need to wait out the rest of the pause.
      const waiting = pausing || settleTimer !== null;
      if (finishedProbability === null || finishedProbability < FINISHED_ABOVE) return;
      if (finished || suspect || !waiting || userBuffer.trim() !== text) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      turnOpen = false;
      finalizeTurn(text);
    });
  };

  const finalizeTurn = (text: string): void => {
    userBuffer = "";
    heldOpen = false;
    pausing = false;
    segmentStart = 0;
    completeness = null;
    send({ type: "user_turn", text });
    if (current && !current.committed && current.userText === text) commit(current);
    else startResponse(text, true);
  };

  const commitTurn = (): void => {
    settleTimer = null;
    if (suspect && reviewing) {
      commitAfterReview = true; // let the decision on this turn land first
      return;
    }
    if (suspect) dropTurn(); // never turned into speech
    const text = userBuffer.trim();
    if (!text) {
      userBuffer = "";
      heldOpen = false;
      if (current && !current.committed) discardSpeculative(current);
      followUpIfIdle(); // a noise opened the turn: don't sit on a finished tool
      return;
    }
    if (heldOpen || completeness?.text !== text) {
      finalizeTurn(text);
      return;
    }
    // A sentence left hanging gets a little more time before we answer it.
    void completeness.verdict.then((finishedProbability) => {
      if (finished || turnOpen || settleTimer) return; // the turn moved on without us
      if (userBuffer.trim() !== text) {
        commitTurn(); // late words: judge the new text
      } else if (finishedProbability !== null && finishedProbability < UNFINISHED_BELOW) {
        heldOpen = true;
        settleTimer = setTimeout(commitTurn, HOLD_OPEN_MS);
      } else {
        finalizeTurn(text);
      }
    });
  };

  const armSettle = (): void => {
    if (settleTimer) clearTimeout(settleTimer);
    const wait = Math.max(0, Math.min(config.converseSettleMs, settleDeadline - Date.now()));
    settleTimer = setTimeout(commitTurn, wait);
  };

  const onTranscript = (text: string): void => {
    if (!text || deaf()) return;
    // Punctuation trailing in after its turn was answered: not a new turn.
    if (!turnOpen && !settleTimer && !userBuffer && !HAS_WORDS.test(text)) return;
    // Words with no turn open yet: same suspicion rule as a turn start.
    if (!turnOpen && !userBuffer && !settleTimer && current?.committed) suspect = true;
    userBuffer += text;
    tell({ type: "transcript", text });
    if (settleTimer) armSettle();
    reviewSuspect();
    if (suspect) return;
    // The transcript trails the voice: words still land after the pause began.
    if (pausing || settleTimer) askCompleteness();
    // More words arrived after we started guessing: guess again.
    if (current && !current.committed && current.userText !== userBuffer.trim()) {
      discardSpeculative(current);
      if (userBuffer.trim()) startResponse(userBuffer.trim(), false);
    }
    considerEarlyLook(text);
  };

  const onTurn = (reported: TurnPhase): void => {
    if (deaf()) return;
    // We may have answered at the pause without waiting for the turn's end;
    // the user picking up again is then a new turn talking over the reply.
    const phase: TurnPhase = reported === "resume" && current?.committed ? "start" : reported;
    if (phase === "start" || phase === "resume") {
      pausing = false;
      segmentStart = userBuffer.length;
    }
    if (phase === "start" && !settleTimer) {
      if (current?.committed) suspect = true;
      else if (suspect) dropTurn(); // leftovers of an echo that never ended
    }
    tell({ type: "turn", phase: reported });
    switch (phase) {
      case "start":
        turnOpen = true;
        commitAfterReview = false;
        heldOpen = false;
        if (settleTimer) {
          // The user went on before we answered: same turn, keep listening.
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        if (!suspect) stopCurrent();
        return;
      case "eager_end":
        pausing = true;
        askCompleteness();
        if (!suspect && params?.speculate && !current && userBuffer.trim()) {
          startResponse(userBuffer.trim(), false);
        }
        return;
      case "resume":
        if (current && !current.committed) discardSpeculative(current);
        return;
      case "end": {
        turnOpen = false;
        // The last words can trail the end of the turn: give them a moment
        // to arrive before answering. (Never `flush` here: on Voxtral 3 a
        // flush finalizes the transcription and ends the session.)
        askCompleteness();
        settleDeadline = Date.now() + config.converseSettleMs * 4;
        armSettle();
        return;
      }
    }
  };

  const onToolResult = (callId: string, rawOutput: string, isError: boolean): void => {
    const output = rawOutput.slice(0, MAX_TOOL_OUTPUT_CHARS);
    const waiter = waiters.get(callId);
    if (waiter) {
      waiter.resolve({ output, isError });
      return;
    }
    const action = turnActions.find((a) => a.call.id === callId);
    if (action) {
      action.result = (isError ? "Error: " : "") + output;
      return;
    }
    const name = lateCalls.get(callId);
    if (!name) return; // cancelled, or never asked for
    lateCalls.delete(callId);
    lateResults.push(
      `[Tool result — "${name}" (call ${callId}) has finished${isError ? " with an error" : ""}]\n${output}`,
    );
    followUpIfIdle();
  };

  // --- Transcription upstream ----------------------------------------------

  const connectUpstream = (start: ConverseStartParams, llmName: string, llmModel: string): void => {
    upstream = connectTranscription(deps.realtime, config.realtimeModel, toSessionUpdate(start), {
      onReady: (requestId) =>
        send({
          type: "ready",
          requestId,
          sttModel: config.realtimeModel,
          ttsModel: config.ttsModel,
          llmProvider: llmName,
          llmModel,
          deciderModel: deciding() ? config.deciderModel : null,
          audio: { encoding: "pcm_s16le", sampleRate: TTS_SAMPLE_RATE, channels: 1 },
        }),
      onDelta: onTranscript,
      onTurn: ({ phase }) => onTurn(phase),
      // Nothing here asks for the final transcript, so getting one means the
      // assistant has gone deaf: say so rather than sit there silently.
      onDone: () => fail("upstream_error", "The transcription session ended", CLOSE_UPSTREAM_ERROR),
      onError: (code, message) =>
        fail(code, message, code === "server_error" ? CLOSE_INTERNAL : CLOSE_UPSTREAM_ERROR),
    });
  };

  // --- Client messages ------------------------------------------------------

  ws.on("message", (data, isBinary) => {
    if (finished) return;
    resetIdle();

    if (isBinary) {
      if (!params) {
        fail("bad_message", "Binary audio received before `start`", CLOSE_BAD_MESSAGE);
        return;
      }
      upstream?.sendAudio(rawDataToBuffer(data));
      return;
    }

    const message = parseConverseClientMessage(rawDataToBuffer(data).toString("utf8"));
    if (!message) {
      fail("bad_message", "Unrecognized control message", CLOSE_BAD_MESSAGE);
      return;
    }
    if (message.type === "start") {
      if (params) {
        fail("bad_message", "Duplicate `start`", CLOSE_BAD_MESSAGE);
        return;
      }
      const start = normalizeConverseStart(message, config.defaultTargetDelayMs);
      if ("error" in start) {
        fail("bad_message", start.error, CLOSE_BAD_MESSAGE);
        return;
      }
      const resolved = resolveLlm(config, start);
      if ("error" in resolved) {
        fail("bad_message", resolved.error, CLOSE_BAD_MESSAGE);
        return;
      }
      params = start;
      llm = resolved;
      if (start.instructions.trim()) systemPrompt = `${VOICE_PREAMBLE}\n\n${start.instructions.trim()}`;
      history.push(...start.history);
      connectUpstream(start, resolved.name, resolved.model);
      return;
    }
    if (!params) {
      fail("bad_message", `\`${message.type}\` before \`start\``, CLOSE_BAD_MESSAGE);
      return;
    }
    switch (message.type) {
      case "tool_result":
        onToolResult(message.callId, message.output, message.isError === true);
        return;
      case "text": {
        const text = message.text.trim().slice(0, MAX_TEXT_CHARS);
        if (!text) return;
        dropTurn(); // typing overrides whatever the mic was picking up
        send({ type: "user_turn", text });
        startResponse(text, true);
        return;
      }
      case "interrupt":
        if (current?.committed) interrupt(current);
        return;
      case "stop":
        finish(CLOSE_DONE, "done");
        return;
    }
  });

  ws.on("close", () => finish(CLOSE_DONE, "client_closed"));
  ws.on("error", () => finish(CLOSE_INTERNAL, "client_error"));

  resetIdle();
  sessionTimer = setTimeout(
    () => fail("session_too_long", "Maximum session duration reached", CLOSE_SESSION_TOO_LONG),
    config.maxSessionMs,
  );
}
