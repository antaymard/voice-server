import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time string comparison (hashes first so lengths may differ). */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/** Extract the token from an `Authorization: Bearer <token>` header value. */
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Origin policy: when a browser sends an Origin header it must be allowlisted;
 * requests without one (curl, native apps) rely on the token alone. A page
 * served by this very server (the built-in demos) is always allowed: pass the
 * request's `Host` header as `host` to recognize it. Browsers set both
 * headers themselves, so a page from another site cannot fake the match.
 */
export function isOriginAllowed(
  origin: string | undefined | null,
  allowed: string[] | "*",
  host?: string | null,
): boolean {
  if (allowed === "*") return true;
  if (!origin) return true;
  const normalized = origin.replace(/\/$/, "");
  if (allowed.includes(normalized)) return true;
  if (!host) return false;
  try {
    return new URL(normalized).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

// --- Session tokens -------------------------------------------------------------
//
// The master AUTH_TOKEN is a server-to-server secret: it never expires and
// opens everything. A browser gets a session token instead, minted for it by
// an app's backend through `POST /v1/tokens`: short-lived, limited to the
// features it names, and carrying who it was minted for. Tokens are signed,
// not stored, so they survive restarts and need no database; the price is
// that one cannot be revoked before it expires.

/** What a token may be used for; each maps to a family of endpoints. */
export const SCOPES = ["stt", "tts", "converse", "decide", "media"] as const;
export type Scope = (typeof SCOPES)[number];

export const SESSION_TOKEN_PREFIX = "vs_s_";
export const DEFAULT_SESSION_TOKEN_TTL_SEC = 60 * 60;

export type SessionClaims = {
  /** Who the app's backend minted the token for (opaque to this server). */
  subject: string | null;
  scopes: Scope[];
  /** Expiry, in seconds since the epoch. */
  expiresAt: number;
};

/**
 * Signing key, derived from the master token: rotating AUTH_TOKEN therefore
 * invalidates every session token at once.
 */
function signingKey(authToken: string): Buffer {
  return createHmac("sha256", authToken).update("voice-server session tokens v1").digest();
}

const sign = (payload: string, authToken: string): string =>
  createHmac("sha256", signingKey(authToken)).update(payload).digest("base64url");

export function mintSessionToken(claims: SessionClaims, authToken: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: claims.subject, scp: claims.scopes, exp: claims.expiresAt }),
  ).toString("base64url");
  return `${SESSION_TOKEN_PREFIX}${payload}.${sign(payload, authToken)}`;
}

/** The claims of a genuine token (expired or not), or null if it is not one of ours. */
export function readSessionToken(token: string, authToken: string): SessionClaims | null {
  if (!token.startsWith(SESSION_TOKEN_PREFIX)) return null;
  const [payload, signature, ...rest] = token.slice(SESSION_TOKEN_PREFIX.length).split(".");
  if (!payload || !signature || rest.length > 0) return null;
  if (!safeEqual(signature, sign(payload, authToken))) return null;
  try {
    const raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const scopes = raw["scp"];
    if (typeof raw["exp"] !== "number" || !Array.isArray(scopes)) return null;
    return {
      subject: typeof raw["sub"] === "string" ? raw["sub"] : null,
      scopes: scopes.filter((s): s is Scope => (SCOPES as readonly unknown[]).includes(s)),
      expiresAt: raw["exp"],
    };
  } catch {
    return null;
  }
}

export type Authorization =
  /** `subject` is null for the master token. */
  | { ok: true; master: boolean; subject: string | null }
  | { ok: false; status: 401 | 403; code: "unauthorized" | "token_expired" | "forbidden"; message: string };

/**
 * May this token do `need`? `need` is a scope, or "master" for what only the
 * master token may do (minting tokens).
 */
export function authorize(
  token: string | null | undefined,
  authToken: string,
  need: Scope | "master",
  now: number = Date.now(),
): Authorization {
  if (!token) return { ok: false, status: 401, code: "unauthorized", message: "Missing token" };
  if (safeEqual(token, authToken)) return { ok: true, master: true, subject: null };
  const claims = readSessionToken(token, authToken);
  if (!claims) return { ok: false, status: 401, code: "unauthorized", message: "Invalid token" };
  if (claims.expiresAt * 1000 <= now) {
    return { ok: false, status: 401, code: "token_expired", message: "Session token expired: request a new one" };
  }
  if (need === "master") {
    return { ok: false, status: 403, code: "forbidden", message: "This needs the server token, not a session token" };
  }
  if (!claims.scopes.includes(need)) {
    return { ok: false, status: 403, code: "forbidden", message: `This session token does not grant "${need}"` };
  }
  return { ok: true, master: false, subject: claims.subject };
}

/** Which scope an HTTP path under /v1 needs. */
export function scopeForPath(pathname: string): Scope | "master" | null {
  if (pathname === "/v1/tokens") return "master";
  if (pathname === "/v1/converse") return "converse";
  if (pathname === "/v1/decide") return "decide";
  if (pathname === "/v1/speak" || pathname === "/v1/voices") return "tts";
  if (pathname.startsWith("/v1/media/")) return "media";
  if (
    pathname === "/v1/transcribe" ||
    pathname === "/v1/realtime" ||
    pathname === "/v1/gladia/realtime" ||
    pathname.startsWith("/v1/gladia/transcribe")
  ) {
    return "stt";
  }
  return null;
}
