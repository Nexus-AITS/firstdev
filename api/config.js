/**
 * Runtime configuration endpoint.
 *
 * Why this exists: Vite inlines `VITE_`-prefixed variables into the public
 * bundle at BUILD time, which forces a rebuild to rotate a credential and puts
 * the value in immutable CDN assets forever. This endpoint removes that
 * coupling — the browser fetches its config at RUNTIME, and the values live
 * only in the server environment.
 *
 * Env vars read (deliberately NOT VITE_-prefixed, so nothing is inlined):
 *   SUPABASE_URL       https://<project-ref>.supabase.co
 *   SUPABASE_ANON_KEY  public anon / publishable key
 *
 * ── Security note, stated plainly ────────────────────────────────────────────
 * The anon key is returned to the browser because the browser needs it to call
 * Supabase directly. That key is public by design — it grants nothing beyond
 * what Row Level Security allows (see
 * supabase/migrations/20260926000001_registration_policies.sql, where the only
 * anon grant is a narrow INSERT and reads stay denied). This endpoint is
 * therefore NOT a way to hide a secret, and it is not treated as one: there is
 * no service-role key, no database URL and no PAT anywhere near it, and
 * `assertPublishableKey` below actively refuses to serve a privileged key so a
 * fat-fingered env var cannot be published by accident.
 *
 * What it DOES buy: the key is absent from the static JS, and rotating it needs
 * no rebuild — redeploy the function, or just restart it.
 */
// Read inside the handler, not at module scope: a serverless runtime may reuse a
// warm instance, and module-level captures freeze whatever existed at import
// time. Reading per-request also means a redeploy with new values is picked up
// without a cold start.
function readSupabaseUrl() {
  return (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
}

function readAnonKey() {
  return process.env.SUPABASE_ANON_KEY || "";
}

/**
 * A Supabase anon / publishable key is either a legacy anon JWT (`eyJ…`, whose
 * payload carries `role: "anon"`) or a `sb_publishable_…` key. A service-role
 * key is a JWT whose payload says `role: "service_role"` — that one bypasses
 * RLS entirely and must never be served from a public endpoint.
 */
function assertPublishableKey(key) {
  if (!key) return "SUPABASE_ANON_KEY is not set";
  if (key.startsWith("sb_publishable_") || key.startsWith("sb_secret_")) {
    // sb_secret_ IS the service-role equivalent — reject it explicitly.
    return key.startsWith("sb_secret_")
      ? "SUPABASE_ANON_KEY holds an sb_secret_ (service-role) key — refusing to publish it"
      : null;
  }
  if (key.startsWith("eyJ")) {
    try {
      const payload = JSON.parse(atob(key.split(".")[1]));
      if (payload.role && payload.role !== "anon") {
        return `SUPABASE_ANON_KEY carries role "${payload.role}" — refusing to publish it`;
      }
      return null;
    } catch {
      return "SUPABASE_ANON_KEY looks like a JWT but could not be decoded";
    }
  }
  return "SUPABASE_ANON_KEY is not a recognised Supabase anon / publishable key";
}

export default function handler(req, res) {
  // Same-origin only. The response is tiny and per-deploy, and it must never be
  // held by a shared cache — a rotated key has to take effect immediately.
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "method not allowed" });
  }

  const supabaseUrl = readSupabaseUrl();
  if (!supabaseUrl) {
    return res.status(503).json({ error: "SUPABASE_URL is not set on this deployment" });
  }
  let origin;
  try {
    origin = new URL(supabaseUrl).origin;
  } catch {
    return res.status(503).json({ error: "SUPABASE_URL is not a valid URL" });
  }

  const anonKey = readAnonKey();
  const keyProblem = assertPublishableKey(anonKey);
  if (keyProblem) return res.status(503).json({ error: keyProblem });

  return res.status(200).json({ supabaseUrl: origin, supabaseAnonKey: anonKey });
}
