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
 * requests without one (curl, native apps) rely on the token alone.
 */
export function isOriginAllowed(
  origin: string | undefined | null,
  allowed: string[] | "*",
): boolean {
  if (allowed === "*") return true;
  if (!origin) return true;
  return allowed.includes(origin.replace(/\/$/, ""));
}
