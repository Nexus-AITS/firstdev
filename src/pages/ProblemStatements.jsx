/**
 * /problem-statements — the brief each hackathon team reads.
 *
 * Owned by the operations team, not by a developer, for the same reason the
 * contact page is: a problem statement that lives in a React component is one that
 * is wrong the first time a judge edits it and nobody can find the file. Every
 * brief is a row in public.problem_statements, written from the console's Problem
 * statements tab, and this page renders whatever the database says — including
 * nothing at all, which it says plainly rather than showing an empty frame.
 *
 * The event filter offers only events that actually HAVE a brief. That is computed
 * in the database (public_problem_statements returns the distinct events alongside
 * the briefs) so choosing an event can never produce a blank page.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import Select from "../components/ui/Select.jsx";
import { loadPublicProblemStatements } from "../data/staff.js";

function StatementCard({ item }) {
  return (
    <li
      className="border border-line bg-void-raised/60 p-6 transition hover:border-violet-bright/50"
      data-action="problem-statement"
    >
      <div className="flex flex-wrap items-center gap-3">
        {item.event_title ? (
          /* A link to the event, because the brief and the event page disagree
             often enough that a reader should be able to check. Rendered only when
             the slug still resolves — public_problem_statements resolves the title
             server-side, so a retired event yields no label and no dead link. */
          <Link
            to={`/events/${item.event_slug}`}
            className="font-mono text-[10px] uppercase tracking-[0.3em] text-lavender/80 transition hover:text-lavender"
          >
            {item.event_title}
          </Link>
        ) : null}
        {item.event_date ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-ash">
            {item.event_date}
          </span>
        ) : null}
        {item.track ? (
          <span className="border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.25em] text-crystal/60">
            {item.track}
          </span>
        ) : null}
      </div>

      <h2 className="mt-3 font-display text-2xl leading-tight tracking-[0.1em] text-crystal">
        {item.title}
      </h2>

      {item.summary ? (
        <p className="mt-4 text-sm leading-[1.9] text-crystal/70">{item.summary}</p>
      ) : null}

      {/* Plain text again, not HTML. A brief is prose a team reads and builds from;
           it has no need of markup, and rendering an operator's string as markup is
           the whole class of bug this codebase has been bitten by twice. */}
      {item.detail ? (
        <p className="mt-4 whitespace-pre-line border-t border-line pt-4 text-sm leading-[1.9] text-crystal/60">
          {item.detail}
        </p>
      ) : null}
    </li>
  );
}

export default function ProblemStatements() {
  const [state, setState] = useState({ status: "loading", statements: [], events: [], error: null });
  const [eventId, setEventId] = useState("");

  // `events` is kept from the unfiltered response rather than re-fetched per
  // selection, so switching the filter is instant and never flashes "no events".
  useEffect(() => {
    let alive = true;
    loadPublicProblemStatements(null).then((result) => {
      if (!alive) return;
      if (result.ok) {
        setState({ status: "ready", statements: result.statements, events: result.events, error: null });
      } else {
        setState({ status: "error", statements: [], events: [], error: result.error });
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const options = useMemo(
    () => [
      { value: "", label: "All events" },
      ...state.events.map((e) => ({ value: e.id, label: e.title })),
    ],
    [state.events]
  );

  // Filtered here rather than by asking the database again. The whole list is
  // already in memory — a handful of briefs, not a roster — so a second round trip
  // per click would be latency for nothing.
  const visible = useMemo(
    () => (eventId ? state.statements.filter((s) => s.event_id === eventId) : state.statements),
    [state.statements, eventId]
  );

  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pt-40 text-center md:px-10 md:pt-52">
          <h1 className="font-display text-[clamp(2.4rem,8.5vw,6.5rem)] font-medium leading-[1.02] tracking-[0.07em] text-crystal text-glow-soft">
            <Reveal>
              <span className="block">PROBLEM</span>
            </Reveal>
            <Reveal delay={0.12}>
              <span className="block italic text-lavender text-glow">STATEMENTS</span>
            </Reveal>
          </h1>
          <Reveal delay={0.3}>
            <div className="hairline mx-auto mt-12 w-52 md:w-80" aria-hidden />
            <p className="mx-auto mt-10 max-w-2xl text-[15px] leading-[2] tracking-wide text-crystal/65">
              What each event asks you to build, written by the team that runs it. Read the
              brief, pick the track, and ask at the desk if something is unclear — the
              wording below is the same wording the judges score against.
            </p>
          </Reveal>
        </section>

        <section className="relative z-10 mx-auto mt-16 max-w-[1000px] px-5 pb-32 md:px-10">
          {/* The filter only appears when there is something to choose between.
              One option rendered as a dropdown is a dropdown that can only ever
              return its own value. */}
          {state.status === "ready" && state.events.length > 1 ? (
            <div className="mb-8 flex justify-center">
              <div className="w-full max-w-xs">
                <label
                  className="block text-center font-mono text-[10px] uppercase tracking-[0.3em] text-ash"
                  htmlFor="statement-event-filter"
                >
                  Event
                </label>
                <Select
                  id="statement-event-filter"
                  className="mt-2"
                  value={eventId}
                  onChange={(v) => setEventId(v ?? "")}
                  options={options}
                />
              </div>
            </div>
          ) : null}

          <h2 className="sr-only">All problem statements</h2>

          {state.status === "loading" ? (
            <p
              aria-live="polite"
              className="border border-line px-5 py-6 text-center font-mono text-[11px] uppercase tracking-[0.3em] text-ash"
            >
              Loading problem statements…
            </p>
          ) : null}

          {state.status === "error" ? (
            <p
              role="alert"
              className="border border-red-400/40 bg-red-500/10 px-5 py-6 text-center text-sm text-red-200"
            >
              {state.error}
            </p>
          ) : null}

          {state.status === "ready" && visible.length === 0 ? (
            /* Distinguishes "nothing published at all" from "this event has none",
               because the two need different replies from the reader and a single
               empty box cannot tell them apart. */
            <p className="border border-line px-5 py-8 text-center">
              <span className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
                {state.statements.length === 0 ? "Nothing published yet" : "No brief for this event"}
              </span>
              <span className="mt-4 block text-sm leading-relaxed text-crystal/60">
                {state.statements.length === 0
                  ? "Problem statements have not been published yet. The event pages still carry each event's description."
                  : "That event has no brief published. Pick another event, or check back before the event starts."}
              </span>
            </p>
          ) : null}

          {state.status === "ready" && visible.length > 0 ? (
            <ul className="grid gap-5" data-action="statement-list">
              {visible.map((item) => (
                <StatementCard key={item.id} item={item} />
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </Page>
  );
}