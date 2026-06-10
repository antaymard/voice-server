import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Mistral } from "@mistralai/mistralai";
import { bearerToken, isOriginAllowed, safeEqual } from "./auth.ts";
import type { Config } from "./config.ts";
import { createTranscribeHandler } from "./transcribe.ts";

export type AppDeps = {
  batch: Mistral;
  activeSessions: () => number;
};

export function createApp(config: Config, deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) =>
    c.json({ ok: true, uptime: Math.round(process.uptime()), activeSessions: deps.activeSessions() }),
  );

  app.use(
    "/v1/*",
    cors({
      origin: (origin) => (isOriginAllowed(origin, config.allowedOrigins) ? origin : ""),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 86400,
    }),
  );

  app.use("/v1/*", async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !safeEqual(token, config.authToken)) {
      return c.json({ error: { code: "unauthorized", message: "Missing or invalid bearer token" } }, 401);
    }
    await next();
  });

  app.post(
    "/v1/transcribe",
    bodyLimit({
      maxSize: config.maxUploadBytes,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "payload_too_large",
              message: `Request body exceeds ${config.maxUploadBytes} bytes`,
            },
          },
          413,
        ),
    }),
    createTranscribeHandler(deps.batch, config),
  );

  // Demo page (mic + file upload). Static files are public; API calls made
  // from the page still require the token.
  app.use("*", serveStatic({ root: "./public" }));

  return app;
}
