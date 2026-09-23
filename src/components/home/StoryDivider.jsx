import Reveal from "../ui/Reveal.jsx";
import StoryMotif from "./StoryMotif.jsx";

/**
 * A breath between story beats: a centred datum rule with micro-telemetry.
 * Keeps the long scroll rhythmised and makes the page read as one continuous
 * interface instead of stacked sections. Purely decorative — hidden from
 * assistive tech so it never interrupts the narrative.
 */
export default function StoryDivider({ label = null }) {
  return (
    <div aria-hidden className="relative z-10 flex items-center justify-center px-6 py-2">
      <Reveal>
        <div className="flex items-center gap-4 md:gap-6">
          <span className="hairline w-10 md:w-24" />
          <span className="h-1 w-1 rotate-45 bg-lavender/45" />
          {label ? (
            <span className="text-[9px] font-medium uppercase tracking-[0.5em] text-lavender/40">
              {label}
            </span>
          ) : null}
          <span className="h-1 w-1 rotate-45 bg-lavender/45" />
          <span className="hairline w-10 md:w-24" />
        </div>
      </Reveal>
    </div>
  );
}