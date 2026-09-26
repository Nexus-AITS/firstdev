# Supabase data model — `registrations`

> **Status: live — wizard writes flow to Supabase.** The migration, the anon
> INSERT policy (`20260926000001_registration_policies.sql`) and
> `supabase/seed.sql` are applied to the remote project (ref
> `xvteqcvvjlxhwijwxbbq`) via `npm run db:migrate` (Management API +
> `SUPABASE_ACCESS_TOKEN` from `.env`); idempotent, safe to re-run.
> `src/lib/supabase.js` exposes the shared `supabase` client (with
> `isSupabaseConfigured`) + `submitRegistration()`; builds without
> `VITE_SUPABASE_*` degrade instead of crashing — the wizard still runs and
> reports "cloud sync unavailable". The `/register` wizard dual-writes (local
> store first for `/admin123456789`, then the anon insert), and `npm run db:ping` proves
> connectivity from the anon side.
> Remaining: authenticated-admin pass (sign-in gate, scoped SELECT policies),
> then swap the function bodies in `src/data/registrations.js` for
> `supabase.from("registrations")` queries — the Admin page API stays identical.

## Files

| File                                                       | Purpose                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `supabase/migrations/20260926000000_create_registrations.sql` | Canonical, idempotent DDL (enum, table, indexes, triggers, RLS)     |
| `supabase/migrations/20260926000002_registration_purchase_context.sql` | `purchase_type` / `purchase_label` — which event / which bundle |
| `supabase/seed.sql`                                        | Three obviously-fake rows for local experiments             |
| `src/lib/supabase.js`                                      | Shared Supabase client (Vite env credentials)               |
| `scripts/supabase-ping.mjs` (`npm run db:ping`)            | Connectivity check: auth health + `registrations` select    |
| `scripts/apply-migration.mjs` (`npm run db:migrate`)       | Applies migrations + seed via the Management API (PAT)      |
| `docs/supabase-data-model.md`                              | This document — decisions, extension recipes, wiring checklist |

## Table `public.registrations`

| Column          | Type                    | Null | Default            | Rule                                                                 |
| --------------- | ----------------------- | ---- | ------------------ | -------------------------------------------------------------------- |
| `id`            | uuid                    | no   | `gen_random_uuid()` | primary key                                                          |
| `name`          | text                    | no   | —                  | 2–120 chars after trim                                               |
| `roll_number`   | text                    | no   | —                  | 3–40 chars; unique per college (case/whitespace-insensitive index)   |
| `college_name`  | text                    | no   | —                  | 2–160 chars                                                          |
| `year`          | text                    | no   | —                  | one of `1st`, `2nd`, `3rd`, `4th`                                    |
| `department`    | text                    | no   | —                  | 2–80 chars (e.g. CSE, ECE, IT, Mech)                                 |
| `phone_number`  | text                    | no   | —                  | 8–15 chars; digits with optional `+`, space or `-`                   |
| `email`         | text                    | no   | —                  | basic `user@host.tld` pattern; unique ignoring case                  |
| `payment_status` | `public.payment_status` | no   | `'awaiting_utr'`   | enum: `awaiting_utr`, `unverified`, `verified`, `rejected`           |
| `utr_number`     | text                    | yes  | —                  | UTR entered by the participant; 6–30 chars `[A-Za-z0-9-]`; unique     |
| `utr_submitted_at` | timestamptz           | yes  | —                  | auto-stamped on submit / re-submit (trigger)                          |
| `payment_verified_at` | timestamptz        | yes  | —                  | auto-stamped when admin verifies; cleared if status leaves `verified` |
| `payment_verified_by` | text               | yes  | —                  | admin identity that confirmed the UTR                                |
| `purchase_type`  | text                    | yes  | —                  | `event` \| `bundle` (check constraint); what the participant bought   |
| `purchase_label` | text                    | yes  | —                  | display label: event title, or bundle name + number + price          |
| `created_at`    | timestamptz             | no   | `now()`            | insert time                                                          |
| `updated_at`    | timestamptz             | no   | `now()`            | refreshed by trigger on every UPDATE                                 |

Money amounts are intentionally **not** columns — event pricing stays in
`src/data/events.js`; this table tracks *who registered* and *whether the
payment happened*.

## Payment verification workflow (UTR)

1. **Registration created** → `payment_status = 'awaiting_utr'`, no UTR yet.
2. **Participant enters UTR** → status becomes `unverified` ("not verified");
   `utr_number` is stored (unique across all rows) and `utr_submitted_at` is
   stamped automatically by trigger.
3. **Admin confirms the UTR** → status becomes `verified`;
   `payment_verified_at` (auto-stamped) and `payment_verified_by` (admin
   identity) record who confirmed and when.
4. **Admin rejects** (wrong/invalid UTR) → `rejected`; the participant may
   submit a corrected UTR, which flips the status back to `unverified` and
   re-stamps `utr_submitted_at`.

