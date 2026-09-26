/**
 * Supabase client — the NEXUS gatekeeper's identity provider.
 *
 * Google sign-in is delegated to Supabase Auth (`provider: "google"`), so the
 * browser only ever talks to <project>.supabase.co; the Google consent screen
 * is reached with a top-level redirect, not an iframe or a third-party script.
 * That is why the CSP in vite.config.js / public/_headers only widens
 * `connect-src` and `img-src` — no accounts.google.com script or frame.
 *
 * The anon / publishable key is *designed* to be public (it grants nothing
 * beyond what Row Level Security allows), so it ships in the bundle through
 * Vite's VITE_ prefix. A service-role key must never appear in this repo.
 *
 * When the env vars are absent (fresh clone, CI, or a deployment that forgot
 * them) the site must still render: `isAuthConfigured` gates every auth
 * surface so NEXUS degrades to a plain gateway instead of crashing.
 */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
// Accepts either the legacy anon JWT or a newer sb_publishable_… key.
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

export const isAuthConfigured = Boolean(supabaseUrl && supabaseAnonKey);

const AUTH_OPTIONS = {
  // PKCE is the flow Supabase recommends for browsers: Google returns
  // `?code=…` (never tokens in the hash), and detectSessionInUrl swaps that
  // code for a session automatically on the callback page load. Both are set
  // explicitly so behaviour never depends on a library default changing.
  flowType: "pkce",
  detectSessionInUrl: true,
  persistSession: true,
  autoRefreshToken: true,
};

/**
 * Build the client.
 *
 * supabase-js is ~215 kB, so a static import would drag it into the entry
 * bundle that blocks first paint — the same cost three.js carries, which is
 * why `LazyCrystalCanvas` keeps that behind a dynamic import too. AuthProvider
 * calls this from its effect: the page paints immediately, the navbar holds a
 * loader diamond, and the client lands a beat later. Returns null when the
 * deployment has no credentials rather than throwing.
 */
export async function createAuthClient() {
  if (!isAuthConfigured) return null;
  try {
    // Dynamic on purpose: this is the line that keeps supabase-js out of the
    // blocking entry bundle. Vite splits it into its own async chunk.
    const { createClient } = await import("@supabase/supabase-js");
    return createClient(supabaseUrl, supabaseAnonKey, { auth: AUTH_OPTIONS });
  } catch {
    // Malformed URL, or the chunk failed to resolve. Returned as null so the
    // caller can surface it in the UI — nothing here should throw into render.
    return null;
  }
}

/** Where Supabase sends the browser back to. Must be allow-listed in the
 *  Supabase dashboard (Auth → URL Configuration → Redirect URLs) in every
 *  environment, or the redirect is refused before it reaches the app. */
export function getAuthRedirectUrl() {
  return `${window.location.origin}/auth/callback`;
}

/** Where a signed-in traveller lands when no return path was remembered —
 *  only reachable when sessionStorage is unavailable (private mode). Home is
 *  the least surprising place to drop someone. */
export const DEFAULT_POST_AUTH_PATH = "/";

const NEXT_KEY = "nexus.auth.next";

/**
 * Remember where the sign-in started so the callback can send the traveller
 * back to it. sessionStorage (not local) because the intent should not
 * outlive the tab, and only same-origin paths are stored — an absolute URL
 * here would turn the callback into an open redirect.
 */
export function rememberPostAuthPath(path) {
  try {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return;
    window.sessionStorage.setItem(NEXT_KEY, path);
  } catch {
    /* private mode / storage disabled — the default path is used instead */
  }
}

/** Read and clear the remembered path (one-shot: never trap a later visit). */
export function takePostAuthPath() {
  try {
    const path = window.sessionStorage.getItem(NEXT_KEY);
    window.sessionStorage.removeItem(NEXT_KEY);
    if (!path || !path.startsWith("/") || path.startsWith("//")) return DEFAULT_POST_AUTH_PATH;
    return path;
  } catch {
    return DEFAULT_POST_AUTH_PATH;
  }
}

/**
 * OAuth failures come back as query params (PKCE) or hash params (implicit),
 * so both are checked. Returns null when the visitor simply arrived normally.
 */
export function readAuthRedirectError() {
  if (typeof window === "undefined") return null;
  const sources = [window.location.search, window.location.hash.replace(/^#/, "?")];
  for (const source of sources) {
    const params = new URLSearchParams(source);
    const code = params.get("error_code") || params.get("error");
    if (!code) continue;
    return {
      code,
      description: params.get("error_description") || params.get("error_message") || "",
    };
  }
  return null;
}
