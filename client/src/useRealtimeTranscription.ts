import { useCallback, useEffect, useRef, useState } from "react";
import {
  NO_RECONNECT_CLOSE_CODES,
  parseServerEvent,
  type DoneEvent,
  type SegmentEvent,
  type ServerErrorEvent,
  type TranscriptSegment,
} from "./protocol.ts";
import { createPcmWorkletUrl } from "./worklet.ts";

const SAMPLE_RATE = 16000;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = [500, 1000, 2000];
const MAX_PENDING_CHUNKS = 50; // ~5s of audio buffered until the session is ready
const STOP_TIMEOUT_MS = 10_000;

export type TranscriptionStatus = "idle" | "connecting" | "listening" | "stopping" | "error";

export type UseRealtimeTranscriptionOptions = {
  /** Base URL of voice-server, e.g. "https://voice.example.com". */
  serverUrl: string;
  /** The server's shared AUTH_TOKEN. */
  token: string;
  /** Latency/accuracy tradeoff in ms (240-2400, server default 480). */
  targetDelayMs?: number;
  /** Audio chunk duration sent over the socket (default 100 ms). */
  chunkMs?: number;
  /** Reconnect automatically on unexpected disconnects (default true, 3 attempts). */
  reconnect?: boolean;
  /** Override the worklet module URL (for CSPs that forbid blob: workers). */
  workletUrl?: string;
  onSegment?: (segment: SegmentEvent) => void;
  onDone?: (event: DoneEvent) => void;
  onError?: (error: ServerErrorEvent) => void;
};

export type UseRealtimeTranscriptionResult = {
  status: TranscriptionStatus;
  /** Committed transcript (accumulated deltas; replaced by the final text on done). */
  text: string;
  segments: TranscriptSegment[];
  language: string | null;
  error: ServerErrorEvent | null;
  /** Must be called from a user gesture (required for the mic / AudioContext on iOS). */
  start: () => Promise<void>;
  /** Stops the mic and resolves with the final transcript. */
  stop: () => Promise<string>;
  /** Clears text/segments/error while idle. */
  reset: () => void;
};

type Session = {
  ws: WebSocket | null;
  ctx: AudioContext | null;
  stream: MediaStream | null;
  node: AudioWorkletNode | null;
  ready: boolean;
  pending: ArrayBuffer[];
  /** Transcript accumulated by previous (reconnected) upstream sessions. */
  baseText: string;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  stopResolve: ((text: string) => void) | null;
  stopPromise: Promise<string> | null;
};

function toWsUrl(serverUrl: string, token: string): string {
  const base = serverUrl.replace(/\/$/, "").replace(/^http/, "ws");
  return `${base}/v1/realtime?token=${encodeURIComponent(token)}`;
}