CHECK constraints keep the states consistent: no UTR ⇔ `awaiting_utr`;
`verified` ⇔ `payment_verified_at IS NOT NULL`; verification audit fields are
cleared whenever the status leaves `verified`. A single UTR can only ever be
used once (partial unique index), so one transaction cannot pay twice.

## Indexes, uniqueness, triggers

- `uq_registrations_college_roll` — `(upper(btrim(college_name)), upper(btrim(roll_number)))`: one registration per student per college, tolerant of case/whitespace.
- `uq_registrations_email` — `lower(btrim(email))`: one registration per email.
- `uq_registrations_utr` — partial unique index on `btrim(utr_number)`: a UTR may only ever be used once (blocks sharing one transaction reference).
- `idx_registrations_payment_status`, `idx_registrations_created_at` — dashboard filtering/sorting.
- `trg_registrations_set_updated_at` — keeps `updated_at` fresh via the `public.set_updated_at()` function.
- `trg_registrations_payment_audit` — stamps `utr_submitted_at` / `payment_verified_at` and clears verification audit fields when the status leaves `verified`.

## Security posture (pre-wiring)

Row Level Security is **enabled with zero policies**, so the PostgREST API
denies all access for `anon` / `authenticated` roles. The table is reachable
only through the SQL editor (or a service role with explicit policies) until
integration deliberately adds rules — matching the project's deny-by-default
security stance.

## Applying it (done — how to re-run)

1. **Repo (used here):** `npm run db:migrate` — runs every file in
   `supabase/migrations/` plus `supabase/seed.sql` through the Management API
   using `SUPABASE_ACCESS_TOKEN` from `.env`. Idempotent; applied 2026-09-26
   to project `xvteqcvvjlxhwijwxbbq`. Seed shows `rows in public.registrations: 3`.
2. **Dashboard:** SQL Editor → paste the migration → Run → optionally paste `supabase/seed.sql`.
3. **CLI:** `npx supabase link --project-ref <ref>` then `npx supabase db push` (the `supabase/` directory already follows CLI layout); run the seed manually or via `supabase db reset`. Note: `db:migrate` does not write the CLI's tracking row, so `db push` will re-run the migration once — harmless because it is idempotent.
4. **Local:** `npx supabase db start` → `npx supabase db reset` applies migrations + seed.

> **Upgrading an earlier staged copy?** The enum was redesigned for the UTR
> flow (`pending|paid|failed|refunded` → `awaiting_utr|unverified|verified|rejected`).
> Since this schema has never been applied to a live project, simply drop and
> re-run: `drop table public.registrations; drop type public.payment_status;`

## Extension recipes

- **New payment status:** run as its own statement — `alter type public.payment_status add value 'disputed';` (and extend the enum list in the migration for fresh environments).
- **Allow 5th year:** `alter table public.registrations drop constraint chk_registrations_year, add constraint chk_registrations_year check (year in ('1st','2nd','3rd','4th','5th'));`
- **Purchase context (done):** `purchase_type` / `purchase_label` landed via
  `20260926000002_registration_purchase_context.sql` — a display-level record of
  which event / which bundle each row bought (what the admin panel shows).
- **Link to events later:** add `event_id uuid` / `event_slug text` (mirroring `src/data/events.js` ids) and a junction table for team registrations — deferred on purpose for now.

## Integration checklist

- [x] `npm i @supabase/supabase-js`
- [x] `.env` with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (commit `.env.example` only)
- [x] Add the project URL to `connect-src` in the CSP (`vite.config.js` `securityHeadersPlugin` **and** `public/_headers` — keep both in sync)
- [x] Registration wizard on `/register` inserting into `public.registrations`
      (dual-write: local store first for `/admin123456789`, then best-effort Supabase
      insert; `/gateway` redirects legacy links into the wizard)
- [x] UTR entry step (wizard step 3) setting `utr_number` +
      `payment_status = 'unverified'` — one final insert, not a two-phase update
- [x] Admin console (`/admin123456789`) — roster, dashboard totals, Confirm/Reject/Remove;
      runs on the local mirror `src/data/registrations.js` (functions map 1:1
      to Supabase calls)
- [x] Purchase context — `purchase_type`/`purchase_label` (migration
      `20260926000002`) captured by the wizard from `?event=`/`?bundle=` and
      shown in the admin roster (Purchase column) + event/bundle dashboard counts
- [x] RLS **insert** policy for `anon`/`authenticated`
      (`20260926000001_registration_policies.sql`) — CHECK mirrors the schema
      invariants (`unverified`+UTR, or `awaiting_utr`+no UTR). Reads stay
      denied and only admin flows can set `verified` — both still require the
      authenticated-admin pass below
- [ ] Authenticated admin pass: sign-in gate for `/admin123456789`, scoped RLS
      policies (SELECT own row / admin reads all), then point the console at
      the API instead of the local mirror
- [ ] Optional payment webhook feeding the same status transitions
