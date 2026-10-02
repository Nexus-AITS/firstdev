import { Link, useParams } from "react-router-dom";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import RealmFX from "../components/fx/RealmFX.jsx";
import CrystalSigil from "../components/event/CrystalSigil.jsx";
import EventLogo from "../components/event/EventLogo.jsx";
import MetaRow from "../components/event/MetaRow.jsx";
/* The registration count used to render here through <Seats/>. It is now an
   operations figure and lives only in the admin console. */
import NotFound from "./NotFound.jsx";
import { formatEventFee, getEventFee, formatEntryType, paymentNote } from "../data/events.js";
import { realms } from "../data/realms.js";
import { catalogueLoaded } from "../data/catalogue.js";
import useEventView from "../hooks/useEventView.js";
import usePricing from "../hooks/usePricing.js";

export default function EventDetail() {
  const { eventId } = useParams();
  // The live view, subscribed: a date or venue a master edited in the console
  // reaches this page without a redeploy. getEventView falls back to the
  // compiled-in data, so this is also the offline path.
  const event = useEventView(eventId);
  // Repaint the billing line when the database answers. The fee is read through
  // getEventFee, so a price a master changed in the console is what shows here.
  usePricing();

  /* NOT FOUND versus NOT LOADED YET - and the difference is one network round
     trip, so getting it wrong flashes the wrong page.

     An event that exists only in the database cannot be resolved until
     public_catalogue answers, because there is no compiled copy to fall back on.
     Returning NotFound in that window showed a real, on-sale event as a 404 for
     as long as the fetch took, which reads as "this event does not exist" and
     sends an operator looking for a bug in the catalogue tab.

     So: while the catalogue is still loading, hold the route. Only once it has
     answered is `null` real evidence that the id is wrong. */
  if (!event && !catalogueLoaded()) {
    return (
      <Page>
        <div className="relative min-h-svh overflow-hidden bg-void">
          <RealmFX mode="stars" factor={0.7} />
          <p
            role="status"
            aria-live="polite"
            className="relative z-10 px-5 pt-40 text-center font-mono text-[11px] uppercase tracking-[0.35em] text-ash md:px-10"
          >
            Loading event…
          </p>
        </div>
      </Page>
    );
  }

  if (!event) return <NotFound />;

  /* An event row carries `realm`, and the catalogue CHECK confines it to the
     three realms this site has pages for. The lookup is still defensive because
     `realm.route` is dereferenced directly below, and a row from a future
     migration must render something rather than crash the page to black - which
     is the same failure mode the profile dropdowns had. */
  const realm = realms[event.realm] ?? realms.forge;

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

            {/* A game event is recognised by its mark, not just its name, so an
                event that declares a logo gets it directly under the title. */}
            {event.logo ? (
              <Reveal delay={0.14}>
                <div className="mt-7 flex justify-center md:justify-start">
                  <EventLogo
                    logo={event.logo}
                    title={event.title}
                    className="w-[min(88%,420px)]"
                  />
                </div>
              </Reveal>
            ) : null}

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

        {/* about — only when there is prose to show. An event created in the
            console carries none (the `about` paragraphs live only in the
            compiled seed), and a heading with nothing under it reads as a page
            that failed to load rather than one with a short description. */}
        {event.about.length ? (
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
        ) : null}

        {/* CTA */}
        <section className="relative z-10 mx-auto mt-20 max-w-[1680px] px-5 pb-32 text-center md:mt-28 md:px-10">
          <Reveal>
            <div className="hairline mx-auto w-48 md:w-72" aria-hidden />
            <p className="mt-9 text-[10px] font-medium uppercase tracking-[0.5em] text-lavender/75">
              Registration happens right here in the Nexus
            </p>
            {/* The registration count used to render here through <Seats/>. It
                was the only thing under this line, and the whole div went with
                it rather than being left holding nothing.

                A public counter tells a prospective participant how busy an event
                already is — the operations team's information rather than theirs —
                and it changes the decision to register. It lives in the console
                now, where an operator reconciles against it. */}
            {/* `!= null`, not truthy: a fee of 0 must still render (as FREE). */}
            {getEventFee(event.id) != null ? (
              <div className="mt-6 flex flex-col items-center gap-2">
                <div className="flex items-center justify-center gap-4">
                  <span aria-hidden className="h-px w-8 bg-gold/40" />
                  <p className="font-display text-[clamp(1.7rem,3.2vw,2.6rem)] font-medium text-gold [text-shadow:0_0_26px_rgba(245,215,142,0.45)]">
                    {formatEventFee(event.id)}
                  </p>
                  <span className="text-[10px] font-medium uppercase tracking-[0.4em] text-crystal/55">
                    {formatEntryType(event)}
                  </span>
                  <span aria-hidden className="h-px w-8 bg-gold/40" />
                </div>
                {/* WHO pays is a different question from WHO may enter, and on a
                    team event it is the difference between Rs 349 per person and
                    Rs 349 for five people. This used to speak only for a squad, so
                    NEXUS BREACH printed its cap and said nothing — which is how a
                    participant ends up believing a team of five owes Rs 349.

                    paymentNote() covers BOTH cases and does the arithmetic, and it
                    returns null for an individual event, where one person paying
                    one fee needs no explanation. */}
                {paymentNote(event) ? (
                  <p className="mt-1 max-w-md text-center font-mono text-[10px] uppercase tracking-[0.2em] leading-relaxed text-gold/80">
                    {paymentNote(event)}
                  </p>
                ) : null}
              </div>
            ) : null}

            {/* Where a paid participant goes to form a team, when that happens off
                this site. A COLUMN, not a constant: the destination changes, and
                the console has to be able to change it. Blank for every event
                that does not have an off-site team step. */}
            {event.teamFormUrl ? (
              <p className="mt-5 text-[11px] leading-relaxed tracking-wide text-crystal/55">
                Every participant pays their own fee. Once your payment is approved, you will be
                able to form a team and continue from there.
              </p>
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
              {/* A free event has no QR and no UTR to paste — don't promise them.
                  Tested against the LIVE fee, so dropping an event to 0 in the
                  console also drops the payment copy, not just the number. */}
              {getEventFee(event.id) > 0
                ? "Details → payment QR → UTR — one short crossing"
                : "Details → confirmation — one short crossing"}
            </p>
          </Reveal>
        </section>
      </div>
    </Page>
  );
}
