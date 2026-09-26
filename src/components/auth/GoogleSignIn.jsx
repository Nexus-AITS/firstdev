import { useAuth } from "../../context/AuthContext";
import CinematicButton from "../ui/CinematicButton.jsx";

/**
 * Official Google "G" mark (four-colour). Google's branding guidelines require
 * the unmodified multicolour mark wherever a "Sign in with Google" affordance
 * is offered, so it is inlined rather than re-tinted to the NEXUS palette.
 */
function GoogleMark({ className = "h-3.5 w-3.5" }) {
  return (
    <svg aria-hidden viewBox="0 0 48 48" className={`${className} shrink-0`} focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/**
 * Sign in with Google.
 *
 * variants:
 *  - "inline" — a nav-weight text control, sized to sit beside the hamburger
 *    without competing with the wordmark.
 *  - "button" — the full bracketed CinematicButton, for the gateway and the
 *    mobile menu where it is the primary action.
 *
 * When the deployment has no Supabase env vars the control degrades to a
 * status line rather than a button that could only ever fail.
 */
export default function GoogleSignIn({
  variant = "button",
  label = "Sign in with Google",
  arrow = "right",
  className = "",
}) {
  const { signInWithGoogle, configured, status, error } = useAuth();
  const busy = status === "loading";

  if (!configured) {
    return (
      <p className={`text-[9px] uppercase tracking-[0.32em] text-crystal/35 ${className}`}>
        Sign-in unavailable
      </p>
    );
  }

  if (variant === "inline") {
    return (
      <button
        type="button"
        onClick={signInWithGoogle}
        disabled={busy}
        aria-busy={busy || undefined}
        data-cursor="sign in"
        className={`group inline-flex items-center gap-2.5 py-2 text-[10px] font-medium uppercase tracking-[0.34em] text-crystal/55 transition-all duration-300 hover:text-crystal hover:[text-shadow:0_0_16px_rgba(168,85,247,0.7)] disabled:opacity-60 lg:text-[11px] ${className}`}
      >
        <GoogleMark className="h-3 w-3" />
        {busy ? "Checking" : "Sign in"}
      </button>
    );
  }

  return (
    <div className={className}>
      <CinematicButton
        onClick={signInWithGoogle}
        disabled={busy}
        arrow={arrow}
        aria-busy={busy || undefined}
        className={busy ? "opacity-70" : ""}
      >
        <span className="flex items-center gap-3">
          <GoogleMark className="h-4 w-4" />
          {busy ? "Checking the threshold" : label}
        </span>
      </CinematicButton>
      {/* Only a failed hand-off can reach here — success means the browser is
          already on its way to Google. role="alert" so it is announced. */}
      {error ? (
        <p role="alert" className="mt-4 text-[10px] uppercase tracking-[0.3em] text-gold/90">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export { GoogleMark };
