/**
 * The gateway opening: start in near darkness with a faint purple
 * crystalline energy breathing at the centre and small fragments drifting
 * through space, then dissolve the veil so the three realm cores are
 * revealed as if the camera pushed toward them.
 *
 * `phase`: "dark" -> "reveal" -> "done" (unmounted by Events).
 */
const FRAGMENTS = [
  { left: 22, top: 30, size: 26, fx: "-46vw", fy: "-30vh", rot: 12, delay: "-1.2s" },
  { left: 68, top: 24, size: 20, fx: "44vw", fy: "-34vh", rot: -26, delay: "-3.8s" },
  { left: 40, top: 62, size: 30, fx: "-18vw", fy: "48vh", rot: 34, delay: "-0.6s" },
  { left: 78, top: 58, size: 18, fx: "52vw", fy: "38vh", rot: -12, delay: "-5.1s" },
  { left: 14, top: 70, size: 22, fx: "-54vw", fy: "34vh", rot: 48, delay: "-2.4s" },
  { left: 54, top: 16, size: 16, fx: "16vw", fy: "-52vh", rot: -40, delay: "-4.4s" },
  { left: 32, top: 44, size: 24, fx: "-30vw", fy: "-8vh", rot: 8, delay: "-0.2s" },
  { left: 86, top: 40, size: 14, fx: "58vw", fy: "6vh", rot: -56, delay: "-3.2s" },
  { left: 60, top: 78, size: 28, fx: "30vw", fy: "50vh", rot: 22, delay: "-1.8s" },
  { left: 8, top: 48, size: 18, fx: "-58vw", fy: "-4vh", rot: -34, delay: "-6.0s" },
];

const SHARD_CLIP = "polygon(50% 0%, 92% 30%, 76% 92%, 22% 88%, 6% 34%)";

export default function RealmIntro({ phase }) {
  if (phase === "done") return null;
  const fading = phase === "reveal";

  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-0 z-[90] overflow-hidden bg-void ${
        fading ? "opacity-0 transition-opacity duration-[1400ms] ease-out" : "opacity-100"
      }`}
    >
      {/* faint purple crystalline energy at the centre */}
      <div
        className={`absolute left-1/2 top-[46%] h-[40vmin] w-[40vmin] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[70px] ${
          fading ? "opacity-0 transition-opacity duration-700" : "anim-breathe-soft opacity-60"
        }`}
        style={{
          background:
            "radial-gradient(circle, rgba(124,58,237,0.9), rgba(168,85,247,0.35) 45%, transparent 72%)",
        }}
      />
      <div
        className={`absolute left-1/2 top-[46%] h-[10vmin] w-[10vmin] -translate-x-1/2 -translate-y-1/2 rounded-full ${
          fading ? "opacity-0 transition-opacity duration-500" : "anim-pulse opacity-80"
        }`}
        style={{
          background: "radial-gradient(circle, #f5f3ff, rgba(216,180,254,0.7) 55%, transparent 75%)",
        }}
      />

      {/* small crystal fragments drifting through space */}
      {FRAGMENTS.map((f, i) => (
        <span
          key={i}
          className={`absolute ${fading ? "anim-flyby" : "anim-drift"}`}
          style={{
            left: `${f.left}%`,
            top: `${f.top}%`,
            width: f.size,
            height: f.size,
            background: "linear-gradient(150deg, #e9dcff, #7c3aed)",
            clipPath: SHARD_CLIP,
            opacity: fading ? undefined : 0.55,
            "--fx": f.fx,
            "--fy": f.fy,
            animationDelay: fading ? `${i * 34}ms` : f.delay,
            transform: fading ? undefined : `rotate(${f.rot}deg)`,
          }}
        />
      ))}

      {/* film grain / vignette so the darkness has texture */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 46%, transparent 30%, rgba(5,3,8,0.75) 78%, #050308 100%)",
        }}
      />
    </div>
  );
}