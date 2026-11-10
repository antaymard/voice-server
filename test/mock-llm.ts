/**
 * Mock of an OpenAI-compatible chat-completions endpoint (streaming), for
 * /v1/converse tests. Each request consumes the next scripted reply; with
 * none left it answers "ok.". Requests are recorded on `requests`.
 */
import { createServer } from "node:http";

export type ScriptedReply = {
  /** Text deltas, in order. */
  text?: string[];
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** Wait before the first byte. */
  delayMs?: number;
  /** After the text, keep the stream open this long (a reply still being written). */
  hangMs?: number;
  /** Answer with this HTTP status instead. */
  status?: number;
};

export type MockLlm = {
  baseUrl: string;
  requests: Array<{ authorization: string; body: Record<string, unknown> }>;
  script: (...replies: ScriptedReply[]) => void;
  close: () => Promise<void>;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function startMockLlm(): Promise<MockLlm> {
  const requests: MockLlm["requests"] = [];
  const queue: ScriptedReply[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      void (async () => {
        if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
          res.writeHead(404).end();
          return;
        }
        requests.push({ authorization: req.headers.authorization ?? "", body: JSON.parse(raw) });
        const reply = queue.shift() ?? { text: ["ok."] };
        if (reply.delayMs) await sleep(reply.delayMs);
        if (reply.status) {
          res.writeHead(reply.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "mock failure" }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const write = (delta: unknown): void =>
          void res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
        for (const text of reply.text ?? []) write({ content: text });
        if (reply.hangMs) await sleep(reply.hangMs);
        for (const [index, call] of (reply.toolCalls ?? []).entries()) {
          // Arguments split in two fragments, as real providers stream them.
          const half = Math.ceil(call.arguments.length / 2);
          write({ tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: call.arguments.slice(0, half) } }] });
          write({ tool_calls: [{ index, function: { arguments: call.arguments.slice(half) } }] });
        }
        res.end("data: [DONE]\n\n");
      })();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        script: (...replies) => void queue.push(...replies),
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
