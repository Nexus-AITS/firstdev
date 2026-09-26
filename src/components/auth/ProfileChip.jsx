import { useState } from "react";
import { useAuth } from "../../context/AuthContext";

/**
 * The signed-in identity: Google avatar (or an initial), name, email and a
 * sign-out control.
 *
 * variants:
 *  - "inline" — navbar. The avatar always shows; the text block and sign-out
 *    only exist from md up, where there is room for them. Phones sign out
 *    through the mobile menu instead (variant "stack").
 *  - "stack" — mobile menu. Everything visible, full-width sign-out.
 */
export default function ProfileChip({ variant = "inline", className = "" }) {
  const { name, email, avatarUrl, signOut } = useAuth();
  const [busy, setBusy] = useState(false);

  const initial = (name || email || "?").trim().charAt(0).toUpperCase();

  const handleSignOut = async () => {
    setBusy(true);
    try {
      await signOut();
    } finally {
      setBusy(false);
    }
  };

  const avatar = (
    <span className="relative block h-8 w-8 shrink-0 overflow-hidden rounded-full border border-lavender/40 bg-[radial-gradient(circle_at_50%_35%,rgba(124,58,237,0.55),rgba(10,6,18,0.92))] shadow-[0_0_16px_rgba(168,85,247,0.45)]">
      {avatarUrl ? (
        // referrerPolicy: the avatar is served by googleusercontent, which
        // 403s when a referrer is attached in some browser configurations.
        <img
          src={avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-display text-xs text-crystal">
          {initial}
        </span>
      )}
    </span>
  );

  if (variant === "stack") {
    return (
      <div className={className}>
        <p className="text-[10px] font-medium uppercase tracking-[0.5em] text-lavender/60">
          Signed in
        </p>
        <div className="mt-5 flex items-center gap-4">
          {avatar}
          <span className="min-w-0">
            <span className="block truncate font-display text-xl tracking-[0.08em] text-crystal">
              {name}
            </span>
            {email ? (
              <span className="mt-1 block truncate text-[10px] tracking-[0.18em] text-crystal/45">
                {email}
              </span>
            ) : null}
          </span>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={busy}
          className="mt-6 inline-flex w-full items-center justify-center border border-lavender/30 px-6 py-3.5 text-[10px] font-medium uppercase tracking-[0.4em] text-crystal/75 transition-colors duration-300 hover:border-lavender hover:text-crystal disabled:opacity-60"
        >
          {busy ? "Signing out" : "Sign out"}
        </button>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {avatar}
      {/* min-w-0 + truncate: a long Google display name must never widen the
          fixed navbar (the verify suite fails any horizontal overflow). */}
      <span className="hidden min-w-0 flex-col md:flex">
        <span className="max-w-[10rem] truncate text-[10px] font-medium uppercase tracking-[0.28em] text-crystal/80">
          {name}
        </span>
        {email ? (
          <span className="max-w-[10rem] truncate text-[9px] tracking-[0.16em] text-crystal/40">
            {email}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={busy}
        className="hidden text-[10px] font-medium uppercase tracking-[0.32em] text-crystal/45 transition-colors duration-300 hover:text-lavender disabled:opacity-60 md:inline-flex"
      >
        {busy ? "…" : "Sign out"}
      </button>
    </div>
  );
}
