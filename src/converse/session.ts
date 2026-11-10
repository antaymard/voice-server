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
 * - Tools don't block the conversation: a call that outlives its response
 *   (timeout or interruption) keeps running client-side, and its result is
 *   picked up when it arrives.
 */
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { RawData } from "ws";
import type { RealtimeConnection, RealtimeTranscription } from "@mistralai/mistralai/extra/realtime";
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
import { sendRawSessionUpdate } from "../mistral.ts";
import { resolveLlm, type ChatMessage, type Llm, type ToolCall } from "./llm.ts";
import { createSentenceSplitter, toSpeakable } from "./sentences.ts";
import { TTS_BYTES_PER_SECOND, TTS_SAMPLE_RATE, type Tts } from "./tts.ts";

export type ConverseDeps = { realtime: RealtimeTranscription; llm: Llm; tts: Tts };

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_PENDING_SENDS = 200;
const MAX_PREREADY_BUFFER_BYTES = 512 * 1024;
const MAX_CLIENT_BUFFERED_BYTES = 8 * 1024 * 1024;
/** LLM turns per response (each tool round-trip costs one). */
const MAX_ROUNDS = 6;
/** Oldest turns are dropped past the first figure, down to the second. */
const HISTORY_HIGH_WATER = 120;
const HISTORY_LOW_WATER = 80;
/** Used to guess the length of a sentence whose audio is still being generated. */
const EST_BYTES_PER_CHAR = TTS_BYTES_PER_SECOND / 15;

const VOICE_PREAMBLE =
  "You are a voice assistant in a live spoken conversation. Everything you write is read aloud: " +
  "use plain spoken sentences, with no markdown, lists, emojis or code. Keep replies short and natural, " +
  "and answer in the user's language. The user's words come from live speech recognition and may " +
  "contain transcription errors. If you were interrupted, your previous message only holds what the " +
  "user actually heard. A tool result marked as pending is still running: say so briefly and carry on; " +
  "its result will be given to you when it arrives.";

const PENDING_TOOL_OUTPUT = JSON.stringify({
  status: "pending",
  note: "Still running. The result will be provided later in the conversation.",
});

