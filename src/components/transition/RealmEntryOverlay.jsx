import { useRealmEntry } from "../../context/RealmEntryContext";

/**
 * Shards streaking outward past the camera during the fly-through.
 * `fx/fy` are the outward vectors each fragment travels along; staggered
 * delays keep the burst reading as debris, not a synchronized array.
 */
const FLYBY = [
  { size: 46, tone: "linear-gradient(140deg,#e9dcff,#7c3aed)", fx: "-62vw", fy: "-38vh", rot: 12, delay: 0 },
  { size: 34, tone: "linear-gradient(200deg,#f5d78e,#7c3aed)", fx: "58vw", fy: "-42vh", rot: -24, delay: 40 },
  { size: 58, tone: "linear-gradient(160deg,#d8b4fe,#4c1d95)", fx: "-48vw", fy: "44vh", rot: 34, delay: 80 },
  { size: 28, tone: "linear-gradient(120deg,#fffdf6,#a855f7)", fx: "64vw", fy: "36vh", rot: -8, delay: 110 },
  { size: 40, tone: "linear-gradient(220deg,#e9dcff,#6d28d9)", fx: "8vw", fy: "-62vh", rot: 48, delay: 150 },
  { size: 36, tone: "linear-gradient(20deg,#f5d78e,#a855f7)", fx: "-14vw", fy: "58vh", rot: -36, delay: 190 },
  { size: 24, tone: "linear-gradient(180deg,#d8b4fe,#7c3aed)", fx: "44vw", fy: "-16vh", rot: 20, delay: 220 },
  { size: 30, tone: "linear-gradient(340deg,#fffdf6,#6d28d9)", fx: "-56vw", fy: "12vh", rot: -52, delay: 260 },
  { size: 52, tone: "linear-gradient(150deg,#c4b5fd,#3b1a66)", fx: "28vw", fy: "52vh", rot: 62, delay: 300 },
  { size: 22, tone: "linear-gradient(90deg,#f5d78e,#d8b4fe)", fx: "-30vw", fy: "-54vh", rot: -14, delay: 340 },
];

const SHARD_CLIP = "polygon(50% 0%, 92% 30%, 76% 92%, 22% 88%, 6% 34%)";

/**
 * Full-screen realm entry transition. Mounted once in App (above the routes)
 * so it can swallow the gateway, hold black across navigation, then dissolve
 * onto the freshly mounted realm page.
 */
export default function RealmEntryOverlay() {
  const { phase, entry } = useRealmEntry();
  if (!entry) return null;

  const { accent, x, y } = entry;
  const originStyle = {
    left: `${Math.round(Math.min(1, Math.max(0, x)) * 100)}%`,
    top: `${Math.round(Math.min(1, Math.max(0, y)) * 100)}%`,
  };

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[110] overflow-hidden">
      {/* fragment fly-through — only while pushing into the crystal */}
      {phase === "closing" ? (
        <div className="absolute inset-0">
          {FLYBY.map((f, i) => (
            <span
              key={`${i}-${f.fx}`}
              className="anim-flyby absolute"
              style={{
                left: "50%",
                top: "50%",
                width: f.size,
                height: f.size,
                background: f.tone,
                clipPath: SHARD_CLIP,
                "--fx": f.fx,
                "--fy": f.fy,
                animationDelay: `${f.delay}ms`,
                transform: `rotate(${f.rot}deg)`,
              }}
            />
          ))}
        </div>
      ) : null}

      {/* energy wall that swallows the screen, expanding from the portal */}
      <div className="absolute -translate-x-1/2 -translate-y-1/2" style={originStyle}>
        <div
          key={`warp-${phase}-${entry.route}`}
          className={`h-[70vmax] w-[70vmax] rounded-full ${
            phase === "closing" ? "anim-warp" : ""
          }`}
          style={{
            background: `radial-gradient(circle, #fff 0%, ${accent} 18%, #7c3aed 42%, rgba(5,3,8,0.96) 74%, rgba(5,3,8,0) 100%)`,
            opacity: phase === "opening" ? 0 : undefined,
            transition: phase === "opening" ? "opacity 700ms ease-out" : undefined,
          }}
        />
      </div>

      {/* the veil itself — always mounted so both fades animate smoothly */}
      <div
        className={`absolute inset-0 bg-[#050308] ${
          phase === "closing"
            ? "opacity-100 transition-opacity duration-[460ms] delay-[140ms]"
            : phase === "opening"
              ? "opacity-0 transition-opacity duration-[760ms]"
              : "opacity-0"
        }`}
      />
    </div>
  );
}
