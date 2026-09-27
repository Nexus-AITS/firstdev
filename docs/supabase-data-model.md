# Supabase data model — `registrations`, staff, audit, pricing

> **Status: live — Supabase is the single source of truth.**
> Migrations `...0000` through `...0004` are applied to the remote project (ref
> `xvteqcvvjlxhwijwxbbq`) via `npm run db:migrate` (Management API +
> `SUPABASE_ACCESS_TOKEN` from `.env`); idempotent, safe to re-run.
>
> **As of Phase 2 there is no local mirror.** `src/data/registrations.js` is a
> thin repository of real queries against `public.registrations`, and the
> `localStorage` dual-write, the demo roster and `supabase/seed.sql` are gone.
> A failed insert is a visible failure, not a row that exists only in a browser.
>
> **Access is enforced by Row Level Security, not by the pages.** A participant
> signs in with Google and can insert, read and correct only their own row
> (`user_id = auth.uid()`). Staff are something else entirely, and cannot be a
> Google account — see "The two identity systems" below.
> `npm run verify:rls` proves the participant model and `npm run verify:staff`
> proves the staff model, both against the live database. The UI gate is a
> convenience; the database is the control.
>
> Credentials arrive at RUNTIME from `GET /api/config` (`api/config.js` reading
> `SUPABASE_URL` / `SUPABASE_ANON_KEY` from the server env, with **no `VITE_`
> prefix** so Vite cannot inline them into the bundle). Deployments without them
> degrade to a clear "unavailable" state rather than crashing.
>
> **Open:** migration `...0003` added `user_id`, so registrations created before
> it have no owner. Their author reclaims one by signing in with the matching
> email and submitting a reference — the UPDATE policy admits that row and the
> guard trigger allows the ownership change. `npm run db:ping` reports how many
> are still unclaimed.

## Files

| File                                                       | Purpose                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `supabase/migrations/20260926000000_create_registrations.sql` | Canonical, idempotent DDL (enum, table, indexes, triggers, RLS)     |
| `supabase/migrations/20260926000002_registration_purchase_context.sql` | `purchase_type` / `purchase_label` — which event / which bundle |
| `supabase/migrations/20260926000003_participant_rls_and_admin_users.sql` | `user_id`, `public.admin_users`, `is_admin()`, participant + admin RLS, guard triggers, demo-row purge |
| `supabase/migrations/20260926000004_staff_roles_audit_and_pricing.sql` | `staff_users` / `staff_sessions` / `staff_audit_log` / `pricing`, the `staff_role` enum, the three-tier RLS model, 60-minute sessions, audit triggers |
| `src/config/supabase.js`                                  | The one memoised client (`getAuthClient()`) + auth config  |
| `src/data/registrations.js`                                | Repository — every export is a real query, `{ data, error }` |
| `src/data/staff.js`                                        | Staff auth (login/session/roles) + every console query      |
| `src/data/pricing.js`                                      | DB-first prices with a JS fallback for offline first paint  |
| `src/pages/Admin.jsx`                                      | The `/nexus-admin` console — login gate, 4 tabs, role-gated |
| `scripts/supabase-ping.mjs` (`npm run db:ping`)            | Connectivity + anon-is-denied check + privileged row count  |
| `scripts/apply-migration.mjs` (`npm run db:migrate`)       | Applies migrations via the Management API (PAT); no seed    |
| `scripts/db-query.mjs` (`npm run db:query`)                | Run read-only SQL as postgres — an operator inspection tool |
| `scripts/grant-staff.mjs` (`npm run staff:bootstrap`)      | Creates the FIRST master; the only anonymous path, closes once used |
| `scripts/sync-pricing.mjs` (`npm run db:sync-pricing`)    | Seeds `public.pricing` from the real `bundles.js` / `events.js` values |
| `scripts/verify-rls.mjs` (`npm run verify:rls`)            | Proves the participant RLS model against the live project    |
| `scripts/verify-staff.mjs` (`npm run verify:staff`)        | Proves the staff model: 60-min expiry, 3 tiers, audit trail |
| `docs/supabase-data-model.md`                              | This document — decisions, extension recipes, wiring checklist |
| `docs/phase-1-report.md`                                   | Phase 1 report (schema, tooling, verification)              |
| `docs/phase-2-report.md`                                   | Phase 2 report (auth, RLS, client consolidation)           |
| `docs/phase-3-report.md`                                   | Phase 3 report (staff auth, roles, audit, DB pricing)      |

