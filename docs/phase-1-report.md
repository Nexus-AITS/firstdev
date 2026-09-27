# Phase 1 report — Supabase schema, tooling and verification

**Status:** complete and applied to the live project.
**Commits:** `41bc881` (register + admin features), `40e77e2` ("phase 1 completed").
**Project ref:** `xvteqcvvjlxhwijwxbbq`.
**Migrations applied:** `...0000`, `...0001`, `...0002` (plus `...0003` from Phase 2).

> This document records what Phase 1 actually delivered. Where Phase 2
> superseded a Phase 1 decision, that is called out explicitly rather than
> quietly rewritten — the reasoning matters, and so does the fact that it
> changed. See `docs/phase-2-report.md` for what replaced it and why.

---

## 1. Objective

Give the NEXUS event site a real backend for registrations instead of a
browser-local store, without breaking the existing static SPA build or
exposing participant data.

Concretely, Phase 1 had to:

1. model the registration data properly (types, constraints, indexes);
2. get the schema onto a live Supabase project reproducibly;
3. keep the browser able to write registrations;
4. keep reads closed;
5. prove all of the above with tooling a reviewer can re-run.

---

## 2. What was delivered

### 2.1 The schema — `public.registrations`

`supabase/migrations/20260926000000_create_registrations.sql` (162 lines)
created the canonical table.

**Columns.** `id` (uuid PK), `name`, `roll_number`, `college_name`, `year`,
`department`, `phone_number`, `email`, `payment_status`, `utr_number`,
`utr_submitted_at`, `payment_verified_at`, `payment_verified_by`, `created_at`,
`updated_at`. Every one is documented with a `comment on column`, so the
Supabase dashboard and psql `\d+` explain themselves.

**Payment status is an enum, not a string.**

```sql
create type public.payment_status as enum
  ('awaiting_utr', 'unverified', 'verified', 'rejected');
```

This is the single most valuable decision in Phase 1. Payment state is a state
machine, and an enum makes an illegal state unrepresentable rather than merely
discouraged — `'pendng'` is not a value the column can hold.

**Constraints mirror the business rules, in the database, not in JavaScript:**

| Constraint | Rule |
| --- | --- |
| `chk_registrations_name` | 2–120 chars after trim |
| `chk_registrations_roll` | 3–40 chars |
| `chk_registrations_college` | 2–160 chars |
| `chk_registrations_year` | one of `1st` `2nd` `3rd` `4th` |
| `chk_registrations_department` | 2–80 chars |
| `chk_registrations_phone` | 8–15 chars, digits with optional `+`, space, `-` |
| `chk_registrations_email` | `user@host.tld` shape |
| `chk_registrations_utr_state` | no UTR ⇔ `awaiting_utr` |
| `chk_registrations_utr_format` | 6–30 chars `[A-Za-z0-9-]` |
| `chk_registrations_verified_at` | `verified` ⇔ `payment_verified_at IS NOT NULL` |

`chk_registrations_utr_state` is the one that earns its keep: it makes
"registered but unpaid" and "paid but unverified" indistinguishable states
*impossible*, so the UTR flow cannot desynchronise no matter which client
writes.

**Uniqueness is enforced by indexes, not by application code:**

- `uq_registrations_college_roll` on `(upper(btrim(college_name)), upper(btrim(roll_number)))`
  — one registration per student per college, tolerant of case and whitespace.
- `uq_registrations_email` on `lower(btrim(email))` — one registration per email.
- `uq_registrations_utr`, a **partial** unique index on `btrim(utr_number)` —
  a UTR may be used only once. This blocks two students submitting the same
  transaction reference, which is the realistic fraud vector for UPI payments.

**Triggers do the bookkeeping, so no client can lie about it:**

- `trg_registrations_set_updated_at` → `public.set_updated_at()`.
- `trg_registrations_payment_audit` → stamps `utr_submitted_at` on a new or
  changed UTR, stamps `payment_verified_at` on entering `verified`, and **clears**
  both audit fields when the status leaves `verified`. A stale
  `payment_verified_at` on an unverified row is impossible.

Timestamps come from the database clock, which is the only clock that matters
for a payment audit trail.

