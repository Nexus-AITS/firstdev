import { useEffect, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import CrystalCore from "./CrystalCore.jsx";
import WebGLFallback from "./WebGLFallback.jsx";
import ParticleField from "../fx/ParticleField.jsx";
import useDeviceTier from "../../hooks/useDeviceTier";
import usePrefersReducedMotion from "../../hooks/usePrefersReducedMotion";
import useWebGL from "../../hooks/useWebGL";

const tierCap = (t) => (t === "mobile" ? 1.2 : t === "tablet" ? 1.3 : 1.5);

/** Demand-mode nudge so a throttled idle canvas keeps breathing slowly. */
function IdleNudge({ paused }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (paused) return undefined;
    const id = setInterval(() => {
      if (!document.hidden) invalidate();
    }, 80);
    return () => clearInterval(id);
  }, [paused, invalidate]);
  return null;
}

/**
 * Fixed full-viewport hero stage.
 * Layers: nebula backdrop -> core aura -> crystal canvas -> front dust ->
 * typography vignette. Falls back to a CSS crystal without WebGL.
 *
 * Frame budget: full-rate only while the user is actively engaged — 900ms
 * of stillness drops the loop to periodic nudges, and a one-shot FPS
 * governor degrades DPR/quality once on GPUs that can't hold the budget.
 */
