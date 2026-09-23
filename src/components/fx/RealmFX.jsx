import ParticleField from "./ParticleField.jsx";
import Scanlines from "./Scanlines.jsx";

/**
 * Realm gateway environment layer.
 * Always-on: deep nebula pools, the realm-tinted veil (focus-driven),
 * drifting fragments and bottom fog. `mode` layers the focused realm's
 * signature on top — circuitry (Forge), abstract shards + gold (Paradox),
 * HUD rings + scanlines (Arena).
 */
export default function RealmFX({ mode = "stars", tint = "#7c3aed", className = "" }) {
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      {/* deep-space base */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(54% 46% at 50% 40%, rgba(124,58,237,0.30), rgba(5,3,8,0) 74%)",
        }}
      />
      <div className="absolute inset-[-20%] bg-[radial-gradient(36%_32%_at_24%_68%,rgba(76,29,149,0.28),transparent_70%)]" />
      <div className="absolute inset-[-20%] bg-[radial-gradient(32%_30%_at_76%_26%,rgba(168,85,247,0.16),transparent_70%)]" />

      {/* focus-driven realm tint — one custom property steers everything */}
      <div className="realm-veil absolute inset-0" style={{ "--realm-tint": tint }} />

      {mode === "circuit" ? (
        <>
          <div className="grid-circuit absolute inset-0 opacity-70" />
          <div className="absolute left-1/2 top-1/2 h-[70vmin] w-[70vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.28),transparent_65%)] blur-2xl" />
        </>
      ) : null}

      {mode === "paradox" ? (
        <>
          <div className="absolute -left-24 top-1/4 h-72 w-72 rounded-full bg-gold/10 blur-[110px]" />
          <div className="absolute -right-20 bottom-1/4 h-80 w-80 rounded-full bg-violet-core/30 blur-[120px]" />
          {/* a slow distortion band — space refusing to hold still */}
          <div className="anim-distort absolute left-[12%] top-[30%] h-[46vh] w-[38vw] border border-gold/10 bg-[radial-gradient(ellipse_at_center,rgba(245,215,142,0.06),transparent_70%)]" />
        </>
      ) : null}

      {mode === "hud" ? (
        <>
          <div className="absolute inset-0 bg-[radial-gradient(65%_55%_at_50%_45%,rgba(124,58,237,0.22),transparent_70%)]" />
          <div className="anim-glitch-shift absolute left-[8%] top-[36%] h-1 w-[36%] bg-lavender/30" />
          <div className="anim-glitch-shift absolute right-[12%] top-[64%] h-1 w-[24%] bg-violet-core/50" style={{ animationDelay: "-2.6s" }} />
        </>
      ) : null}

      {/* drifting crystal fragments + stars */}
      <ParticleField mode={mode} />

      {mode === "hud" ? <Scanlines /> : null}

      {/* bottom fog seating everything in the void */}
      <div className="absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-void via-void/70 to-transparent" />
    </div>
  );
}
