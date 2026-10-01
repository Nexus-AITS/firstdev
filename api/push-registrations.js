/**
 * Send the NEXUS roster to a destination the operations team configured.
 *
 *   POST /api/push-registrations      { "destination_id": "<uuid>" }
 *   X-Nexus-Staff-Token: <the console's staff token>
 *
 * ── Why this function exists at all ─────────────────────────────────────────
 * The database cannot make an HTTP request on this project: pg_net is not among
 * its extensions (pg_trgm, pgcrypto, supabase_vault, uuid-ossp are), and adding
 * one is a dashboard-level change on a project this team does not administer
 * that way. So the request is made here.
 *
 * ── What this function is trusted with, and what it is not ───────────────────
 * It is trusted to DELIVER a message. It is not trusted to decide what is in
 * it. The destination URL, the auth header, the secret and the entire payload
 * all come from public.staff_push_payload(), which reads the secret out of
 * supabase_vault and builds the body from public.registration_api_row(). So a
 * payload can never disagree with what the partner API would return for the same
 * moment, and the secret is never in the browser: the console sends only a
 * destination id.
 *
 * ── Why MASTER-only, checked twice ───────────────────────────────────────────
 * staff_push_payload is gated on a master staff session, and so is this
 * endpoint's own check. That is the one function on the project that can read a
 * working outbound credential, so a coordinator cannot reach it even by
 * calling the RPC directly.
 *
 * ── Why the status is recorded ──────────────────────────────────────────────
 * An operator pressing SEND and seeing nothing is the failure mode worth
 * designing against, so the destination's own answer is written back to
 * public.push_destinations and rendered on the tab. A push that fails loudly in
 * the console is recoverable; one that fails silently is not.
 */
function readSupabaseUrl() {
  return (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
}

function readAnonKey() {
  return process.env.SUPABASE_ANON_KEY || "";
}

/** One call, with the console's staff token, so the database does the gating. */
async function callRpc(name, params, staffToken) {
  const supabaseUrl = readSupabaseUrl();
  const anonKey = readAnonKey();
  if (!supabaseUrl || !anonKey) throw new Error("no database connection configured");

  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "X-Nexus-Staff-Token": staffToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`the database sent an unreadable answer (HTTP ${res.status})`);
  }
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }

  const staffToken = String(req.headers?.["x-nexus-staff-token"] ?? "").trim();
  if (!staffToken) {
    return res.status(401).json({ ok: false, error: "Sign in to the operations console first." });
  }

  const destinationId = String(req.body?.destination_id ?? "").trim();
  if (!destinationId) {
    return res.status(400).json({ ok: false, error: "No destination was named." });
  }

  let prepared;
  try {
    // The database decides: the URL, the headers including the Vault secret, and
    // the body. Nothing about the message is assembled here.
    prepared = await callRpc("staff_push_payload", { p_destination_id: destinationId }, staffToken);
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
  if (prepared?.ok === false) {
    return res.status(403).json(prepared);
  }

  let status = 0;
  let detail = "";
  try {
    const outbound = await fetch(prepared.url, {
      method: "POST",
      headers: prepared.headers ?? { "Content-Type": "application/json" },
      body: JSON.stringify(prepared.body),
      signal: AbortSignal.timeout(30_000),
    });
    status = outbound.status;
    /* A destination is free to answer with an HTML error page, so only the first
       500 characters are kept and the console truncates again. Enough to see
       "unauthorised" or "invalid payload"; not enough to paste a whole site
       into the roster tab. */
    detail = (await outbound.text()).slice(0, 500);
  } catch (err) {
    status = 0;
    detail = err?.message ?? "The destination could not be reached.";
  }

  // Recorded either way. A failed send the operator cannot see is a send that
  // will be repeated, or worse, assumed to have worked.
  try {
    await callRpc(
      "staff_record_push",
      {
        p_destination_id: destinationId,
        p_status: status,
        p_count: prepared.count ?? null,
        p_error: status >= 200 && status < 300 ? null : detail || `HTTP ${status}`,
      },
      staffToken
    );
  } catch {
    // The send already happened; failing to journal it must not turn a delivered
    // payload into a 500 the console renders as "nothing was sent".
  }

  const ok = status >= 200 && status < 300;
  return res.status(ok ? 200 : 502).json({
    ok,
    count: prepared.count ?? 0,
    status,
    // The destination's own words. An operator debugging a 401 needs them more
    // than this function's opinion about them.
    detail: detail.slice(0, 500),
    error: ok ? null : `The destination answered HTTP ${status}.`,
  });
}
