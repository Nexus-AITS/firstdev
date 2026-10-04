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
 * Browsable two ways, because a brief is filed under BOTH an event and a category
 * and a reader usually arrives knowing only one of them: a team that has registered
 * for NEXUS BREACH wants that event's briefs, and a team with no idea which event
 * it is entering wants everything filed under SUSTAINABILITY. Both filters are
 * applied by the database (public_problem_statements takes an event and a
 * category), not in the browser.
 *
 * The event filter offers only events that actually HAVE a brief, and the category
 * filter only categories that exist — each carrying the count of what picking it
 * would leave you with, counted against the OTHER filter. That is what stops a
 * reader choosing an event and a category with nothing between them and landing on
 * an empty page: the combination is offered greyed out rather than offered at all.
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
  const [state, setState] = useState({
    status: "loading",
    statements: [],
    events: [],
    tracks: [],
    error: null,
  });
  const [eventId, setEventId] = useState("");
  const [track, setTrack] = useState("");

  // `events` is kept from the unfiltered response rather than re-fetched per
  // selection, so switching the filter is instant and never flashes "no events".
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, status: "loading" }));
    loadPublicProblemStatements(eventId || null, track || null).then((result) => {
      if (!alive) return;
      if (result.ok) {
        setState({
          status: "ready",
          statements: result.statements,
          events: result.events,
          tracks: result.tracks,
          error: null,
        });
      } else {
        setState({ status: "error", statements: [], events: [], tracks: [], error: result.error });
      }
    });
    return () => {
      alive = false;
    };
  }, [eventId, track]);

  /* The count beside each option is FACETED by the other filter, so a zero means
     "nothing here with what you have already chosen". Those options are disabled
     rather than hidden: visible-but-unavailable tells the reader the combination
     exists and is empty, which is the difference between "I filtered it away" and
     "it was never there".

     The option ALREADY selected is never disabled, even at zero. Disabling the
     reader's current choice would leave a dropdown asserting that its own value
     cannot be selected, and would make the way out "pick something else" rather
     than "clear the filter". */
  const options = useMemo(
    () => [
      { value: "", label: "All events" },
      ...state.events.map((e) => ({
        value: e.id,
        label: `${e.title} (${e.count})`,
        disabled: e.id !== eventId && e.count === 0,
      })),
    ],
    [state.events, eventId]
  );

  const trackOptions = useMemo(
    () => [
      { value: "", label: "All categories" },
      ...state.tracks.map((t) => ({
        // `name` is the lowercased category — stable across responses, so the
        // control keeps its selection when the other filter changes the rows.
        value: t.name,
        label: `${t.label} (${t.count})`,
        disabled: t.name !== track && t.count === 0,
      })),
    ],
    [state.tracks, track]
  );

  // Filtered here rather than by asking the database again. The whole list is
  // already in memory — a handful of briefs, not a roster — so a second round trip
  // per click would be latency for nothing.
  /* Nothing to choose between is not a control: a dropdown offering one real
     option can only ever return that option, and reads as a broken filter. */
  const showEventFilter = state.events.length > 1;
  const showTrackFilter = state.tracks.length > 1;

  const visible = state.statements;
  /* "Nothing published yet" and "your filter matched nothing" need different
     replies from the reader, so the page has to know whether it is filtering. */
  const filtered = Boolean(eventId || track);

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
          {/* The filters only appear when there is something to choose between.
              One option rendered as a dropdown is a dropdown that can only ever
              return its own value.

              Two of them, because a brief is filed under BOTH an event and a
              category and a reader usually knows only one of the two. They sit side
              by side rather than stacked so the pair reads as one control, and each
              carries the count of what it would leave you with. */}
          {state.status === "ready" && (showEventFilter || showTrackFilter) ? (
            <div className="mb-8 flex flex-col items-center justify-center gap-4 sm:flex-row sm:gap-5">
              {showEventFilter ? (
                <div className="w-full max-w-[16rem]">
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
              ) : null}

              {showTrackFilter ? (
                <div className="w-full max-w-[16rem]">
                  <label
                    className="block text-center font-mono text-[10px] uppercase tracking-[0.3em] text-ash"
                    htmlFor="statement-track-filter"
                  >
                    Category
                  </label>
                  <Select
                    id="statement-track-filter"
                    className="mt-2"
                    value={track}
                    onChange={(v) => setTrack(v ?? "")}
                    options={trackOptions}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          <h2 className="sr-only">All problem statements</h2>

          {/* Only on the FIRST load. Every filter change also sets `status` to loading, and
              blanking the list to a spinner on each click turns two dropdowns into
              something that flickers. On a refetch the current briefs stay put and
              the region is marked busy instead. */}
          {state.status === "loading" && state.statements.length === 0 ? (
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
            /* Three different situations, three different replies.
               "Nothing published yet" is an absence of content and the operator's
               to fix. "No brief matches" is the READER's filter and is their to
               undo, so it gets a button that undoes it rather than a sentence
               telling them to go and choose something else. */
            <p className="border border-line px-5 py-8 text-center">
              <span className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
                {filtered ? "No brief matches" : "Nothing published yet"}
              </span>
              <span className="mt-4 block text-sm leading-relaxed text-crystal/60">
                {filtered
                  ? "That event and category have no brief between them. Clear the filter to see everything that has been published."
                  : "Problem statements have not been published yet. The event pages still carry each event's description."}
              </span>
              {filtered ? (
                <button
                  type="button"
                  onClick={() => {
                    setEventId("");
                    setTrack("");
                  }}
                  className="mt-6 border border-line px-5 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-lavender transition hover:border-lavender/60"
                >
                  Clear filters
                </button>
              ) : null}
            </p>
          ) : null}

          {/* The list stays rendered while a refetch is in flight, dimmed and marked busy.
             aria-busy is the honest signal: a screen reader is told the region is
             being updated instead of being handed a stale list as if it were final. */}
          {visible.length > 0 ? (
            <ul
              className="grid gap-5 transition-opacity duration-200"
              data-action="statement-list"
              aria-busy={state.status === "loading" ? "true" : undefined}
              style={state.status === "loading" ? { opacity: 0.55 } : undefined}
            >
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