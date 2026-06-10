import type { Server as HttpServer } from "node:http";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { loadConfig, type Config } from "./config.ts";
import { createApp } from "./http.ts";
import { createMistralClients } from "./mistral.ts";
import { attachRealtime, type RealtimeControl } from "./realtime/server.ts";

export type RunningServer = {
  port: number;
  close: () => Promise<void>;
};

export function startServer(config: Config): Promise<RunningServer> {
  const { batch, realtime } = createMistralClients(config);
  let control: RealtimeControl | null = null;
  const app = createApp(config, {
    batch,
    activeSessions: () => control?.activeSessions() ?? 0,
  });

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
      resolve({
        port: info.port,
        close: () =>
          new Promise<void>((done) => {
            control?.shutdown();
            server.close(() => done());
          }),
      });
    }) as HttpServer;
    control = attachRealtime(server, realtime, config);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const config = loadConfig();
  const running = await startServer(config);
  console.log(`voice-server listening on :${running.port}`);

  let closing = false;
  const onSignal = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    void running.close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}
