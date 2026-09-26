import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import SectionHeading from "../components/ui/SectionHeading.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import RealmFX from "../components/fx/RealmFX.jsx";
import BundleCard from "../components/bundled/BundleCard.jsx";
import { bundleGroups } from "../data/bundles.js";

/**
 * BUNDLED — the eight payment bundles of the Nexus.
 *
 * Commerce page: what each price covers, which events a pick-pool can draw
 * from, and a claim CTA per card that crosses the same /gateway hand-off as
 * single-event registration.
 */
const STEPS = [
  {
    n: "01",
    title: "CHOOSE YOUR BUNDLE",
    text: "Eight combinations across the Nexus, NEXUS REBUILDERS and NEXUS OFF-GRID — pick the one that fits your schedule.",
  },
  {
    n: "02",
    title: "PICK YOUR EVENTS",
    text: "At checkout, choose the events your bundle allows from the eligible pool listed right on the card.",
  },
  {
    n: "03",
    title: "PAY ONCE",
    text: "The bundle price covers everything on the card — one payment, every seat it lists.",
  },
];

export default function Bundled() {
  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <RealmFX mode="stars" tint="#a855f7" />

        {/* hero */}
        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pt-40 text-center md:px-10 md:pt-52">
          <Reveal>
            <p className="text-[10px] font-medium uppercase tracking-[0.55em] text-lavender/70">
              Nexus // Payment bundles
            </p>
          </Reveal>

          <h1 className="mt-6 flex flex-col items-center font-display text-[clamp(2.8rem,10vw,8rem)] font-medium leading-[1.02] tracking-[0.08em] text-crystal">
            <Reveal y={54}>
              <span className="block text-glow-soft">NEXUS</span>
            </Reveal>
            <Reveal delay={0.12} y={54}>
              <span className="block italic text-lavender text-glow">
                BUNDLED
              </span>
            </Reveal>
          </h1>

          <Reveal delay={0.4}>
            <div className="hairline mx-auto mt-12 w-52 md:w-80" aria-hidden />
          </Reveal>

          <Reveal delay={0.5}>
            <p className="mx-auto mt-7 max-w-2xl text-sm leading-relaxed tracking-wide text-crystal/60">
              Eight ways to pay for more than one event — bundle the Hackathon
              with NEXUS REBUILDERS or NEXUS OFF-GRID, run a realm alone, and claim every
              seat in the bundle at a single price.
            </p>
          </Reveal>

          <Reveal delay={0.6}>
            <p className="mt-6 text-[10px] font-medium uppercase tracking-[0.45em] text-gold/85 [text-shadow:0_0_18px_rgba(245,215,142,0.4)]">
              From ₹249 · 8 bundles live
            </p>
          </Reveal>
        </section>

        {/* the bundles */}
        {bundleGroups.map((group) => (
          <section
            key={group.id}
            className="relative z-10 mx-auto mt-16 max-w-[1680px] px-5 md:mt-24 md:px-10"
            aria-label={group.titleLines.join(" ")}
          >
            <SectionHeading
              kicker={group.kicker}
              titleLines={group.titleLines}
              size="md"
            />

            <div
              className={`mt-12 grid gap-6 md:mt-16 md:gap-7 ${group.grid}`}
            >
              {group.bundles.map((bundle, i) => (
                <BundleCard key={bundle.id} bundle={bundle} index={i} />
              ))}
            </div>
          </section>
        ))}

        {/* fine print */}
        <section
          className="relative z-10 mx-auto mt-16 max-w-[1680px] px-5 md:mt-20 md:px-10"
          aria-label="Bundle terms"
        >
          <Reveal>
            <p className="mx-auto max-w-2xl text-center text-[10px] uppercase leading-relaxed tracking-[0.3em] text-crystal/40">
              Every price covers exactly the combination printed on its card —
              pick the allowed events at checkout, nothing more to calculate.
            </p>
          </Reveal>
        </section>

        {/* how bundles work */}
        <section
          className="relative z-10 mx-auto mt-20 max-w-[1680px] px-5 md:mt-28 md:px-10"
          aria-label="How bundles work"
        >
          <div className="grid gap-10 text-left md:grid-cols-3 md:gap-12">
            {STEPS.map((step, i) => (
              <Reveal key={step.n} delay={0.1 * i}>
                <div className="group border-t border-white/10 pt-6 transition-colors duration-500 hover:border-violet-bright/60">
                  <span className="text-[11px] tracking-[0.4em] text-gold/85">
                    {step.n}
                  </span>
                  <h2 className="mt-4 font-display text-[clamp(1.3rem,2.2vw,1.8rem)] tracking-[0.1em] text-crystal transition-all duration-500 group-hover:[text-shadow:0_0_22px_rgba(168,85,247,0.7)]">
                    {step.title}
                  </h2>
                  <p className="mt-3 text-sm leading-relaxed text-crystal/55">
                    {step.text}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* return */}
        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pb-36 text-center md:px-10">
          <Reveal delay={0.15}>
            <div className="mt-16 flex justify-center">
              <CinematicButton to="/events" arrow="left">
                Return to all events
              </CinematicButton>
            </div>
          </Reveal>
        </section>
      </div>
    </Page>
  );
}