export function useRealtimeTranscription(
  options: UseRealtimeTranscriptionOptions,
): UseRealtimeTranscriptionResult {
  const [status, setStatus] = useState<TranscriptionStatus>("idle");
  const [text, setText] = useState("");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [language, setLanguage] = useState<string | null>(null);
  const [error, setError] = useState<ServerErrorEvent | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const statusRef = useRef<TranscriptionStatus>("idle");
  const textRef = useRef("");
  const sessionRef = useRef<Session | null>(null);

  const setStatusBoth = (s: TranscriptionStatus): void => {
    statusRef.current = s;
    setStatus(s);
  };

  const isStale = (session: Session): boolean => sessionRef.current !== session;

  /** Release all resources. Never touches React state (safe on unmount). */
  const teardown = (session: Session): void => {
    if (isStale(session)) return;
    sessionRef.current = null;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.stopTimer) clearTimeout(session.stopTimer);
    const ws = session.ws;
    session.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.onclose = null;
      ws.close(1000);
    }
    if (session.stream) for (const track of session.stream.getTracks()) track.stop();
    if (session.node) session.node.disconnect();
    if (session.ctx && session.ctx.state !== "closed") void session.ctx.close().catch(() => {});
  };

  const finishStop = (session: Session): void => {
    if (isStale(session)) return;
    if (session.stopTimer) clearTimeout(session.stopTimer);
    const resolve = session.stopResolve;
    session.stopResolve = null;
    teardown(session);
    setStatusBoth("idle");
    resolve?.(textRef.current);
  };

  const failSession = (session: Session, errorEvent: ServerErrorEvent): void => {
    if (isStale(session)) return;
    setError((prev) => prev ?? errorEvent);
    optionsRef.current.onError?.(errorEvent);
    const resolve = session.stopResolve;
    session.stopResolve = null;
    teardown(session);
    setStatusBoth("error");
    resolve?.(textRef.current);
  };

  const handleEvent = (session: Session, raw: string): void => {
    const event = parseServerEvent(raw);
    if (!event || isStale(session)) return;
    switch (event.type) {
      case "ready": {
        session.ready = true;
        session.reconnectAttempts = 0;
        const ws = session.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          for (const chunk of session.pending) ws.send(chunk);
        }
        session.pending = [];
        if (statusRef.current === "connecting") setStatusBoth("listening");
        break;
      }
      case "delta": {
        textRef.current += event.text;
        setText(textRef.current);
        break;
      }
      case "segment": {
        setSegments((prev) => [...prev, { text: event.text, start: event.start, end: event.end }]);
        optionsRef.current.onSegment?.(event);
        break;
      }
      case "language": {
        setLanguage(event.language);
        break;
      }
      case "done": {
        // Authoritative final text for the current upstream session.
        textRef.current = session.baseText + event.text;
        setText(textRef.current);
        optionsRef.current.onDone?.(event);
        finishStop(session);
        break;
      }
      case "error": {
        // The server closes right after; reconnect policy runs in onclose.
        setError(event);
        optionsRef.current.onError?.(event);
        break;
      }
    }
  };

  const handleClose = (session: Session, closeEvent: CloseEvent): void => {
    if (isStale(session)) return;
    session.ws = null;
    const st = statusRef.current;
    if (st === "stopping") {
      finishStop(session);
      return;
    }
    if (st === "idle" || st === "error") {
      teardown(session);
      return;
    }
    const reconnectEnabled = optionsRef.current.reconnect ?? true;
    const canReconnect =
      reconnectEnabled &&
      st === "listening" &&
      !NO_RECONNECT_CLOSE_CODES.includes(closeEvent.code) &&
      session.reconnectAttempts < MAX_RECONNECT_ATTEMPTS;
    if (canReconnect) {
      session.reconnectAttempts += 1;
      session.ready = false;
      session.pending = [];
      // Transcript accumulates across reconnected sessions.
      session.baseText = textRef.current === "" ? "" : textRef.current.replace(/\s*$/, " ");
      textRef.current = session.baseText;
      setStatusBoth("connecting");
      const delay = RECONNECT_BACKOFF_MS[session.reconnectAttempts - 1] ?? 2000;
      session.reconnectTimer = setTimeout(() => {
        if (!isStale(session)) openSocket(session);
      }, delay);
      return;
    }
    failSession(session, {
      type: "error",
      code: "upstream_error",
      message: `Connection closed unexpectedly (code ${closeEvent.code})`,
    });
  };

  const openSocket = (session: Session): void => {
    const opts = optionsRef.current;
    let ws: WebSocket;
    try {
      ws = new WebSocket(toWsUrl(opts.serverUrl, opts.token));
    } catch (err) {
      failSession(session, {
        type: "error",
        code: "server_error",
        message: `Could not open the WebSocket: ${String(err)}`,
      });
      return;
    }
    ws.binaryType = "arraybuffer";
    session.ws = ws;
    session.ready = false;
    ws.onopen = () => {
      if (isStale(session) || session.ws !== ws) return;
      ws.send(
        JSON.stringify({
          type: "start",
          sampleRate: SAMPLE_RATE,
          ...(opts.targetDelayMs !== undefined ? { targetDelayMs: opts.targetDelayMs } : {}),
        }),
      );
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") handleEvent(session, e.data);
    };
    ws.onclose = (e) => {
      if (session.ws === ws) handleClose(session, e);
    };
  };

  const start = useCallback(async (): Promise<void> => {
    if (statusRef.current !== "idle" && statusRef.current !== "error") return;
    setError(null);
    setSegments([]);
    setLanguage(null);
    textRef.current = "";
    setText("");
    setStatusBoth("connecting");

    const session: Session = {
      ws: null,
      ctx: null,
      stream: null,
      node: null,
      ready: false,
      pending: [],
      baseText: "",
      reconnectAttempts: 0,
      reconnectTimer: null,
      stopTimer: null,
      stopResolve: null,
      stopPromise: null,
    };
    sessionRef.current = session;

    // If the session went stale mid-setup (unmount, stop), teardown() already
    // ran against an earlier snapshot — release what THIS continuation holds.
    const releaseMedia = (): void => {
      if (session.stream) for (const track of session.stream.getTracks()) track.stop();
      if (session.ctx && session.ctx.state !== "closed") void session.ctx.close().catch(() => {});
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      session.stream = stream;
      if (isStale(session)) {
        releaseMedia();
        return;
      }

      // 16 kHz hint; if the browser ignores it, the worklet resamples.
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      } catch {
        ctx = new AudioContext();
      }
      session.ctx = ctx;
      await ctx.audioWorklet.addModule(optionsRef.current.workletUrl ?? createPcmWorkletUrl());
      if (isStale(session)) {
        releaseMedia();
        return;
      }

      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "pcm-processor", {
        processorOptions: {
          targetSampleRate: SAMPLE_RATE,
          chunkMs: optionsRef.current.chunkMs ?? 100,
        },
      });
      session.node = node;
      const muted = ctx.createGain();
      muted.gain.value = 0;
      source.connect(node);
      node.connect(muted);
      muted.connect(ctx.destination);

      node.port.onmessage = (e: MessageEvent) => {
        if (isStale(session)) return;
        const data: unknown = e.data;
        if (data instanceof ArrayBuffer) {
          const ws = session.ws;
          if (session.ready && ws && ws.readyState === WebSocket.OPEN) ws.send(data);
          else if (session.pending.length < MAX_PENDING_CHUNKS) session.pending.push(data);
          return;
        }
        if ((data as { type?: string } | null)?.type === "flushed") {
          // Tail audio has been posted; now ask the server to finalize.
          const ws = session.ws;
          if (session.ready && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "stop" }));
          } else {
            finishStop(session);
          }
        }
      };

      openSocket(session);
    } catch (err) {
      if (isStale(session)) {
        releaseMedia();
        return;
      }
      failSession(session, {
        type: "error",
        code: "server_error",
        message: `Audio setup failed: ${String(err)}`,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback((): Promise<string> => {
    const session = sessionRef.current;
    if (!session || statusRef.current === "idle" || statusRef.current === "error") {
      return Promise.resolve(textRef.current);
    }
    if (statusRef.current === "stopping") {
      return session.stopPromise ?? Promise.resolve(textRef.current);
    }
    setStatusBoth("stopping");
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }

    const promise = new Promise<string>((resolve) => {
      session.stopResolve = resolve;
      session.stopTimer = setTimeout(() => finishStop(session), STOP_TIMEOUT_MS);
    });
    session.stopPromise = promise;

    // Cut the mic right away; the worklet flushes its tail then reports
    // "flushed", which triggers the protocol `stop` (see port.onmessage).
    if (session.stream) for (const track of session.stream.getTracks()) track.stop();
    if (session.node && session.ready) {
      session.node.port.postMessage({ type: "flush" });
    } else if (session.ws && session.ws.readyState === WebSocket.OPEN && session.ready) {
      session.ws.send(JSON.stringify({ type: "stop" }));
    } else {
      finishStop(session);
    }
    return promise;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = useCallback((): void => {
    if (statusRef.current !== "idle" && statusRef.current !== "error") return;
    textRef.current = "";
    setText("");
    setSegments([]);
    setLanguage(null);
    setError(null);
    setStatusBoth("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      const session = sessionRef.current;
      if (session) teardown(session);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { status, text, segments, language, error, start, stop, reset };
}
