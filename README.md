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
| `/nexus-admin`        | Operations console (unlinked) |

## Data model (Supabase — connected, and the source of truth)

The registration schema — **Name, Roll Number, College name, Year, Department,
Phone Number, Email, UTR number, Payment status** — lives in
`supabase/migrations/20260926000000_create_registrations.sql`, with ownership
and participant access control in `...0003_participant_rls_and_admin_users.sql`
and the staff system, audit trail and pricing in
`...0004_staff_roles_audit_and_pricing.sql`. Full notes in
`docs/supabase-data-model.md`; the phase reports are in `docs/phase-1-report.md`,
`docs/phase-2-report.md` and `docs/phase-3-report.md`. Applied to the live
project via `npm run db:migrate` (Management API + `SUPABASE_ACCESS_TOKEN` in
`.env`).

**There is no local mirror and no seed data.** The database holds only real
registrations, written by signed-in participants, and the operations console
reads straight from it.

Payments follow a **UTR verification flow**: the participant submits a UTR
number (`unverified` → "not verified"), then staff confirm it (`verified`);
rejected UTRs can be re-submitted by their author.

### Two separate identity systems

This is the part worth reading twice. Participants and staff authenticate
**completely differently**, and neither can become the other.

|                     | Participant                          | Staff                                    |
| ------------------- | ------------------------------------ | ---------------------------------------- |
| Signs in with        | Google OAuth                         | username + password — **no social login** |
| Database role        | `authenticated`                      | `anon` + `X-Nexus-Staff-Token`           |
| Lives in             | `auth.users` (Supabase Auth)         | `public.staff_users` / `staff_sessions`  |
| Session length       | Supabase-managed                     | **60 minutes, hard, server-enforced**   |

They share no table, no session and no token. A signed-in participant who opens
`/nexus-admin` gets the staff login form like anyone else, because the staff code
never reads the Supabase session.

Credentials are served at runtime by `api/config.js` from `SUPABASE_URL` /
`SUPABASE_ANON_KEY` — **no `VITE_` prefix**, so the anon key never lands in the
built bundle.

Access is enforced by **Row Level Security**, not by the pages:

| Role          | Roster                 | Audit log | Staff accounts | Pricing |
| ------------- | ---------------------- | --------- | -------------- | ------- |
| `coordinator` | read and search        | —         | —              | read    |
| `admin`       | read, confirm, reject  | read      | —              | read    |
| `master`      | + remove, manage staff, set prices | read | create/change | read + write |

A participant can register and correct **only their own** row. They can never
mark their own payment verified — a trigger refuses it.

Every staff action is recorded in `public.staff_audit_log` with **who, which
role, what, to which row, and when** — including before/after values. The log is
append-only and written by database *triggers*, so a client can neither omit an
entry nor edit one afterwards. It answers "who confirmed this participant, and
at what time" directly.

Create the first master account with:

```bash
npm run staff:bootstrap -- nexusadmin "a-long-passphrase" "Full Name"
```

That path works **only while no staff exist**, then closes permanently; from
then on a signed-in master adds the other tiers from the console's Staff tab, so
the addition lands in the audit log.

```bash
npm run verify:rls     # 30 checks — the participant model
npm run verify:staff   # 23 checks — staff login, 60-min expiry, 3 tiers, audit
```

Both run against the live database.

## Operations console (`/nexus-admin`)

An operations console at **`/nexus-admin`** — deliberately **not linked from the
navbar or footer**; open the URL directly. (`/admin123456789` redirects here so
an old bookmark still lands in the right place.) Four tabs, gated by role:

- **Roster** — every participant's details with search (name, email, roll number,
  college, UTR) and a status filter; **Confirm** and **Reject** for `admin` and
  above, **Remove** for `master` only.
- **Audit log** — the append-only history described above, filterable by action.
- **Staff** (master only) — add accounts, change roles, deactivate, and revoke
  every session for an account.
- **Pricing** (master only) — edit the bundle and event prices the public site
  renders, with no rebuild or redeploy.

**Sessions last 60 minutes and expire in the database**, not the browser — the
token is only a pointer to a session row, so there is nothing client-side to
extend. The countdown in the header is a courtesy; the server decides.

An unauthenticated visitor sees only the sign-in card: no roster markup, and no
social login button to press.

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
   publishable key. On Vercel set the same two names in Project → Settings →
   Environment Variables, ticking **Production**. They are `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` — **no `VITE_` prefix**, deliberately: a prefixed
   variable is compiled into the public bundle at build time, which pins the
   credential to a rebuild and leaves it in immutable CDN assets.