## The two identity systems

This is the single most important thing to understand about the schema, so it
is stated before any table.

|                | Participant                            | Staff                                       |
| -------------- | -------------------------------------- | ------------------------------------------- |
| Signs in with  | Google OAuth (Supabase Auth)           | username + password (no social login)      |
| Connects as    | database role `authenticated`          | database role `anon`                        |
| Identity       | a Supabase JWT (`auth.uid()`)          | `X-Nexus-Staff-Token` header               |
| Lives in       | `auth.users` (Supabase-owned)          | `public.staff_users` + `public.staff_sessions` |
| Row scoping    | `user_id = auth.uid()`                 | `staff_at_least('admin')` etc.             |
| Session life   | Supabase-managed, refreshable          | 60 minutes, hard, server-side               |

They share **no table, no session store and no token**. A signed-in
participant who navigates to `/nexus-admin` gets the staff login form like
anyone else, because the staff code never consults the Supabase session. This is
what "no social login on the admin page" has to mean for it to be worth
anything.

Phase 2 authorised operators by a row in `admin_users`, i.e. by a *Supabase
Auth* account — the same provider as the participant sign-in. That is retired:
migration `...0004` drops the `admin_*` policies and `is_admin()`, and
`admin_users` is no longer on any access path. Leaving both in place would mean a
Google account that was ever added to `admin_users` could still read the roster.

## Staff roles

| Role          | Registrations     | Audit log | Staff accounts | Pricing |
| ------------- | ----------------- | --------- | -------------- | ------- |
| `coordinator` | read              | no        | no             | no      |
| `admin`       | read + update     | read      | no             | no      |
| `master`      | read + update + delete | read | create/change | read + write |

Every one of those is an RLS policy. The console also hides what a role cannot
use (`src/data/staff.js` `can()`), but that is only a courtesy — removing a
button changes nothing an attacker could do, because the database still refuses.

`staff_update()` refuses to deactivate or demote the **only** active master.
Without that, one wrong click would lock everyone out permanently, since adding a
new master requires an existing master.

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
- `ix_registrations_user_id` — the owner lookup every participant policy does.
- `trg_registrations_set_updated_at` — keeps `updated_at` fresh via the `public.set_updated_at()` function.
- `trg_registrations_payment_audit` — stamps `utr_submitted_at` / `payment_verified_at` and clears verification audit fields when the status leaves `verified`.
- `trg_registrations_set_user_id` — stamps `user_id` from `auth.uid()`, so the browser cannot spoof an owner even if it tries.
- `trg_registrations_guard_update` — column-level guard. RLS says *which rows* a caller owns; only this trigger can say *which columns* they may touch. Without it a participant could `payment_status = 'verified'` their own row and mint a confirmed payment.

## Tables added in Phase 3

### `public.staff_users`

| Column                             | Type                  | Notes                                                       |
| ---------------------------------- | --------------------- | ----------------------------------------------------------- |
| `id`                               | uuid                  | primary key                                                  |
| `username`                         | text                  | `^[a-z0-9._-]{3,32}$`, unique ignoring case                  |
| `password_hash`                    | text                  | pgcrypto **bcrypt**; the plaintext never exists server-side  |
| `full_name`                        | text                  | display name shown in the console                           |
| `role`                             | `public.staff_role`   | `master` \| `admin` \| `coordinator`                         |
| `is_active`                        | boolean               | a deactivated account cannot sign in even with a live token |
| `failed_attempts` / `locked_until` | int / timestamptz     | 5 failures locks the account for 15 minutes                 |
| `last_login_at`, `created_at`, `created_by` | —             | who made it, and when                                        |

