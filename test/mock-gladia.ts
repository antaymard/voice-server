/**
 * Mock of the Gladia v2 API surface used by voice-server:
 * - POST /v2/upload             (multipart file upload)
 * - POST /v2/pre-recorded       (start a transcription job)
 * - GET  /v2/pre-recorded/:id   (poll a job)
 * - POST /v2/live               (mint a live session URL)
 * - WS   /v2/live               (live transcription socket)
 *
 * Deterministic behavior for tests:
 * - any REST call with x-gladia-key containing "bad-key" -> 401,
 *   "key-400" -> 400.
 * - pre-recorded: the first GET of a job returns "processing", the second
 *   returns "done" with GLADIA_RESULT_FIXTURE. An init whose audio_url
 *   contains "fail" yields an "error" job; "slow" stays "processing" forever.
 *   Init bodies are recorded in `initBodies` for assertions.
 * - live: init bodies are recorded in `liveInitBodies`. On the socket, the
 *   i-th binary frame emits a partial "p{i}" (only if the session asked for
 *   partials) and, for even i, a final utterance "f{i/2}". A frame decoding
 *   to "KILL" terminates the socket. On {"type":"stop_recording"} the mock
 *   sends post_final_transcript with the joined finals and closes 1000.
 *
 * Also runnable standalone for offline demo testing: `npm run mock:gladia`
 * (listens on 9098; point the server at it with
 *  GLADIA_API_KEY=any GLADIA_BASE_URL=http://127.0.0.1:9098).
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

export type MockGladia = {
  port: number;
  httpUrl: string;
  /** Parsed bodies of every POST /v2/pre-recorded, in order. */
  initBodies: Record<string, unknown>[];
  /** Parsed bodies of every POST /v2/live, in order. */
  liveInitBodies: Record<string, unknown>[];
  uploadCount: () => number;
  close: () => Promise<void>;
};

export const GLADIA_RESULT_FIXTURE = {
  metadata: {
    audio_duration: 4.2,
    number_of_distinct_channels: 1,
    billing_time: 4.2,
    transcription_time: 1.1,
  },
  transcription: {
    full_transcript: "bonjour tout le monde",
    languages: ["fr"],
    utterances: [
      {
        text: "bonjour tout le monde",
        language: "fr",
        start: 0.1,
        end: 3.9,
        confidence: 0.98,
        channel: 0,
        speaker: 0,
        words: [
          { word: "bonjour", start: 0.1, end: 0.8, confidence: 0.99 },
          { word: "tout", start: 0.9, end: 1.2, confidence: 0.97 },
          { word: "le", start: 1.2, end: 1.4, confidence: 0.98 },
          { word: "monde", start: 1.4, end: 1.9, confidence: 0.98 },
        ],
      },
    ],
  },
};

export const GLADIA_SUMMARY_FIXTURE = {
  success: true,
  is_empty: false,
  results: "Quelqu'un salue tout le monde.",
  exec_time: 0.2,
};

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

