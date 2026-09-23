/**
 * Procedural line-art motifs for the Home scroll story. Each beat gets a
 * different constellation/fracture diagram so the narrative is carried by
 * imagery as much as by type — drawn with SVG strokes (currentColor) so it
 * costs nothing and scales crisply at any size.
 */
const FRACTURE = [
  "M100 10 L140 60 L118 128 L62 132 L40 66 Z",
  "M100 10 L118 128",
  "M62 132 L140 60",
  "M40 66 L118 128",
];

const PIECES = [
  "M20 30 L74 18 L96 62 L52 78 Z",
  "M120 34 L170 24 L182 72 L138 84 Z",
  "M34 104 L84 92 L104 136 L48 146 Z",
  "M132 108 L186 96 L196 140 L144 152 Z",
  "M20 30 L120 34",
  "M96 62 L104 136",
];

const CONVERGE = [
  "M100 100 L12 22",
  "M100 100 L188 26",
  "M100 100 L8 96",
  "M100 100 L192 92",
  "M100 100 L30 176",
  "M100 100 L172 172",
  "M100 100 L100 8",
  "M100 100 L100 192",
];

const CORE = [
  "M100 34 L166 100 L100 166 L34 100 Z",
  "M100 56 L144 100 L100 144 L56 100 Z",
];

/** node positions for the CONVERGE variant (the "pieces" arriving) */
const CONVERGE_NODES = [
  [12, 22],
  [188, 26],
  [8, 96],
  [192, 92],
  [30, 176],
  [172, 172],
  [100, 8],
  [100, 192],
];

export default function StoryMotif({ variant = "fracture", className = "" }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 0.7,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    vectorEffect: "non-scaling-stroke",
  };

  return (
    <svg
      viewBox="0 0 200 200"
      className={className}
      aria-hidden
      focusable="false"
      {...common}
    >
      {variant === "fracture" ? (
        <>
          <path d={FRACTURE[0]} strokeDasharray="5 5" opacity="0.9" />
          <path d={FRACTURE[1]} opacity="0.55" />
          <path d={FRACTURE[2]} opacity="0.55" />
          <path d={FRACTURE[3]} opacity="0.35" />
          {/* stray splinters flying off the break */}
          <path d="M6 44 L30 40 M188 54 L166 60 M22 172 L46 162 M178 164 L156 154" opacity="0.4" />
        </>
      ) : null}

      {variant === "pieces" ? (
        <>
          <path d={PIECES[0]} opacity="0.6" />
          <path d={PIECES[1]} opacity="0.6" />
          <path d={PIECES[2]} opacity="0.6" />
          <path d={PIECES[3]} opacity="0.6" />
          <path d={PIECES[4]} strokeDasharray="3 6" opacity="0.35" />
          <path d={PIECES[5]} strokeDasharray="3 6" opacity="0.35" />
        </>
      ) : null}

      {variant === "convergence" ? (
        <>
          {CONVERGE.map((d, i) => (
            <path key={d} d={d} opacity={0.24 + (i % 3) * 0.14} />
          ))}
          {CONVERGE_NODES.map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="2.6" opacity="0.75" />
          ))}
        </>
      ) : null}

      {variant === "core" ? (
        <>
          <path d={CORE[0]} opacity="0.75" />
          <path d={CORE[1]} opacity="0.5" />
          <circle cx="100" cy="100" r="72" strokeDasharray="2 9" opacity="0.45" />
          <circle cx="100" cy="100" r="88" strokeDasharray="14 34" opacity="0.35" />
          <circle cx="100" cy="100" r="6" fill="currentColor" stroke="none" opacity="0.9" />
        </>
      ) : null}
    </svg>
  );
}