import Reveal from "../ui/Reveal.jsx";
import StoryMotif from "./StoryMotif.jsx";

/**
 * One beat of the Home scroll story — text lives beside the crystal
 * so the core stays visible while it fragments and reforms.
 *
 * `index` is the beat number ("01") printed as a small HUD marker beside the
 * lead label, and `motif` renders the matching constellation diagram as a
 * faint watermark behind the copy, so each beat carries its own imagery.
 * The word plates get a soft radial wash so the copy stays readable over the
 * brightest part of the crystal.
 */
export default function StoryBeat({
  lines,
  align = "right",
  lead,
  index = null,
  motif = null,
  children = null,
  className = "",
}) {
  const pos =
    align === "left"
      ? "md:items-start md:pl-[6vw] text-center md:text-left"
      : align === "right"
        ? "md:items-end md:pr-[6vw] text-center md:text-left"
        : "items-center text-center";

  return (
    <section
      className={`relative z-10 flex min-h-svh flex-col justify-center px-6 md:px-12 ${pos} ${className}`}
    >
      {/* beat motif — a faint HUD diagram centred on the core so the story is
          carried by imagery as well as type. Centred inside the section, so it
          can never push the layout or cause horizontal overflow. */}
      {motif ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center opacity-[0.12] md:opacity-[0.22]"
        >
          <StoryMotif
            variant={motif}
            className="anim-float h-[52vmin] w-[52vmin] text-lavender md:h-[62vmin] md:w-[62vmin]"
          />
        </div>
      ) : null}

      <div className="relative flex w-full max-w-[min(88vw,640px)] flex-col gap-3">
        {/* readability plate — a whisper of shadow under the text block,
            never a visible panel */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-x-8 -inset-y-10 -z-10 rounded-[3rem] bg-[radial-gradient(ellipse_at_center,rgba(5,3,8,0.82),rgba(10,6,18,0.45)_55%,transparent_78%)] blur-xl"
        />

        {lead || index ? (
          <Reveal>
            <p className="mb-3 flex items-center gap-3 text-[10px] font-medium uppercase tracking-[0.5em] text-lavender/70">
              {index ? (
                <>
                  <span className="font-display text-xs tracking-[0.2em] text-lavender/50">{index}</span>
                  <span aria-hidden className="h-px w-6 bg-lavender/25" />
                </>
              ) : null}
              {lead}
              {motif ? (
                <span aria-hidden className="hidden h-px w-10 bg-gradient-to-r from-lavender/40 to-transparent md:block" />
              ) : null}
            </p>
          </Reveal>
        ) : null}

        {lines.map((line, i) => (
          <Reveal key={line} delay={0.1 * i}>
            <span className="block font-display text-[clamp(2.1rem,5.4vw,4.5rem)] leading-[1.08] tracking-[0.07em] text-crystal text-glow-soft">
              {line}
            </span>
          </Reveal>
        ))}

        {children ? <Reveal delay={0.1 * lines.length + 0.15}>{children}</Reveal> : null}
      </div>
    </section>
  );
}
