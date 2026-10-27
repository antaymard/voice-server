import type { Context } from "hono";
import type { Mistral } from "@mistralai/mistralai";
import { mapUpstreamError } from "./transcribe.ts";

const VOICE_TYPES = ["all", "preset", "custom"] as const;
const GENDERS = ["female", "male", "neutral"] as const;
const MAX_PAGE_SIZE = 100;

type VoiceType = (typeof VOICE_TYPES)[number];
type Gender = (typeof GENDERS)[number];

/** Comma-separated and/or repeated query values: `?language=fr,en&language=de`. */
function listParam(c: Context, name: string): string[] {
  return c.req
    .queries(name)
    ?.flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean) ?? [];
}

/**
 * Voice discovery for `/v1/speak`: lists Mistral's preset voices and the
 * voices saved in this server's Mistral workspace (cursor-paginated). The
 * `id` of an entry is what `/v1/speak` takes as `voice`.
 */
export function createVoicesHandler(batch: Mistral) {
  return async (c: Context): Promise<Response> => {
    const badRequest = (message: string) =>
      c.json({ error: { code: "bad_request", message } }, 400);

    const type = (c.req.query("type") || "all").toLowerCase();
    if (!(VOICE_TYPES as readonly string[]).includes(type)) {
      return badRequest(`Invalid type "${type}" (use one of ${VOICE_TYPES.join(", ")})`);
    }
    const genders = listParam(c, "gender").map((g) => g.toLowerCase());
    const badGender = genders.find((g) => !(GENDERS as readonly string[]).includes(g));
    if (badGender) {
      return badRequest(`Invalid gender "${badGender}" (use one of ${GENDERS.join(", ")})`);
    }
    const pageSizeRaw = c.req.query("page_size");
    const pageSize = pageSizeRaw === undefined ? undefined : Number(pageSizeRaw);
    if (
      pageSize !== undefined &&
      (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
    ) {
      return badRequest(`\`page_size\` must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }
    const languages = listParam(c, "language").map((l) => l.toLowerCase());
    const query = c.req.query("query");
    const pageToken = c.req.query("page_token");

    try {
      const page = await batch.audio.voices.search({
        type: type as VoiceType,
        ...(genders.length ? { gender: genders as Gender[] } : {}),
        ...(languages.length ? { language: languages } : {}),
        ...(query ? { query } : {}),
        ...(pageSize !== undefined ? { pageSize } : {}),
        ...(pageToken ? { pageToken } : {}),
      });
      const { data, nextPageToken } = page.result;
      return c.json({
        voices: data.map((v) => ({
          id: v.id,
          name: v.name,
          slug: v.slug ?? null,
          type: v.type,
          languages: v.languages ?? [],
          gender: v.gender ?? null,
          description: v.description ?? null,
          tags: v.tags ?? [],
        })),
        nextPageToken: nextPageToken ?? null,
      });
    } catch (err) {
      const { status, code, message } = mapUpstreamError(err);
      console.error(`[voices] upstream error (${status} ${code}):`, err);
      return c.json({ error: { code, message } }, status);
    }
  };
}
