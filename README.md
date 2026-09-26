# NEXUS

A grand, cinematic, futuristic event-universe frontend.

> Black + Purple + Violet + Crystal White. Occasional gold energy inside important cores.

## Stack

- React 19 + Vite
- React Router 7
- Tailwind CSS 4
- GSAP + ScrollTrigger
- Lenis (smooth scroll)
- Three.js / React Three Fiber (procedural crystal core)
- Framer Motion

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build
npm run preview  # preview build
```

## Routes

| Route              | Page                        |
| ------------------ | --------------------------- |
| `/`                | Home gateway                |
| `/events`          | Realm selection             |
| `/events/forge`    | Technical realm             |
| `/events/paradox`  | Non-technical realm         |
| `/events/arena`    | Esports realm               |
| `/events/:eventId` | Event detail                |
| `/register`         | Registration wizard (details → payment QR → UTR) |
| `/gateway`          | Legacy hand-off → redirects to `/register` |
| `/auth/callback`    | Google sign-in landing      |
| `/ai`              | Nexus AI                    |
| `/about`           | About Nexus                 |
| `/bundled`         | Bundled passes              |
| `/admin`           | Admin console (unlinked)    |

## Data model (Supabase — connected)

The registration schema — **Name, Roll Number, College name, Year, Department,
Phone Number, Email, UTR number, Payment status** — lives in
`supabase/migrations/20260926000000_create_registrations.sql`
(with fake sample rows in `supabase/seed.sql` and full notes in
`docs/supabase-data-model.md`). It is **applied to the live project** via
`npm run db:migrate` (Management API + `SUPABASE_ACCESS_TOKEN` in `.env`).
Payments follow a **UTR verification flow**: the participant submits a UTR
number (`unverified` → "not verified"), then an admin confirms it
(`verified`); rejected UTRs can be re-submitted. RLS keeps **reads denied**;
the only API write path is the narrow anon `INSERT` policy in
`supabase/migrations/20260926000001_registration_policies.sql`, used by the
`/register` wizard (dual-write: local store first for `/admin`, then
best-effort sync to Supabase).

## Admin console (`/admin`)

An operations console at **`/admin`** — deliberately **not linked from the
navbar or footer**; open the URL directly. It provides:

- a **clear dashboard** — total participants, distinct colleges that
  participated, and payment-state counts (verified / to review / awaiting
  UTR / rejected);
- **all participant details** in one table — user id, name, contact, roll
  number, college, year · department, **UTR**, submission date and status,
  with search, status filters and a **sort select beside the search**
  (newest / oldest, name A–Z, college, status — action first);
- row actions — **Confirm** (admin confirms the UTR → status flips to
  `verified` with `payment_verified_at`/`payment_verified_by` audit stamps),
  **Reject**, and a two-step **Remove** participant.

It runs on `src/data/registrations.js`, a local mirror of the Supabase schema
whose functions map 1:1 to future Supabase calls (swap the internals when
keys land). **Authentication is a planned follow-up pass** — until it ships,
treat the `/admin` URL as private.

## Registration flow & external links

Every event's "Enter Event" CTA (and every bundle's "Claim" CTA) routes to
**`/register`** — an in-app wizard: **details → payment QR → UTR reference →
confirmation**. `/gateway` is kept as a legacy redirect so old links still
land in the wizard. Payment QR configuration (UPI id, payee) lives in
**`src/config/payment.js`** — set `PAYMENT_VPA` there and the QR renders from
the event's fee automatically.

Remaining external URLs live in **`src/config/eventLinks.js`** (used by the
Nexus AI hand-off). Replace `https://YOUR-REAL-APP-URL...` with the real
application — nothing else needs to change.

Event content lives in **`src/data/events.js`** (add/edit events there).

## Google sign-in (Supabase)

"Sign in with Google" is delegated to **Supabase Auth** (`provider: "google"`),
so the browser only talks to the Supabase project — the Google consent screen
is reached with a top-level redirect, never an iframe or third-party script.

- **Client:** `src/config/supabase.js` (env-driven) → **`src/context/AuthContext.jsx`**
  → `src/components/auth/` (`AuthControl`, `GoogleSignIn`, `ProfileChip`).
- **Routes:** sign-in lives in the navbar, the mobile menu and `/gateway`;
  `/auth/callback` narrates the PKCE `?code=` exchange and then continues to
  where the sign-in started (remembered in `sessionStorage`, one-shot).
