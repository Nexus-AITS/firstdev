/**
 * /contact — how to reach NEXUS.
 *
 * The addresses on this page are NOT written here. They are rows in
 * public.contacts, created from the console's Contacts tab, because a phone
 * number hardcoded in a React component is a phone number that is still wrong
 * six months later. The page is therefore a renderer with no content of its
 * own: retire every row and this page says so plainly instead of quietly
 * showing a stale number.
 *
 * Each row carries its own PURPOSE ("payment issues", "event queries") so a
 * participant can tell which channel to use instead of picking at random — and
 * so the operations team can retire one channel and leave the rest standing.
 */
import { useEffect, useState } from "react";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import { loadPublicContacts } from "../data/staff.js";

/**
 * A `tel:` href has to be a real dial string: `tel:+91 98765 43210` is rejected or
 * silently truncated by a good share of handsets, so the spaces, brackets and
 * dashes a human uses to read the number are dropped.
 *
 * The leading + is KEPT ONLY if the operator typed one. Inventing it would be a
 * guess about a country code: a value entered as "9000000000" would dial
 * "+9000000000", which is not that number anywhere. What was typed is what
 * dials — the operator is the one who knows whether to write the country code.
 * Returns null when there is nothing dialable, so the caller falls back to plain
 * text rather than emitting a dead link.
 */
function telHref(value) {
  const trimmed = String(value ?? "").trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  return `tel:${hasPlus ? "+" : ""}${digits}`;
}


/**
 * A mailto: that pre-fills the subject and body, because "which event?" is the
 * first question the team asks and the participant's answer to it is free to
 * attach here.
 */
function mailtoHref(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed.includes("@")) return null;
  const subject = encodeURIComponent("NEXUS — registration query");
  const body = encodeURIComponent("Event: \nRegistration ID: \nWhat I need help with: ");
  return `mailto:${trimmed}?subject=${subject}&body=${body}`;
}

function hrefFor(contact) {
  if (contact.kind === "phone") return telHref(contact.value);
  if (contact.kind === "email") return mailtoHref(contact.value);
  if (contact.kind === "website") {
    const trimmed = String(contact.value ?? "").trim();
    if (!trimmed) return null;
    // A bare "nexus.example" is not a URL. Add the scheme rather than handing
    // the browser a string it will resolve against the current page.
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }
  return null;
}

const KIND_LABEL = {
  email: "Email",
  phone: "Phone",
  website: "Web",
  text: "Text",
};

function ChannelCard({ contact }) {
  const href = hrefFor(contact);
  return (
    <li className="flex flex-col justify-between border border-line bg-void-raised/60 p-6 transition hover:border-violet-bright/50">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-lavender/70">
          {KIND_LABEL[contact.kind] ?? "Contact"}
        </p>
        <h3 className="mt-3 font-display text-xl tracking-[0.12em] text-crystal">
          {contact.label}
        </h3>
        {contact.purpose ? (
          <p className="mt-3 text-sm leading-relaxed text-crystal/60">{contact.purpose}</p>
        ) : null}
      </div>

      <div className="mt-6">
        {href ? (
          <a
            href={href}
            className="block break-words font-mono text-[15px] text-violet-bright underline decoration-violet-bright/30 underline-offset-4 transition hover:decoration-violet-bright"
          >
            {contact.value}
          </a>
        ) : (
          /* A "text" row (an office address) has nothing to dial or mail, so it
             is rendered as text rather than as a link that goes nowhere. */
          <span className="block break-words font-mono text-[15px] text-bone">
            {contact.value}
          </span>
        )}
        {contact.note ? (
          <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
            {contact.note}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export default function Contact() {
  const [state, setState] = useState({ status: "loading", contacts: [], error: null });

  useEffect(() => {
    let alive = true;
    loadPublicContacts().then((result) => {
      if (!alive) return;
      if (result.ok) setState({ status: "ready", contacts: result.contacts, error: null });
      else setState({ status: "error", contacts: [], error: result.error });
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pt-40 text-center md:px-10 md:pt-52">
          <h1 className="font-display text-[clamp(2.8rem,10vw,8rem)] font-medium leading-[1.02] tracking-[0.08em] text-crystal text-glow-soft">
            <Reveal>
              <span className="block">REACH</span>
            </Reveal>
            <Reveal delay={0.12}>
              <span className="block italic text-lavender text-glow">NEXUS</span>
            </Reveal>
          </h1>
          <Reveal delay={0.3}>
            <div className="hairline mx-auto mt-12 w-52 md:w-80" aria-hidden />
            <p className="mx-auto mt-10 max-w-2xl text-[15px] leading-[2] tracking-wide text-crystal/65">
              Payments, seats, team changes, a rule you think is wrong, or just a question
              before you register — every channel below reaches the operations team. Quote your
              event name and registration ID if you have one, and the answer lands in one reply
              instead of four.
            </p>
          </Reveal>
        </section>

        <section className="relative z-10 mx-auto mt-20 max-w-[1100px] px-5 pb-32 md:px-10">
          <h2 className="sr-only">Contact channels</h2>

          {state.status === "loading" ? (
            <p
              aria-live="polite"
              className="border border-line px-5 py-6 text-center font-mono text-[11px] uppercase tracking-[0.3em] text-ash"
            >
              Loading contact channels…
            </p>
          ) : null}

          {state.status === "error" ? (
            <p
              role="alert"
              className="border border-red-400/40 bg-red-500/10 px-5 py-6 text-center text-sm text-red-200"
            >
              {state.error} In the meantime, the event pages carry the same details as the event
              they belong to.
            </p>
          ) : null}

          {state.status === "ready" && state.contacts.length === 0 ? (
            /* Not an error and not a crash: nobody has published a channel yet.
               Say that, rather than rendering an empty box that reads as a
               broken page. */
            <p className="border border-line px-5 py-8 text-center">
              <span className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
                Nothing published yet
              </span>
              <span className="mt-4 block text-sm leading-relaxed text-crystal/60">
                No contact channel has been published for NEXUS yet. If the fest is close, the
                registration form&apos;s own confirmation message is the fastest way to reach the
                desk.
              </span>
            </p>
          ) : null}

          {state.status === "ready" && state.contacts.length > 0 ? (
            <ul className="grid gap-5 md:grid-cols-2" data-action="contact-list">
              {state.contacts.map((contact, i) => (
                <ChannelCard key={contact.id ?? `${contact.kind}-${i}`} contact={contact} />
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </Page>
  );
}
