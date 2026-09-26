import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import RealmFX from "../components/fx/RealmFX.jsx";
import CrystalSigil from "../components/event/CrystalSigil.jsx";
import GoogleSignIn from "../components/auth/GoogleSignIn.jsx";
import { useAuth } from "../context/AuthContext";
import { readAuthRedirectError, takePostAuthPath } from "../config/supabase";

/**
 * How long to wait for the ?code= exchange before calling it a failure.
 * Supabase returns the code with a 5-minute validity, but the exchange itself
 * is one request — if it has not landed in twelve seconds the visitor is
 * staring at a hung screen, and saying so beats spinning forever.
 */
const EXCHANGE_TIMEOUT_MS = 12000;

/** A row of pulsing shards — the same loader language as the route fallback. */
function ThresholdPulse() {
  return (
    <div aria-hidden className="mt-10 flex items-center justify-center gap-3">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="anim-pulse h-2 w-2 rotate-45 bg-violet-bright shadow-[0_0_14px_rgba(168,85,247,0.9)]"
          style={{ animationDelay: `${i * 0.22}s` }}
        />
      ))}
    </div>
  );
}

/**
 * OAuth landing page. Supabase (through detectSessionInUrl) swaps the ?code=
 * for a session as soon as the client initialises, so this page only has to
 * narrate it: cross the threshold, then continue where the sign-in started.
 */
export default function AuthCallback() {
  const navigate = useNavigate();
  const { signedIn, configured } = useAuth();
  // Read once on mount: Supabase rewrites the URL as soon as the exchange
  // resolves, so a later read would find it already cleaned.
  const [redirectError] = useState(() => readAuthRedirectError());
  const [timedOut, setTimedOut] = useState(false);

  // Only arm the watchdog while an exchange could plausibly still be running.
  useEffect(() => {
    if (!configured || signedIn || redirectError) return undefined;
    const id = setTimeout(() => setTimedOut(true), EXCHANGE_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [configured, signedIn, redirectError]);

  // Continue to the remembered path with replace() so the callback URL never
  // sits in history — pressing Back should leave the app, not re-run OAuth.
  useEffect(() => {
    if (!signedIn) return undefined;
    const id = setTimeout(() => navigate(takePostAuthPath(), { replace: true }), 900);
    return () => clearTimeout(id);
  }, [signedIn, navigate]);

  const failed = !configured || Boolean(redirectError) || (timedOut && !signedIn);

  const message = !configured
    ? {
        state: "unavailable",
        title: "SIGN-IN UNAVAILABLE",
        detail:
          "This deployment has no identity provider wired up, so no session can be sealed here.",
      }
    : redirectError
      ? {
          state: "refused",
          title: "THE THRESHOLD REFUSED",
          detail:
            redirectError.description ||
            "Google did not grant access for this request. No session was created.",
        }
      : timedOut
        ? {
            state: "refused",
            title: "THE THRESHOLD REFUSED",
            detail:
              "The hand-off never completed. The code may have expired, or the sign-in was started in a different tab or browser than the one receiving it.",
          }
        : signedIn
          ? {
              state: "accepted",
              title: "SIGNATURE ACCEPTED",
              detail: "Your identity is sealed into the Nexus. Continuing…",
            }
          : {
              state: "verifying",
              title: "CROSSING THE THRESHOLD",
              detail: "Google has vouched for you. The crystal is sealing your session.",
            };

  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <RealmFX mode="stars" />

        <section className="relative z-10 mx-auto flex min-h-svh max-w-2xl flex-col items-center justify-center px-6 py-32 text-center">
          <Reveal>
            <CrystalSigil
              variant="crystal"
              accent={failed ? "gold" : "violet"}
              className={`mx-auto w-28 md:w-40 ${message.state === "verifying" ? "anim-float" : ""}`}
              label="Nexus identity crystal"
            />
          </Reveal>

          <Reveal delay={0.08}>
            <p className="mt-10 text-[10px] font-medium uppercase tracking-[0.55em] text-lavender/70">
              Nexus // Identity
            </p>
          </Reveal>

          <Reveal delay={0.14}>
            <h1 className="mt-6 font-display text-[clamp(1.5rem,5vw,3rem)] leading-[1.1] tracking-[0.14em] text-crystal text-glow">
              {message.title}
            </h1>
          </Reveal>

          {/* The narration changes without a route change, so it is mirrored
              into a live region for assistive tech. */}
          <p role="status" aria-live="polite" className="sr-only">
            {message.title}
          </p>

          <Reveal delay={0.2}>
            <div className="hairline mx-auto mt-8 w-40 md:w-64" aria-hidden />
          </Reveal>

          <Reveal delay={0.26}>
            <p className="mt-7 max-w-lg text-sm leading-relaxed tracking-wide text-crystal/60">
              {message.detail}
            </p>
          </Reveal>

          {message.state === "verifying" || message.state === "accepted" ? <ThresholdPulse /> : null}

          {message.state === "verifying" ? (
            <Reveal delay={0.1}>
              <p className="mt-8 text-[10px] uppercase tracking-[0.4em] text-crystal/35">
                Verifying signature
              </p>
            </Reveal>
          ) : null}

          {message.state === "refused" ? (
            <Reveal delay={0.1}>
              <div className="mt-10 flex flex-col items-center gap-8">
                <GoogleSignIn label="Try again" />
                <Link
                  to="/"
                  className="text-[10px] uppercase tracking-[0.4em] text-crystal/40 transition-colors hover:text-lavender"
                >
                  ← Return to the gateway
                </Link>
              </div>
            </Reveal>
          ) : null}

          {message.state === "unavailable" ? (
            <Reveal delay={0.1}>
              <Link
                to="/"
                className="mt-10 inline-block text-[10px] uppercase tracking-[0.4em] text-crystal/40 transition-colors hover:text-lavender"
              >
                ← Return to the gateway
              </Link>
            </Reveal>
          ) : null}
        </section>
      </div>
    </Page>
  );
}
