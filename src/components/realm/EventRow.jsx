import { Link } from "react-router-dom";
import Reveal from "../ui/Reveal.jsx";
import CrystalSigil from "../event/CrystalSigil.jsx";
import { formatMaxSize } from "../../data/events.js";

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

/** THE FORGE — alternating cinematic event rows with ghost numerals. */
export default function EventRow({ event, index = 0 }) {
  const flip = index % 2 === 1;

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

          {event.payment ? (
            <p className="mt-6 text-[11px] font-medium uppercase tracking-[0.36em] text-gold/85 [text-shadow:0_0_16px_rgba(245,215,142,0.35)]">
              ₹{event.payment} · {formatMaxSize(event.maxSize)}
            </p>
          ) : null}

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
