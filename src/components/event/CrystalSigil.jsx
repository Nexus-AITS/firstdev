import { SIGIL_VARIANTS } from "./sigilVariants.jsx";

const ACCENTS = { violet: "#a855f7", lavender: "#d8b4fe", gold: "#f5d78e" };

/**
 * Visual centerpiece for events: procedural SVG crystal sigil with a
 * rotating dashed frame, halo glow and a per-event variant interior.
 */
export default function CrystalSigil({ variant = "crystal", accent = "violet", className = "", label }) {
  const c = ACCENTS[accent] ?? ACCENTS.violet;
  const renderInterior = SIGIL_VARIANTS[variant] ?? SIGIL_VARIANTS.crystal;

  return (
    <div
      className={`relative aspect-square ${className}`}
      role="img"
      aria-label={label ?? "Crystal sigil"}
    >
      <div
        aria-hidden
        className="absolute inset-[-14%] rounded-full opacity-60 blur-2xl"
        style={{ background: `radial-gradient(circle, ${c}40, transparent 66%)` }}
      />
      <svg
        viewBox="0 0 200 200"
        className="relative h-full w-full overflow-visible"
        aria-hidden
        focusable="false"
      >
        <circle
          cx="100"
          cy="100"
          r="93"
          fill="none"
          stroke={c}
          strokeOpacity="0.4"
          strokeWidth="0.8"
          strokeDasharray="2 9"
          className="anim-spin-slow"
          style={{ transformOrigin: "100px 100px" }}
        />
        <circle
          cx="100"
          cy="100"
          r="85"
          fill="none"
          stroke="#d8b4fe"
          strokeOpacity="0.25"
          strokeWidth="0.6"
          strokeDasharray="28 12"
          className="anim-spin-rev"
          style={{ transformOrigin: "100px 100px" }}
        />
        {renderInterior(c)}
      </svg>
    </div>
  );
}
