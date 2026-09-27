# Phase 2 report — identity, Row Level Security, and the database as the only source of truth

**Status:** implemented, applied to the live project, and verified.
**Project ref:** `xvteqcvvjlxhwijwxbbq`.
**New migration:** `supabase/migrations/20260926000003_participant_rls_and_admin_users.sql` (243 lines).

> Phase 1 built a correct schema and a working write path, but with no access
> control: anybody could write a row, nobody could read the roster, and the
> admin console ran on a `localStorage` mirror holding a 14-row demo roster.
> Phase 2 closes that gap. See `docs/phase-1-report.md` for the starting point
> and `docs/supabase-data-model.md` for the resulting reference.

---

## 1. Objective

Make the database the single source of truth, and put every access rule in the
database rather than in a page:

1. **Participants** authenticate with Google before they can register, and own
   the registration they create.
2. **Operators** authenticate with Supabase email + password and are authorised
   by a row in the database.
3. **A participant can read and correct only their own registration.**
4. **A participant can never confirm their own payment.**
5. **Nobody can grant themselves operator access through the public API.**
6. **An unauthenticated visitor can do nothing at all** — not read, not write.
7. **No demo or seed data** anywhere, in the repo or in the table.

---

## 2. Schema — migration `...0003`

### 2.1 Ownership: `registrations.user_id`

```sql
alter table public.registrations
  add column if not exists user_id uuid references auth.users (id) on delete set null;
create index if not exists ix_registrations_user_id on public.registrations (user_id);
```

`ON DELETE SET NULL` rather than `CASCADE`: deleting a Google account must not
delete a registration that records a payment someone made. The row survives as
an unowned record of a real transaction.

The column is **stamped from the JWT by a trigger**, never supplied by the
client:

```sql
create trigger trg_registrations_set_user_id
  before insert on public.registrations
  for each row execute function public.set_registration_user_id();
```

A client that omits `user_id` gets the correct value; a client that tries to
send somebody else's is rejected by the INSERT policy's `WITH CHECK`. The
browser is never trusted to say who it is.

### 2.2 The operator roster: `public.admin_users`

```sql
create table admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text        not null,
  full_name  text,
  created_at timestamptz not null default now(),
  created_by text
);
```

`public.is_admin()` is `SECURITY DEFINER` with `search_path` pinned to empty, so
consulting it from a policy does not recurse and cannot be subverted by a
caller-controlled `search_path`:

```sql
create or replace function public.is_admin ()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.admin_users where user_id = auth.uid()); $$;
```

`admin_users` gets **exactly one policy** — a signed-in user may read their own
membership. There are no INSERT/UPDATE/DELETE policies at all, so the public API
has no path to that table. Granting access is an out-of-band operation.

### 2.3 The guard trigger — why RLS alone was not enough

RLS answers *which rows* a caller may touch. It cannot answer *which columns*
of that row they may set. A participant who owns a row could, with only RLS,
send `payment_status = 'verified'` and mint themselves a confirmed payment.

`trg_registrations_guard_update` closes that. For any non-admin UPDATE it
refuses, with `42501`:

- any change to `id`, `user_id`, `created_at`, `payment_verified_at` or
  `payment_verified_by`;
- any transition **into or out of** `verified` — verification is an
  operations-team action, and a confirmed payment cannot be quietly re-opened;
- any status outside `awaiting_utr` / `unverified` / `rejected`.

and it permits exactly one case beyond ordinary detail edits: **claiming an
unowned row whose email equals the signed-in account's verified email**. That
is the migration path for registrations created before `user_id` existed (see
§5).

### 2.4 Policies

| Policy | Command | Gate |
| --- | --- | --- |
| `participant_insert_own_registration` | INSERT | `user_id = auth.uid()` and a legal payment state |
| `participant_select_own_registration` | SELECT | `user_id = auth.uid()` |
| `participant_update_own_registration` | UPDATE | own row, or an unowned row matching the JWT email |
| `admin_select_registrations` | SELECT | `public.is_admin()` |
| `admin_update_registrations` | UPDATE | `public.is_admin()` |
| `admin_delete_registrations` | DELETE | `public.is_admin()` |
| `admin_users_read_own` | SELECT | `user_id = auth.uid()` |

