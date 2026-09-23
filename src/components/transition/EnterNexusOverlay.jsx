import { useEffect, useRef } from "react";
import { buildNexusTimeline } from "./nexusTimeline.js";
import { HEX_ECHO, SHARD_CLIP, SHARD_STYLES, SWARM_STYLES } from "./overlayParticles.js";
import { useNexusTransition } from "../../context/TransitionContext";

/**
 * Full-screen cinematic ENTER NEXUS sequence.
 * Navigates at the black peak, then reveals "WELCOME TO THE NEXUS".
 */
export default function EnterNexusOverlay() {
  const { phase, reduced, onMidpoint, onComplete } = useNexusTransition();

  const veilRef = useRef(null);
  const flashRef = useRef(null);
  const diamondRef = useRef(null);
  const ringsRef = useRef(null);
  const shardsRef = useRef(null);
  const swarmRef = useRef(null);
  const welcomeRef = useRef(null);
  const tlRef = useRef(null);
  const cbRef = useRef({ onMidpoint, onComplete });
  cbRef.current = { onMidpoint, onComplete };

  useEffect(() => {
    if (phase !== "running") return undefined;

    const tl = buildNexusTimeline({
      reduced,
      veil: veilRef.current,
      flash: flashRef.current,
      diamond: diamondRef.current,
      rings: ringsRef.current,
      shards: shardsRef.current,
      swarm: swarmRef.current,
      welcome: welcomeRef.current,
      onMidpoint: () => cbRef.current.onMidpoint(),
      onComplete: () => cbRef.current.onComplete(),
    });
    tlRef.current = tl;

    const onKey = (event) => {
      if (event.key === "Escape" && tlRef.current && tlRef.current.progress() < 1) {
        tlRef.current.progress(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      tl.kill();
      tlRef.current = null;
      window.removeEventListener("keydown", onKey);
    };
  }, [phase, reduced]);

  if (phase === "idle") return null;

  return (
    <div
      className={`fixed inset-0 z-[100] overflow-hidden ${
        phase === "running" ? "pointer-events-auto" : "pointer-events-none"
      }`}
    >
      <div ref={veilRef} className="absolute inset-0 bg-[#030204]" style={{ opacity: 0 }} />

      <div className="absolute inset-0 flex items-center justify-center">
        <div ref={diamondRef} className="relative h-[44vmin] w-[44vmin]" style={{ opacity: 0 }}>
          <div
            className="absolute inset-[-40%] rounded-full blur-2xl"
            style={{ background: "radial-gradient(circle, rgba(168,85,247,0.55), transparent 65%)" }}
          />
          <div
            className="absolute inset-0"
            style={{
              clipPath: HEX_ECHO,
              background:
                "conic-gradient(from 0deg, rgba(124,58,237,0.95), rgba(216,180,254,0.75), rgba(168,85,247,1), rgba(124,58,237,0.95))",
            }}
          />
          <div
            className="absolute inset-[15%]"
            style={{
              clipPath: HEX_ECHO,
              background:
                "radial-gradient(circle at 50% 42%, #f5f3ff 0%, #d8b4fe 32%, rgba(124,58,237,0.9) 68%, rgba(10,6,18,0.96) 100%)",
            }}
          />
        </div>
        <div
          ref={flashRef}
          className="absolute inset-0 m-auto h-[34vmin] w-[34vmin] rounded-full"
          style={{
            opacity: 0,
            background:
              "radial-gradient(circle, #fff 0%, #f5f3ff 26%, rgba(216,180,254,0.7) 52%, rgba(168,85,247,0.35) 68%, transparent 76%)",
          }}
        />
      </div>

      <div ref={ringsRef} className="absolute left-1/2 top-1/2 h-0 w-0">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="absolute left-0 top-0 h-[34vmin] w-[34vmin] rounded-full border"
            style={{ borderColor: i === 1 ? "rgba(245,215,142,0.55)" : "rgba(216,180,254,0.7)", opacity: 0 }}
          />
        ))}
      </div>

      <div ref={shardsRef} className="absolute inset-0">
        {SHARD_STYLES.map((s, i) => (
          <span
            key={i}
            className="absolute"
            style={{
              left: "50%",
              top: "50%",
              width: s.size,
              height: s.size,
              background: s.tone,
              clipPath: SHARD_CLIP,
              transform: `rotate(${s.rot}deg)`,
              opacity: 0,
            }}
          />
        ))}
      </div>

      <div ref={swarmRef} className="absolute inset-0">
        {SWARM_STYLES.map((p, i) => (
          <span
            key={i}
            className="absolute rounded-full"
            style={{
              left: `${p.left}%`,
              top: `${p.top}%`,
              width: p.size,
              height: p.size,
              background: p.tone,
              boxShadow: `0 0 10px ${p.tone}`,
              opacity: 0,
            }}
          />
        ))}
      </div>

      <div className="absolute inset-0 flex items-center justify-center px-6">
        <p
          ref={welcomeRef}
          role="status"
          className="text-center font-display text-[clamp(1.4rem,4.5vw,3rem)] tracking-[0.34em] text-crystal text-glow"
          style={{ opacity: 0 }}
        >
          WELCOME TO THE NEXUS
        </p>
      </div>

      {phase === "running" ? (
        <button
          type="button"
          onClick={() => {
            if (tlRef.current && tlRef.current.progress() < 1) tlRef.current.progress(1);
          }}
          className="pointer-events-auto absolute bottom-7 right-7 z-[60] text-[10px] uppercase tracking-[0.4em] text-crystal/50 transition-colors hover:text-lavender focus-visible:text-lavender"
        >
          Skip
        </button>
      ) : null}
    </div>
  );
}
