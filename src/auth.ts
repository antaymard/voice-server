import { createHash, timingSafeEqual } from "node:crypto";

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