The Phase 1 `anon_insert_registrations` policy is **dropped**, and `anon` is
revoked all grants on both tables. An unauthenticated visitor can now do
nothing whatsoever.

### 2.5 The demo rows are gone

---

## 3. Client changes

### 3.1 One Supabase client

Phase 1 built **two**: an auth client, and a data client in `src/lib/supabase.js`
with `persistSession: false`. That was not a style problem. A supabase-js
instance with persistence off cannot carry the session, so every RLS-scoped read
through the data client would have been denied; and because each instance
installs its own `onAuthStateChange` listener over one shared storage key, the
two would have fought each other on sign-in and sign-out.

`src/config/supabase.js` now exposes a single memoised `getAuthClient()`, used by
`AuthContext` (auth) and by the data layer (queries). `src/lib/supabase.js` is
deleted. The repository and the session are now the same client, which is the
precondition for RLS-scoped queries working at all.

### 3.2 The repository — `src/data/registrations.js`

Rewritten from a `localStorage` store with a demo roster into a thin repository
of real queries. Every export resolves to `{ data, error }` rather than
throwing, because every caller has a designed failed state and a rejected
promise escaping into a React handler is what blanks a route.

PostgREST error codes are translated into something actionable: `23505` becomes
"this email is already registered" (or the UTR / roll-number variant, matched
from the constraint name), and `42501` from the guard trigger becomes "only the
NEXUS operations team can change payment verification".

`addRegistration` deliberately sends **no** `user_id` and **no** timestamps — the
trigger stamps the owner and the database's clock stamps the audit fields.

### 3.3 `/register` — Google OAuth gate

The wizard's first step is now identity, and the details form is not rendered
until a session exists. This is not only UX: the INSERT policy requires
`user_id = auth.uid()`, so an unsigned visitor's row would be refused. Failing
in the page tells the participant why, instead of letting them fill in a form
and watch it not save.

The stepper is hidden while signed out — a progress track for a wizard you
cannot start is a worse message than no track. The event title, fee and context
stay visible above the gate, because choosing what to register for comes before
being asked to identify yourself.

A signed-in participant also gets a **"your registrations"** list showing live
status, and — when a UTR has been rejected — an inline form to send a corrected
one. That flow is only possible now that rows have an owner.

### 3.4 `/admin123456789` — email + password

The console is behind a Supabase email/password sign-in card
(`AuthContext.signInWithPassword`). The generic "those credentials were not
recognised" message is deliberate: GoTrue distinguishes "no such user" from
"wrong password" internally, and surfacing that difference would make the form
an account-enumeration oracle.

After sign-in the console asks the database whether the account is on the
operations roster (`isAdminUser()`). Three states, each rendered distinctly:

- not signed in → sign-in card;
- signed in, not on the roster → an explicit "not on the operations roster"
  notice with a sign-out button, and no data;
- on the roster → the live console.

The roster body is only ever mounted in the third state. The "auth: not enabled"
banner is gone — its absence is now the signal that a gate exists.

Every mutating action re-reads the roster from the database rather than
patching local state, because the triggers do work the client cannot see and a
refusal only the server can detect must not be papered over with an optimistic
update.

### 3.5 `db:ping` rewritten

Phase 1's `db:ping` treated a successful read as the happy path. After Phase 2 a
successful read by `anon` would mean participant PII is exposed, so the check is
inverted: `42501` is the pass condition, and a readable roster is a **failure**
that tells you to run `db:migrate`. It then reports the true row count and how
many rows are still unclaimed, using the management API.


`supabase/seed.sql` is deleted and `db:migrate` no longer has a seed step.
Migration `...0003` §6 purges the three placeholder rows that Phase 1 had
inserted, matched by their **exact seed addresses** — not `user_id is null`,

---

## 4. Verification