export default function CrystalCanvas() {
  const tier = useDeviceTier();
  const reduced = usePrefersReducedMotion();
  const hasWebGL = useWebGL();
  const [active, setActive] = useState(true); // tab visible
  const [idle, setIdle] = useState(false); // no recent user input

  useEffect(() => {
    const onVis = () => setActive(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    onVis();
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Pixel budget: the crystal stage is full-screen and always animating —
  // DPR above ~1.5 multiplies fill cost for detail nobody can resolve
  // behind fog/grain/vignette. Seeded from the tier, then the FPS governor
  // below may step these down (never back up — no oscillation).
  const [dprCap, setDprCap] = useState(() => tierCap(tier));
  const [quality, setQuality] = useState(() => (tier === "desktop" ? "high" : "low"));

  useEffect(() => {
    setDprCap(tierCap(tier));
    setQuality(tier === "desktop" ? "high" : "low");
  }, [tier]);

  // Idle throttle: wake events (real input or the governor's synthetic
  // "nexus-wake") re-enable full rate; stillness for 900ms drops to nudges.
  const live = active && !reduced;
  useEffect(() => {
    if (reduced) return undefined;
    let timer = setTimeout(() => setIdle(true), 900);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), 900);
    };
    const events = ["pointermove", "pointerdown", "wheel", "keydown", "touchstart", "scroll"];
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    window.addEventListener("nexus-wake", wake);
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, wake);
      window.removeEventListener("nexus-wake", wake);
    };
  }, [reduced]);

  // One-shot FPS governor: sample the first steady seconds (holding the
  // page awake via synthetic wake events), then permanently step down
  // resolution/quality if this GPU misses the budget.
  useEffect(() => {
    if (!hasWebGL || reduced) return undefined;
    let raf = 0;
    let frames = 0;
    let t0 = 0;
    const beats = setInterval(() => window.dispatchEvent(new Event("nexus-wake")), 250);
    const start = setTimeout(() => {
      const tick = (t) => {
        if (!t0) t0 = t;
        frames += 1;
        const ms = t - t0;
        if (ms < 2500) {
          raf = requestAnimationFrame(tick);
          return;
        }
        clearInterval(beats);
        const fps = (frames * 1000) / ms;
        if (fps < 30) {
          setDprCap(1);
          setQuality("low");
        } else if (fps < 46) {
          setDprCap((d) => Math.min(d, 1.2));
          setQuality("low");
        }
      };
      raf = requestAnimationFrame(tick);
    }, 2200);
    return () => {
      clearTimeout(start);
      clearInterval(beats);
      cancelAnimationFrame(raf);
    };
  }, [hasWebGL, reduced]);

  const fragmentCount = tier === "mobile" ? 10 : tier === "tablet" ? 14 : 18;
  const camZ = tier === "mobile" ? 8.8 : tier === "tablet" ? 7.9 : 7.4;

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
      {/* deep space nebula */}
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(52% 44% at 50% 46%, rgba(124,58,237,0.34), rgba(5,3,8,0) 72%)",
        }}
      />
      <div className="absolute inset-[-20%] bg-[radial-gradient(38%_34%_at_28%_66%,rgba(76,29,149,0.30),transparent_70%)]" />
      <div className="absolute inset-[-20%] bg-[radial-gradient(34%_30%_at_74%_30%,rgba(168,85,247,0.18),transparent_70%)]" />
      {/* slow-breathing nebula pools — depth without distraction */}
      <div className="anim-drift absolute inset-[-25%] bg-[radial-gradient(30%_26%_at_64%_70%,rgba(124,58,237,0.22),transparent_70%)]" />
      <div className="anim-drift absolute inset-[-30%] bg-[radial-gradient(26%_24%_at_24%_24%,rgba(216,180,254,0.10),transparent_70%)]" style={{ animationDelay: "-23s" }} />

      {/* aura behind the crystal — the radial gradient already blooms to
          transparent, so no blur filter is needed on a 64vmin layer */}
      <div className="anim-pulse absolute left-1/2 top-1/2 h-[64vmin] w-[64vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(168,85,247,0.40),rgba(124,58,237,0.10)_55%,transparent_72%)]" />

      {hasWebGL ? (
        <Canvas
          className="absolute inset-0"
          dpr={[1, dprCap]}
          camera={{ position: [0, 0.1, camZ], fov: 42, near: 0.1, far: 60 }}
          frameloop={live && !idle ? "always" : "demand"}
          gl={{
            alpha: true,
            // MSAA off: at DPR ≥ 1.2 behind fog + grain the multisampled
            // main buffer was a top-3 full-screen GPU cost for soft edges
            antialias: false,
            powerPreference: "high-performance",
            stencil: false,
          }}
          onCreated={({ gl }) => {
            if ("transmissionResolutionScale" in gl) {
              // The transmission pass re-renders the whole scene into a
              // buffer every frame — 0.85 was the single largest GPU cost.
              // 0.55 (0.42 mobile) is invisible through fogged facets.
              gl.transmissionResolutionScale = tier === "mobile" ? 0.42 : 0.55;
            }
          }}
        >
          <fogExp2 attach="fog" args={["#0a0612", 0.042]} />
          <ambientLight color="#4c1d95" intensity={0.55} />
          <directionalLight position={[-2, 3.5, 2.5]} intensity={0.7} color="#f5f3ff" />
          <pointLight position={[3.4, 2.4, 4.2]} intensity={45} distance={24} color="#a855f7" />
          <pointLight position={[-4.5, 1.2, -3.5]} intensity={32} distance={26} color="#d8b4fe" />
          {/* two weak fill lights dropped: every extra light multiplies the
              per-fragment cost of all five MeshPhysicalMaterials */}
          <IdleNudge paused={!(live && idle)} />
          <CrystalCore fragments={fragmentCount} reduced={reduced} quality={quality} />
        </Canvas>
      ) : (
        <WebGLFallback />
      )}

      {/* dust drifting in front of the crystal */}
      <div className="absolute inset-0">
        <ParticleField mode="energy" factor={0.45} />
      </div>

      {/* typography vignette — keeps NEXUS/CTA readable over the glow */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(to bottom, rgba(5,3,8,0.78) 0%, rgba(5,3,8,0.34) 20%, rgba(5,3,8,0) 42%, rgba(5,3,8,0) 64%, rgba(5,3,8,0.7) 100%)",
        }}
      />
      {/* cinematic edge vignette — pulls the eye to the crystal */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(118% 90% at 50% 48%, transparent 50%, rgba(5,3,8,0.34) 78%, rgba(5,3,8,0.66) 100%)",
        }}
      />
    </div>
  );
}
