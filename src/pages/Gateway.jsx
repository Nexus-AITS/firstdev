import { Link, useSearchParams } from "react-router-dom";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import ParticleField from "../components/fx/ParticleField.jsx";
import CrystalSigil from "../components/event/CrystalSigil.jsx";
import { APPLICATION_BASE_URL } from "../config/eventLinks.js";
import { getEventById } from "../data/events.js";
import { realms } from "../data/realms.js";

/**
 * Registration hand-off — every event's "Enter Event" CTA lands here first.
 * The single external button resolves APPLICATION_BASE_URL from
 * src/config/eventLinks.js, so the real application URL is set in exactly
 * one place. Optional `?event=<id>` context personalises the crossing.
 */
const STEPS = [
  {
    n: "01",
    title: "CHOOSE IN THE REALMS",
    text: "Browse the Forge, the Paradox and the Arena, then open the event you want to enter.",
  },
  {
    n: "02",
    title: "CROSS THE GATEWAY",
    text: "This page is the single hand-off point — every event registration passes through it.",
  },
  {
    n: "03",
    title: "CLAIM YOUR SEAT",
    text: "The real Nexus application completes your registration and confirms your place.",
  },
];

export default function Gateway() {
  const [searchParams] = useSearchParams();
  const event = getEventById(searchParams.get("event"));
  const realm = event ? realms[event.realm] : null;

  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
          <ParticleField mode="stars" factor={0.8} />
        </div>

        {/* hero */}
        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pt-40 text-center md:px-10 md:pt-52">
          <Reveal>
            <p className="text-[10px] font-medium uppercase tracking-[0.55em] text-lavender/70">
              Nexus // Registration
            </p>
          </Reveal>

          <h1 className="mt-6 flex flex-col items-center font-display text-[clamp(2.8rem,10vw,8rem)] font-medium leading-[1.02] tracking-[0.08em] text-crystal">
            <Reveal y={54}>
              <span className="block text-glow-soft">NEXUS</span>
            </Reveal>
            <Reveal delay={0.12} y={54}>
              <span className="block italic text-lavender text-glow">GATEWAY</span>
            </Reveal>
          </h1>

          <Reveal delay={0.4}>
            <div className="hairline mx-auto mt-12 w-52 md:w-80" aria-hidden />
          </Reveal>

          <Reveal delay={0.5}>
            <p className="mx-auto mt-7 max-w-xl text-sm leading-relaxed tracking-wide text-crystal/60">
              {event
                ? `One threshold remains. Cross the gateway and the real Nexus application will take your registration for ${event.title}.`
                : "Every registration in the Nexus crosses a single threshold — this gateway hands you over to the real application, where your seat is claimed."}
            </p>
          </Reveal>
        </section>


        {/* selected event context (from ?event=<id>) */}
        {event ? (
          <section
            className="relative z-10 mx-auto mt-14 max-w-[1680px] px-5 md:mt-20 md:px-10"
            aria-label="Selected event"
          >
            <Reveal>
              <div className="glass-panel mx-auto grid max-w-3xl items-center gap-7 px-6 py-7 md:grid-cols-[auto_1fr] md:gap-9 md:px-10 md:py-9">
                <CrystalSigil
                  variant={event.sigil}
                  accent={event.accent}
                  className="anim-float mx-auto w-24 md:w-32"
                  label={`${event.title} crystal sigil`}
                />
                <div className="text-center md:text-left">
                  <div className="flex flex-wrap items-center justify-center gap-3 md:justify-start">
                    <span className="text-[11px] tracking-[0.4em] text-lavender">{event.number}</span>
                    <span aria-hidden className="h-px w-8 bg-lavender/40" />
                    <span className="font-display text-[clamp(0.8rem,1.4vw,1.05rem)] font-medium uppercase tracking-[0.34em] text-gold [text-shadow:0_0_18px_rgba(245,215,142,0.45)]">
                      {event.category}
                    </span>
                  </div>
                  <h2 className="mt-3 font-display text-[clamp(1.5rem,3vw,2.4rem)] leading-tight tracking-[0.07em] text-crystal">
                    {event.title}
                  </h2>
                  <p className="mt-2 text-[10px] uppercase tracking-[0.3em] text-crystal/50">
                    {realm ? `Realm — ${realm.name}` : null}
                    {realm ? " · " : null}
                    {event.date}
                  </p>
                </div>
              </div>
            </Reveal>
          </section>
        ) : null}

        {/* the one external CTA */}
        <section
          className="relative z-10 mx-auto mt-16 max-w-[1680px] px-5 text-center md:mt-24 md:px-10"
          aria-label="Application hand-off"
        >
          <Reveal>
            <div className="hairline mx-auto w-48 md:w-72" aria-hidden />
            <p className="mt-9 text-[10px] font-medium uppercase tracking-[0.5em] text-lavender/75">
              {event ? `Ready to register for ${event.title}` : "Registration begins beyond this page"}
            </p>
            <div className="relative mt-8 inline-block">
              <div
                aria-hidden
                className="absolute inset-[-60%] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.32),transparent_65%)] blur-2xl"
              />
              <CinematicButton href={APPLICATION_BASE_URL} className="relative px-10 py-5 md:px-14">
                Enter the application
              </CinematicButton>
            </div>
            <p className="mt-7 text-[10px] uppercase tracking-[0.32em] text-crystal/35">
              This gateway hands you over to the real Nexus application
            </p>
          </Reveal>
        </section>

        {/* how the crossing works */}
        <section
          className="relative z-10 mx-auto mt-20 max-w-[1680px] px-5 md:mt-28 md:px-10"
          aria-label="How registration works"
        >
          <div className="grid gap-10 text-left md:grid-cols-3 md:gap-12">
            {STEPS.map((step, i) => (
              <Reveal key={step.n} delay={0.1 * i}>
                <div className="group border-t border-white/10 pt-6 transition-colors duration-500 hover:border-violet-bright/60">
                  <span className="text-[11px] tracking-[0.4em] text-gold/85">{step.n}</span>
                  <h2 className="mt-4 font-display text-[clamp(1.3rem,2.2vw,1.8rem)] tracking-[0.1em] text-crystal transition-all duration-500 group-hover:[text-shadow:0_0_22px_rgba(168,85,247,0.7)]">
                    {step.title}
                  </h2>
                  <p className="mt-3 text-sm leading-relaxed text-crystal/55">{step.text}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* return */}
        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pb-36 text-center md:px-10">
          <Reveal delay={0.15}>
            <Link
              to={event ? `/events/${event.id}` : "/events"}
              className="mt-16 inline-block text-[10px] uppercase tracking-[0.4em] text-crystal/40 transition-colors hover:text-lavender"
            >
              ← {event ? "Return to the event" : "Return to the realms"}
            </Link>
          </Reveal>
        </section>
      </div>
    </Page>
  );
}

