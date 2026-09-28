import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";

export const TEST_TOKEN = "test-token-0123456789abcdef0123456789abcdef";

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    mistralApiKey: "mock-api-key",
    authToken: TEST_TOKEN,
    allowedOrigins: "*",
    batchModel: "voxtral-mini-latest",
    realtimeModel: "voxtral-mini-transcribe-realtime-2602",
    ttsModel: "voxtral-mini-tts-2603",
    ttsVoice: "",
    ttsFormat: "pcm",
    maxTtsChars: 8000,
    maxUploadBytes: 25 * 1024 * 1024,
    maxSessions: 20,
    maxSessionMs: 10 * 60 * 1000,
    idleTimeoutMs: 60 * 1000,
    defaultTargetDelayMs: 480,
    mistralBaseUrl: "http://127.0.0.1:1",
    mistralWsUrl: "ws://127.0.0.1:1",
    gladiaApiKey: "mock-gladia-key",
    gladiaBaseUrl: "http://127.0.0.1:1",
    gladiaBulkModel: "solaria-1",
    gladiaLiveModel: "",
    gladiaRegion: "",
    gladiaPollIntervalMs: 10,
    gladiaPollTimeoutMs: 3000,
    // Media module disabled by default; tests opt in with an allowlist.
    // Test files run in parallel processes, so each gets its own work dir.
    mediaAllowedSourceHosts: [],
    mediaWorkDir: join(tmpdir(), `media-jobs-test-${process.pid}`),
    mediaMaxSourceBytes: 600 * 1024 * 1024,
    mediaMaxDurationSec: 8 * 3600,
    mediaMaxConcurrentJobs: 2,
    mediaJobTtlMs: 60 * 60 * 1000,
    mediaFfmpegTimeoutMs: 60 * 1000,
    mediaSilenceNoiseDb: -35,
    mediaSilenceMinSec: 0.4,
    mediaSilenceWindowSec: 60,
    mediaMinLastPartSec: 30,
    ...overrides,
  };
}