No role can INSERT or UPDATE this table directly — deliberately, because
`staff_create()` / `staff_update()` are the audited path and a direct write
would skip the audit trail. Only a `master` may even SELECT it.

### `public.staff_sessions`

| Column                           | Notes                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `token_hash`                     | **sha256 of the opaque token**, not the token. A database dump yields no usable session. |
| `expires_at`                     | `now() + interval '60 minutes'` at issue time. Hard.                          |
| `revoked_at`                     | `staff_logout()` revokes *this* session only, not the account's other sessions. |
| `ip`, `user_agent`, `created_at` | recorded for the audit trail / incident review                                |

Granted to **no** client role. Sessions exist only because `staff_login()`
created them and `staff_logout()` revoked them.

### `public.staff_audit_log`

Append-only. Columns: `staff_id`, `username`, `role`, `action`, `entity`,
`entity_id`, `details` (jsonb), `created_at`.

Clients may only `SELECT`, and only as `admin` or above. Every write comes from a
`SECURITY DEFINER` function or a database trigger, so an entry is written
**whether or not the client wants one** — a `BEFORE UPDATE` / `BEFORE DELETE`
trigger on `registrations`, an `AFTER` trigger on `pricing`, and explicit inserts
inside the staff-management functions. A client cannot omit an entry; it also
cannot edit or delete one.

`details` carries before/after values, so the log answers "which UTR was this,
and what was it before?" without needing the current row.

### `public.pricing`

| Column                     | Notes                                                                    |
| -------------------------- | ------------------------------------------------------------------------ |
| `kind`                     | `bundle` \| `event`                                                      |
| `ref_id`                   | the `bundles.js` / `events.js` id; unique with `kind`                    |
| `price`                    | integer INR, `>= 0`. **0 means FREE, never "unknown"**                   |
| `is_active`                | a false row is hidden from the public read, so a bundle can be withdrawn |
| `updated_at`, `updated_by` | last change                                                              |

Public SELECT (prices are already on the public site, so this exposes nothing
new); master-only writes, audited by trigger.

**The JS constants are a fallback, not the authority.** `src/data/pricing.js`
prefers the database and falls back to `bundles.js` / `events.js` only when the
database has not answered on a cold first paint. `getPrice()` returns `null`
rather than guessing, so a page can never render a confidently wrong price.


## Security model (Phase 3)

The participant half is unchanged from Phase 2 and still holds: Google sign-in,
`user_id = auth.uid()`, own-row-only RLS, and a guard trigger that stops a
participant touching identity or verification fields. What changed is the staff
half, and it is a replacement rather than an extension.

### Roles

Ranked `master` (3) > `admin` (2) > `coordinator` (1) > none (0). The single
predicate every staff policy consults is `public.staff_at_least(role)`, which
resolves the `X-Nexus-Staff-Token` header to a live session row on **every**
request — re-checking expiry, revocation and `is_active` each time.

That is what makes the 60 minutes real. The browser holds a token, but the token
is only a pointer to a session row; there is nothing in the client to extend.

### Policies

| Table             | coordinator | admin   | master         |
| ----------------- | ----------- | ------- | -------------- |
| `registrations`   | SELECT      | + UPDATE | + DELETE       |
| `staff_audit_log` | —           | SELECT   | SELECT         |
| `staff_users`     | —           | —       | SELECT         |
| `pricing`         | SELECT      | SELECT   | SELECT + write |
| `staff_sessions`  | —           | —       | —              |

Reading something you may not see returns **zero rows with HTTP 200**, not an
error — that is how RLS filtering works. `verify:staff` therefore asserts
`rows.length === 0` for a denial and only treats a non-2xx as a hard failure.

Staff connect as `anon`, which holds `select, update, delete` on `registrations`
and deliberately **not** `insert`: a staff member must never create a
registration. Participants connect as `authenticated` and stay confined to their
own row.

