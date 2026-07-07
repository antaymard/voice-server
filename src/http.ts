import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Mistral } from "@mistralai/mistralai";
import { bearerToken, isOriginAllowed, safeEqual } from "./auth.ts";
import type { Config } from "./config.ts";
import { createTranscribeHandler } from "./transcribe.ts";
import { createSynthesizeHandler } from "./synthesize.ts";

export type AppDeps = {
  batch: Mistral;
  activeSessions: () => number;
};

export function createApp(config: Config, deps: AppDeps): Hono {
  const app = new Hono();

  // Every response — including crashes and unknown routes — uses the JSON
  // error envelope, so clients never have to special-case plain-text bodies.
  app.onError((err, c) => {
    console.error(`[http] unhandled error on ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
  });
  app.notFound((c) =>
    c.json(
      { error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } },
      404,
    ),
  );

  app.get("/healthz", (c) =>
    c.json({ ok: true, uptime: Math.round(process.uptime()), activeSessions: deps.activeSessions() }),
  );

  app.use(
    "/v1/*",
    cors({
      origin: (origin) => {
        if (isOriginAllowed(origin, config.allowedOrigins)) return origin;
        // The browser hides CORS failures from the page ("Failed to fetch"),
        // so leave a server-side trace of why the request was blocked.
        console.warn(`[http] blocked CORS origin "${origin}" (not in ALLOWED_ORIGINS)`);
        return "";
      },
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

  app.post("/v1/speak", createSynthesizeHandler(deps.batch, config));

  // Demo page (mic + file upload). Static files are public; API calls made
  // from the page still require the token.
  app.use("*", serveStatic({ root: "./public" }));

  return app;
}