**RLS was switched on with zero policies** — deny-by-default. The table existed
but was unreachable from the public API.

### 2.2 The write path — migration `...0001`

`20260926000001_registration_policies.sql` (25 lines) added a single narrow
policy so the `/register` wizard could write:

```sql
create policy anon_insert_registrations
  on public.registrations for insert to anon, authenticated
  with check (
    (payment_status = 'unverified' and utr_number is not null)
    or (payment_status = 'awaiting_utr' and utr_number is null)
  );
```

The `WITH CHECK` repeats the payment-state invariant, so the API path could not
create a row the table constraints would have rejected for a different reason.
Reads stayed denied — there was no SELECT policy at all.

### 2.3 Purchase context — migration `...0002`

`20260926000002_registration_purchase_context.sql` (36 lines) added
`purchase_type` (`'event'` | `'bundle'` | null) and `purchase_label`, with a

### 2.4 Tooling

Four scripts, all runnable with `npm run`, all non-interactive:

| Script | Command | Purpose |
| --- | --- | --- |
| `scripts/supabase-ping.mjs` | `db:ping` | Reachability: env parse → GoTrue health → a real query |
| `scripts/apply-migration.mjs` | `db:migrate` | Applies every migration via the Management API |
| `scripts/verify-deploy.mjs` | `test` / `verify:deploy` | Deploy-shape guard, needs no network |
| `scripts/verify.mjs` | `verify` | Playwright: routes, wizard, admin console |

**Why the Management API and not the CLI.** `npx supabase` needs its own auth
dance and a linked project. The Management API is a single authenticated
`POST`, so `db:migrate` is one `node` invocation with no prerequisites beyond a
token in `.env` — and it is the *same* code path the Supabase SQL editor uses,
so "works locally" and "works in the dashboard" stop being different things.

**`apply-migration.mjs` is strict about its own success.** The first version
printed "ALL CHECKS PASSED" even when the verification response was not JSON or
carried no numeric `total`. That is the worst possible failure mode for a
migration tool: a green run that proves nothing. The current version refuses to
report success unless it can prove its claim, and sets `process.exitCode`
rather than calling `process.exit()` — the latter aborts with `0xC0000409` on
Windows while the fetch connection is still tearing down, which hides the exit
code from CI.

**`verify-deploy.mjs` guards four invariants that drift silently** because they
are maintained by hand across several files:

1. **SPA fallback** — every route in `src/App.jsx` is covered by a 200 rule in
   `public/_redirects` *and* by a `vercel.json` rewrite. They are alternatives
   (Vercel reads only one; Netlify/Cloudflare read only the other), so both are
   checked, with path-to-glob semantics rather than naive prefix matching.
2. **CSP origin** — `public/_headers` and `vercel.json` cannot read env vars,
   so a Supabase project change would silently block every auth request. A
   static header file cannot be derived, so this is asserted rather than
   derived.
3. **Secret hygiene** — anything `VITE_`-prefixed is inlined into the public
   bundle, so no PAT (`sbp_…`), service-role key, or database connection string
   may carry that prefix.
4. **`.env` hygiene** — gitignored and untracked.

`npm test` is wired to it, so it runs with no arguments and no network.

### 2.5 Credential delivery (refined in `ca6d1fd`)

Phase 1 originally read credentials from `import.meta.env.VITE_SUPABASE_*`,
which Vite inlines into the public bundle at build time. That is not a
*disclosure* problem — the anon key is public by design and grants nothing
beyond RLS — but it is an **operability** problem: the key is pinned to a
rebuild and frozen in immutable CDN assets, so rotating it needs a full
redeploy.

Commit `ca6d1fd` ("renamed env var input method delivery mechanism") replaced
that with runtime delivery:

- `api/config.js` — a Vercel function reading `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` from the **server** environment, and **no `VITE_`
  prefix**, so Vite cannot inline them.
- `src/config/runtime-config.js` — the browser fetches `GET /api/config` once
  per page load and memoises it in `sessionStorage`.
- `runtimeConfigPlugin` in `vite.config.js` — serves the same endpoint under
  `vite dev` and `vite preview`, so local behaviour matches production.
