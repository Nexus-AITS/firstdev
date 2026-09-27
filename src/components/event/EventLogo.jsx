import { useState } from "react";

/**
 * An event's logo.
 *
 * Events are recognisable by mark as much as by name — "the game one" — so an
 * event can declare `logo: "<file>"` in events.js and this renders
 * `<origin>/logos/<file>.svg`.
 *
 * Two decisions worth keeping:
 *
 * 1. Same-origin only. The CSP is `img-src 'self' data: blob:
 *    https://*.googleusercontent.com` (public/_headers, vercel.json,
 *    vite.config.js), so a hotlinked logo from a game's CDN would be BLOCKED in
 *    production while working fine on localhost. Anything that must render lives
 *    in public/logos.
 *
 * 2. A missing file falls back to a rendered wordmark instead of a broken-image
 *    icon. Deleting the asset then degrades to "the title in a plate" rather
 *    than to a hole in the page — and a swapped-in official file needs no
 *    component change at all.
 */
function Wordmark({ title, className = "" }) {
  return (
    <span
      data-event-logo="fallback"
      className={`inline-flex items-center gap-3 border border-lavender/40 bg-[linear-gradient(120deg,rgba(124,58,237,0.22),rgba(10,5,20,0.7))] px-5 py-3 ${className}`}
    >
      <span
        aria-hidden
        className="h-8 w-1.5 rotate-45 bg-gradient-to-b from-gold/80 to-violet-bright/80"
      />
      <span className="font-display text-[clamp(0.9rem,1.6vw,1.2rem)] uppercase tracking-[0.34em] text-crystal">
        {title}
      </span>
    </span>
  );
}

export default function EventLogo({ logo, title, className = "" }) {
  const [missing, setMissing] = useState(false);

  if (!logo || missing) {
    return <Wordmark title={title} className={className} />;
  }

  return (
    <img
      src={`${import.meta.env.BASE_URL}logos/${logo}.svg`}
      alt={`${title} logo`}
      data-event-logo={logo}
      onError={() => setMissing(true)}
      className={`h-auto w-full max-w-[420px] ${className}`}
    />
  );
}