- **Flow:** `flowType: "pkce"` + `detectSessionInUrl: true`, so Supabase swaps
  the code for a session automatically on the callback page load.

### Configure once per environment

1. **Supabase → Auth → URL Configuration**
   - Site URL: `https://nexus.n-events.tech`
   - Redirect URLs: `https://nexus.n-events.tech/auth/callback` **and**
     `http://localhost:5173/auth/callback` (the origin must match exactly, or
     the redirect is refused before it reaches the app).
2. **Google Cloud → OAuth 2.0 Client**
   - Authorized redirect URI: `https://xvteqcvvjlxhwijwxbbq.supabase.co/auth/v1/callback`
3. **Env vars** — copy `.env.example` → `.env` and fill in the anon /
   publishable key (Vite loads `.env` automatically; `.env.local` also works
   and takes precedence). On Vercel set the same two names in Project →
   Settings → Environment Variables. The anon key is public by design, but
   anything with a `VITE_` prefix is **inlined into the browser bundle** — a
   service-role key or the database connection string must never go there.

Without those env vars the site still builds and runs: every auth surface
degrades to a status line instead of a dead button (`isAuthConfigured`).

### Where the Supabase origin lives

`vite dev` and `vite preview` read `VITE_SUPABASE_URL` from `.env` and derive
the CSP origin from it (`vite.config.js`). `public/_headers` (Netlify /
Cloudflare) and `vercel.json` (the host in use) cannot read env vars, so those
two hardcode `https://xvteqcvvjlxhwijwxbbq.supabase.co`. Change the Supabase
project ⇒ update `.env`, `public/_headers` and `vercel.json`, or the browser
silently blocks the auth requests. `connect-src` covers the token calls and
`img-src` the Google avatars — **no** `accounts.google.com` script or frame is
needed, because the redirect flow means Google never runs on this page.

`npm run verify:google` asserts the navbar control really reaches Google
(`accounts.google.com`), which is the check that catches a redirect URL
missing from the Supabase allow list.

> Note: `public/_headers` (Netlify / Cloudflare) and `vercel.json` are *not*
> both honoured by any one host — Vercel only reads `vercel.json`. The SPA
> fallback is likewise mirrored as `public/_redirects` and the `vercel.json`
> rewrite, without which deep links 404 on a hard refresh.

## Accessibility & performance

- Keyboard navigation, visible focus states, semantic landmarks
- `prefers-reduced-motion` disables cinematic animation & smooth scroll
- WebGL fallback (CSS crystal), reduced particle density on mobile/tablet
- Canvas loops pause when the tab is hidden

## Verification

An automated Playwright suite lives at `verify.mjs`:

```bash
npm run build
npm run preview   # keep running on :4173
node verify.mjs   # uses system Chrome (channel: "chrome")
```

It checks all routes × desktop/mobile viewports for console errors and
horizontal overflow, the ENTER NEXUS transition (normal + reduced-motion),
realm-portal navigation, the mobile menu, keyboard focus order, that event
and bundle CTAs route into `/register` (with `/gateway` redirecting there),
and a full wizard pass — details form → payment QR → UTR submission → success
screen, including the row landing in the store `/admin` reads.

---

## Performance & security (built in)

- **Route-level code splitting** — every page except the landing hero is a
  `React.lazy` chunk, so the entry bundle no longer carries all ten pages.
- **WebGL off the critical path** — three.js (the largest dependency) loads
  behind `LazyCrystalCanvas` / `LazyRealmStage` with on-brand CSS fallbacks
  (nebula backdrop / faceted silhouette); first paint never waits for it.
- **Vendor chunks** — `react` / `three` / `gsap` / `motion` are split in
  `vite.config.js` for long-term caching.
- **Security headers** — CSP, `nosniff`, frame-deny, referrer and
  permissions policies are served by dev/preview via the
  `securityHeadersPlugin` in `vite.config.js` and mirrored for hosting in
  `public/_headers` (Netlify / Cloudflare Pages). Keep both in sync.
- **Dependency audit** — `npm audit` reports 0 vulnerabilities.
- **Compositor-friendly motion** — every keyframe animates only
  transform / opacity / clip-path / stroke-dashoffset; WebGL stages pause
  on hidden tabs and respect reduced-motion.
- **Production hygiene** — `console.log/debug/info` are stripped from
  production bundles (warn/error survive); external CTAs carry
  `rel="noopener noreferrer"`.
