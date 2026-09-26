import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  createAuthClient,
  isAuthConfigured,
  getAuthRedirectUrl,
  rememberPostAuthPath,
} from "../config/supabase";

const AuthContext = createContext(null);

/** Google hands us a profile through user_metadata — never assume a shape. */
function readIdentity(user) {
  if (!user) return { name: "", email: "", avatarUrl: "" };
  const meta = user.user_metadata ?? {};
  const email = user.email ?? "";
  return {
    name:
      meta.full_name ||
      meta.name ||
      meta.user_name ||
      (email ? email.split("@")[0] : "") ||
      "Nexus traveller",
    email,
    avatarUrl: meta.avatar_url || meta.picture || "",
  };
}

/**
 * Google identity for the whole app: one session, one sign-in entry point.
 *
 * `status` is deliberately three-valued — "loading" is what stops a returning
 * visitor from seeing a SIGN IN button for a frame before their stored session
 * resolves (the same reason the route chunks use a Suspense fallback).
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState(isAuthConfigured ? "loading" : "signed_out");
  const [error, setError] = useState(null);
  // Populated by the async client chunk; every call site guards on it, and the
  // controls that need it are disabled while status is still "loading".
  const [client, setClient] = useState(null);

  useEffect(() => {
    if (!isAuthConfigured) return undefined;
    let alive = true;
    let unsubscribe = null;

    createAuthClient()
      .then((supabase) => {
        if (!alive) return undefined;
        if (!supabase) {
          // createAuthClient returns null on a malformed URL — report unsigned
          // rather than leaving the navbar spinner running forever.
          setStatus((s) => (s === "loading" ? "signed_out" : s));
          return undefined;
        }
        setClient(supabase);

        // The callback MUST stay synchronous. Supabase Auth holds an internal
        // navigation lock while it dispatches, so awaiting another supabase call
        // inside it (getSession, etc.) deadlocks the client — the documented
        // reason the callback is "safe to use without an async function".
        const { data } = supabase.auth.onAuthStateChange((event, next) => {
          if (!alive) return;
          if (event === "SIGNED_OUT") {
            setSession(null);
            setStatus("signed_out");
            return;
          }
          if (next) {
            setSession(next);
            setStatus("signed_in");
            if (event === "SIGNED_IN") setError(null);
          }
        });
        unsubscribe = data.subscription.unsubscribe;

        // Seed from storage so a returning visitor is already signed in before
        // the first auth surface paints. A session established by the OAuth
        // redirect may land here or through onAuthStateChange — both are
        // idempotent.
        return supabase.auth
          .getSession()
          .then(({ data: seeded }) => {
            if (!alive) return;
            const next = seeded?.session ?? null;
            setSession((current) => current ?? next);
            setStatus((current) =>
              current === "loading" ? (next ? "signed_in" : "signed_out") : current
            );
          })
          .catch(() => {
            if (alive) setStatus((current) => (current === "loading" ? "signed_out" : current));
          });
      })
      .catch(() => {
        // The async supabase-js chunk failed to load (offline, blocked, a
        // truncated deploy) — degrade to signed-out so the UI reflects
        // reality instead of implying a session is on its way.
        if (alive) setStatus((current) => (current === "loading" ? "signed_out" : current));
      });

    return () => {
      alive = false;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    // `client` is null until the async chunk resolves; the controls that call
    // this are disabled while status is "loading", so this is belt-and-braces.
    if (!isAuthConfigured || !client) {
      setError("Google sign-in is not configured for this deployment.");
      return;
    }
    setError(null);
    rememberPostAuthPath(window.location.pathname + window.location.search);

    const { error: err } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: getAuthRedirectUrl(),
        // Always show the account chooser: shared lab machines are the norm
        // here, and silently reusing the last Google account is confusing.
        queryParams: { prompt: "select_account" },
      },
    });

    // On success the browser is already navigating to Google, so only a
    // failure (misconfigured project, blocked popup, offline) reaches here.
    if (err) setError(err.message);
  }, [client]);

  const signOut = useCallback(async () => {
    if (!client) return;
    // scope: "local" signs this browser out only — a stray click should never
    // end the traveller's session on every device they own.
    const { error: err } = await client.auth.signOut({ scope: "local" });
    if (err) setError(err.message);
  }, [client]);

  const clearError = useCallback(() => setError(null), []);
  const identity = useMemo(() => readIdentity(session?.user), [session]);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      status,
      signedIn: status === "signed_in",
      configured: isAuthConfigured,
      error,
      clearError,
      signInWithGoogle,
      signOut,
      ...identity,
    }),
    [session, status, error, clearError, signInWithGoogle, signOut, identity]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