const TURN_PHASES: Record<string, TurnPhase> = {
  "turn.start": "start",
  "turn.eager_end": "eager_end",
  "turn.resume": "resume",
  "turn.end": "end",
};

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

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

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
  let upstream: RealtimeConnection | null = null;
  let params: ConverseStartParams | null = null;
  let llm: { name: string; provider: { baseUrl: string; apiKey: string }; model: string } | null = null;
  let ready = false;
  let finished = false;

  let pendingSends = 0;
  let sendChain: Promise<void> = Promise.resolve();
  const preReadyAudio: Buffer[] = [];
  let preReadyBytes = 0;
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
  const waiters = new Map<string, ToolWaiter>();
  /** Calls whose response moved on; value = tool name. */
  const lateCalls = new Map<string, string>();
  /** Results of such calls, waiting to be shown to the model on its next turn. */
  let lateResults: string[] = [];

  const finish = (code: number, reason: string): void => {
    if (finished) return;
    finished = true;
    for (const t of [idleTimer, sessionTimer, settleTimer, current?.clearTimer]) if (t) clearTimeout(t);
    current?.abort.abort();
    for (const waiter of waiters.values()) waiter.resolve(null);
    waiters.clear();
    onClose();
    const conn = upstream;
    if (conn) void conn.close().catch(() => {});
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
    if (userText) history.push({ role: "user", content: userText });
    trimHistory();
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
          ...response.buffered,
        ];
    return [{ role: "system", content: systemPrompt }, ...mergeUserMessages([...history, ...pending])];
  };

  /** Free the "assistant is speaking" slot once the audio has played out. */
  const scheduleClear = (response: ResponseState): void => {
    response.clearTimer = setTimeout(
      () => {
        if (current === response) current = null;
        followUpIfIdle();
      },
      Math.max(0, response.playhead - Date.now()),
    );
  };

  const speak = (response: ResponseState, text: string): void => {
    const segment: Segment = { text, bytes: 0, complete: false, chunks: [] };
    response.segments.push(segment);
    const speakable = toSpeakable(text);
    response.ttsChain = response.ttsChain.then(async () => {
      const { signal } = response.abort;
      if (signal.aborted || !speakable) {
        segment.complete = true;
        return;
      }
      // PCM samples are 2 bytes: never split one across frames.
      let carry: Buffer | null = null;
      try {
        for await (const chunk of deps.tts(speakable, { voice: params?.voice, signal })) {
          if (signal.aborted) return;
          const data: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
          const even = data.length - (data.length % 2);
          carry = even < data.length ? data.subarray(even) : null;
          if (even === 0) continue;
          const audio = data.subarray(0, even);
          segment.bytes += audio.length;
          emit(response, { audio, segment });
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
      segment.complete = true;
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
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        response.phase = "llm";
        response.roundText = "";
        response.segments = [];
        const splitter = createSentenceSplitter();
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
          for (const sentence of splitter.push(chunk.text)) speak(response, sentence);
        }
        if (signal.aborted) return;
        for (const sentence of splitter.flush()) speak(response, sentence);

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
    if (committed) openTurn(userText);
    emit(response, { event: { type: "response_start", responseId: response.id } });
    void runResponse(response);
  };

  /** The user's turn is final: release what was prepared for it. */
  const commit = (response: ResponseState): void => {
    response.committed = true;
    openTurn(response.userText);
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

  /** Echo guard: without barge-in, what the mic hears while we speak is us. */
  const deaf = (): boolean => params?.bargeIn === false && current?.committed === true;

  const commitTurn = (): void => {
    settleTimer = null;
    const text = userBuffer.trim();
    userBuffer = "";
    if (!text) {
      if (current && !current.committed) discardSpeculative(current);
      followUpIfIdle(); // a noise opened the turn: don't sit on a finished tool
      return;
    }
    send({ type: "user_turn", text });
    if (current && !current.committed && current.userText === text) commit(current);
    else startResponse(text, true);
  };

  const armSettle = (): void => {
    if (settleTimer) clearTimeout(settleTimer);
    const wait = Math.max(0, Math.min(config.converseSettleMs, settleDeadline - Date.now()));
    settleTimer = setTimeout(commitTurn, wait);
  };

  const onTranscript = (text: string): void => {
    if (!text || deaf()) return;
    userBuffer += text;
    send({ type: "transcript", text });
    if (settleTimer) armSettle();
    // More words arrived after we started guessing: guess again.
    if (current && !current.committed && current.userText !== userBuffer.trim()) {
      discardSpeculative(current);
      if (userBuffer.trim()) startResponse(userBuffer.trim(), false);
    }
  };

  const onTurn = (phase: TurnPhase): void => {
    if (deaf()) return;
    send({ type: "turn", phase });
    switch (phase) {
      case "start":
        turnOpen = true;
        if (settleTimer) {
          // The user went on before we answered: same turn, keep listening.
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        stopCurrent();
        return;
      case "eager_end":
        if (params?.speculate && !current && userBuffer.trim()) startResponse(userBuffer.trim(), false);
        return;
      case "resume":
        if (current && !current.committed) discardSpeculative(current);
        return;
      case "end": {
        turnOpen = false;
        const conn = upstream;
        // Ask for the words still in the transcriber's buffer, then give
        // them a moment to arrive before answering.
        if (conn) sendChain = sendChain.then(() => conn.flushAudio()).catch(() => {});
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
    const name = lateCalls.get(callId);
    if (!name) return; // cancelled, or never asked for
    lateCalls.delete(callId);
    lateResults.push(
      `[Tool result — "${name}" (call ${callId}) has finished${isError ? " with an error" : ""}]\n${output}`,
    );
    followUpIfIdle();
  };

  // --- Transcription upstream ----------------------------------------------

  const forwardAudio = (chunk: Buffer): void => {
    const conn = upstream;
    if (!conn || finished) return;
    pendingSends += 1;
    if (pendingSends > MAX_PENDING_SENDS) {
      fail("backpressure", "Audio arrives faster than upstream accepts it", CLOSE_UPSTREAM_ERROR);
      return;
    }
    sendChain = sendChain
      .then(() => conn.sendAudio(chunk))
      .catch((err) => {
        if (!finished) fail("upstream_error", `Failed to forward audio: ${String(err)}`, CLOSE_UPSTREAM_ERROR);
      })
      .finally(() => {
        pendingSends -= 1;
      });
  };

  const pumpEvents = (conn: RealtimeConnection): void => {
    void (async () => {
      try {
        for await (const event of conn.events()) {
          if (finished) return;
          if ("raw" in event) {
            // The SDK doesn't model Voxtral 3 turn events yet; read them raw.
            const phase = TURN_PHASES[event.type];
            if (phase) onTurn(phase);
            continue;
          }
          if (event.type === "transcription.text.delta") onTranscript(event.text);
          else if (event.type === "error") {
            const detail = event.error?.message;
            fail(
              "upstream_error",
              typeof detail === "string" ? detail : JSON.stringify(detail ?? "Upstream error"),
              CLOSE_UPSTREAM_ERROR,
            );
            return;
          }
        }
        if (!finished) fail("upstream_error", "Transcription connection closed unexpectedly", CLOSE_UPSTREAM_ERROR);
      } catch (err) {
        if (!finished) fail("upstream_error", `Transcription stream failed: ${String(err)}`, CLOSE_UPSTREAM_ERROR);
      }
    })();
  };

  const connectUpstream = (start: ConverseStartParams, llmName: string, llmModel: string): void => {
    void (async () => {
      let conn: RealtimeConnection;
      try {
        conn = await deps.realtime.connect(config.realtimeModel, { timeoutMs: CONNECT_TIMEOUT_MS });
      } catch (err) {
        fail("upstream_error", `Could not reach the transcription service: ${String(err)}`, CLOSE_UPSTREAM_ERROR);
        return;
      }
      if (finished) {
        void conn.close().catch(() => {});
        return;
      }
      upstream = conn;
      const turn = start.turnDetection;
      try {
        sendRawSessionUpdate(conn, {
          audio_format: { encoding: "pcm_s16le", sample_rate: start.sampleRate },
          target_streaming_delay_ms: start.targetDelayMs,
          ...(start.language ? { language: start.language } : {}),
          ...(start.contextBias ? { context_bias: start.contextBias } : {}),
          turn_detection: {
            start_threshold: turn.startThreshold,
            eager_end_threshold: turn.eagerEndThreshold,
            end_threshold: turn.endThreshold,
            min_silence_ms: turn.minSilenceMs,
            end_timeout_ms: turn.endTimeoutMs,
          },
        });
      } catch (err) {
        fail("server_error", String(err), CLOSE_INTERNAL);
        return;
      }
      pumpEvents(conn);
      ready = true;
      send({
        type: "ready",
        requestId: conn.requestId,
        sttModel: config.realtimeModel,
        ttsModel: config.ttsModel,
        llmProvider: llmName,
        llmModel,
        audio: { encoding: "pcm_s16le", sampleRate: TTS_SAMPLE_RATE, channels: 1 },
      });
      for (const chunk of preReadyAudio) forwardAudio(chunk);
      preReadyAudio.length = 0;
      preReadyBytes = 0;
    })();
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
      const chunk = rawDataToBuffer(data);
      if (ready) {
        forwardAudio(chunk);
        return;
      }
      preReadyBytes += chunk.length;
      if (preReadyBytes > MAX_PREREADY_BUFFER_BYTES) {
        fail("backpressure", "Too much audio buffered before the session was ready", CLOSE_UPSTREAM_ERROR);
        return;
      }
      preReadyAudio.push(chunk);
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
