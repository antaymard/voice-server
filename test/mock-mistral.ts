/**
 * Mock of the Mistral API surface used by voice-server:
 * - POST /v1/audio/transcriptions (batch)
 * - WS   /v1/audio/transcriptions/realtime (realtime)
 *
 * Deterministic behavior for tests:
 * - batch: api key containing "bad-key" -> 401, "key-400" -> 400, else fixture.
 * - realtime: replies `session.created`, echoes `session.updated`, emits one
 *   `transcription.language` on the first audio append, one
 *   `transcription.text.delta` ("p1 ", "p2 ", ...) per append, and
 *   `transcription.done` on `input_audio.end`. An append whose audio decodes
 *   to the ASCII string "KILL" terminates the socket (simulates upstream death).
 *
 * Also runnable standalone for offline demo testing: `npm run mock`
 * (listens on 9099; point the server at it with
 *  MISTRAL_BASE_URL=http://127.0.0.1:9099 MISTRAL_WS_URL=ws://127.0.0.1:9099).
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

export type MockMistral = {
  port: number;
  httpUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
};

export const BATCH_FIXTURE = {
  model: "voxtral-mini-latest",
  text: "bonjour le monde",
  language: "fr",
  segments: [],
  usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, prompt_audio_seconds: 2 },
};

export function startMockMistral(port = 0): Promise<MockMistral> {
  const httpServer = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
      const auth = req.headers.authorization ?? "";
      req.resume(); // drain the upload
      req.on("end", () => {
        const json = (status: number, body: unknown): void => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (auth.includes("bad-key")) return json(401, { message: "Unauthorized" });
        if (auth.includes("key-400")) return json(400, { object: "error", message: "Invalid request (mock)" });
        return json(200, BATCH_FIXTURE);
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not found (mock)" }));
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/v1/audio/transcriptions/realtime" });
  wss.on("connection", (ws, req) => {
    const model =
      new URL(req.url ?? "", "http://localhost").searchParams.get("model") ?? "mock-model";
    let audioFormat: unknown = { encoding: "pcm_s16le", sample_rate: 16000 };
    let targetDelayMs: number | null = null;
    const session = () => ({
      request_id: "mock-req-1",
      model,
      audio_format: audioFormat,
      target_streaming_delay_ms: targetDelayMs,
    });
    ws.send(JSON.stringify({ type: "session.created", session: session() }));

    let appendCount = 0;
    const parts: string[] = [];
    ws.on("message", (data) => {
      let msg: { type?: string; audio?: string; session?: Record<string, unknown> };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.close(1002, "mock: invalid json");
        return;
      }
      switch (msg.type) {
        case "session.update": {
          if (msg.session?.["audio_format"]) audioFormat = msg.session["audio_format"];
          const delay = msg.session?.["target_streaming_delay_ms"];
          if (typeof delay === "number") targetDelayMs = delay;
          ws.send(JSON.stringify({ type: "session.updated", session: session() }));
          return;
        }
        case "input_audio.append": {
          const audio = Buffer.from(String(msg.audio ?? ""), "base64");
          if (audio.toString("utf8") === "KILL") {
            ws.terminate();
            return;
          }
          appendCount += 1;
          if (appendCount === 1) {
            ws.send(JSON.stringify({ type: "transcription.language", audio_language: "fr" }));
          }
          const text = `p${appendCount} `;
          parts.push(text);
          ws.send(JSON.stringify({ type: "transcription.text.delta", text }));
          return;
        }
        case "input_audio.flush":
          return;
        case "input_audio.end": {
          const text = parts.join("").trim();
          ws.send(
            JSON.stringify({
              type: "transcription.done",
              model,
              text,
              language: "fr",
              segments: [{ text, start: 0, end: appendCount, speaker_id: null }],
              usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                prompt_audio_seconds: appendCount,
              },
            }),
          );
          return;
        }
        default:
          return;
      }
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => {
      const address = httpServer.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: actualPort,
        httpUrl: `http://127.0.0.1:${actualPort}`,
        wsUrl: `ws://127.0.0.1:${actualPort}`,
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            httpServer.close(() => done());
          }),
      });
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const mock = await startMockMistral(9099);
  console.log(`Mock Mistral API listening at ${mock.httpUrl} (HTTP) / ${mock.wsUrl} (WS)`);
  console.log("Point voice-server at it with:");
  console.log(`  MISTRAL_BASE_URL=${mock.httpUrl} MISTRAL_WS_URL=${mock.wsUrl} npm run dev`);
}
