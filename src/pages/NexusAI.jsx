import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import RealmFX from "../components/fx/RealmFX.jsx";
import { getEventLink } from "../config/eventLinks.js";

const NODES = [
  { n: "01", title: "NAVIGATE THE REALMS", text: "Ask where you belong — the Nexus maps every event to your intent." },
  { n: "02", title: "FORGE NEW IDEAS", text: "Break a brief into sparks, then rebuild them into pitches worth defending." },
  { n: "03", title: "DECODE THE UNKNOWN", text: "Decode rules, schedules and secrets before anyone else does." },
];

const TRANSCRIPT = [
  { cmd: true, text: "> nexus --query \"which realm fits a builder?\"" },
  { cmd: false, text: "▸ THE FORGE — 5 events. NEXUS BREACH opens in 03:12:44." },
  { cmd: true, text: "> nexus --query \"what breaks the paradox?\"" },
  { cmd: false, text: "▸ Everything scheduled. Bring questions instead." },
];

export default function NexusAI() {
  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <RealmFX mode="ai" />

        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pb-28 pt-36 text-center md:px-10 md:pt-44">
          <Reveal>
            <p className="text-[10px] font-medium uppercase tracking-[0.55em] text-lavender/70">Nexus // Intelligence</p>
          </Reveal>

          <h1 className="mt-6 flex flex-col items-center font-display text-[clamp(2.4rem,7vw,5.8rem)] leading-[1.05] tracking-[0.09em] text-crystal">
            <Reveal><span className="block text-glow">THE NEXUS</span></Reveal>
            <Reveal delay={0.12}><span className="block italic text-lavender">thinks with you.</span></Reveal>
          </h1>

          <Reveal delay={0.24}><div className="hairline mx-auto mt-9 w-48 md:w-72" aria-hidden /></Reveal>

          <Reveal delay={0.32}>
            <p className="mx-auto mt-7 max-w-xl text-sm leading-relaxed tracking-wide text-crystal/60">
              An intelligence woven into the realm — it knows every event, every schedule and every
              corridor between the three worlds.
            </p>
          </Reveal>

          <Reveal delay={0.2}>
            <div className="relative mx-auto mt-14 h-[260px] w-[260px] md:h-[340px] md:w-[340px]">
              <div aria-hidden className="anim-pulse absolute inset-[-24%] rounded-full blur-3xl"
                style={{ background: "radial-gradient(circle, rgba(124,58,237,0.55), transparent 66%)" }} />
              <svg viewBox="0 0 200 200" className="relative h-full w-full" aria-hidden>
                <circle cx="100" cy="100" r="94" fill="none" stroke="#d8b4fe" strokeOpacity="0.45"
                  strokeWidth="0.7" strokeDasharray="3 8" className="anim-spin-slow" style={{ transformOrigin: "100px 100px" }} />
                <circle cx="100" cy="100" r="76" fill="none" stroke="#f5d78e" strokeOpacity="0.5"
                  strokeWidth="0.6" strokeDasharray="24 12" className="anim-spin-rev" style={{ transformOrigin: "100px 100px" }} />
                <circle cx="100" cy="100" r="48" fill="#7c3aed" fillOpacity="0.4" stroke="#a855f7" strokeWidth="1.4" />
                <circle cx="100" cy="100" r="30" fill="none" stroke="#f5f3ff" strokeOpacity="0.7" strokeWidth="1" />
                <circle cx="100" cy="100" r="12" fill="#f5f3ff" className="anim-pulse" />
              </svg>
            </div>
          </Reveal>

          <div className="mt-16 grid gap-10 text-left md:mt-24 md:grid-cols-3 md:gap-12">
            {NODES.map((node, i) => (
              <Reveal key={node.n} delay={0.1 * i}>
                <div className="group border-t border-white/10 pt-6 transition-colors duration-500 hover:border-violet-bright/60">
                  <span className="text-[11px] tracking-[0.4em] text-gold/85">{node.n}</span>
                  <h2 className="mt-4 font-display text-[clamp(1.3rem,2.2vw,1.8rem)] tracking-[0.1em] text-crystal transition-all duration-500 group-hover:[text-shadow:0_0_22px_rgba(168,85,247,0.7)]">
                    {node.title}
                  </h2>
                  <p className="mt-3 text-sm leading-relaxed text-crystal/55">{node.text}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={0.1}>
            <div className="glass-panel mx-auto mt-16 max-w-2xl px-6 py-7 text-left" aria-hidden>
              {TRANSCRIPT.map((line, i) => (
                <Reveal key={i} delay={i * 0.18}>
                  <p className={`mt-3 text-xs leading-relaxed tracking-[0.04em] md:text-sm ${line.cmd ? "text-lavender" : "text-crystal/70"}`}>
                    {line.text}
                  </p>
                </Reveal>
              ))}
              <span className="anim-blink mt-5 inline-block h-3.5 w-2 bg-lavender" />
            </div>
          </Reveal>

          <Reveal delay={0.15}>
            <div className="relative mt-14 inline-block">
              <div aria-hidden className="absolute inset-[-60%] rounded-full bg-[radial-gradient(circle,rgba(168,85,247,0.3),transparent_65%)] blur-2xl" />
              <CinematicButton href={getEventLink("nexusAI")} className="relative px-10 py-5 md:px-14">
                Enter Nexus AI
              </CinematicButton>
            </div>
          </Reveal>
        </section>
      </div>
    </Page>
  );
}
