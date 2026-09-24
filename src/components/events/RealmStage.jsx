import { useEffect } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import RealmCrystal from "../three/RealmCrystal.jsx";
import WebGLFallback from "../three/WebGLFallback.jsx";
import useDeviceTier from "../../hooks/useDeviceTier";
import usePrefersReducedMotion from "../../hooks/usePrefersReducedMotion";
import useWebGL from "../../hooks/useWebGL";

/**
 * While a portal is idle its canvas runs on demand and we only nudge a
 * render every ~110ms — a slow ambient breath instead of a full 60fps loop.
 * The focused portal flips to `frameloop="always"` in RealmStage.
 */
function IdlePulse({ active, reduced }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (active || reduced) return undefined;
    // 180ms (was 110ms): idle portals are three canvases on /events — each
    // nudge is a full transmission render, so the slower ambient breath
    // halves idle GPU load with no visible difference on slow sine motion.
    const id = setInterval(() => {
      if (!document.hidden) invalidate();
    }, 180);
    return () => clearInterval(id);
  }, [active, reduced, invalidate]);
  return null;
}

/**
 * Scoped WebGL stage for one realm portal. Its own canvas means the crystal
 * and its DOM label align automatically at every viewport size — no shared
 * camera projection to keep in sync.
 *
 * Layers: nebula halo -> realm atmosphere -> crystal canvas -> vignette.
 */
export default function RealmStage({ realm, active = false, className = "" }) {
  const tier = useDeviceTier();
  const reduced = usePrefersReducedMotion();
  const hasWebGL = useWebGL();

  const camZ = tier === "mobile" ? 6.1 : tier === "tablet" ? 5.7 : 5.4;
  const accent = realm.accent;
  const fx = realm.fx; // circuit | paradox | hud
  const dprCap = tier === "mobile" ? 1.15 : tier === "tablet" ? 1.3 : 1.4;
  const quality = tier === "desktop" ? "high" : "low";

  return (
    <div className={`relative aspect-square w-full ${className}`} aria-hidden>
      {/* nebula halo behind the crystal */}
      <div
        className={`absolute inset-[-18%] rounded-full blur-3xl transition-opacity duration-700 ${
          active ? "opacity-100" : "opacity-55"
        }`}
        style={{ background: `radial-gradient(circle, ${accent}40, transparent 66%)` }}
      />

      {/* realm atmosphere — the DOM half of each realm's identity */}
      {fx === "circuit" ? (
        <div
          className={`grid-circuit absolute inset-[6%] transition-opacity duration-700 ${
            active ? "opacity-70" : "opacity-30"
          }`}
        />
      ) : null}

      {realm.id === "paradox" ? (
        <>
          {/* fracture seam glow behind the split core */}
          <div
            className={`anim-rift absolute left-1/2 top-[18%] h-[64%] w-[3px] -translate-x-1/2 ${
              active ? "opacity-100" : "opacity-50"
            }`}
            style={{ background: "linear-gradient(to bottom, transparent, #f5d78e, transparent)" }}
          />
          <div
            className="anim-ember absolute left-[46%] top-[52%] h-1.5 w-1.5 rounded-full bg-gold shadow-[0_0_14px_rgba(245,215,142,0.9)]"
            style={{ "--ex": "26px" }}
          />
          <div
            className="anim-ember absolute left-[54%] top-[56%] h-1 w-1 rounded-full bg-gold shadow-[0_0_12px_rgba(245,215,142,0.9)]"
            style={{ "--ex": "-30px", animationDelay: "-3.4s" }}
          />
        </>
      ) : null}

      {realm.id === "forge" ? (
        <>
          {/* reactor containment pulse */}
          <div
            className={`anim-pulse-ring absolute left-1/2 top-1/2 h-[72%] w-[72%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-lavender/45 ${
              active ? "opacity-100" : "opacity-40"
            }`}
          />
          <div
            className={`anim-arc absolute left-[10%] top-[30%] h-px w-[80%] bg-gradient-to-r from-transparent via-lavender to-transparent ${
              active ? "opacity-100" : "opacity-40"
            }`}
            style={{ animationDelay: "-1.1s" }}
          />
        </>
      ) : null}

      {/* arena: HUD corner frame + scanlines */}
      {realm.id === "arena" ? (
        <>
          <div
            className={`absolute inset-[8%] transition-opacity duration-500 ${
              active ? "opacity-100" : "opacity-45"
            }`}
          >
            <span className="absolute left-0 top-0 h-8 w-8 border-l border-t border-lavender/70" />
            <span className="absolute right-0 top-0 h-8 w-8 border-r border-t border-lavender/70" />
            <span className="absolute bottom-0 left-0 h-8 w-8 border-b border-l border-lavender/70" />
            <span className="absolute bottom-0 right-0 h-8 w-8 border-b border-r border-lavender/70" />
          </div>
          <div
            className={`absolute inset-[10%] transition-opacity duration-500 ${
              active ? "opacity-70" : "opacity-30"
            }`}
            style={{
              background:
                "repeating-linear-gradient(to bottom, rgba(168,85,247,0.16) 0 1px, transparent 1px 5px)",
            }}
          />
        </>
      ) : null}

      {hasWebGL ? (
        <Canvas
          className="absolute inset-0"
          dpr={[1, dprCap]}
          camera={{ position: [0, 0.12, camZ], fov: 40, near: 0.1, far: 40 }}
          frameloop={active && !reduced ? "always" : "demand"}
          gl={{
            alpha: true,
            antialias: tier === "desktop",
            powerPreference: "high-performance",
            stencil: false,
          }}
          onCreated={({ gl }) => {
            if ("transmissionResolutionScale" in gl) {
              // portals are small on screen — a half-res transmission pass
              // is visually identical here and ~2x cheaper per nudge
              gl.transmissionResolutionScale = tier === "mobile" ? 0.42 : 0.55;
            }
          }}
        >
          <fogExp2 attach="fog" args={["#0a0612", 0.055]} />
          <ambientLight color="#4c1d95" intensity={0.5} />
          <pointLight position={[2.6, 1.8, 3.4]} intensity={26} distance={20} color="#a855f7" />
          <pointLight position={[-3, 1, -2.6]} intensity={18} distance={22} color="#d8b4fe" />
          <IdlePulse active={active} reduced={reduced} />
          <RealmCrystal realmId={realm.id} active={active} reduced={reduced} quality={quality} />
        </Canvas>
      ) : (
        <div className="absolute inset-0">
          <WebGLFallback />
        </div>
      )}

      {/* cinematic vignette so the crystal sits in darkness — fades to
          transparent before the stage bounds so no rectangle is ever visible */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(closest-side at 50% 46%, transparent 56%, rgba(5,3,8,0.5) 92%, transparent 100%)",
        }}
      />
    </div>
  );
}
