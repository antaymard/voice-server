/**
 * Thin client for the Gladia v2 REST API (https://api.gladia.io).
 * No SDK dependency: plain fetch, `x-gladia-key` auth.
 *
 * Endpoints used:
 * - POST /v2/upload            multipart upload -> hosted audio_url
 * - POST /v2/pre-recorded      start an async transcription job
 * - GET  /v2/pre-recorded/:id  poll a job (queued|processing|done|error)
 * - POST /v2/live              mint a live session -> per-session wss URL
 */
import type { Config } from "../config.ts";

export class GladiaHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type GladiaJob = {
  id: string;
  status: "queued" | "processing" | "done" | "error";
  /** Set when status is "error". */
  errorCode?: number | string;
  /** Raw Gladia result object (present when status is "done"). */
  result?: Record<string, unknown>;
};

export type GladiaLiveSession = { id: string; url: string };

export type GladiaClient = {
  /** Upload an audio file to Gladia's storage; returns the hosted audio URL. */
  upload(fileName: string, content: Blob): Promise<string>;
  /** Start a pre-recorded transcription job; returns its id. */
  initTranscription(body: Record<string, unknown>): Promise<string>;
  /** Fetch the current state of a pre-recorded job. */
  getTranscription(id: string): Promise<GladiaJob>;
  /** Create a live session; returns the WebSocket URL to stream audio to. */
  initLiveSession(body: Record<string, unknown>): Promise<GladiaLiveSession>;
};

function extractGladiaMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const message = (body as Record<string, unknown>)["message"];
  if (typeof message === "string" && message) return message;
  if (Array.isArray(message)) {
    const joined = message.filter((m) => typeof m === "string").join("; ");
    if (joined) return joined;
  }
  return null;
}

export function createGladiaClient(config: Config): GladiaClient {
  const request = async (
    path: string,
    init: { method: string; body?: BodyInit; contentType?: string },
  ): Promise<unknown> => {
    const headers: Record<string, string> = { "x-gladia-key": config.gladiaApiKey };
    if (init.contentType) headers["content-type"] = init.contentType;
    const res = await fetch(`${config.gladiaBaseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      throw new GladiaHttpError(
        res.status,
        extractGladiaMessage(body) ?? `Gladia returned HTTP ${res.status}`,
      );
    }
    return body;
  };

  const asRecord = (value: unknown, context: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null) {
      throw new GladiaHttpError(502, `Unexpected Gladia response for ${context}`);
    }
    return value as Record<string, unknown>;
  };

  return {
    async upload(fileName, content) {
      const form = new FormData();
      form.append("audio", content, fileName);
      const body = asRecord(await request("/v2/upload", { method: "POST", body: form }), "upload");
      const audioUrl = body["audio_url"];
      if (typeof audioUrl !== "string" || !audioUrl) {
        throw new GladiaHttpError(502, "Gladia upload response is missing audio_url");
      }
      return audioUrl;
    },

    async initTranscription(initBody) {
      const body = asRecord(
        await request("/v2/pre-recorded", {
          method: "POST",
          body: JSON.stringify(initBody),
          contentType: "application/json",
        }),
        "transcription init",
      );
      const id = body["id"];
      if (typeof id !== "string" || !id) {
        throw new GladiaHttpError(502, "Gladia transcription response is missing id");
      }
      return id;
    },

    async getTranscription(id) {
      const body = asRecord(
        await request(`/v2/pre-recorded/${encodeURIComponent(id)}`, { method: "GET" }),
        "transcription result",
      );
      const status = body["status"];
      if (status !== "queued" && status !== "processing" && status !== "done" && status !== "error") {
        throw new GladiaHttpError(502, `Gladia returned unknown job status "${String(status)}"`);
      }
      const errorCode = body["error_code"];
      const result = body["result"];
      return {
        id: typeof body["id"] === "string" ? body["id"] : id,
        status,
        ...(typeof errorCode === "number" || typeof errorCode === "string"
          ? { errorCode }
          : {}),
        ...(typeof result === "object" && result !== null
          ? { result: result as Record<string, unknown> }
          : {}),
      };
    },

    async initLiveSession(initBody) {
      const region = config.gladiaRegion
        ? `?region=${encodeURIComponent(config.gladiaRegion)}`
        : "";
      const body = asRecord(
        await request(`/v2/live${region}`, {
          method: "POST",
          body: JSON.stringify(initBody),
          contentType: "application/json",
        }),
        "live session init",
      );
      const id = body["id"];
      const url = body["url"];
      if (typeof id !== "string" || typeof url !== "string" || !url) {
        throw new GladiaHttpError(502, "Gladia live response is missing id/url");
      }
      return { id, url };
    },
  };
}

export type GladiaErrorInfo = { status: 400 | 404 | 429 | 502; code: string; message: string };

/** Map an upstream Gladia failure onto our JSON error envelope. */
export function mapGladiaError(err: unknown): GladiaErrorInfo {
  if (err instanceof GladiaHttpError) {
    if (err.status === 401 || err.status === 403) {
      return {
        status: 502,
        code: "upstream_auth",
        message: "Upstream authentication failed (check the server's GLADIA_API_KEY)",
      };
    }
    if (err.status === 400 || err.status === 422) {
      return { status: 400, code: "bad_request", message: err.message };
    }
    if (err.status === 404) {
      return { status: 404, code: "not_found", message: "No Gladia transcription with this id" };
    }
    if (err.status === 429) {
      return { status: 429, code: "rate_limited", message: "Upstream rate limit reached, retry later" };
    }
    return { status: 502, code: "upstream_error", message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 502,
    code: "upstream_error",
    message: message.length > 500 ? `${message.slice(0, 500)}…` : message,
  };
}
