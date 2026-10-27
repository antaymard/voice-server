/**
 * Mock of the Mistral API surface used by voice-server:
 * - POST /v1/audio/transcriptions (batch)
 * - POST /v1/audio/speech (text-to-speech, JSON one-shot or SSE stream)
 * - WS   /v1/audio/transcriptions/realtime (realtime)
 *
 * Deterministic behavior for tests:
 * - batch: api key containing "bad-key" -> 401, "key-400" -> 400, else fixture.
 * - speech: same key rules; "key-stream-error" -> SSE response whose socket
 *   dies before any audio delta (simulates an upstream failure mid-handshake).
 * - realtime: replies `session.created`, echoes `session.updated`, emits one
 *   `transcription.language` on the first audio append, one
 *   `transcription.text.delta` ("p1 ", "p2 ", ...) per append, and
 *   `transcription.done` on `input_audio.end`. An append whose audio decodes
 *   to the ASCII string "KILL" terminates the socket (simulates upstream death).
 *   Voxtral 3: with `diarize`, each append yields a `transcription.segment`
 *   (speaker_1, null timestamps) instead of a delta; with `turn_detection`,
 *   `turn.start` precedes the first delta and `turn.end` precedes `done`;
 *   both together, or a `session.update` after audio, yield an `error` event.
 * - voices: GET /v2/audio/voices returns VOICES_FIXTURE.
 * - Every request the server makes is recorded on `received` for assertions.
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
  /** Last request of each kind, as received upstream (snake_case wire format). */
  received: {
    /** Multipart fields; files are replaced by "<file>". */
    transcription: Record<string, string[]> | null;
    speech: Record<string, unknown> | null;
    /** `session` payload of the last realtime `session.update`. */
    realtimeSession: Record<string, unknown> | null;
    /** Query string of the last voices listing. */
    voicesQuery: string | null;
  };
  close: () => Promise<void>;
};

export const VOICES_FIXTURE = [
  {
    id: "voice_592",
    name: "Marie",
    slug: null,
    languages: ["fr"],
    gender: "female",
    retention_notice: 30,
    created_at: "2026-10-20T00:00:00Z",
    user_id: null,
    type: "preset",
  },
];

export const BATCH_FIXTURE = {
  model: "voxtral-mini-transcribe-3-0",
  text: "bonjour le monde",
  language: "fr",
  segments: [],
  usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, prompt_audio_seconds: 2 },
};

/** Decoded bytes the speech mock produces (streamed as two deltas, or in one shot). */
export const SPEECH_FIXTURE_BYTES = Buffer.from("MOCKAUDIO");
const SPEECH_CHUNKS = ["MOCK", "AUDIO"]; // concatenate to SPEECH_FIXTURE_BYTES

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

function readRaw(req: import("node:http").IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function readMultipartFields(
  req: import("node:http").IncomingMessage,
): Promise<Record<string, string[]>> {
  const raw = await readRaw(req);
  const form = await new Response(new Uint8Array(raw), {
    headers: { "content-type": req.headers["content-type"] ?? "" },
  })
    .formData()
    .catch(() => null);
  const fields: Record<string, string[]> = {};
  for (const [key, value] of form?.entries() ?? []) {
    (fields[key] ??= []).push(typeof value === "string" ? value : "<file>");
  }
  return fields;
}

export function startMockMistral(port = 0): Promise<MockMistral> {
  const received: MockMistral["received"] = {
    transcription: null,
    speech: null,
    realtimeSession: null,
    voicesQuery: null,
  };
  const httpServer = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
      const auth = req.headers.authorization ?? "";
      void readMultipartFields(req).then((fields) => {
        received.transcription = fields;
        const json = (status: number, body: unknown): void => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (auth.includes("bad-key")) return json(401, { message: "Unauthorized" });
        if (auth.includes("key-400")) return json(400, { object: "error", message: "Invalid request (mock)" });
        return json(200, { ...BATCH_FIXTURE, model: fields["model"]?.[0] ?? BATCH_FIXTURE.model });
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/v2/audio/voices")) {
      received.voicesQuery = new URL(req.url, "http://localhost").search;
      const auth = req.headers.authorization ?? "";
      res.writeHead(auth.includes("bad-key") ? 401 : 200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          auth.includes("bad-key")
            ? { message: "Unauthorized" }
            : { data: VOICES_FIXTURE, next_page_token: null },
        ),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/v1/audio/speech") {
      const auth = req.headers.authorization ?? "";
      void readBody(req).then((raw) => {
        const json = (status: number, body: unknown): void => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (auth.includes("bad-key")) return json(401, { message: "Unauthorized" });
        if (auth.includes("key-400")) return json(400, { object: "error", message: "Invalid request (mock)" });
        if (auth.includes("key-stream-error")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.flushHeaders();
          setTimeout(() => res.destroy(), 10);
          return;
        }
        let stream = false;
        try {
          received.speech = JSON.parse(raw) as Record<string, unknown>;
          stream = received.speech?.["stream"] === true;
        } catch {
          return json(400, { object: "error", message: "Bad JSON (mock)" });
        }
        if (!stream) {
          return json(200, { audio_data: SPEECH_FIXTURE_BYTES.toString("base64") });
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const chunk of SPEECH_CHUNKS) {
          const data = JSON.stringify({
            type: "speech.audio.delta",
            audio_data: Buffer.from(chunk).toString("base64"),
          });
          res.write(`event: speech.audio.delta\ndata: ${data}\n\n`);
        }
        res.end();
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
    let diarize = false;
    let turnDetection = false;
    const parts: string[] = [];
    const sendError = (message: string): void =>
      void ws.send(JSON.stringify({ type: "error", error: { message, code: 4000 } }));
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
          received.realtimeSession = msg.session ?? null;
          if (appendCount > 0) {
            sendError("Session fields cannot be changed after audio has started.");
            return;
          }
          if (msg.session?.["audio_format"]) audioFormat = msg.session["audio_format"];
          const delay = msg.session?.["target_streaming_delay_ms"];
          if (typeof delay === "number") targetDelayMs = delay;
          diarize = msg.session?.["diarize"] === true;
          turnDetection = msg.session?.["turn_detection"] !== undefined;
          if (diarize && turnDetection) {
            sendError("Diarization is not compatible with turn detection.");
            return;
          }
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
          if (turnDetection && appendCount === 1) {
            ws.send(JSON.stringify({ type: "turn.start", time_s: 0.1 }));
          }
          const text = `p${appendCount} `;
          parts.push(text);
          ws.send(
            JSON.stringify(
              diarize
                ? { type: "transcription.segment", text, start: null, end: null, speaker_id: "speaker_1" }
                : { type: "transcription.text.delta", text },
            ),
          );
          return;
        }
        case "input_audio.flush":
          return;
        case "input_audio.end": {
          if (turnDetection) {
            ws.send(JSON.stringify({ type: "turn.end", time_s: appendCount, end_reason: "threshold" }));
          }
          const text = parts.join("").trim();
          ws.send(
            JSON.stringify({
              type: "transcription.done",
              model,
              text,
              language: "fr",
              segments: [{ text, start: 0, end: appendCount, speaker_id: diarize ? "speaker_1" : null }],
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
        received,
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
