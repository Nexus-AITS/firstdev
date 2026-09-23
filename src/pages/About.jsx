import { Link } from "react-router-dom";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import ParticleField from "../components/fx/ParticleField.jsx";
import CrystalSigil from "../components/event/CrystalSigil.jsx";

const CHAPTERS = [
  { n: "01", title: "OUR VISION", sigil: "temporal", accent: "violet",
    text: "A world where every idea has a gravity well — pulling people, craft and technology into orbit." },
  { n: "02", title: "OUR PURPOSE", sigil: "fracture", accent: "lavender",
    text: "To give builders, dreamers and competitors a stage vast enough for the impossible to feel routine." },
  { n: "03", title: "OUR COMMUNITY", sigil: "arena", accent: "gold",
    text: "Engineers. Artists. Athletes of the digital arena. One nexus, countless signatures." },
];

const CLUSTER = [
  { variant: "fracture", accent: "violet" },
  { variant: "timeline", accent: "lavender" },
  { variant: "arena", accent: "gold" },
];

export default function About() {
  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
          <ParticleField mode="stars" factor={0.8} />
        </div>

        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pt-40 text-center md:px-10 md:pt-52">
          <h1 className="flex flex-col items-center font-display text-[clamp(2.8rem,10vw,8rem)] font-medium leading-[1.02] tracking-[0.08em] text-crystal">
            {["EVERYTHING", "STARTS WITH", "AN IDEA."].map((line, i) => (
              <Reveal key={line} delay={0.12 * i} y={54}>
                <span className={`block ${i === 2 ? "italic text-lavender text-glow" : "text-glow-soft"}`}>{line}</span>
              </Reveal>
            ))}
          </h1>
          <Reveal delay={0.45}>
            <div className="hairline mx-auto mt-12 w-52 md:w-80" aria-hidden />
          </Reveal>
        </section>

        <section className="relative z-10 mx-auto mt-24 grid max-w-[1680px] items-center gap-12 px-5 md:mt-36 md:grid-cols-2 md:gap-20 md:px-10">
          <div className="text-center md:text-left">
            <Reveal>
              <p className="text-[10px] font-medium uppercase tracking-[0.55em] text-lavender/70">Chapter zero</p>
            </Reveal>
            <Reveal delay={0.1}>
              <h2 className="mt-5 font-display text-[clamp(2rem,5vw,4rem)] tracking-[0.1em] text-crystal text-glow-soft">
                WHAT IS NEXUS?
              </h2>
            </Reveal>
            <Reveal delay={0.2}>
              <p className="mx-auto mt-7 max-w-lg text-[15px] leading-[2] tracking-wide text-crystal/65 md:mx-0">
                Nexus is an event ecosystem where technical innovation, creativity, imagination and
                competition collide. Three realms, one universe — built to be entered and remembered,
                not just read.
              </p>
            </Reveal>
          </div>

          <div className="flex items-center justify-center gap-4 md:gap-8" aria-hidden>
            {CLUSTER.map((s, i) => (
              <Reveal key={s.variant} delay={0.15 * i}>
                <CrystalSigil variant={s.variant} accent={s.accent}
                  className="w-24 transition-transform duration-700 hover:scale-110 md:w-36" />
              </Reveal>
            ))}
          </div>
        </section>

        <section className="relative z-10 mx-auto mt-28 max-w-[1680px] px-5 md:mt-40 md:px-10" aria-label="About chapters">
          <div className="flex flex-col gap-20 md:gap-32">
            {CHAPTERS.map((chapter, i) => (
              <article key={chapter.n}
                className={`grid items-center gap-8 md:grid-cols-12 md:gap-14 ${i % 2 === 1 ? "md:[direction:rtl]" : ""}`}>
                <div className="md:col-span-4 md:[direction:ltr]">
                  <CrystalSigil variant={chapter.sigil} accent={chapter.accent}
                    className="mx-auto w-40 md:w-full md:max-w-[260px]" />
                </div>
                <div className="md:col-span-7 md:[direction:ltr] md:text-left">
                  <span aria-hidden className="block font-display text-[clamp(3rem,8vw,6rem)] leading-none text-crystal/[0.07]">
                    {chapter.n}
                  </span>
                  <Reveal>
                    <h2 className="mt-2 font-display text-[clamp(1.8rem,4vw,3.2rem)] tracking-[0.12em] text-crystal">
                      {chapter.title}
                    </h2>
                  </Reveal>
                  <Reveal delay={0.12}>
                    <div className="hairline mt-5 w-36" aria-hidden />
                  </Reveal>
                  <Reveal delay={0.2}>
                    <p className="mt-6 max-w-xl text-[15px] leading-[2] tracking-wide text-crystal/65">{chapter.text}</p>
                  </Reveal>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="relative z-10 mx-auto mt-32 max-w-[1680px] px-5 pb-36 text-center md:px-10 md:mt-44">
          <Reveal>
            <p className="font-display text-[clamp(1.6rem,4vw,3.2rem)] leading-snug tracking-[0.14em] text-crystal text-glow">
              THREE REALMS.<br />
              <span className="italic text-lavender">COUNTLESS POSSIBILITIES.</span>
            </p>
          </Reveal>
          <Reveal delay={0.18}>
            <div className="mt-10 flex justify-center">
              <CinematicButton to="/events">Explore the realms</CinematicButton>
            </div>
          </Reveal>
          <Reveal delay={0.3}>
            <Link to="/" className="mt-8 inline-block text-[10px] uppercase tracking-[0.4em] text-crystal/40 transition-colors hover:text-lavender">
              ← Return to the gateway
            </Link>
          </Reveal>
        </section>
      </div>
    </Page>
  );
}