- `api/config.js` decodes the key and **refuses to serve** anything whose role
  is not `anon`, so a fat-fingered service-role value fails loudly at the
  endpoint instead of being published.

Two consequences, both asserted by `verify:deploy`:

- `/api/*` must not be SPA-rewritten. `vercel.json` uses `/((?!api/).*)`; a
  catch-all would return `index.html` to `fetch()`, the config would parse as
  `null`, and auth would die with no error anywhere.
- CSP `connect-src` uses `https://*.supabase.co` in both `vercel.json` and
  `public/_headers`, because the origin is no longer known at build time.

`CHECK` on the pair. The wizard captured these from the `?event=` / `?bundle=`
query string, which is what makes "this registration is for NEXUS BREACH"
answerable later instead of being lost at submit time.


---

## 3. Verification performed

| Check | Command | Result |
| --- | --- | --- |
| Migrations apply cleanly | `npm run db:migrate` | 3 migrations + seed applied, verified |
| Project reachable with `.env` | `npm run db:ping` | GoTrue HTTP 200, key accepted, table present |
| Deploy shape | `npm test` | 13/13 PASS |
| Routes render, no overflow | `npm run verify` | 16 routes × 2 viewports PASS |
| Registration wizard end-to-end | `npm run verify` | details → QR → UTR → success, row persisted |
| Admin roster + Confirm/Remove | `npm run verify` | stats correct, verify increments, remove decrements |
| Google OAuth reachable | `npm run verify:google` | navbar control reaches `accounts.google.com` |

`db:migrate` was also self-tested against a failure path (missing token,
unreachable endpoint) via a PowerShell harness, confirming a non-zero exit and
no false "ALL CHECKS PASSED".

---

## 4. Known limitations carried into Phase 2

Phase 1 shipped a working write path and a closed read path. It did **not**
ship access control, and the gap was deliberate and documented rather than
accidental:

1. **Anybody could write a row.** The `anon` INSERT policy had no identity
   requirement, so the roster could be filled with junk and registrations could
   not be tied to the person who made them.

2. **Nothing could read the roster.** No SELECT policy existed, so the admin
   console kept reading a `localStorage` mirror with a 14-row demo roster. The
   console showed participants who had never registered, and the database held
   rows no browser had ever verified.

3. **Dual-write.** The wizard wrote `localStorage` first, then attempted a
   best-effort insert. A failed insert still produced a success screen reading
   "cloud sync unavailable" — a participant could be told they were registered
   when the server had refused.

4. **Two Supabase clients.** The auth client and the data client were separate
   instances, one with `persistSession: false`. A second instance cannot carry
   the session, so RLS-scoped reads through it would have failed — and its auth
   listener would have fought the real one over the shared storage key.

5. **No ownership.** `registrations` had no `user_id`, so a participant could
   not see, correct, or re-submit their own registration, and a rejected UTR
   could only be fixed by the participant emailing the team.

6. **Demo data in the production table.** `supabase/seed.sql` ran on every
   `db:migrate`, so the live roster contained three obviously-fake rows that
   looked exactly like real ones in the admin console.

---

## 5. What Phase 2 changed

Summarised here for continuity; detailed in `docs/phase-2-report.md`.

| Phase 1 | Phase 2 |
| --- | --- |
| `anon` may INSERT | `anon` may do **nothing**; grants revoked entirely |
| No ownership column | `registrations.user_id`, stamped from `auth.uid()` by trigger |
| Reads closed to everyone | Reads scoped: own row for a participant, all rows for an operator |
| `localStorage` mirror + demo roster | Database only; mirror and `supabase/seed.sql` deleted |
| Dual-write, best-effort | Single write; a failure is a visible failure |
| Two Supabase clients | One memoised client, shared with the auth session |
| Anyone can write a row | Only a signed-in participant, and only as themselves |
| Verification is a UI action | A trigger refuses a participant self-verifying |
| Console open to anyone with the link | Email + password, authorised by `public.admin_users` |
| Demo rows seeded every migrate | Seed step removed; demo rows purged once, by exact address |

The invariants Phase 1 got right were kept: the enum, the constraints, the
three unique indexes, and the audit triggers. Phase 2 added access control
around them rather than touching them.
