import Reveal from "../ui/Reveal.jsx";
import CinematicButton from "../ui/CinematicButton.jsx";
import { describeInclude, getPickPool } from "../../data/bundles.js";

// notched shard silhouette — matches the Off-Grid card language
const CLIP =
  "polygon(0 0, calc(100% - 26px) 0, 100% 26px, 100% 100%, 26px 100%, 0 calc(100% - 26px))";

/** One payment-bundle offer: number + name, price, inclusions, claim CTA. */
export default function BundleCard({ bundle, index = 0 }) {
  return (
    <Reveal delay={0.06 * (index % 3)} className="h-full">
      <article
        className="group relative h-full overflow-hidden transition-transform duration-700 ease-out hover:-translate-y-1"
        style={{ clipPath: CLIP }}
      >
        <div className="glass-panel relative flex h-full flex-col px-6 py-8 transition-colors duration-500 group-hover:border-lavender/25 md:px-8 md:py-9">
          <span
            aria-hidden
            className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gold/50 to-transparent opacity-60"
          />
          <span
            aria-hidden
            className="absolute inset-0 opacity-0 transition-opacity duration-700 group-hover:opacity-100"
            style={{
              background:
                "radial-gradient(70% 100% at 8% 50%, rgba(124,58,237,0.2), transparent 70%)",
            }}
          />

          {/* number — name */}
          <div className="relative flex items-center gap-3">
            <span className="text-[11px] tracking-[0.4em] text-gold/85">
              {bundle.number}
            </span>
            <span aria-hidden className="h-px flex-1 bg-gold/25" />
            <span className="font-display text-[13px] font-medium uppercase tracking-[0.28em] text-gold/90 [text-shadow:0_0_18px_rgba(245,215,142,0.35)]">
              {bundle.name}
            </span>
          </div>

          {/* price */}
          <p className="relative mt-5 flex flex-wrap items-baseline gap-x-2 gap-y-1 font-display text-crystal">
            <span className="flex items-baseline">
              <span className="text-[clamp(1.3rem,2.2vw,1.8rem)] text-lavender">
                ₹
              </span>
              <span className="text-[clamp(2.8rem,4.6vw,3.9rem)] font-medium leading-none text-glow">
                {bundle.price}
              </span>
            </span>
            <span className="text-[10px] font-medium uppercase tracking-[0.4em] text-crystal/45">
              per bundle
            </span>
          </p>

          {/* inclusions */}
          <ul className="relative mt-6 flex flex-col gap-3 border-t border-white/10 pt-6">
            {bundle.includes.map((item, i) => {
              const pool = item.pick ? getPickPool(item) : null;
              return (
                <li
                  key={`${describeInclude(item)}-${i}`}
                  className="flex items-start gap-3"
                >
                  <span
                    aria-hidden
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rotate-45 bg-violet-bright shadow-[0_0_10px_rgba(168,85,247,0.9)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-[11px] font-medium uppercase leading-relaxed tracking-[0.16em] text-crystal/75">
                      {describeInclude(item)}
                    </span>
                    {pool ? (
                      <span className="mt-1 block text-[9px] uppercase leading-relaxed tracking-[0.18em] text-crystal/35">
                        {pool.map((event) => event.title).join(" · ")}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="relative mt-auto pt-7">
            <CinematicButton to={`/register?bundle=${bundle.id}`} className="w-full">
              Claim this bundle
            </CinematicButton>
          </div>
        </div>
      </article>
    </Reveal>
  );
}