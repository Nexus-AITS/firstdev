import { Link } from "react-router-dom";
import RealmStage from "./LazyRealmStage.jsx";

/**
 * One realm portal: the crystalline 3D core plus its identity block
 * (kicker / name / mantra / ENTER). Wraps a single <a> so the gateway
 * keeps exactly three realm links inside <main>.
 *
 * Hover/focus reports up to Events for page-wide dominance: the focused
 * realm brightens while the others dim, desaturate and drift back.
 */
export default function RealmStation({
  realm,
  index = 0,
  focused = false,
  dimmed = false,
  ready = false,
  onHover,
  onSelect,
  className = "",
}) {
  const num = String(index + 1).padStart(2, "0");

  return (
    <article
      className={`relative transition-[opacity,filter,transform] duration-[900ms] ease-out ${
        ready ? "translate-y-0 opacity-100" : "translate-y-12 opacity-0"
      } ${dimmed ? "opacity-40 saturate-[0.4] blur-[1.5px]" : "opacity-100"} ${className}`}
      style={{ transitionDelay: `${index * 140}ms` }}
    >
      {/* ghost index numeral — depth layer behind the portal */}
      <span
        aria-hidden
        className="pointer-events-none absolute -top-10 left-1/2 -z-10 -translate-x-1/2 select-none font-display text-[13rem] leading-none text-white/[0.035] transition-all duration-700 md:text-[17rem]"
        style={{ opacity: focused ? 0.9 : 0.5 }}
      >
        {num}
      </span>

      <Link
        to={realm.route}
        data-cursor="enter"
        aria-label={`Enter ${realm.name} — ${realm.kicker}`}
        className="group block rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-lavender/70"
        onMouseEnter={() => onHover?.(realm.id)}
        onMouseLeave={() => onHover?.(null)}
        onFocus={() => onHover?.(realm.id)}
        onBlur={() => onHover?.(null)}
        onClick={(e) => onSelect?.(e, realm)}
      >
        {/* the portal itself */}
        <div className="mx-auto w-[min(86vw,480px)] md:w-[86%]">
          <RealmStage realm={realm} active={focused} />
        </div>

        {/* identity block */}
        <div className="relative -mt-6 px-2 text-center md:text-left">
          <p className="text-[clamp(1rem,2.2vw,1.7rem)] font-display font-medium uppercase tracking-[0.38em] text-gold [text-shadow:0_0_24px_rgba(245,215,142,0.4)]">
            {realm.kicker}
          </p>
          <h3
            className={`mt-3 font-display text-[clamp(2.2rem,4.6vw,4.4rem)] leading-[0.98] tracking-[0.02em] transition-all duration-500 ${
              focused
                ? "text-crystal [text-shadow:0_0_34px_rgba(168,85,247,0.9)]"
                : "text-crystal/90"
            }`}
          >
            {realm.name}
          </h3>
          <div
            className={`hairline mx-auto mt-4 h-px transition-all duration-700 md:mx-0 ${
              focused ? "w-44 opacity-100" : "w-24 opacity-60"
            }`}
            aria-hidden
          />
          <p className="mt-4 text-[10px] uppercase tracking-[0.42em] text-crystal/55 transition-colors duration-500 group-hover:text-lavender">
            {realm.mantra}
          </p>
          <span
            className={`mt-7 inline-flex items-center gap-4 border px-6 py-3 text-[10px] uppercase tracking-[0.44em] transition-all duration-500 ${
              focused
                ? "border-lavender text-crystal shadow-[0_0_36px_rgba(124,58,237,0.55)]"
                : "border-lavender/35 text-crystal/75 group-hover:border-lavender group-hover:text-crystal"
            }`}
          >
            Enter
            <span aria-hidden className="text-lavender">
              →
            </span>
          </span>
        </div>
      </Link>
    </article>
  );
}