Without those env vars the site still builds and runs: every auth surface
degrades to a status line instead of a dead button (`isAuthConfigured`).

### Where the Supabase credentials come from

They are **fetched at runtime**, not compiled in. `api/config.js` is a Vercel
function that reads `SUPABASE_URL` / `SUPABASE_ANON_KEY` from the server
environment and returns them as JSON; `src/config/runtime-config.js` fetches
`GET /api/config` once per page load and memoises the result in
`sessionStorage`. `vite dev` / `vite preview` serve the same endpoint through
`runtimeConfigPlugin` in `vite.config.js`, so local behaviour matches prod.

Why: the anon key is public by design (it grants nothing beyond RLS), so this is
not about hiding it — it is about **rotatability**. Change the env var, redeploy
the function, and every open tab picks it up on its next load. No rebuild, no
stale asset. `api/config.js` also decodes the key and refuses to serve anything
whose role is not `anon`, so a fat-fingered service-role value fails loudly
instead of being published.

Two consequences worth knowing:

- **`/api/*` must not be SPA-rewritten.** `vercel.json` uses
  `/((?!api/).*)` so the function stays reachable; a catch-all would return
  `index.html` to `fetch()`, the config would parse as `null`, and auth would
  die with no error anywhere. `npm run verify:deploy` asserts this.
- **The CSP `connect-src` uses `https://*.supabase.co`**, in both
  `vercel.json` and `public/_headers`. A static header file cannot read the
  server environment, and the origin is no longer known at build time. The
  wildcard is broader than one project but grants no data access — RLS is the
  gate. `img-src` still needs `https://*.googleusercontent.com` for avatars, and
  **no** `accounts.google.com` script or frame, because the redirect flow means
  Google never runs on this page.

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

An automated Playwright suite lives at `scripts/verify.mjs`:

```bash
npm run build
npm run preview     # keep running on :4173
npm run verify      # node scripts/verify.mjs (system Chrome, channel: "chrome")
```

### Database checks (need `.env` with a `SUPABASE_ACCESS_TOKEN`)

```bash
npm run db:migrate                  # apply migrations (idempotent, no seed)
npm run db:ping                     # reachable? is anon denied? how many rows?
npm run db:query -- "<sql>"         # run read-only SQL as postgres (operator tool)
npm run verify:rls                  # prove the participant RLS model (30 checks)
npm run verify:staff                # prove the staff model (23 checks)
npm run verify:staff-ui             # drive staff CRUD in the real console UI (23 checks)
npm run verify:pricing              # prove a price edit reaches the public site (6 checks)
npm run staff:bootstrap -- u "pw"   # create the FIRST master; closes once used
npm run db:sync-pricing             # seed public.pricing from bundles.js / events.js
```

`verify:staff` uses `SUPABASE_STAFF_EMAIL` / `SUPABASE_STAFF_PASSWORD` from
`.env` when present, so it exercises the three tiers as a real master instead of
bootstrapping a throwaway one. It cleans up every account, session and audit row
it creates.

`verify:staff-ui` and `verify:pricing` both need `npm run preview` running on
`:4173`, and both clean up after themselves — the first removes the probe
accounts it creates, the second restores the price it moved. They exist because
the two features they cover shipped broken while every other test passed:
`StaffTab` never rendered its own "add account" form, and no public component
ever read a price from the database. Each of those bugs sat behind a test suite
that asserted against the same stale constants the UI was rendering.

`npm test` (== `verify:deploy`) needs no network or credentials and guards the
deploy shape: SPA fallback, CSP, no `VITE_`-prefixed vars, and the runtime
config wiring.

It checks all routes × desktop/mobile viewports for console errors and
horizontal overflow, the ENTER NEXUS transition (normal + reduced-motion),
realm-portal navigation, the mobile menu, keyboard focus order, that event
and bundle CTAs route into `/register` (with `/gateway` redirecting there),
the operations-console gate (no roster markup and **no social login button**
without a staff session), and the full wizard pass — details form → payment QR
→ UTR submission → success screen.

---

## Performance & security (built in)

- **Route-level code splitting** — every route except the landing hero is a
  `React.lazy` chunk, so the entry bundle carries only 1 of the 14 page files.
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
