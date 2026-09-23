import { motion, useReducedMotion } from "framer-motion";

const LETTERS = ["N", "E", "X", "U", "S"];
const DATUM = [
  { k: "Realm", v: "03" },
  { k: "Core", v: "Stable" },
  { k: "Signal", v: "Locked" },
];

/**
 * Gateway hero: title lockup — AITS TIRUPATI · presents · NEXUS, with
 * the massive wordmark always LAST — plus crystal stage (center,
 * rendered by Home), meta + scroll cue (bottom). The entry CTA lives at
 * the end of the scroll story, so the gateway stays a threshold rather
 * than a button. Atmosphere comes from HUD calibration rings, side rails
 * and a datum strip — an interface floating inside the universe.
 */
export default function HomeHero() {
  const reduced = useReducedMotion();

  return (
    <section
      className="relative flex min-h-svh flex-col items-center justify-between px-6 pb-14 pt-28 text-center md:pt-36"
      aria-label="NEXUS gateway"
    >
      {/* ---- ambient HUD frame (decoration only) ---- */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* calibration rings, counter-rotating around the wordmark.
            Positioner and animator are separate elements because the spin
            keyframes own `transform` and would override the centring. */}
        <div className="absolute left-1/2 top-[23%] h-[104vmin] w-[104vmin] -translate-x-1/2 -translate-y-1/2">
          <svg viewBox="0 0 400 400" fill="none" stroke="currentColor" className="anim-spin-slow h-full w-full text-lavender/12">
            <circle cx="200" cy="200" r="198" strokeWidth="0.4" strokeDasharray="2 9" />
            <circle cx="200" cy="200" r="170" strokeWidth="0.35" strokeDasharray="52 150" />
            <circle cx="200" cy="200" r="128" strokeWidth="0.3" strokeDasharray="1 16" />
          </svg>
        </div>
        <div className="absolute left-1/2 top-[23%] h-[76vmin] w-[76vmin] -translate-x-1/2 -translate-y-1/2">
          <svg viewBox="0 0 400 400" fill="none" stroke="currentColor" className="anim-spin-rev h-full w-full text-violet-bright/15">
            <circle cx="200" cy="200" r="190" strokeWidth="0.4" strokeDasharray="118 300" />
            <circle cx="200" cy="200" r="150" strokeWidth="0.3" strokeDasharray="8 26" />
          </svg>
        </div>

        {/* side rails — rotated micro-copy, desktop only */}
        <span className="absolute left-7 top-1/2 hidden -rotate-90 text-[9px] uppercase tracking-[0.62em] text-lavender/50 md:block">
          Nexus · Entry Sequence
        </span>
        <span className="absolute right-7 top-1/2 hidden rotate-90 text-[9px] uppercase tracking-[0.62em] text-lavender/50 md:block">
          Crystal Core · 00
        </span>

        {/* corner viewfinder marks */}
        <span className="absolute left-5 top-24 h-8 w-8 border-l border-t border-lavender/20 md:left-9 md:top-32 md:h-10 md:w-10" />
        <span className="absolute right-5 top-24 h-8 w-8 border-r border-t border-lavender/20 md:right-9 md:top-32 md:h-10 md:w-10" />
        <span className="absolute bottom-9 left-5 h-8 w-8 border-b border-l border-lavender/20 md:left-9 md:h-10 md:w-10" />
        <span className="absolute bottom-9 right-5 h-8 w-8 border-b border-r border-lavender/20 md:right-9 md:h-10 md:w-10" />
      </div>

      {/* ---- wordmark ---- */}
      <div className="relative flex flex-col items-center">
        <motion.div
          className="mb-6 flex items-center gap-4 md:mb-8"
          initial={reduced ? false : { opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.8 }}
        >
          <span aria-hidden className="hairline w-8 md:w-16" />
          <p className="text-[10px] font-medium uppercase tracking-[0.55em] text-lavender/70 md:text-[11px]">
            An event ecosystem
          </p>
          <span aria-hidden className="hairline w-8 md:w-16" />
        </motion.div>

        <h1 className="flex flex-col items-center" aria-label="AITS TIRUPATI presents NEXUS">
          {/* presenting institution — takes the old wordmark's top slot */}
          <motion.span
            aria-hidden
            className="text-sheen block font-display text-[clamp(1.4rem,4.8vw,3.6rem)] font-medium uppercase leading-none tracking-[0.22em]"
            initial={reduced ? false : { opacity: 0, y: -14, rotateX: -40 }}
            animate={{ opacity: 1, y: 0, rotateX: 0 }}
            transition={{ delay: 0.3, duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          >
            AITS TIRUPATI
          </motion.span>

          {/* connector — flanked + glowing so it stays legible over the crystal */}
          <motion.span
            aria-hidden
            className="mt-4 flex items-center gap-3 font-display text-[13px] italic tracking-[0.46em] text-lavender md:mt-5 md:text-[15px] [text-shadow:0_1px_8px_rgba(5,3,8,0.9),0_0_16px_rgba(216,180,254,0.55)]"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.52, duration: 0.9 }}
          >
            <span className="hairline w-7 md:w-12" />
            <span className="-mr-[0.46em] px-1">presents</span>
            <span className="hairline w-7 md:w-12" />
          </motion.span>

          {/* the wordmark — always last */}
          <span className="wordmark-glow mt-5 flex justify-center font-display text-[clamp(3.4rem,15vw,11rem)] font-medium leading-none md:mt-7">
            {LETTERS.map((ch, i) => (
              <motion.span
                key={ch}
                aria-hidden
                className="text-sheen mr-[0.26em] inline-block last:mr-0"
                style={{ animationDelay: `${i * 0.42}s` }}
                initial={reduced ? false : { opacity: 0, y: "0.35em", rotateX: -55 }}
                animate={{ opacity: 1, y: 0, rotateX: 0 }}
                transition={{ delay: 0.66 + i * 0.09, duration: 1, ease: [0.22, 1, 0.36, 1] }}
              >
                {ch}
              </motion.span>
            ))}
          </span>
        </h1>

        <motion.p
          className="mt-6 text-[9px] font-medium uppercase tracking-[0.5em] text-crystal/75 [text-shadow:0_1px_10px_rgba(5,3,8,0.9),0_0_22px_rgba(5,3,8,0.7)] md:text-[10px]"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.25, duration: 1.1 }}
        >
          Signal acquired
        </motion.p>
      </div>

      <div className="flex-1" aria-hidden />

      {/* ---- crystal legend, scroll cue, datum strip ---- */}
      <motion.div
        className="relative flex flex-col items-center gap-5"
        initial={reduced ? false : { opacity: 0, y: 26 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.05, duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      >
        <div aria-hidden className="flex w-full items-center justify-center gap-4 md:gap-6">
          <span className="hairline w-10 md:w-20" />
          <span className="h-1 w-1 rotate-45 bg-lavender/60" />
          <span className="hairline w-10 md:w-20" />
        </div>

        <p className="font-display text-sm italic tracking-[0.42em] text-lavender [text-shadow:0_1px_12px_rgba(5,3,8,0.95),0_0_30px_rgba(5,3,8,0.75)] md:text-base">
          NEXUS CRYSTAL
        </p>

        <div aria-hidden className="flex w-full items-center justify-center gap-4 md:gap-6">
          <span className="hairline w-10 md:w-20" />
          <span className="h-1 w-1 rotate-45 bg-lavender/70" />
          <span className="hairline w-10 md:w-20" />
        </div>

        <p className="text-[10px] font-medium uppercase tracking-[0.5em] text-crystal/90 [text-shadow:0_1px_10px_rgba(5,3,8,0.9),0_0_22px_rgba(5,3,8,0.7)] md:text-[11px]">
          Connect • Create • Transcend
        </p>

        <motion.svg
          aria-hidden
          viewBox="0 0 14 30"
          className="h-7 w-3.5 text-lavender"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          animate={reduced ? undefined : { y: [0, 7, 0] }}
          transition={{ repeat: Infinity, duration: 1.9, ease: "easeInOut" }}
        >
          <path d="M7 0v26M1.5 20.5L7 27l5.5-6.5" />
        </motion.svg>

        {/* datum strip — micro telemetry that keeps the gateway feeling live */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 [text-shadow:0_1px_10px_rgba(5,3,8,0.9),0_0_20px_rgba(5,3,8,0.7)] md:gap-x-9">
          {DATUM.map((d, i) => (
            <span
              key={d.k}
              className="flex items-center gap-3 text-[9px] font-medium uppercase tracking-[0.38em]"
            >
              {i > 0 ? <span aria-hidden className="h-1 w-1 rotate-45 bg-lavender/55" /> : null}
              <span className="text-crystal/80">{d.v}</span>
              <span className="text-lavender/90">{d.k}</span>
            </span>
          ))}
        </div>
      </motion.div>
    </section>
  );
}
