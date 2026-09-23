import { Link } from "react-router-dom";
import Reveal from "../ui/Reveal.jsx";
import CrystalSigil from "../event/CrystalSigil.jsx";

/** THE ARENA — competitive HUD row: sigil, number, title, mode, status, view. */
export default function ArenaRow({ event, index = 0 }) {
  const live = /LIVE/i.test(event.status);
  const dotColor = live ? "#f5d78e" : "#a855f7";

  return (
    <Reveal delay={0.07 * index}>
      <article className="group relative overflow-hidden border border-white/8 bg-void/40 transition-colors duration-500 hover:border-violet-bright/55 hover:bg-nebula/50">
        <span
          aria-hidden
          className="absolute left-0 top-0 h-full w-[3px] bg-gradient-to-b from-violet-bright/80 to-transparent"
        />
        <span
          aria-hidden
          className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-violet-core/12 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full"
        />

        <div className="relative grid items-center gap-4 px-5 py-6 md:grid-cols-12 md:gap-6 md:px-8 md:py-7">
          <div className="flex items-center gap-3 md:col-span-2">
            <CrystalSigil
              variant={event.sigil}
              accent={event.accent}
              className="h-11 w-11 shrink-0 opacity-85 transition-transform duration-500 group-hover:scale-110"
              label={`${event.title} crystal sigil`}
            />
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${live ? "anim-pulse" : ""}`}
              style={{ background: dotColor, boxShadow: `0 0 8px ${dotColor}` }}
            />
            <span className="text-[10px] tracking-[0.35em] text-lavender">{event.number}</span>
          </div>

          <div className="md:col-span-4">
            <p className="font-display text-[clamp(0.8rem,1.4vw,1.1rem)] font-medium uppercase tracking-[0.42em] text-gold [text-shadow:0_0_18px_rgba(245,215,142,0.45)]">
              {event.category}
            </p>
            <h3 className="anim-glitch mt-1 [animation-play-state:paused] font-display text-[clamp(1.4rem,2.6vw,2.1rem)] tracking-[0.04em] text-crystal transition-[text-shadow] duration-500 group-hover:[animation-play-state:running] group-hover:[text-shadow:0_0_24px_rgba(168,85,247,0.75)]">
              {event.title}
            </h3>
          </div>

          <p className="text-[10px] uppercase tracking-[0.3em] text-crystal/55 md:col-span-2">
            {event.mode ?? "TBD"}
          </p>

          <div className="md:col-span-2">
            <span
              className="inline-block border px-3 py-1.5 text-[9px] uppercase tracking-[0.24em]"
              style={{
                borderColor: live ? "rgba(245,215,142,0.55)" : "rgba(216,180,254,0.4)",
                color: live ? "#f5d78e" : "#d8b4fe",
              }}
            >
              {event.status}
            </span>
          </div>

          <div className="md:col-span-2 md:text-right">
            <Link
              to={`/events/${event.id}`}
              data-cursor="open"
              className="inline-flex items-center gap-2.5 text-[10px] font-medium uppercase tracking-[0.34em] text-crystal/70 transition-colors duration-300 hover:text-lavender hover:[text-shadow:0_0_16px_rgba(216,180,254,0.7)]"
            >
              View event
              <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </article>
    </Reveal>
  );
}
