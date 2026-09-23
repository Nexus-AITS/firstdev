import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import RealmFX from "../components/fx/RealmFX.jsx";
import RealmHeader from "../components/realm/RealmHeader.jsx";
import ArenaRow from "../components/realm/ArenaRow.jsx";
import { realms } from "../data/realms.js";
import { getEventsByRealm } from "../data/events.js";

export default function Arena() {
  const realm = realms.arena;
  const list = getEventsByRealm("arena");

  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <RealmFX mode={realm.fx} />
        <RealmHeader realm={realm} />

        {/* protocol strip */}
        <Reveal delay={0.2}>
          <div className="relative z-10 mx-auto mt-10 max-w-[1680px] px-5 md:px-10">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-violet-bright/25 py-3 text-[9px] uppercase tracking-[0.36em] text-lavender/80 md:text-[10px]">
              <span>Arena protocol // season 01</span>
              <span aria-hidden className="hidden h-3 w-px bg-lavender/30 md:block" />
              <span>{list.length} titles</span>
              <span aria-hidden className="hidden h-3 w-px bg-lavender/30 md:block" />
              <span>Double elimination</span>
              <span aria-hidden className="hidden h-3 w-px bg-lavender/30 md:block" />
              <span className="text-gold/90">Streamed on the arena wall</span>
            </div>
          </div>
        </Reveal>

        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pb-28 pt-12 md:px-10 md:pt-16" aria-label="Esports titles">
          <div className="flex flex-col gap-4 md:gap-5">
            {list.map((event, i) => (
              <ArenaRow key={event.id} event={event} index={i} />
            ))}
          </div>

          <Reveal delay={0.1}>
            <p className="mt-14 text-center text-[10px] uppercase tracking-[0.5em] text-crystal/40">
              Pick your title — the bracket is waiting
            </p>
          </Reveal>

          <Reveal delay={0.16}>
            <div className="mt-10 flex justify-center">
              <CinematicButton to="/events" arrow="left">
                Return to all events
              </CinematicButton>
            </div>
          </Reveal>
        </section>
      </div>
    </Page>
  );
}