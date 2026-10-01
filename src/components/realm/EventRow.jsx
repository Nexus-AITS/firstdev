import { Link } from "react-router-dom";
import Reveal from "../ui/Reveal.jsx";
import CrystalSigil from "../event/CrystalSigil.jsx";
/* The registration count used to render here through <Seats/>. It is now an
   operations figure and lives only in the admin console: a public counter tells a
   prospective participant how busy an event already is, which is the operations
   team's commercial information rather than theirs. */
/* getEventFee stays imported: this component reads the DB-first fee directly
   for the `fee != null` gate, and dropping it in favour of paymentNote() left a
   free identifier in the file. esbuild does not resolve free identifiers, so the
   build stayed green and the page died at runtime with a ReferenceError on every
   row — which is what a blank realm page is. A lint pass or an undefined-variable
   check would have caught this; a build does not. */
import {
  formatEventFee,
  formatEntryType,
  formatPaymentMode,
  getEventFee,
  paymentNote,
} from "../../data/events.js";
import usePricing from "../../hooks/usePricing.js";

function ExploreLink({ id }) {
  return (
    <Link
      to={`/events/${id}`}
      data-cursor="open"
      className="group/x inline-flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.42em] text-lavender transition-colors duration-300 hover:text-crystal hover:[text-shadow:0_0_16px_rgba(216,180,254,0.7)]"
    >
      Explore
      <svg
        aria-hidden
        viewBox="0 0 24 12"
        className="h-2.5 w-6 overflow-visible transition-transform duration-300 group-hover/x:translate-x-1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      >
        <path d="M0 6h22M17 1l5 5-5 5" />
      </svg>
    </Link>
  );
}

/** NEXUS REBUILDERS — alternating cinematic event rows with ghost numerals. */
export default function EventRow({ event, index = 0 }) {
  const flip = index % 2 === 1;
  // Subscribe so a price changed in the console repaints this row, and read the
  // DB-first fee rather than the compiled-in `event.payment` constant.
  usePricing();
  const fee = getEventFee(event.id);

  return (
    <article className="group relative border-t border-white/5 py-12 md:py-16">
      <span
        aria-hidden
        className="pointer-events-none absolute -top-4 select-none font-display text-[clamp(5.5rem,15vw,12rem)] leading-none text-crystal/[0.05] transition-colors duration-700 group-hover:text-violet-bright/[0.12]"
        style={flip ? { right: 0 } : { left: 0 }}
      >
        {event.number}
      </span>

      <div className="relative grid items-center gap-10 md:grid-cols-12 md:gap-10">
        <Reveal className={flip ? "md:col-span-6 md:col-start-7" : "md:col-span-6 md:col-start-1"}>
          <div className="flex items-center gap-4">
            <span className="text-[11px] tracking-[0.4em] text-lavender">{event.number}</span>
            <span aria-hidden className="h-px w-8 bg-lavender/40" />
          </div>

          {/* event type — billing line with real priority beside the title */}
          <div className="mt-4 flex items-center gap-4">
            <span aria-hidden className="h-px w-8 shrink-0 bg-gold/50 md:w-12" />
            <span className="font-display text-[clamp(1rem,2vw,1.55rem)] font-medium uppercase tracking-[0.36em] text-gold [text-shadow:0_0_22px_rgba(245,215,142,0.45)]">
              {event.category}
            </span>
          </div>

          <h3 className="mt-4 font-display text-[clamp(1.8rem,4vw,3.3rem)] leading-tight tracking-[0.07em] text-crystal transition-all duration-500 group-hover:[text-shadow:0_0_30px_rgba(168,85,247,0.7)]">
            {event.title}
          </h3>

          <p className="mt-4 max-w-md whitespace-pre-line text-sm leading-relaxed tracking-wide text-crystal/60">
            {event.tagline}
          </p>

          {/* `!= null`, not truthy: a fee of 0 is a FREE entry, not "unknown". */}
          {fee != null ? (
            <p className="mt-6 text-[11px] font-medium uppercase tracking-[0.36em] text-gold/85 [text-shadow:0_0_16px_rgba(245,215,142,0.35)]">
              {formatEventFee(event.id)} · {formatEntryType(event)}
              {/* WHO pays, whenever the event is entered as a TEAM. On a squad
                  event the bare figure is ambiguous in both directions — Rs 300
                  for five people, or Rs 300 each for five people — and the card
                  is where that gets decided. An individual event never shows it,
                  because one person paying one fee needs no explanation. */}
              {formatPaymentMode(event) ? ` · ${formatPaymentMode(event)}` : ""}
            </p>
          ) : null}

          {/* The sentence, not the label: "₹349 · TEAM · MAX 5" is what produced the
              confusion in the first place, because neither word said who pays.
              This states it, and for a per-person team it also does the
              arithmetic, so a full squad's cost is never a surprise at the desk. */}
          {paymentNote(event) ? (
            <p className="mt-2 max-w-md text-[11px] leading-relaxed tracking-wide text-crystal/45">
              {paymentNote(event)}
            </p>
          ) : null}

          {/* The registration count used to render here through <Seats/>. It is now an
              operations figure and lives only in the admin console: a public
              counter tells a prospective participant how busy an event already
              is, which is the operations team's information rather than theirs,
              and it changes the decision to register in a way nobody asked for. */}
          <div className="mt-6">
            <ExploreLink id={event.id} />
          </div>
        </Reveal>

        <Reveal
          delay={0.15}
          className={flip ? "md:col-span-5 md:col-start-1" : "md:col-span-5 md:col-start-8"}
        >
          <CrystalSigil
            variant={event.sigil}
            accent={event.accent}
            className="mx-auto w-[64%] max-w-[300px] transition-transform duration-700 ease-out group-hover:scale-105"
            label={`${event.title} crystal sigil`}
          />
        </Reveal>
      </div>
    </article>
  );
}
