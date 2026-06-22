export type Config = {
  port: number;
  mistralApiKey: string;
  authToken: string;
  /** Allowed browser origins, or "*" to disable the check (dev only). */
  allowedOrigins: string[] | "*";
  batchModel: string;
  realtimeModel: string;
  maxUploadBytes: number;
  maxSessions: number;
  maxSessionMs: number;
  idleTimeoutMs: number;
  defaultTargetDelayMs: number;
  mistralBaseUrl: string;
  mistralWsUrl: string;
};

function intEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = ["MISTRAL_API_KEY", "AUTH_TOKEN", "ALLOWED_ORIGINS"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const authToken = env["AUTH_TOKEN"] as string;
  if (authToken.length < 32) {
    console.warn("[config] AUTH_TOKEN is shorter than 32 characters; use e.g. `openssl rand -hex 32`");
  }

  const rawOrigins = env["ALLOWED_ORIGINS"] as string;
  let allowedOrigins: string[] | "*";
  if (rawOrigins.trim() === "*") {
    console.warn("[config] ALLOWED_ORIGINS=* disables the origin check; do not use in production");
    allowedOrigins = "*";
  } else {
    allowedOrigins = rawOrigins
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean);
    if (allowedOrigins.length === 0) {
      throw new Error("ALLOWED_ORIGINS must list at least one origin, or be `*`");
    }
  }

  return {
    port: intEnv(env, "PORT", 3000),
    mistralApiKey: env["MISTRAL_API_KEY"] as string,
    authToken,
    allowedOrigins,
    batchModel: env["BATCH_MODEL"] || "voxtral-mini-latest",
    realtimeModel: env["REALTIME_MODEL"] || "voxtral-mini-transcribe-realtime-2602",
    maxUploadBytes: intEnv(env, "MAX_UPLOAD_BYTES", 25 * 1024 * 1024),
    maxSessions: intEnv(env, "MAX_SESSIONS", 20),
    maxSessionMs: intEnv(env, "MAX_SESSION_MS", 10 * 60 * 1000),
    idleTimeoutMs: intEnv(env, "IDLE_TIMEOUT_MS", 60 * 1000),
    defaultTargetDelayMs: intEnv(env, "DEFAULT_TARGET_DELAY_MS", 480),
    mistralBaseUrl: env["MISTRAL_BASE_URL"] || "https://api.mistral.ai",
    mistralWsUrl: env["MISTRAL_WS_URL"] || "wss://api.mistral.ai",
  };
}
