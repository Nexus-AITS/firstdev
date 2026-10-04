/**
 * /announcements — what the team needs to say, in the order it matters.
 *
 * Nothing here is written in this file. Every notice is a row in
 * public.announcements, created from the console's Announcements tab, because an
 * announcement typed into a React component is one nobody remembers to update the
 * morning of the event. The page is therefore a renderer with no content of its
 * own: retire every row and it says so plainly rather than quietly showing last
 * year's notice.
 *
 * Pinned notices come first, then newest. A pin is a claim about importance, so it
 * outranks recency — otherwise pinning a schedule change and then posting an
 * unrelated note tomorrow would bury the thing that was pinned.
 */
import { useEffect, useState } from "react";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import { loadPublicAnnouncements } from "../data/staff.js";

/**
 * "2026-10-03T14:00:00Z" -> "3 OCTOBER 2026".
 *
 * Rendered in UTC deliberately. The site's own dates come out of the database as
 * IST-anchored strings ("OCT 5, 2026"), so formatting the timestamp in the
 * viewer's own zone would show an announcement published at 9am IST as the
 * PREVIOUS day for anybody west of Greenwich. The day is the fact here; the hour
 * is not, and a notice that changes day when you cross a timezone is a notice
 * people stop trusting.
 */
function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d
    .toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    })
    .toUpperCase();
}

/**
 * A href that is safe to put on the page.
 *
 * A javascript: URL stored in the database and rendered into an href is stored
 * XSS, and "only admins can write this" is exactly the assumption that gets
 * tested. Anything that is not http(s), mailto or a site-relative path renders as
 * no link at all — the text still shows, which is the honest outcome.
 */
function safeHref(href) {
  const trimmed = String(href ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  return null;
}

function AnnouncementCard({ item }) {
  const href = safeHref(item.link_href);
  const date = formatDate(item.published_at ?? item.created_at);
  return (
    <li
      className={`border bg-void-raised/60 p-6 transition hover:border-violet-bright/50 ${
        item.is_pinned ? "border-lavender/50" : "border-line"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        {item.is_pinned ? (
          <span className="border border-lavender/50 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.25em] text-lavender">
            Pinned
          </span>
        ) : null}
        {item.tag ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-lavender/70">
            {item.tag}
          </span>
        ) : null}
        {date ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-ash">{date}</span>
        ) : null}
      </div>

      <h2 className="mt-3 font-display text-2xl leading-tight tracking-[0.1em] text-crystal">
        {item.title}
      </h2>

      {item.body ? (
        /* whitespace-pre-line, not dangerouslySetInnerHTML: the body is TEXT an
           operator wrote, and it is rendered as text. That is a deliberate ceiling
           on the feature — no bold, no links in the copy — and it is what makes it
           impossible for one announcement to carry script into every reader's
           page. */
        <p className="mt-4 whitespace-pre-line text-sm leading-[1.9] text-crystal/70">
          {item.body}
        </p>
      ) : null}

      {/* Label and destination render only when the href survived safeHref. The
          database already refuses half a link; this is the second line of defence
          for a row written before that constraint existed. */}
      {href && item.link_label ? (
        <a
          href={href}
          className="mt-5 inline-block font-mono text-[11px] uppercase tracking-[0.2em] text-lavender underline-offset-4 transition hover:text-crystal hover:underline"
        >
          {item.link_label} →
        </a>
      ) : null}
    </li>
  );
}

export default function Announcements() {
  const [state, setState] = useState({ status: "loading", announcements: [], error: null });

  useEffect(() => {
    let alive = true;
    loadPublicAnnouncements().then((result) => {
      if (!alive) return;
      if (result.ok) setState({ status: "ready", announcements: result.announcements, error: null });
      else setState({ status: "error", announcements: [], error: result.error });
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pt-40 text-center md:px-10 md:pt-52">
          <h1 className="font-display text-[clamp(2.6rem,9vw,7rem)] font-medium leading-[1.02] tracking-[0.08em] text-crystal text-glow-soft">
            <Reveal>
              <span className="block">ANNOUNCE</span>
            </Reveal>
            <Reveal delay={0.12}>
              <span className="block italic text-lavender text-glow">MENTS</span>
            </Reveal>
          </h1>
          <Reveal delay={0.3}>
            <div className="hairline mx-auto mt-12 w-52 md:w-80" aria-hidden />
            <p className="mx-auto mt-10 max-w-2xl text-[15px] leading-[2] tracking-wide text-crystal/65">
              Schedule changes, published results, and anything else the team needs to say —
              newest first, with anything pinned kept at the top until it is taken down.
            </p>
          </Reveal>
        </section>

        <section className="relative z-10 mx-auto mt-20 max-w-[900px] px-5 pb-32 md:px-10">
          <h2 className="sr-only">All announcements</h2>

          {state.status === "loading" ? (
            <p
              aria-live="polite"
              className="border border-line px-5 py-6 text-center font-mono text-[11px] uppercase tracking-[0.3em] text-ash"
            >
              Loading announcements…
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

          {state.status === "ready" && state.announcements.length === 0 ? (
            /* Not an error and not a crash: nothing has been published yet. Say
               that, rather than rendering an empty box that reads as a broken
               page. */
            <p className="border border-line px-5 py-8 text-center">
              <span className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
                Nothing to announce
              </span>
              <span className="mt-4 block text-sm leading-relaxed text-crystal/60">
                There are no announcements right now. Event dates, venue and registration
                details live on each event&apos;s own page.
              </span>
            </p>
          ) : null}

          {state.status === "ready" && state.announcements.length > 0 ? (
            <ul className="grid gap-5" data-action="announcement-list">
              {state.announcements.map((item) => (
                <AnnouncementCard key={item.id} item={item} />
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </Page>
  );
}