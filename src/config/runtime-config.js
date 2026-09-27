/**
 * Runtime configuration — the single source of truth for public deployment
 * settings, fetched instead of compiled in.
 *
 * Vite inlines `VITE_`-prefixed variables into the bundle at build time, which
 * couples a credential to a rebuild and leaves it in immutable CDN assets. The
 * browser therefore asks `/api/config` (a Vercel function reading the server
 * environment) what it needs. The response is held in `sessionStorage` so a
 * hard refresh does not re-hit the function, and it is namespaced and
 * same-origin by construction.
 *
 * The anon key is public by design — it grants nothing beyond Row Level
 * Security — so shipping it to the browser is correct. What this buys is
 * rotatability: change the env var, redeploy the function, and every open tab
 * picks it up on its next load. No rebuild, no stale asset.
 *
 * Contract: resolves to `{ supabaseUrl, supabaseAnonKey }` or null when the
 * deployment is unconfigured. It never throws — every caller already has a
 * designed "unavailable" state, and an exception here would take down the
 * routes that import it.
 */
const ENDPOINT = "/api/config";
const CACHE_KEY = "nexus.config.v1";
/** The endpoint is same-origin and tiny; a slow answer means something is wrong. */
const TIMEOUT_MS = 5000;

/** Cached for the lifetime of the page so repeat calls never re-fetch. */
let memo = null;

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Guard against a truncated or hand-edited entry.
    return typeof parsed?.supabaseUrl === "string" && typeof parsed?.supabaseAnonKey === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeCache(value) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    /* private mode / quota — the in-memory memo still serves this page */
  }
}

/**
 * Resolve the deployment config, or null when it is unavailable.
 * Deduplicated: concurrent callers share one in-flight request.
 */
export function loadRuntimeConfig() {
  if (memo) return Promise.resolve(memo);

  const cached = typeof window === "undefined" ? null : readCache();
  if (cached) {
    memo = cached;
    return Promise.resolve(cached);
  }

  return fetch(ENDPOINT, {
    // Same-origin credential-free GET; `same-origin` keeps it from ever
    // attaching cookies, so this cannot become a CSRF vector.
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      // A 200 can still carry an error body when the function is misconfigured;
      // require both fields before trusting it.
      if (!data?.supabaseUrl || !data?.supabaseAnonKey) return null;
      const value = { supabaseUrl: data.supabaseUrl, supabaseAnonKey: data.supabaseAnonKey };
      memo = value;
      writeCache(value);
      return value;
    })
    .catch((err) => {
      // Offline, blocked by CSP, or a 404 because the function is not deployed
      // (a static host has no /api). All degrade to "unconfigured" by design.
      console.warn("runtime config unavailable:", err?.message || err);
      return null;
    });
}

/** Drop the memo + cache. Exported for tests and for a manual retry. */
export function resetRuntimeConfig() {
  memo = null;
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing to clear */
  }
}
