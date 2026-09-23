import { useEffect, useRef } from "react";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import CrystalCanvas from "../components/three/LazyCrystalCanvas.jsx";
import ParticleField from "../components/fx/ParticleField.jsx";
import HomeHero from "../components/home/HomeHero.jsx";
import StoryBeat from "../components/home/StoryBeat.jsx";
import StoryDivider from "../components/home/StoryDivider.jsx";
import { gsap, ScrollTrigger } from "../lib/gsap";
import { crystalStore, resetCrystalStore } from "../lib/crystalStore";
import { useNexusTransition } from "../context/TransitionContext";
import usePrefersReducedMotion from "../hooks/usePrefersReducedMotion";

/** scroll progress -> { scatter, glow } story of the crystal */
function mapStory(p) {
  let scatter;
  if (p < 0.14) scatter = 0;
  else if (p < 0.42) scatter = (p - 0.14) / 0.28;
  else if (p < 0.54) scatter = 1;
  else if (p < 0.88) scatter = 1 - (p - 0.54) / 0.34;
  else scatter = 0;
  const glow = Math.min(1, Math.max(0, (p - 0.62) / 0.32));
  return { scatter, glow };
}

export default function Home() {
  const wrapRef = useRef(null);
  const progressRef = useRef(null);
  const { enterNexus } = useNexusTransition();
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    resetCrystalStore();
    if (reduced) return undefined;

    const st = ScrollTrigger.create({
      trigger: wrapRef.current,
      start: "top top",
      end: "bottom bottom",
      onUpdate: (self) => {
        const { scatter, glow } = mapStory(self.progress);
        crystalStore.tScatter = scatter;
        crystalStore.tGlow = glow;
        if (progressRef.current) {
          progressRef.current.style.transform = `scaleX(${self.progress})`;
        }
      },
    });

    return () => {
      st.kill();
      crystalStore.tScatter = 0;
      crystalStore.tGlow = 0;
    };
  }, [reduced]);

  return (
    <Page>
      {/* story progress hairline — pure transform, GPU-friendly */}
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[70] h-px">
        <div
          ref={progressRef}
          className="h-full origin-left scale-x-0 bg-gradient-to-r from-violet-core via-violet-bright to-lavender shadow-[0_0_10px_rgba(168,85,247,0.75)]"
        />
      </div>

      {/* cosmic backdrop — stars, aurora veils and the crystal's halo */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
        <ParticleField mode="stars" />
        {/* aurora ribbons: huge blurred violet/lavender washes that drift
            slowly enough to register as atmosphere, not motion */}
        <div className="anim-aurora absolute -left-[22%] top-[-18%] h-[72vmax] w-[72vmax] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.5),rgba(124,58,237,0.12)_45%,transparent_70%)] blur-3xl md:blur-[110px]" />
        <div
          className="anim-aurora absolute -right-[26%] top-[16%] h-[64vmax] w-[64vmax] rounded-full bg-[radial-gradient(circle,rgba(168,85,247,0.42),rgba(216,180,254,0.1)_48%,transparent_72%)] blur-3xl md:blur-[130px]"
          style={{ animationDelay: "-11s", animationDuration: "41s" }}
        />
        <div
          className="anim-aurora absolute bottom-[-24%] left-[8%] h-[58vmax] w-[58vmax] rounded-full bg-[radial-gradient(circle,rgba(245,215,142,0.16),rgba(124,58,237,0.14)_42%,transparent_70%)] blur-3xl md:blur-[140px]"
          style={{ animationDelay: "-23s", animationDuration: "49s" }}
        />
        {/* the halo breathing behind the core — ties CSS light to the WebGL
            crystal so the two layers read as one volume. Centering lives on
            the wrapper so the scale animation stays clean. */}
        <div
          aria-hidden
          className="absolute left-1/2 top-[46%] h-[46vmax] w-[46vmax] -translate-x-1/2 -translate-y-1/2"
        >
          <div className="anim-halo h-full w-full rounded-full bg-[radial-gradient(circle,rgba(168,85,247,0.3),rgba(124,58,237,0.1)_40%,transparent_68%)] blur-3xl" />
        </div>
        {/* fine vertical energy curtain near the centre column */}
        <div className="absolute left-1/2 top-0 h-full w-[52vw] -translate-x-1/2 bg-[linear-gradient(to_bottom,transparent,rgba(168,85,247,0.09)_38%,rgba(216,180,254,0.05)_55%,transparent)] blur-2xl" />
        {/* engineered space: a masked measurement grid so the void reads as a
            constructed realm rather than empty black. Fades out well before
            the edges, so it can never introduce overflow. */}
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(216,180,254,0.9) 1px, transparent 1px), linear-gradient(90deg, rgba(216,180,254,0.9) 1px, transparent 1px)",
            backgroundSize: "88px 88px",
            maskImage: "radial-gradient(62% 52% at 50% 44%, #000 0%, transparent 86%)",
            WebkitMaskImage: "radial-gradient(62% 52% at 50% 44%, #000 0%, transparent 86%)",
          }}
        />
      </div>
      <CrystalCanvas />

      {/* film grain — unifies every layer under one texture */}
      <div aria-hidden className="noise-veil pointer-events-none fixed inset-0 z-[65] opacity-40 mix-blend-soft-light" />

      <div ref={wrapRef} className="relative z-10">
        <HomeHero />

        <StoryBeat
          index="01"
          align="right"
          lead="The fracture"
          motif="fracture"
          lines={["THE WORLD", "IS FRAGMENTED."]}
        />

        <StoryDivider label="Phase 02 — Gathering" />

        <StoryBeat
          index="02"
          align="left"
          lead="The pieces"
          motif="pieces"
          lines={["IDEAS.", "PEOPLE.", "TECHNOLOGY.", "POSSIBILITIES."]}
        />

        <StoryDivider label="Phase 03 — Alignment" />

        <StoryBeat
          index="03"
          align="right"
          lead="The convergence"
          motif="convergence"
          lines={["WHEN EVERYTHING", "CONNECTS..."]}
        />

        <StoryDivider label="Phase 04 — Emergence" />

        <StoryBeat
          index="04"
          align="center"
          lead="The emergence"
          motif="core"
          lines={["NEW POSSIBILITIES", "EMERGE."]}
        />

        {/* CTA — the threshold */}
        <section className="relative z-10 flex min-h-svh flex-col items-center justify-center px-6 py-24 text-center">
          <Reveal>
            <div className="mb-9 flex flex-col items-center gap-5">
              <div aria-hidden className="flex w-full items-center justify-center gap-4">
                <span className="hairline w-12 md:w-24" />
                <span className="h-1 w-1 rotate-45 bg-gold/70" />
                <span className="hairline w-12 md:w-24" />
              </div>
              <p className="text-[10px] font-medium uppercase tracking-[0.55em] text-lavender/95 [text-shadow:0_1px_10px_rgba(5,3,8,0.9),0_0_22px_rgba(5,3,8,0.7)]">
                The threshold is open
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.12}>
            <div className="relative">
              {/* dark stage — the fixed crystal's core burns directly behind
                  the threshold at end-of-scroll; this local scrim lifts the
                  button off it without touching the crystal itself (same
                  pattern as the story-beat scrims). Stays inside the
                  section's z-10 context, so it paints above the canvas. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-[-100%] -z-10 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(5,3,8,0.88),rgba(10,6,18,0.5)_52%,transparent_76%)] blur-xl"
              />
              {/* the core ignites: a breathing gold/violet heart behind the
                  threshold, then a tighter bloom right under the button */}
              <div
                aria-hidden
                className="anim-halo absolute inset-[-120%] rounded-full bg-[radial-gradient(circle,rgba(245,215,142,0.34),rgba(168,85,247,0.16)_45%,transparent_70%)] blur-3xl"
              />
              <div
                aria-hidden
                className="anim-halo absolute inset-[-70%] rounded-full bg-[radial-gradient(circle,rgba(245,215,142,0.28),transparent_65%)] blur-2xl"
                style={{ animationDelay: "-2.1s" }}
              />
              {/* counter-rotating orbit rings frame the threshold */}
              <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-[270%] w-[270%] -translate-x-1/2 -translate-y-1/2">
                <svg viewBox="0 0 200 200" className="anim-spin-slow h-full w-full text-lavender/30" fill="none" stroke="currentColor" strokeWidth="0.5" aria-hidden>
                  <circle cx="100" cy="100" r="97" strokeDasharray="3 11" />
                </svg>
                <svg viewBox="0 0 200 200" className="anim-spin-rev absolute inset-0 h-full w-full text-violet-bright/25" fill="none" stroke="currentColor" strokeWidth="0.4" aria-hidden>
                  <circle cx="100" cy="100" r="88" strokeDasharray="24 60" />
                </svg>
              </div>
              <CinematicButton
                onClick={enterNexus}
                className="relative bg-void/60 px-9 py-5 shadow-[0_0_70px_rgba(5,3,8,0.9),0_0_50px_rgba(124,58,237,0.45)] backdrop-blur-[3px] [text-shadow:0_0_18px_rgba(216,180,254,0.75)] md:px-12 md:py-6 md:text-xs"
              >
                Enter the Nexus
              </CinematicButton>
            </div>
          </Reveal>
          <Reveal delay={0.28}>
            <div className="mt-9 flex flex-col items-center gap-5">
              <div aria-hidden className="flex w-full items-center justify-center gap-4">
                <span className="hairline w-14 md:w-28" />
                <span className="h-1 w-1 rotate-45 bg-lavender/50" />
                <span className="hairline w-14 md:w-28" />
              </div>
              <p className="max-w-md text-xs leading-relaxed tracking-[0.18em] text-crystal/85 [text-shadow:0_1px_10px_rgba(5,3,8,0.9),0_0_22px_rgba(5,3,8,0.7)]">
                THREE REALMS AWAIT ON THE OTHER SIDE OF THE CORE.
              </p>
            </div>
          </Reveal>
        </section>
      </div>
    </Page>
  );
}