A note on grants, because this caused a real bug here: Supabase grants ALL on
public tables to `anon` and `authenticated` by default, and **RLS narrows, it
does not grant**. Writing `revoke all` *after* creating a policy silently
produces "permission denied" with an empty result rather than an obvious
failure. Migration `...0004` therefore revokes first, then grants back exactly
the privileges its policies guard.

### The guard trigger, in detail

`guard_registration_update()` runs `BEFORE UPDATE`:

1. If the caller is at least `admin` — allow, and record an audit entry with the
   before/after status and UTR.
2. Otherwise allow exactly one thing: claiming a row that has no `user_id`, by
   setting it to `auth.uid()` when the row's email matches the verified JWT
   email. This is how a pre-`user_id` registration is reclaimed.
3. Otherwise refuse: identity and verification columns are frozen, and a
   participant may only correct details while the payment is not yet verified.

`audit_registration_delete()` runs `BEFORE DELETE` so a removal is recorded with
the row's details. Deleting a registration destroys the only record that a real
payment was made, which is why delete is master-only *and* always logged.

### Granting access

Exactly two ways in, and both are audited:

```bash
# 1. The FIRST master. Works only while staff_users is empty, then closes for good.
npm run staff:bootstrap -- nexusadmin "a-long-passphrase" "Full Name"

# 2. Every account after that: sign in at /nexus-admin and use the Staff tab.
#    Adding a coordinator or an admin requires a signed-in master, precisely so
#    the addition lands in the audit log.
```

`staff_bootstrap_master()` is the only function that can write `staff_users`
without a session, and it returns an error the moment any account exists. A
master can also deactivate an account, reset a password, change a role, and
revoke every session for an account (after a suspected compromise).

### Proving it

```bash
npm run db:ping       # anon SELECT is denied; prints the real row count
npm run verify:rls    # 30 checks — the participant model
npm run verify:staff  # 23 checks — staff login, 60-min expiry, 3 tiers, audit
npm run verify        # the console gate: no roster, no social login
```

`verify:staff` drives the real PostgREST endpoints with the real anon key and a
real token — the path the browser actually takes — rather than impersonating
sessions inside SQL. Set `SUPABASE_STAFF_EMAIL` / `SUPABASE_STAFF_PASSWORD` in
`.env` so it exercises the tiers as a real master instead of bootstrapping a
throwaway one. It creates its own admin and coordinator, exercises each tier,
then deletes the accounts, sessions and audit rows it created.

## Applying it (done — how to re-run)

1. **Repo (used here):** `npm run db:migrate` — runs every file in
   `supabase/migrations/` through the Management API using
   `SUPABASE_ACCESS_TOKEN` from `.env`, then verifies that
   `public.registrations` (including `user_id`) and `public.admin_users` both
   answer. Idempotent; applied 2026-09-27 to project `xvteqcvvjlxhwijwxbbq`.
   There is **no seed step** — the database holds only real registrations.
2. **Dashboard:** SQL Editor → paste the migration → Run.
3. **CLI:** `npx supabase link --project-ref <ref>` then `npx supabase db push`
   (the `supabase/` directory already follows CLI layout). Note: `db:migrate`
   does not write the CLI's tracking row, so `db push` will re-run each migration
   once — harmless, because every file is idempotent.
4. **Local:** `npx supabase db start` → `npx supabase db reset` applies the
   migrations.

> **Never drop the table to "upgrade".** This schema is applied to the live
> project — evolving it means adding a new idempotent file under
> `supabase/migrations/` (see "Extension recipes" below), not
> `drop table` / `drop type`, which would destroy every real registration.

## Extension recipes

- **New payment status:** run as its own statement — `alter type public.payment_status add value 'disputed';` (and extend the enum list in the migration for fresh environments).
- **Allow 5th year:** `alter table public.registrations drop constraint chk_registrations_year, add constraint chk_registrations_year check (year in ('1st','2nd','3rd','4th','5th'));`
- **Purchase context (done):** `purchase_type` / `purchase_label` landed via
  `20260926000002_registration_purchase_context.sql` — a display-level record of
  which event / which bundle each row bought (what the admin panel shows).
