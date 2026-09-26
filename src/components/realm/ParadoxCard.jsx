import { Link } from "react-router-dom";
import Reveal from "../ui/Reveal.jsx";
import CrystalSigil from "../event/CrystalSigil.jsx";
import { formatMaxSize } from "../../data/events.js";

const SHIFTS = ["", "md:ml-[7%]", "md:ml-[13%]", "md:ml-[4%]", "md:ml-[10%]"];
const TILTS = [-0.6, 0.5, -0.4, 0.7, -0.5];

const CLIP =
  "polygon(0 0, calc(100% - 30px) 0, 100% 30px, 100% 100%, 30px 100%, 0 calc(100% - 30px))";

/** NEXUS OFF-GRID — offset shard panels, experimental composition. */
export default function ParadoxCard({ event, index = 0 }) {
  const shift = SHIFTS[index % SHIFTS.length];
  const tilt = TILTS[index % TILTS.length];

  return (
    <Reveal delay={0.05 * (index % 3)} className={`w-full ${shift}`}>
      <article
        className="group relative w-full overflow-hidden transition-transform duration-700 ease-out"
        style={{ clipPath: CLIP, transform: `rotate(${tilt}deg)` }}
      >
        <div className="glass-panel relative px-6 py-9 transition-colors duration-500 group-hover:border-lavender/25 md:px-10 md:py-11">
          <span
            aria-hidden
            className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gold/50 to-transparent opacity-60"
          />
          <div
            aria-hidden
            className="absolute inset-0 opacity-0 transition-opacity duration-700 group-hover:opacity-100"
            style={{ background: "radial-gradient(70% 100% at 8% 50%, rgba(124,58,237,0.22), transparent 70%)" }}
          />

          <div className="relative flex flex-col items-center gap-7 md:flex-row md:gap-10">
            <CrystalSigil
              variant={event.sigil}
              accent={event.accent}
              className="w-[42%] max-w-[170px] shrink-0 transition-transform duration-700 group-hover:rotate-[-4deg] group-hover:scale-105"
              label={`${event.title} crystal sigil`}
            />

            <div className="min-w-0 flex-1 text-center md:text-left">
              <div className="flex flex-wrap items-center justify-center gap-3 md:justify-start">
                <span className="text-[11px] tracking-[0.4em] text-gold/90">{event.number}</span>
                <span aria-hidden className="h-px w-6 bg-gold/40" />
                <span className="font-display text-[clamp(0.95rem,1.8vw,1.4rem)] font-medium uppercase tracking-[0.34em] text-gold [text-shadow:0_0_20px_rgba(245,215,142,0.4)]">
                  {event.category}
                </span>
              </div>

              <h3 className="mt-4 font-display text-[clamp(1.7rem,3.6vw,2.9rem)] leading-tight tracking-[0.06em] text-crystal transition-all duration-500 group-hover:[text-shadow:0_0_28px_rgba(245,215,142,0.45)]">
                {event.title}
              </h3>

              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed tracking-wide text-crystal/60">
                {event.tagline}
              </p>

              {event.payment ? (
                <p className="mt-5 text-[11px] font-medium uppercase tracking-[0.34em] text-gold/85 [text-shadow:0_0_16px_rgba(245,215,142,0.35)]">
                  ₹{event.payment} · {formatMaxSize(event.maxSize)}
                </p>
              ) : null}

              <Link
                to={`/events/${event.id}`}
                data-cursor="open"
                className="mt-6 inline-flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.42em] text-gold/90 transition-colors duration-300 hover:text-gold hover:[text-shadow:0_0_16px_rgba(245,215,142,0.6)]"
              >
                Explore
                <span aria-hidden>→</span>
              </Link>
            </div>
          </div>
        </div>
      </article>
    </Reveal>
  );
}
