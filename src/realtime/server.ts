import type { Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { RealtimeTranscription } from "@mistralai/mistralai/extra/realtime";
import { CLOSE_SHUTDOWN, type ServerErrorEvent } from "../../client/src/protocol.ts";
import { bearerToken, isOriginAllowed, safeEqual } from "../auth.ts";
import type { Config } from "../config.ts";
import type { GladiaClient } from "../gladia/client.ts";
import { runGladiaSession } from "../gladia/bridge.ts";
import { runSession } from "./bridge.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  503: "Service Unavailable",
};

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  // A rejected upgrade surfaces client-side as a bare connection failure,
  // so the server log is the only place the actual cause is visible.
  console.warn(`[realtime] rejected WebSocket upgrade (${status}): ${reason}`);
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

export type RealtimeControl = {
  activeSessions: () => number;
  shutdown: () => void;
};

export type RealtimeDeps = {
  realtime: RealtimeTranscription;
  /** null when GLADIA_API_KEY is not configured (upgrades answer 503). */
  gladia: GladiaClient | null;
};

export function attachRealtime(
  server: HttpServer,
  deps: RealtimeDeps,
  config: Config,
): RealtimeControl {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024, // oversized audio frames auto-close with 1009
    perMessageDeflate: false, // PCM does not compress; save the CPU
  });
  const sessions = new Set<WebSocket>();
  const alive = new WeakMap<WebSocket, boolean>();
  let shuttingDown = false;

  server.on("upgrade", (req, socket, head) => {
    let pathname: string;
    let token: string | null;
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      pathname = url.pathname;
      token = url.searchParams.get("token") ?? bearerToken(req.headers.authorization);
    } catch {
      rejectUpgrade(socket, 400, `unparseable request URL "${req.url ?? ""}"`);
      return;
    }
    if (pathname !== "/v1/realtime" && pathname !== "/v1/gladia/realtime") {
      rejectUpgrade(socket, 404, `unknown path "${pathname}"`);
      return;
    }
    if (pathname === "/v1/gladia/realtime" && !deps.gladia) {
      rejectUpgrade(socket, 503, "Gladia endpoints are disabled (set GLADIA_API_KEY)");
      return;
    }
    if (shuttingDown) {
      rejectUpgrade(socket, 503, "server is shutting down");
      return;
    }
    if (!token || !safeEqual(token, config.authToken)) {
      rejectUpgrade(socket, 401, token ? "invalid token" : "missing token");
      return;
    }
    if (!isOriginAllowed(req.headers.origin, config.allowedOrigins)) {
      rejectUpgrade(socket, 403, `origin "${req.headers.origin}" not in ALLOWED_ORIGINS`);
      return;
    }
    if (sessions.size >= config.maxSessions) {
      rejectUpgrade(socket, 429, `session limit reached (MAX_SESSIONS=${config.maxSessions})`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sessions.add(ws);
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      const onClose = (): void => void sessions.delete(ws);
      if (pathname === "/v1/gladia/realtime") {
        runGladiaSession(ws, deps.gladia as GladiaClient, config, onClose);
      } else {
        runSession(ws, deps.realtime, config, onClose);
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of sessions) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    activeSessions: () => sessions.size,
    shutdown: () => {
      shuttingDown = true;
      clearInterval(heartbeat);
      const event: ServerErrorEvent = {
        type: "error",
        code: "server_shutdown",
        message: "Server is shutting down",
      };
      for (const ws of sessions) {
        try {
          ws.send(JSON.stringify(event));
          ws.close(CLOSE_SHUTDOWN, "server_shutdown");
        } catch {
          ws.terminate();
        }
      }
      wss.close();
    },
  };
}