- **New staff role:** `alter type public.staff_role add value 'auditor';`, then
  extend the rank in `staff_at_least()` and the `can` list in
  `src/data/staff.js`'s `ROLE_META`. Pick a number that fits the existing ladder
  (coordinator 1, admin 2, master 3).
- **Longer staff sessions:** change the one `interval '60 minutes'` in
  `staff_login()` and the `SESSION_MINUTES` constant in `src/pages/Admin.jsx`.
  `verify:staff` asserts the exact value, so it will catch a mismatch.
- **Link to events later:** add `event_id uuid` / `event_slug text` (mirroring `src/data/events.js` ids) and a junction table for team registrations — deferred on purpose for now.

## Integration checklist

- [x] `npm i @supabase/supabase-js`
- [x] `.env` with `SUPABASE_URL` / `SUPABASE_ANON_KEY` (commit `.env.example` only).
      **No `VITE_` prefix** — those vars are served at runtime by `api/config.js`,
      so the anon key is absent from the built bundle and rotatable without a rebuild.
- [x] `connect-src` in the CSP allows `https://*.supabase.co` (`vite.config.js`
      `securityHeadersPlugin` **and** `public/_headers` + `vercel.json` — keep all
      in sync). A static header file cannot read env vars, and the origin is only
      known at runtime, so the wildcard replaces the old hardcoded project URL.
- [x] `vercel.json` rewrite excludes `/api/` (`/((?!api/).*)`) so the runtime-config
      function is not swallowed by the SPA catch-all — asserted by `verify:deploy`.
- [x] Registration wizard on `/register` inserting into `public.registrations`
      directly (no local mirror; `/gateway` redirects legacy links into the
      wizard)
- [x] UTR entry step (wizard step 3) setting `utr_number` +
      `payment_status = 'unverified'` — one final insert, not a two-phase update
- [x] Operations console (`/nexus-admin`) — roster, search, Confirm/Reject, audit
      log, staff management and pricing, reading live from the database via
      `src/data/staff.js`. `/admin123456789` redirects here.
- [x] Purchase context — `purchase_type`/`purchase_label` (migration
      `20260926000002`) captured by the wizard from `?event=`/`?bundle=` and
      shown in the roster.
- [x] **Phase 2** — Google OAuth gates `/register`; `registrations.user_id` is
      stamped from the JWT (migration `...0003`); participant RLS policies and
      the column-level guard trigger. Proven by `npm run verify:rls` (30 checks
      against the live project) and by the gate assertions in `npm run verify`.
- [x] **Phase 3** — staff auth fully independent of Supabase Auth (migration
      `...0004`): `staff_users` / `staff_sessions` / `staff_audit_log` /
      `pricing`, the `staff_role` enum, a hard 60-minute session, the
      master/admin/coordinator tiers in RLS, the Phase 2 `admin_users` path
      dropped, and audit triggers on registration + pricing changes. Prices
      seed from the real JS values (`npm run db:sync-pricing`) and are edited
      from the console. Proven by `npm run verify:staff` (23 checks driving the
      real PostgREST endpoints as a real master) and the gate checks in
      `npm run verify` (no roster, no social login).
- [x] Demo rows and `supabase/seed.sql` removed — the database holds only real
      registrations (migration `...0003` §6, and no seed step in `db:migrate`)
- [x] First master account created: `npm run staff:bootstrap -- nexusadmin "…"`
- [ ] Add an admin and a coordinator from the console's Staff tab, and change
      the bootstrap passphrase to one only the organisers know
- [ ] Reclaim any pre-ownership registration by submitting a reference with the
      matching address (`npm run db:ping` reports how many are unclaimed)
- [ ] Optional payment webhook feeding the same status transitions
