import { Link } from "react-router-dom";

/** Inner crystal silhouette per realm. */
const SHAPES = {
  forge: "60,10 102,34 94,86 60,112 26,86 18,34",
  paradox: "32,16 100,38 78,106 18,86",
  arena: "60,8 106,30 98,88 60,114 22,88 14,30",
};

/**
 * Dimensional realm portal — layered rotating rings, energy core and
 * crystalline silhouette. Keyboard/touch navigable; hover drives the
 * page-wide environment FX via onHover(fxMode|null).
 */
export default function RealmPortal({ realm, onHover }) {
  const accent = realm.accent;
  const shape = SHAPES[realm.id] ?? SHAPES.forge;

  const hover = () => onHover?.(realm.fx);
  const unhover = () => onHover?.(null);

  return (
    <Link
      to={realm.route}
      data-cursor="enter"
      aria-label={`Enter ${realm.name} — ${realm.kicker}`}
      className="group flex flex-col items-center outline-none"
      onMouseEnter={hover}
      onMouseLeave={unhover}
      onFocus={hover}
      onBlur={unhover}
    >
      <div className="relative aspect-square w-full max-w-[400px]">
        {/* halo */}
        <div
          aria-hidden
          className="absolute inset-[-16%] rounded-full opacity-50 blur-3xl transition-opacity duration-700 group-hover:opacity-100 group-focus-visible:opacity-100"
          style={{ background: `radial-gradient(circle, ${accent}4d, transparent 66%)` }}
        />

        {/* outer dashed ring */}
        <svg aria-hidden viewBox="0 0 200 200" className="absolute inset-0 h-full w-full anim-spin-slow">
          <circle
            cx="100"
            cy="100"
            r="96"
            fill="none"
            stroke={accent}
            strokeOpacity="0.5"
            strokeWidth="0.7"
            strokeDasharray="3 8"
          />
          {[0, 90, 180, 270].map((a) => (
            <line
              key={a}
              x1="100"
              y1="4"
              x2="100"
              y2="14"
              stroke="#f5f3ff"
              strokeOpacity="0.8"
              strokeWidth="1"
              transform={`rotate(${a} 100 100)`}
            />
          ))}
        </svg>

        {/* inner counter ring */}
        <svg
          aria-hidden
          viewBox="0 0 200 200"
          className="absolute inset-[6%] h-[88%] w-[88%] anim-spin-rev"
        >
          <circle
            cx="100"
            cy="100"
            r="94"
            fill="none"
            stroke="#d8b4fe"
            strokeOpacity="0.32"
            strokeWidth="0.6"
            strokeDasharray="34 14"
          />
        </svg>

        {/* core disc */}
        <div className="absolute inset-[15%] overflow-hidden rounded-full border border-white/10 bg-[radial-gradient(circle_at_50%_38%,rgba(124,58,237,0.5),rgba(10,6,18,0.92)_70%)]">
          {/* hover energy sweep */}
          <div
            aria-hidden
            className="absolute inset-0 rounded-full opacity-0 transition-opacity duration-700 group-hover:opacity-100 group-focus-visible:opacity-100"
            style={{ background: `conic-gradient(from 0deg, transparent 62%, ${accent}73, transparent 88%)` }}
          />
          <svg
            aria-hidden
            viewBox="0 0 120 120"
            className="absolute inset-0 m-auto h-[64%] w-[64%] transition-transform duration-700 ease-out group-hover:scale-110 group-hover:rotate-6 group-focus-visible:scale-110"
          >
            <polygon
              points={shape}
              fill={accent}
              fillOpacity="0.16"
              stroke={accent}
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <polygon points={shape} fill="none" stroke="#f5f3ff" strokeOpacity="0.5" strokeWidth="0.5" />
            <circle cx="60" cy="58" r="6" fill="#f5f3ff" className="anim-pulse" />
          </svg>
        </div>

        {/* corner shards */}
        <span
          aria-hidden
          className="absolute -right-1 top-[18%] h-2.5 w-2.5 rotate-45 bg-lavender/70 shadow-[0_0_12px_rgba(216,180,254,0.9)] transition-transform duration-700 group-hover:translate-y-3"
        />
        <span
          aria-hidden
          className="absolute -left-1 bottom-[22%] h-2 w-2 rotate-45 shadow-[0_0_12px_rgba(168,85,247,0.9)]"
          style={{ background: accent }}
        />
      </div>

      {/* label */}
      <div className="mt-9 text-center">
        <p className="text-[10px] font-medium uppercase tracking-[0.5em] text-lavender/75">{realm.kicker}</p>
        <h3 className="mt-3 font-display text-[clamp(1.9rem,3vw,2.7rem)] tracking-[0.16em] text-crystal transition-all duration-500 group-hover:[text-shadow:0_0_26px_rgba(168,85,247,0.85)] group-focus-visible:[text-shadow:0_0_26px_rgba(168,85,247,0.85)]">
          {realm.name}
        </h3>
        <div className="hairline mx-auto mt-4 w-20 transition-all duration-500 group-hover:w-36" aria-hidden />
        <p className="mt-4 text-[10px] uppercase tracking-[0.42em] text-crystal/55 transition-colors duration-500 group-hover:text-lavender">
          {realm.mantra}
        </p>
      </div>
    </Link>
  );
}
