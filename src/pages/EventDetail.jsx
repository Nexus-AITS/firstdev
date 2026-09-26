import { Link, useParams } from "react-router-dom";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import RealmFX from "../components/fx/RealmFX.jsx";
import CrystalSigil from "../components/event/CrystalSigil.jsx";
import MetaRow from "../components/event/MetaRow.jsx";
import NotFound from "./NotFound.jsx";
import { getEventById, formatMaxSize } from "../data/events.js";
import { realms } from "../data/realms.js";

export default function EventDetail() {
  const { eventId } = useParams();
  const event = getEventById(eventId);

  if (!event) return <NotFound />;

  const realm = realms[event.realm];

  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <RealmFX mode="stars" factor={0.7} />

        {/* back */}
        <div className="relative z-10 mx-auto max-w-[1680px] px-5 pt-28 md:px-10 md:pt-32">
          <Link
            to={realm.route}
            className="group/back inline-flex items-center gap-3 text-[10px] uppercase tracking-[0.4em] text-crystal/50 transition-colors hover:text-lavender"
          >
            <span aria-hidden className="transition-transform duration-300 group-hover/back:-translate-x-1.5">
              ←
            </span>
            Back to {realm.name}
          </Link>
        </div>

        {/* hero */}
        <header className="relative z-10 mx-auto grid max-w-[1680px] items-center gap-10 px-5 pt-10 md:grid-cols-2 md:gap-16 md:px-10 md:pt-14">
          <div className="text-center md:text-left">
            <Reveal>
              <div className="flex flex-wrap items-center justify-center gap-4 md:justify-start">
                <span className="text-[11px] tracking-[0.42em] text-lavender">{event.number}</span>
                <span aria-hidden className="h-px w-10 bg-lavender/40" />
              </div>
            </Reveal>

            {/* event type — billing line with real priority beside the title */}
            <Reveal delay={0.06}>
              <div className="mt-5 flex items-center justify-center gap-4 md:justify-start">
                <span
                  aria-hidden
                  className="hidden h-px w-10 shrink-0 bg-gradient-to-r from-transparent via-gold/60 to-gold/70 sm:block md:w-14"
                />
                <span className="text-center font-display text-[clamp(1rem,2.2vw,1.7rem)] font-medium uppercase tracking-[0.36em] text-gold [text-shadow:0_0_24px_rgba(245,215,142,0.45)]">
                  {event.category}
                </span>
              </div>
            </Reveal>

            <Reveal delay={0.1}>
              <h1 className="mt-6 font-display text-[clamp(2.4rem,7vw,5.4rem)] leading-[1.02] tracking-[0.06em] text-crystal text-glow">
                {event.title}
              </h1>
            </Reveal>

            <Reveal delay={0.2}>
              <p className="mt-6 whitespace-pre-line font-display text-[clamp(1.15rem,2.4vw,1.9rem)] italic leading-snug tracking-[0.08em] text-lavender">
                {event.tagline}
              </p>
            </Reveal>
          </div>

          <Reveal delay={0.15}>
            <CrystalSigil
              variant={event.sigil}
              accent={event.accent}
              className="anim-float mx-auto w-[68%] max-w-[420px]"
              label={`${event.title} crystal sigil`}
            />
          </Reveal>
        </header>

        {/* meta */}
        <div className="relative z-10 mx-auto mt-14 max-w-[1680px] px-5 md:mt-20 md:px-10">
          <Reveal>
            <MetaRow event={event} />
          </Reveal>
        </div>

        {/* about */}
        <section
          className="relative z-10 mx-auto mt-16 grid max-w-[1680px] gap-8 px-5 md:mt-24 md:grid-cols-12 md:px-10"
          aria-label="About the event"
        >
          <div className="md:col-span-4">
            <Reveal>
              <h2 className="font-display text-[clamp(1.6rem,3vw,2.6rem)] tracking-[0.12em] text-crystal">
                ABOUT THE EVENT
              </h2>
              <div className="hairline mt-5 w-32" aria-hidden />
            </Reveal>
          </div>
          <div className="flex flex-col gap-5 md:col-span-7 md:col-start-6">
            {event.about.map((paragraph, i) => (
              <Reveal key={i} delay={0.08 * i}>
                <p className="text-[15px] leading-[1.95] tracking-wide text-crystal/65">{paragraph}</p>
              </Reveal>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="relative z-10 mx-auto mt-20 max-w-[1680px] px-5 pb-32 text-center md:mt-28 md:px-10">
          <Reveal>
            <div className="hairline mx-auto w-48 md:w-72" aria-hidden />
            <p className="mt-9 text-[10px] font-medium uppercase tracking-[0.5em] text-lavender/75">
              Registration happens right here in the Nexus
            </p>
            {event.payment ? (
              <div className="mt-6 flex items-center justify-center gap-4">
                <span aria-hidden className="h-px w-8 bg-gold/40" />
                <p className="font-display text-[clamp(1.7rem,3.2vw,2.6rem)] font-medium text-gold [text-shadow:0_0_26px_rgba(245,215,142,0.45)]">
                  ₹{event.payment}
                </p>
                <span className="text-[10px] font-medium uppercase tracking-[0.4em] text-crystal/55">
                  {formatMaxSize(event.maxSize)}
                </span>
                <span aria-hidden className="h-px w-8 bg-gold/40" />
              </div>
            ) : null}
            <div className="relative mt-8 inline-block">
              <div
                aria-hidden
                className="absolute inset-[-60%] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.32),transparent_65%)] blur-2xl"
              />
                <CinematicButton
                  to={`/register?event=${event.id}`}
                  className="relative px-10 py-5 md:px-14"
                >
                  Enter Event
                </CinematicButton>
            </div>
            <p className="mt-7 text-[10px] uppercase tracking-[0.32em] text-crystal/35">
              Details → payment QR → UTR — one short crossing
            </p>
          </Reveal>
        </section>
      </div>
    </Page>
  );
}
