/**
 * The NEXUS participant read API.
 *
 *   GET /api/registrations?event=<id>&verified=true|false&limit=500&offset=0
 *   Authorization: Bearer nxk_…          (a key from the console's API tab)
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The data lives in Postgres and the shape of it is already written down ONCE,
 * as public.registration_api_row(). This endpoint adds nothing to that: it calls
 * public.api_registrations() and returns what the database said. The alternative
 * — assembling the JSON here in JavaScript — would create a second definition of
 * "who registered", and the operations console and a partner site would drift
 * apart exactly the way every other screen on this site used to.
 *
 * ── Why a partner needs this at all ─────────────────────────────────────────
 * So they need no Supabase SDK, no project URL and no anon key. One URL and one
 * bearer token. The anon key never leaves this file.
 *
 * ── Security ────────────────────────────────────────────────────────────────
 * The API key is a credential the DATABASE checks, not one this function
 * trusts: it is forwarded as X-Nexus-Api-Key and api_registrations() resolves it
 * against public.api_keys, honouring its scopes and its revocation. A revoked
 * key therefore stops working the moment it is revoked, with no deploy and
 * nothing cached here.
 *
 * The response carries names, roll numbers, colleges, EMAIL ADDRESSES and PHONE
 * NUMBERS, so the default scope is `read:verified` — confirmed participants
 * only. `verified=false` widens that, but only for a key that was granted
 * read:all; for any other key the database ignores the request and returns the
 * narrow set, which is why a caller cannot argue its way past its own grant.
 *
 * No CORS header is set. A server-to-server caller needs none, and adding one
 * would let any web page in a browser read the roster with a leaked key. If a
 * partner genuinely needs browser access, allow their origin by name here rather
 * than by default.
 */
function readSupabaseUrl() {
  return (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
}

function readAnonKey() {
  return process.env.SUPABASE_ANON_KEY || "";
}

/** Every header the API key might arrive in, lowercased. */
function apiKeyFrom(req) {
  const auth = String(req.headers?.authorization ?? "");
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  const direct = String(req.headers?.["x-nexus-api-key"] ?? "").trim();
  return bearer || direct;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  // A per-request read: a revoked key must stop working on the NEXT call, and a
  // cached 200 would say otherwise for as long as the cache lived.
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }

  const supabaseUrl = readSupabaseUrl();
  const anonKey = readAnonKey();
  if (!supabaseUrl || !anonKey) {
    return res.status(503).json({
      ok: false,
      error: "This deployment has no database connection configured.",
    });
  }

  const key = apiKeyFrom(req);
  if (!key) {
    return res.status(401).json({
      ok: false,
      error:
        "A NEXUS API key is required. Send it as `Authorization: Bearer nxk_…`.",
    });
  }

  const q = req.query ?? {};
  const body = {
    p_event_id: q.event && q.event !== "all" ? String(q.event) : null,
    p_only_verified: q.verified === undefined ? null : q.verified !== "false",
    p_limit: q.limit ? Number(q.limit) : 500,
    p_offset: q.offset ? Number(q.offset) : 0,
  };

  let upstream;
  try {
    upstream = await fetch(`${supabaseUrl}/rest/v1/rpc/api_registrations`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        // The key the CALLER supplied, in the header the database reads. The
        // anon key above is only there because PostgREST needs one; it grants
        // nothing by itself, which is the whole point of api/config.js refusing
        // to publish a service-role key.
        "X-Nexus-Api-Key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return res.status(502).json({ ok: false, error: "The database is unreachable." });
  }

  const text = await upstream.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return res.status(502).json({ ok: false, error: "The database sent an unreadable answer." });
  }
  // PostgREST returns a function's jsonb directly; an array here means the
  // function returned a set, which is not the declared shape.
  const payload = Array.isArray(parsed) ? parsed[0] : parsed;

  if (payload?.ok === false) {
    // 401 for a credential problem, 403 for a scope problem, so a partner can
    // tell "my key was revoked" from "my key is not allowed to see this".
    const status = /required/i.test(payload.error ?? "") ? 401 : 403;
    return res.status(status).json(payload);
  }

  return res.status(200).json(payload);
}
