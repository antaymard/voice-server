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

type RawSessionUpdate = {
  audio_format?: { encoding: "pcm_s16le"; sample_rate: number };
  target_streaming_delay_ms?: number;
};

/**
 * The published SDK (pinned to exactly 2.2.5) does not expose
 * `target_streaming_delay_ms`, but the upstream `session.update` schema
 * accepts it — send the frame directly on the connection's socket.
 * Revisit when the SDK exposes the target delay.
 */
export function sendRawSessionUpdate(conn: RealtimeConnection, session: RawSessionUpdate): void {
  const ws = (conn as unknown as { websocket?: { send?: (data: string) => void } }).websocket;
  if (!ws || typeof ws.send !== "function") {
    throw new Error("Mistral SDK internals changed: RealtimeConnection.websocket is not accessible");
  }
  ws.send(JSON.stringify({ type: "session.update", session }));
}
