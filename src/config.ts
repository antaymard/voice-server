/** Output formats Mistral's speech endpoint can return. */
export const SPEECH_FORMATS = ["pcm", "wav", "mp3", "flac", "opus"] as const;
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];

export type Config = {
  port: number;
  mistralApiKey: string;
  authToken: string;
  /** Allowed browser origins, or "*" to disable the check (dev only). */
  allowedOrigins: string[] | "*";
  batchModel: string;
  realtimeModel: string;
  ttsModel: string;
  /** Default preset/saved voice, or "" to let Mistral pick its default. */
  ttsVoice: string;
  /** Default output audio format when the request omits one. */
  ttsFormat: SpeechFormat;
  /** Max characters accepted per synthesis request. */
  maxTtsChars: number;
  maxUploadBytes: number;
  maxSessions: number;
  maxSessionMs: number;
  idleTimeoutMs: number;
  defaultTargetDelayMs: number;
  mistralBaseUrl: string;
  mistralWsUrl: string;
  /** Gladia API key; "" disables the /v1/gladia/* endpoints. */
  gladiaApiKey: string;
  gladiaBaseUrl: string;
  /**
   * Pre-recorded model. "solaria-1" (default): 100+ languages, best on
   * clean/formal/read speech, also the only one available live. "solaria-3":
   * best on noisy/production audio, but async-only and restricted to a
   * single language among en/fr/de/es/it (see SOLARIA_3_LANGUAGES).
   */
  gladiaBulkModel: "solaria-1" | "solaria-3";
  /** Live model override, or "" to let Gladia pick its default (solaria-1; the only model live supports as of writing). */
  gladiaLiveModel: string;
  /** Region for live sessions ("eu-west", "us-west"), or "" for Gladia's default. */
  gladiaRegion: string;
  /** Bulk transcription polling cadence and cap. */
  gladiaPollIntervalMs: number;
  gladiaPollTimeoutMs: number;
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

  const ttsFormat = (env["TTS_FORMAT"] || "pcm").toLowerCase();
  if (!(SPEECH_FORMATS as readonly string[]).includes(ttsFormat)) {
    throw new Error(`Invalid TTS_FORMAT "${ttsFormat}": use one of ${SPEECH_FORMATS.join(", ")}`);
  }

  const gladiaBulkModel = env["GLADIA_BULK_MODEL"] || "solaria-1";
  if (gladiaBulkModel !== "solaria-1" && gladiaBulkModel !== "solaria-3") {
    throw new Error(`Invalid GLADIA_BULK_MODEL "${gladiaBulkModel}": use "solaria-1" or "solaria-3"`);
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
    ttsModel: env["TTS_MODEL"] || "voxtral-mini-tts-2603",
    ttsVoice: env["TTS_VOICE"] || "",
    ttsFormat: ttsFormat as SpeechFormat,
    maxTtsChars: intEnv(env, "MAX_TTS_CHARS", 8000),
    maxUploadBytes: intEnv(env, "MAX_UPLOAD_BYTES", 25 * 1024 * 1024),
    maxSessions: intEnv(env, "MAX_SESSIONS", 20),
    maxSessionMs: intEnv(env, "MAX_SESSION_MS", 10 * 60 * 1000),
    idleTimeoutMs: intEnv(env, "IDLE_TIMEOUT_MS", 60 * 1000),
    defaultTargetDelayMs: intEnv(env, "DEFAULT_TARGET_DELAY_MS", 480),
    mistralBaseUrl: env["MISTRAL_BASE_URL"] || "https://api.mistral.ai",
    mistralWsUrl: env["MISTRAL_WS_URL"] || "wss://api.mistral.ai",
    gladiaApiKey: env["GLADIA_API_KEY"] || "",
    gladiaBaseUrl: (env["GLADIA_BASE_URL"] || "https://api.gladia.io").replace(/\/$/, ""),
    gladiaBulkModel,
    gladiaLiveModel: env["GLADIA_LIVE_MODEL"] || "",
    gladiaRegion: env["GLADIA_REGION"] || "",
    gladiaPollIntervalMs: intEnv(env, "GLADIA_POLL_INTERVAL_MS", 1000),
    gladiaPollTimeoutMs: intEnv(env, "GLADIA_POLL_TIMEOUT_MS", 5 * 60 * 1000),
  };
}
