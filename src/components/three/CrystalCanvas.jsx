import { useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import CrystalCore from "./CrystalCore.jsx";
import WebGLFallback from "./WebGLFallback.jsx";
import ParticleField from "../fx/ParticleField.jsx";
import useDeviceTier from "../../hooks/useDeviceTier";
import usePrefersReducedMotion from "../../hooks/usePrefersReducedMotion";
import useWebGL from "../../hooks/useWebGL";

/**
 * Fixed full-viewport hero stage.
 * Layers: nebula backdrop -> core aura -> crystal canvas -> front dust ->
 * typography vignette. Falls back to a CSS crystal without WebGL.
 */
export default function CrystalCanvas() {
  const tier = useDeviceTier();
  const reduced = usePrefersReducedMotion();
  const hasWebGL = useWebGL();
  const [active, setActive] = useState(true);

  useEffect(() => {
    const onVis = () => setActive(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    onVis();
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

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

      {/* aura behind the crystal */}
      <div className="anim-pulse absolute left-1/2 top-1/2 h-[64vmin] w-[64vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(168,85,247,0.40),rgba(124,58,237,0.10)_55%,transparent_72%)] blur-[80px]" />

      {hasWebGL ? (
        <Canvas
          className="absolute inset-0"
          dpr={[1, tier === "mobile" ? 1.3 : 1.75]}
          camera={{ position: [0, 0.1, camZ], fov: 42, near: 0.1, far: 60 }}
          frameloop={active && !reduced ? "always" : "demand"}
          gl={{
            alpha: true,
            antialias: tier !== "mobile",
            powerPreference: "high-performance",
            stencil: false,
          }}
          onCreated={({ gl }) => {
            if ("transmissionResolutionScale" in gl) {
              gl.transmissionResolutionScale = tier === "mobile" ? 0.5 : 0.85;
            }
          }}
        >
          <fogExp2 attach="fog" args={["#0a0612", 0.042]} />
          <ambientLight color="#4c1d95" intensity={0.55} />
          <directionalLight position={[-2, 3.5, 2.5]} intensity={0.7} color="#f5f3ff" />
          <pointLight position={[3.4, 2.4, 4.2]} intensity={45} distance={24} color="#a855f7" />
          <pointLight position={[-4.5, 1.2, -3.5]} intensity={32} distance={26} color="#d8b4fe" />
          <pointLight position={[0, 2.5, -5.5]} intensity={20} distance={30} color="#f5f3ff" />
          <pointLight position={[0, -3.4, 2]} intensity={12} distance={14} color="#7c3aed" />
          <CrystalCore fragments={fragmentCount} reduced={reduced} />
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
