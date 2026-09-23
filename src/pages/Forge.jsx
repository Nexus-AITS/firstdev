import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import RealmFX from "../components/fx/RealmFX.jsx";
import RealmHeader from "../components/realm/RealmHeader.jsx";
import EventRow from "../components/realm/EventRow.jsx";
import { realms } from "../data/realms.js";
import { getEventsByRealm } from "../data/events.js";

export default function Forge() {
  const realm = realms.forge;
  const list = getEventsByRealm("forge");

  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <RealmFX mode={realm.fx} />
        <RealmHeader realm={realm} />

        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pb-28 md:px-10" aria-label="Technical events">
          <div className="mt-14 flex flex-col md:mt-20">
            {list.map((event, i) => (
              <EventRow key={event.id} event={event} index={i} />
            ))}
          </div>

          <Reveal delay={0.1}>
            <p className="mt-16 text-center text-[10px] uppercase tracking-[0.5em] text-crystal/40">
              Select an event to cross into the application
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