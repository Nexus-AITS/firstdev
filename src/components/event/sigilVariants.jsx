/**
 * Per-event SVG sigil renderers — each glyph depicts its actual event
 * (breached shield, idea bulb, chip, AI dialog, code brackets, casefile
 * magnifier, what-if fork, aperture, meme bubble, poster, squad reticle,
 * speed gauge, tower) while speaking the shared NEXUS language: hairline
 * strokes, faceted fills, gold/crystal highlights and one restrained
 * animated accent per glyph. All coordinates sit inside the shared
 * 200x200 viewBox and clear the CrystalSigil frame rings (r=85/93).
 * Each receives the event accent color `c`.
 */
export const SIGIL_VARIANTS = {
  /* NEXUS BREACH — hackathon: shield torn open, crack of light, debris */
  fracture: (c) => (
    <>
      <path
        d="M140 59 L148 64 L148 116 L100 144 L52 116 L52 64 L100 36 L126 51"
        fill="none"
        stroke={c}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M133 46 L152 28 M137 56 L164 48 M129 40 L136 20"
        stroke="#f5f3ff"
        strokeWidth="1.7"
        strokeLinecap="round"
        className="anim-pulse"
      />
      <polyline
        points="100,58 88,88 108,106 96,134"
        fill="none"
        stroke={c}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polygon points="62,152 76,160 68,170" fill={c} fillOpacity="0.4" stroke={c} strokeWidth="1" className="anim-float" />
      <polygon
        points="132,152 146,158 138,168"
        fill={c}
        fillOpacity="0.3"
        stroke={c}
        strokeWidth="1"
        className="anim-float"
        style={{ animationDelay: "0.9s" }}
      />
    </>
  ),

  /* VISION 2065 — ideathon: the idea bulb over a rising pitch line */
  temporal: (c) => (
    <>
      <circle cx="100" cy="82" r="27" fill={c} fillOpacity="0.16" stroke={c} strokeWidth="1.8" />
      <path
        d="M91 90 L96 72 L104 90 L109 74"
        fill="none"
        stroke="#f5f3ff"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
        className="anim-pulse"
      />
      <path d="M88 108 L112 108 M91 116 L109 116" stroke={c} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M96 124 L104 124 L102 132 L98 132 Z" fill={c} fillOpacity="0.5" stroke={c} strokeWidth="1" />
      <path
        d="M100 46 L100 32 M64 58 L53 47 M136 58 L147 47 M56 94 L40 94 M144 94 L160 94"
        stroke="#f5d78e"
        strokeWidth="1.9"
        strokeLinecap="round"
        className="anim-pulse"
      />
      <path d="M62 150 L84 138 L100 146 L136 124" fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" opacity="0.8" />
      <circle cx="136" cy="124" r="3.4" fill="#f5d78e" className="anim-pulse" style={{ animationDelay: "0.7s" }} />
    </>
  ),

  /* CIRCUIT EXPO — the exhibited chip with live traces */
  circuit: (c) => (
    <>
      <rect x="72" y="72" width="56" height="56" rx="4" fill={c} fillOpacity="0.14" stroke={c} strokeWidth="1.7" />
      <rect x="88" y="88" width="24" height="24" fill="none" stroke="#f5f3ff" strokeWidth="1.4" transform="rotate(45 100 100)" />
      {[84, 100, 116].map((p, i) => (
        <g key={i} stroke={c} strokeWidth="1.4" strokeLinecap="round" opacity="0.85">
          <line x1={p} y1="60" x2={p} y2="72" />
          <line x1={p} y1="128" x2={p} y2="140" />
          <line x1="60" y1={p} x2="72" y2={p} />
          <line x1="128" y1={p} x2="140" y2={p} />
        </g>
      ))}
      <path d="M100 60 L100 44 L128 36 M60 100 L42 100 M140 100 L158 100 L166 84" fill="none" stroke={c} strokeWidth="1.1" opacity="0.7" />
      <circle cx="128" cy="36" r="3.4" fill="#f5f3ff" className="anim-pulse" />
      <circle cx="42" cy="100" r="3" fill={c} className="anim-pulse" style={{ animationDelay: "0.5s" }} />
      <circle cx="166" cy="84" r="3" fill="#f5d78e" className="anim-pulse" style={{ animationDelay: "1s" }} />
    </>
  ),

  /* AI TURING GAMBIT — dialog with a live prompt and neural handshake */
  neural: (c) => (
    <>
      <rect x="44" y="56" width="112" height="70" rx="14" fill={c} fillOpacity="0.13" stroke={c} strokeWidth="1.7" />
      <path d="M66 126 L62 152 L94 126" fill={c} fillOpacity="0.13" stroke={c} strokeWidth="1.7" strokeLinejoin="round" />
      <path
        d="M66 82 L78 93 L66 104"
        fill="none"
        stroke="#f5f3ff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="anim-pulse"
      />
      <path d="M90 105 L124 105" stroke="#f5f3ff" strokeWidth="2.4" strokeLinecap="round" className="anim-blink" />
      <circle cx="152" cy="44" r="6" fill={c} fillOpacity="0.5" stroke={c} strokeWidth="1.1" />
      <circle cx="170" cy="64" r="4" fill="#f5d78e" className="anim-pulse" />
      <path d="M152 44 L170 64" stroke={c} strokeWidth="1.1" opacity="0.7" />
    </>
  ),

  /* CODE REBUILDING — code crack: `</>` with a fragment snapping home */
  rebuild: (c) => (
    <>
      <path
        d="M78 68 L50 100 L78 132"
        fill="none"
        stroke={c}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M122 68 L150 100 L122 132"
        fill="none"
        stroke={c}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M114 58 L86 142" stroke="#f5f3ff" strokeWidth="2.6" strokeLinecap="round" className="anim-pulse" />
      <rect
        x="94"
        y="148"
        width="13"
        height="13"
        fill={c}
        fillOpacity="0.45"
        stroke="#f5f3ff"
        strokeWidth="1"
        className="anim-float"
        style={{ animationDelay: "0.6s" }}
      />
      <circle cx="100" cy="42" r="3" fill="#f5d78e" className="anim-pulse" style={{ animationDelay: "1.1s" }} />
    </>
  ),

  /* THE SCIENTIST FILES — murder mystery: lens over a fingerprint + evidence tag */
  mystery: (c) => (
    <>
      <circle cx="92" cy="92" r="35" fill={c} fillOpacity="0.10" stroke={c} strokeWidth="2" />
      <path d="M117 117 L146 146" stroke="#f5f3ff" strokeWidth="4" strokeLinecap="round" />
      <path d="M74 104 A18 14 0 0 1 110 104" fill="none" stroke={c} strokeWidth="1.4" />
      <path d="M79 111 A13 10 0 0 1 105 111" fill="none" stroke={c} strokeWidth="1.2" opacity="0.8" />
      <path d="M84 117 A8 6 0 0 1 100 117" fill="none" stroke="#f5f3ff" strokeWidth="1" className="anim-pulse" />
      <g transform="rotate(14 146 52)">
        <rect x="130" y="42" width="30" height="20" rx="3" fill="none" stroke="#f5d78e" strokeWidth="1.3" />
        <circle cx="137" cy="52" r="2.2" fill="#f5d78e" />
        <path d="M143 47 L156 47 M143 57 L152 57" stroke="#f5d78e" strokeWidth="1.2" strokeLinecap="round" />
      </g>
      <circle cx="50" cy="56" r="3.2" fill="#f5f3ff" className="anim-pulse" style={{ animationDelay: "0.8s" }} />
    </>
  ),

  /* PARADOX 2065 — what-if thinking: the question over a branching future */
  timeline: (c) => (
    <>
      <path
        d="M84 58 C84 40 118 38 118 58 C118 76 100 78 100 96"
        fill="none"
        stroke="#f5f3ff"
        strokeWidth="3"
        strokeLinecap="round"
        className="anim-pulse"
      />
      <circle cx="100" cy="110" r="3.6" fill="#f5f3ff" />
      <path d="M100 164 L100 142" stroke={c} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M100 142 C100 126 74 126 60 114" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M100 142 C100 126 126 126 140 114" fill="none" stroke="#f5d78e" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="60" cy="114" r="5.5" fill={c} fillOpacity="0.5" stroke={c} strokeWidth="1.2" />
      <circle cx="140" cy="114" r="5.5" fill="#f5d78e" fillOpacity="0.5" stroke="#f5d78e" strokeWidth="1.2" className="anim-pulse" />
    </>
  ),

  /* SHUTTER QUEST — spot photography: the aperture */
  lens: (c) => (
    <>
      <circle cx="100" cy="100" r="64" fill="none" stroke={c} strokeWidth="1.6" />
      <circle cx="100" cy="100" r="46" fill="none" stroke={c} strokeWidth="1" opacity="0.6" />
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <line
          key={a}
          x1="100"
          y1="100"
          x2="100"
          y2="42"
          stroke={c}
          strokeWidth="1.5"
          opacity="0.85"
          transform={`rotate(${a} 100 100) rotate(26 100 100)`}
        />
      ))}
      <circle
        cx="100"
        cy="100"
        r="15"
        fill={c}
        fillOpacity="0.35"
        stroke="#f5f3ff"
        strokeWidth="1.3"
        className="anim-pulse"
      />
    </>
  ),

  /* MATRIX — meme making: the reaction bubble that says it all */
  matrix: (c) => (
    <>
      <rect x="44" y="52" width="112" height="76" rx="18" fill={c} fillOpacity="0.13" stroke={c} strokeWidth="1.8" />
      <path d="M72 128 L66 156 L100 128" fill={c} fillOpacity="0.13" stroke={c} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M72 82 Q79 73 86 82" fill="none" stroke="#f5f3ff" strokeWidth="2.3" strokeLinecap="round" />
      <path d="M114 82 Q121 73 128 82" fill="none" stroke="#f5f3ff" strokeWidth="2.3" strokeLinecap="round" />
      <path
        d="M72 100 Q100 128 128 100"
        fill="none"
        stroke={c}
        strokeWidth="2.6"
        strokeLinecap="round"
        className="anim-pulse"
      />
      <path d="M154 38 L164 28 M158 46 L170 44 M146 34 L148 20" stroke="#f5d78e" strokeWidth="1.7" strokeLinecap="round" />
    </>
  ),

  /* PIXEL RESISTANCE — poster design: pinned print dissolving into pixels */
  pixel: (c) => (
    <>
      <rect x="54" y="44" width="88" height="112" fill={c} fillOpacity="0.10" stroke={c} strokeWidth="1.8" />
      <path d="M120 44 L142 44 L142 66 Z" fill={c} fillOpacity="0.38" stroke={c} strokeWidth="1.2" />
      <circle cx="82" cy="74" r="10" fill="#f5d78e" fillOpacity="0.8" className="anim-pulse" />
      <path
        d="M64 126 L86 100 L102 116 L122 94 L134 110"
        fill="none"
        stroke={c}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path d="M64 136 L134 136" stroke={c} strokeWidth="1.4" opacity="0.7" />
      {[
        [144, 116],
        [152, 126],
        [142, 136],
        [150, 146],
        [132, 150],
        [142, 158],
      ].map(([x, y], i) => (
        <rect
          key={i}
          x={x}
          y={y}
          width="8"
          height="8"
          fill={c}
          fillOpacity={i % 2 ? 0.25 : 0.5}
          stroke={c}
          strokeWidth="0.6"
          className="anim-blink"
          style={{ animationDelay: `${i * 0.3}s` }}
        />
      ))}
    </>
  ),

  /* FREE FIRE — squad battle royale: squad reticle with squad pips */
  squad: (c) => (
    <>
      <circle cx="100" cy="100" r="52" fill="none" stroke={c} strokeWidth="2" />
      <path
        d="M100 34 L100 72 M100 128 L100 166 M34 100 L72 100 M128 100 L166 100"
        stroke="#f5f3ff"
        strokeWidth="2.3"
        strokeLinecap="round"
        className="anim-pulse"
      />
      {[
        [72, 72],
        [128, 72],
        [72, 128],
        [128, 128],
      ].map(([x, y], i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r="5"
          fill={c}
          fillOpacity="0.55"
          stroke={c}
          strokeWidth="1.1"
          className="anim-pulse"
          style={{ animationDelay: `${i * 0.24}s` }}
        />
      ))}
      <circle cx="100" cy="100" r="7" fill="#f5d78e" className="anim-pulse" />
    </>
  ),

  /* VELOCITY RIFT — solo time trial: the speed gauge redlining */
  rift: (c) => (
    <>
      <path d="M52 120 A48 48 0 0 1 148 120" fill="none" stroke={c} strokeWidth="2.6" strokeLinecap="round" />
      {[-70, -35, 0, 35, 70].map((a) => (
        <line
          key={a}
          x1="100"
          y1="74"
          x2="100"
          y2="87"
          stroke="#f5d78e"
          strokeWidth="1.7"
          strokeLinecap="round"
          opacity="0.9"
          transform={`rotate(${a} 100 120)`}
        />
      ))}
      <path d="M100 120 L132 84" stroke="#f5f3ff" strokeWidth="3" strokeLinecap="round" className="anim-pulse" />
      <circle cx="100" cy="120" r="6.5" fill={c} fillOpacity="0.7" stroke="#f5f3ff" strokeWidth="1.4" />
      <path
        d="M36 142 L80 142 M52 156 L88 156"
        stroke={c}
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.6"
        className="anim-float"
      />
    </>
  ),

  /* TITAN PROTOCOL — 5v5 MOBA: the nexus tower with its core gem */
  titan: (c) => (
    <>
      <path
        d="M70 74 L70 54 L84 54 L84 64 L116 64 L116 54 L130 54 L130 74 Z"
        fill={c}
        fillOpacity="0.22"
        stroke={c}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M80 74 L120 74 L126 132 L74 132 Z" fill={c} fillOpacity="0.14" stroke={c} strokeWidth="1.6" strokeLinejoin="round" />
      <polygon
        points="100,88 112,103 100,120 88,103"
        fill="#f5d78e"
        fillOpacity="0.75"
        stroke="#f5f3ff"
        strokeWidth="1.2"
        className="anim-pulse"
      />
      <rect x="64" y="132" width="72" height="13" fill={c} fillOpacity="0.3" stroke={c} strokeWidth="1.4" />
      <circle cx="56" cy="104" r="3" fill="#f5d78e" className="anim-pulse" />
      <circle cx="144" cy="104" r="3" fill="#f5d78e" className="anim-pulse" style={{ animationDelay: "0.7s" }} />
    </>
  ),

  /* THE ARENA — shared competitive rings (About / generic) */
  arena: (c) => (
    <>
      <circle
        cx="100"
        cy="100"
        r="62"
        fill="none"
        stroke={c}
        strokeWidth="1.6"
        strokeDasharray="7 9"
        className="anim-spin-slow"
        style={{ transformOrigin: "100px 100px" }}
      />
      <circle cx="100" cy="100" r="42" fill="none" stroke="#f5d78e" strokeWidth="1.1" opacity="0.75" />
      <circle
        cx="100"
        cy="100"
        r="24"
        fill={c}
        fillOpacity="0.32"
        stroke="#f5f3ff"
        strokeWidth="1.5"
        className="anim-pulse"
      />
      {[0, 90, 180, 270].map((a) => (
        <line
          key={a}
          x1="100"
          y1="30"
          x2="100"
          y2="40"
          stroke="#f5d78e"
          strokeWidth="2"
          transform={`rotate(${a} 100 100)`}
        />
      ))}
    </>
  ),

  /* neutral fallback crystal */
  crystal: (c) => (
    <polygon
      points="100,34 152,72 140,148 60,148 48,72"
      fill={c}
      fillOpacity="0.14"
      stroke={c}
      strokeWidth="1.6"
    />
  ),
};

export default SIGIL_VARIANTS;



