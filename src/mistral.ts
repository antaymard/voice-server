import { Mistral } from "@mistralai/mistralai";
import { RealtimeTranscription } from "@mistralai/mistralai/extra/realtime";
import type { RealtimeConnection } from "@mistralai/mistralai/extra/realtime";
import type { Config } from "./config.ts";

export type MistralClients = {
  batch: Mistral;
  realtime: RealtimeTranscription;
};

export function createMistralClients(config: Config): MistralClients {
  return {
    batch: new Mistral({ apiKey: config.mistralApiKey, serverURL: config.mistralBaseUrl }),
    realtime: new RealtimeTranscription({
      apiKey: config.mistralApiKey,
      serverURL: config.mistralWsUrl,
    }),
  };
}

export type RawSessionUpdate = {
  audio_format?: { encoding: "pcm_s16le"; sample_rate: number };
  target_streaming_delay_ms?: number;
  language?: string;
  context_bias?: string[];
  diarize?: boolean;
  speaker_references?: Record<string, string>;
  turn_detection?: {
    start_threshold: number;
    eager_end_threshold: number;
    end_threshold: number;
    min_silence_ms: number;
    end_timeout_ms: number;
  };
};

/**
 * The published SDK (pinned to exactly 3.3.0) only lets
 * `RealtimeConnection.updateSession` set the audio format, but the upstream
 * `session.update` schema accepts every Voxtral 3 session field — send the
 * frame directly on the connection's socket. Voxtral 3 locks session fields
 * once audio starts, so everything must go in this one frame, before audio.
 * Revisit when the SDK exposes the full session payload.
 */
export function sendRawSessionUpdate(conn: RealtimeConnection, session: RawSessionUpdate): void {
  const ws = (conn as unknown as { websocket?: { send?: (data: string) => void } }).websocket;
  if (!ws || typeof ws.send !== "function") {
    throw new Error("Mistral SDK internals changed: RealtimeConnection.websocket is not accessible");
  }
  ws.send(JSON.stringify({ type: "session.update", session }));
}