export function startMockGladia(port = 0): Promise<MockGladia> {
  const initBodies: Record<string, unknown>[] = [];
  const liveInitBodies: Record<string, unknown>[] = [];
  const jobs = new Map<string, { audioUrl: string; body: Record<string, unknown>; polls: number }>();
  let uploads = 0;
  let jobCounter = 0;
  let httpUrl = "";
  let wsUrl = "";

  const httpServer = createServer((req, res) => {
    const key = String(req.headers["x-gladia-key"] ?? "");
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const guard = (): boolean => {
      if (key.includes("bad-key")) {
        json(401, { message: "Invalid API key (mock)", statusCode: 401 });
        return false;
      }
      if (key.includes("key-400")) {
        json(400, { message: "Invalid request (mock)", statusCode: 400 });
        return false;
      }
      return true;
    };

    if (req.method === "POST" && req.url === "/v2/upload") {
      req.resume(); // drain the multipart body
      req.on("end", () => {
        if (!guard()) return;
        uploads += 1;
        json(200, {
          audio_url: `${httpUrl}/file/mock-upload-${uploads}`,
          audio_metadata: { id: `mock-upload-${uploads}`, filename: "test.wav" },
        });
      });
      return;
    }

    if (req.method === "POST" && req.url === "/v2/pre-recorded") {
      void readBody(req).then((raw) => {
        if (!guard()) return;
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return json(400, { message: "Bad JSON (mock)" });
        }
        initBodies.push(body);
        jobCounter += 1;
        const id = `mock-job-${jobCounter}`;
        jobs.set(id, { audioUrl: String(body["audio_url"] ?? ""), body, polls: 0 });
        json(201, { id, result_url: `${httpUrl}/v2/pre-recorded/${id}` });
      });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/v2/pre-recorded/")) {
      if (!guard()) return;
      const id = req.url.slice("/v2/pre-recorded/".length);
      const job = jobs.get(id);
      if (!job) return json(404, { message: `No such job ${id} (mock)` });
      job.polls += 1;
      if (job.audioUrl.includes("fail")) {
        return json(200, { id, status: "error", error_code: 500 });
      }
      if (job.audioUrl.includes("slow") || job.polls < 2) {
        return json(200, { id, status: "processing" });
      }
      const result: Record<string, unknown> = structuredClone(GLADIA_RESULT_FIXTURE);
      if (job.body["summarization"] === true) result["summarization"] = GLADIA_SUMMARY_FIXTURE;
      return json(200, { id, status: "done", result });
    }

    if (req.method === "POST" && (req.url === "/v2/live" || req.url?.startsWith("/v2/live?"))) {
      void readBody(req).then((raw) => {
        if (!guard()) return;
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return json(400, { message: "Bad JSON (mock)" });
        }
        liveInitBodies.push(body);
        const id = `mock-live-${liveInitBodies.length}`;
        json(201, { id, url: `${wsUrl}/v2/live?token=mock-token-${id}` });
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not found (mock)" }));
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/v2/live" });
  wss.on("connection", (ws, req) => {
    // The session token minted at init time ("mock-token-mock-live-<n>")
    // points back to that init's body, so its messages_config applies.
    const token =
      new URL(req.url ?? "", "http://localhost").searchParams.get("token") ?? "";
    const index = Number(token.split("-").pop() ?? "") - 1;
    const init = liveInitBodies[index] ?? liveInitBodies[liveInitBodies.length - 1] ?? {};
    const messagesConfig = (init["messages_config"] ?? {}) as Record<string, unknown>;
    const sendPartials = messagesConfig["receive_partial_transcripts"] !== false;

    let frames = 0;
    let finalCount = 0;
    const finals: string[] = [];
    const transcript = (isFinal: boolean, text: string, start: number, end: number): string =>
      JSON.stringify({
        type: "transcript",
        session_id: "mock-session",
        created_at: new Date().toISOString(),
        data: {
          id: `utt-${frames}`,
          is_final: isFinal,
          utterance: {
            text,
            start,
            end,
            language: "fr",
            confidence: 0.9,
            channel: 0,
            words: [{ word: text, start, end, confidence: 0.9 }],
          },
        },
      });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (buf.toString("utf8") === "KILL") {
          ws.terminate();
          return;
        }
        frames += 1;
        if (sendPartials) ws.send(transcript(false, `p${frames}`, frames - 1, frames));
        if (frames % 2 === 0) {
          finalCount += 1;
          const text = `f${finalCount}`;
          finals.push(text);
          ws.send(transcript(true, text, frames - 2, frames));
        }
        return;
      }
      let msg: { type?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.close(1002, "mock: invalid json");
        return;
      }
      if (msg.type === "stop_recording") {
        ws.send(
          JSON.stringify({
            type: "post_final_transcript",
            session_id: "mock-session",
            data: {
              metadata: { audio_duration: frames },
              transcription: {
                full_transcript: finals.join(" "),
                languages: ["fr"],
                utterances: finals.map((text, i) => ({
                  text,
                  start: i * 2,
                  end: i * 2 + 2,
                  language: "fr",
                  confidence: 0.9,
                })),
              },
            },
          }),
        );
        ws.close(1000);
      }
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => {
      const address = httpServer.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      httpUrl = `http://127.0.0.1:${actualPort}`;
      wsUrl = `ws://127.0.0.1:${actualPort}`;
      resolve({
        port: actualPort,
        httpUrl,
        initBodies,
        liveInitBodies,
        uploadCount: () => uploads,
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
  const mock = await startMockGladia(9098);
  console.log(`Mock Gladia API listening at ${mock.httpUrl}`);
  console.log("Point voice-server at it with:");
  console.log(`  GLADIA_API_KEY=mock GLADIA_BASE_URL=${mock.httpUrl} npm run dev`);
}