`npm run verify:rls` is new. It impersonates real Supabase sessions with
`SET LOCAL ROLE` + `request.jwt.claims` — exactly what PostgREST does with a
bearer token — and asserts the model against the live project. The mechanism
was confirmed empirically before it was trusted: a non-admin claims set yields
`is_admin() = false` and zero visible rows while rows exist.

**21/21 checks pass.** Behavioural results:

| Check | Result |
| --- | --- |
| anon INSERT policy is dropped | PASS |
| all 6 participant/admin policies present with the right command | PASS |
| admin policies gated on `is_admin()` | PASS |
| `admin_users` exposes no write policy | PASS |
| anon holds no table grants | PASS |
| ownership + guard triggers installed | PASS |
| signed-in non-admin reads **0** rows | PASS |
| a participant sees **exactly its own** row | PASS |
| participant cannot promote itself to `verified` | PASS — refused by the guard trigger |
| participant cannot modify another row | PASS — 0 rows affected (RLS filtered) |
| participant cannot delete another row | PASS — 0 rows affected |
| participant cannot grant itself admin | PASS — RLS refused |
| admin roster invisible to a non-admin | PASS |
| anonymous session reads nothing | PASS |

Each behavioural check runs in a transaction that is rolled back, and the probe
user plus its row are deleted in a `finally` block, so the audit leaves no
residue. Stale probe rows from an interrupted run are cleared at startup.

One correction worth recording: the first version asserted that a cross-row
`UPDATE` raises an error. It does not — **RLS filters**, affecting 0 rows and
reporting success. Asserting "an error was raised" would have passed for the
wrong reason and would not have proved the row was left alone. The check now
counts rows actually touched via `RETURNING`.

`npm run verify` (Playwright) gained the gate assertions and all pass:

- the register form is **not reachable** while signed out, and the gate offers a
  sign-in action;
- the stepper is hidden while signed out;
- event context and fee stay visible above the gate;
- the admin console requires sign-in and leaks **no roster markup at all**
  (no table, no stat cards, no rows) to an anonymous visitor;
- unknown credentials are refused by the database with the generic message.

Three older assertions assumed an ungated wizard (details step visible, etc.)
and were updated to the new reality rather than deleted.

`npm test` (deploy shape), `npm run build`, `npm run db:ping`,
`npm run shot:admin` and `npm run shot:pay` all pass.

**Current database state:** 1 row — a real registration. No demo rows, no probe
residue.

---

## 5. Known limitation: unclaimed rows

`...0003` added `user_id`, so any registration created before it has
`user_id IS NULL` and matches no participant SELECT policy — its author could
never see it. Orphaning a real registration was not acceptable, so the UPDATE
policy and the guard trigger were widened with a narrow claim: a signed-in
account may adopt an unowned row **only** when its email equals the verified
email on that account's Google identity. Matching on a JWT claim (rather than a
parameter) is what makes the claim non-transferable, and
`uq_registrations_email` guarantees at most one row per address.

`npm run db:ping` reports how many rows are still unclaimed. The live project has
**1**, which its author reclaims by signing in with the matching Google account
and submitting a reference.

---

## 6. Outstanding / next

- [ ] Grant the first operator account:
      `npm run db:grant-admin -- <email>` (the user must already exist in
      Supabase Auth). Until then the console correctly shows the
      "not on the operations roster" notice to everyone.
- [ ] The one unclaimed registration should be reclaimed by its author.
- [ ] `SUPABASE_VERIFY_EMAIL` / `SUPABASE_VERIFY_PASSWORD` (already reserved in
      `.env.example`) would let `npm run verify:db` drive the full
      register → verify → confirm flow end-to-end with real credentials. The
      Playwright suite deliberately stops at the gates, because it cannot
      perform Google OAuth or know an operator password, and asserting against
      a stubbed session would only prove the stub works.
- [ ] Optional payment webhook feeding the same status transitions.

which would also have caught real registrations. The statement is therefore a
no-op on every re-run and can never touch a real row.
