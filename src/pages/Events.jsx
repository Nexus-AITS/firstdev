import { useCallback, useEffect, useMemo, useState } from "react";
import Page from "../components/ui/Page.jsx";
import RealmFX from "../components/fx/RealmFX.jsx";
import RealmStation from "../components/events/RealmStation.jsx";
import RealmIntro from "../components/events/RealmIntro.jsx";
import { realmList } from "../data/realms.js";
import { useRealmEntry } from "../context/RealmEntryContext";
import usePrefersReducedMotion from "../hooks/usePrefersReducedMotion";

/**
 * Realm gateway — three massive crystalline portals suspended in the NEXUS.
 *
 * Cinematic staging:
 *  1. near-darkness reveal (RealmIntro) with staggered typography
 *  2. asymmetric depth composition (no equal 3-column grid)
 *  3. hover dominance — focused realm brightens, others fade + desaturate,
 *     environment tint follows the focused realm
 *  4. camera-through-crystal entry via RealmEntryContext
 */

// desktop composition: depth-staggered, deliberately asymmetric
const LAYOUT = [
  "mb-24 md:mb-0 md:absolute md:left-0 md:top-0 md:w-[44%]",
  "mb-24 md:mb-0 md:absolute md:left-[52%] md:top-[400px] md:w-[42%]",
  "md:absolute md:left-[16%] md:top-[1040px] md:w-[42%]",
];

export default function Events() {
  const reduced = usePrefersReducedMotion();
  const { enterRealm } = useRealmEntry();
  const [intro, setIntro] = useState(reduced ? "done" : "dark");
  const [focused, setFocused] = useState(null);

  useEffect(() => {
    if (intro !== "dark") return undefined;
    const t1 = setTimeout(() => setIntro("reveal"), 1500);
    const t2 = setTimeout(() => setIntro("done"), 3100);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [intro]);

  const ready = intro !== "dark";
  const focusedRealm = useMemo(
    () => realmList.find((r) => r.id === focused) ?? null,
    [focused]
  );
  const fxMode = focusedRealm?.fx ?? "stars";

  const handleHover = useCallback((id) => setFocused(id), []);

  const handleSelect = useCallback(
    (e, realm) => {
      // let modified clicks fall through to the browser / router
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = e.clientX || rect.left + rect.width / 2;
      const cy = e.clientY || rect.top + rect.height / 2;
      e.preventDefault();
      enterRealm(realm.route, {
        accent: realm.accent,
        x: cx / Math.max(1, window.innerWidth),
        y: cy / Math.max(1, window.innerHeight),
      });
    },
    [enterRealm]
  );

  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        {/* environment: nebula, realm-tinted veil, particles, fog */}
        <RealmFX mode={fxMode} tint={focusedRealm?.accent ?? "#7c3aed"} />

        {/* opening sequence */}
        <RealmIntro phase={intro} />

        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pb-32 pt-36 md:px-10 md:pt-44">
          {/* staged typography: WELCOME -> THREE REALMS -> CHOOSE */}
          <div className="flex flex-col items-center text-center">
            <p
              className={`mb-6 text-[10px] font-medium uppercase tracking-[0.55em] text-lavender/70 transition-all duration-1000 ${
                ready ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
              }`}
              style={{ transitionDelay: "150ms" }}
            >
              Nexus // Realm gateway
            </p>
            <h1
              className={`font-display text-[clamp(2.3rem,6.4vw,5.6rem)] leading-[1.04] tracking-[0.06em] text-crystal text-glow transition-all duration-[1200ms] ${
                ready ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
              }`}
              style={{ transitionDelay: "320ms" }}
            >
              WELCOME TO THE NEXUS
            </h1>
            <div
              className={`mt-7 transition-all duration-[1100ms] ${
                ready ? "translate-y-0 opacity-100" : "translate-y-5 opacity-0"
              }`}
              style={{ transitionDelay: "780ms" }}
            >
              <p className="font-display text-[clamp(1.05rem,2.3vw,1.8rem)] leading-relaxed tracking-[0.22em] text-lavender">
                THREE REALMS.
              </p>
              <p className="mt-2 font-display text-[clamp(1.05rem,2.3vw,1.8rem)] leading-relaxed tracking-[0.22em] text-crystal/85">
                COUNTLESS POSSIBILITIES.
              </p>
            </div>
            <div
              className={`mt-9 flex flex-col items-center gap-4 transition-all duration-[1100ms] ${
                ready ? "translate-y-0 opacity-100" : "translate-y-5 opacity-0"
              }`}
              style={{ transitionDelay: "1240ms" }}
            >
              <div className="hairline w-48 md:w-72" aria-hidden />
              <p className="text-[10px] font-medium uppercase tracking-[0.5em] text-crystal/55">
                Choose your realm
              </p>
            </div>
          </div>


          {/* asymmetric portal composition */}
          <div className="relative mt-16 md:mt-24 md:min-h-[2060px]">
            {/* distant crystalline silhouettes — depth layers */}
            <div
              aria-hidden
              className="pointer-events-none absolute left-[6%] top-[620px] hidden h-[420px] w-[300px] rotate-12 bg-[radial-gradient(ellipse_at_center,rgba(124,58,237,0.16),transparent_70%)] blur-2xl md:block"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute right-[4%] top-[120px] hidden h-[380px] w-[300px] -rotate-12 bg-[radial-gradient(ellipse_at_center,rgba(216,180,254,0.1),transparent_70%)] blur-2xl md:block"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t from-void to-transparent"
            />

            {realmList.map((realm, i) => (
              <RealmStation
                key={realm.id}
                realm={realm}
                index={i}
                ready={ready}
                focused={focused === realm.id}
                dimmed={focused !== null && focused !== realm.id}
                onHover={handleHover}
                onSelect={handleSelect}
                className={LAYOUT[i]}
              />
            ))}
          </div>

          <p
            className={`mt-16 text-center text-[10px] uppercase tracking-[0.5em] text-crystal/40 transition-opacity duration-1000 md:mt-8 ${
              ready ? "opacity-100" : "opacity-0"
            }`}
          >
            Select a realm to cross the threshold
          </p>
        </section>
      </div>
    </Page>
  );
}
