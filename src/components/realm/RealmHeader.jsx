import { Link } from "react-router-dom";
import Reveal from "../ui/Reveal.jsx";
import RealmStage from "../events/LazyRealmStage.jsx";

/**
 * Shared realm page header — return-to-events link, then staged reveal:
 * kicker -> realm name (per word) -> tagline -> hairline -> blurb, with the
 * realm's own crystal core suspended behind the type on desktop. Display
 * type stays tight; labels keep their wide tracking.
 */
export default function RealmHeader({ realm }) {
  const words = realm.name.split(" ");

  return (
    <header className="relative z-10 mx-auto max-w-[1680px] px-5 pt-36 md:px-10 md:pt-44">
      {/* realm crystal hero — the same core that gated you here */}
      <Reveal
        delay={0.3}
        className="pointer-events-none absolute right-2 top-24 -z-10 hidden w-[46%] max-w-[540px] lg:block"
      >
        <RealmStage realm={realm} />
      </Reveal>

      {/* back to the realm gateway */}
      <Reveal>
        <Link
          to="/events"
          className="group/back mb-8 inline-flex items-center gap-3 text-[10px] font-medium uppercase tracking-[0.45em] text-lavender/75 transition-colors duration-300 hover:text-crystal hover:[text-shadow:0_0_16px_rgba(216,180,254,0.7)]"
        >
          <span aria-hidden className="inline-block transition-transform duration-300 group-hover/back:-translate-x-1.5">
            ←
          </span>
          All events
          <span
            aria-hidden
            className="h-px w-8 bg-lavender/40 transition-all duration-300 group-hover/back:w-14 group-hover/back:bg-lavender/90"
          />
        </Link>
      </Reveal>

      <Reveal>
        <p className="flex items-center gap-4 text-[clamp(1.05rem,2.6vw,2rem)] font-display font-medium uppercase tracking-[0.38em] text-gold [text-shadow:0_0_26px_rgba(245,215,142,0.45)]">
          <span aria-hidden className="hairline hidden w-12 shrink-0 md:block md:w-20" />
          {realm.subtitle}
        </p>
      </Reveal>

      <h1 className="mt-6 flex flex-col" aria-label={realm.name}>
        {words.map((word, i) => (
          <Reveal key={word} delay={0.08 * i}>
            <span className="block font-display text-[clamp(3rem,9vw,7.5rem)] font-medium leading-[0.98] tracking-[0.03em] text-crystal text-glow">
              {i > 0 ? " " : ""}
              {word}
            </span>
          </Reveal>
        ))}
      </h1>

      <Reveal delay={0.22}>
        <p className="mt-7 font-display text-[clamp(1.3rem,3vw,2.3rem)] italic tracking-[0.08em] text-lavender">
          {realm.tagline.join("  ")}
        </p>
      </Reveal>

      <Reveal delay={0.32}>
        <div className="hairline mt-8 w-44 md:w-64" aria-hidden />
      </Reveal>

      <Reveal delay={0.4}>
        <p className="mt-7 max-w-xl text-sm leading-relaxed tracking-wide text-crystal/55">{realm.blurb}</p>
      </Reveal>
    </header>
  );
}

