# Phase 3 report — staff auth, three roles, audit trail, database-owned prices

> **Status: implemented and verified against the live project**
> (ref `xvteqcvvjlxhwijwxbbq`). Migration `...0004` applied; `verify:staff`
> 23/23, `verify:rls` 30/30, `verify` and `test` all passing.

## What was asked, and whether it was in the plan

The agreed plan covered: participants on Google OAuth, operators on
email/password, and RLS scoping. The following were **not** in it and arrived as
new requirements:

| Requested                                      | New?  | Built as |
| ---------------------------------------------- | ----- | -------- |
| Console at `/nexus-admin`                      | no    | route change + redirect from the old path |
| No social login; username + password only      | partly | Phase 2 used Supabase email/password, so a *Google* session could not reach it. Phase 3 makes that structural rather than incidental — see below. |
| Enforced login, 60-minute sessions             | new    | `staff_sessions` with a server-side `expires_at` |
| A users table / more people in the console     | new    | `staff_users` + a master-only Staff tab |
| Every action recorded with who and when        | new    | `staff_audit_log`, written by database triggers |
| Bundle prices rendered from the database       | new    | `public.pricing`, seeded from the real JS values |
| Three tiers: master / admin / coordinator      | new    | `staff_role` enum enforced in RLS |

The one place Phase 2 got close is the "no social login" requirement. Phase 2
authorised operators by a row in `public.admin_users`, i.e. by a **Supabase
Auth** account — the same provider as the participant Google sign-in. A Google
account that had ever been added to `admin_users` kept its access, and the two
systems shared an identity provider. Phase 3 removes that rather than relying on
the UI hiding a button.

## The one design decision that matters

**Staff accounts are not Supabase Auth accounts.** They live in
`public.staff_users`, authenticate with bcrypt against `public.staff_sessions`,
and carry their identity in an `X-Nexus-Staff-Token` header on ordinary
`anon`-role requests. They share no table, no session store and no token with
the participant flow.

That buys three things that would otherwise be hard:

1. A Google session cannot reach the roster — not because the page hides the
   option, but because the code never consults the Supabase session.
2. A staff session can expire on a fixed schedule (60 minutes) without fighting
   Supabase Auth's refresh-token model. A refresh would silently extend it.
3. The browser cannot extend a session. The token is a pointer to a session row
   with an `expires_at`; there is nothing client-side to modify.

Participants connect as `authenticated`; staff connect as `anon`. Each is scoped
by its own RLS family.

## The three tiers

Enforced by RLS, and mirrored in the UI only as a convenience.

| Role          | Roster | Audit log | Staff accounts | Pricing |
| ------------- | ------ | --------- | -------------- | ------- |
| `coordinator` | read   | —         | —              | read    |
| `admin`       | read + update | read | —        | read    |
| `master`      | read + update + delete | read | create / update / deactivate | read + write |

`staff_at_least(role)` is the single predicate every policy calls; it resolves
the header to a live session row on each request, so expiry, revocation and
deactivation all take effect immediately.

### Managing accounts from the panel

A master does the full set from the Staff tab — no CLI, no SQL:

- **Create** an account at any tier, including another master, with the
  "Add an account" form.
- **Read** the account list with role, status and last sign-in.
- **Update** a role, a full name, or a password.
- **Deactivate** to revoke access.

Deactivation stands in for delete on purpose. `staff_users` rows are referenced
by `staff_audit_log.staff_id` and by every payment confirmed under that
username; removing a row would leave those actions attributed to an account that
no longer exists. The database also refuses to deactivate or demote the last
active master, so the panel cannot lock everyone out.

Two details worth knowing. A password reset also revokes that account's live
sessions — resetting the password while leaving the old session alive would not
actually revoke anything. And `staff_update` treats a NULL argument as "leave
this alone", which is how one call can change a role without touching a name.

`npm run verify:staff-ui` drives all of this through the real console UI as a
real master, against the live project, and asserts the results in the database
and the audit log. It creates only marked probe accounts and removes them in a
`finally` block.

Two deliberate asymmetries:

- **Delete is master-only.** Removing a registration destroys the only record
  that a real payment was made.
- **The audit log is admin-and-above, not master-only.** An admin verifies
  participants, so they should be able to check who else did and when. A
  coordinator reads the roster but not the history of decisions about it.

A guard in `staff_update()` refuses to deactivate or demote the **only** active
master. Without it, one click would lock the console out permanently, since
adding a master requires a master.

## The audit trail

`public.staff_audit_log` is append-only. Client roles may `SELECT` (admin+) and
nothing else — no insert, no update, no delete.

Entries are written by the **database**, not by the console:

- `BEFORE UPDATE` on `registrations` — captures `payment_status`, `utr_number`
  and `payment_verified_by` changes with their before/after values.
- `BEFORE DELETE` on `registrations` — captures the removed row's details, so a
  deletion leaves a record even though the row is gone.
- `AFTER INSERT/UPDATE/DELETE` on `pricing` — captures old and new price.
- Explicit inserts inside `staff_login` / `staff_logout` / `staff_create` /
  `staff_update` / `staff_revoke_sessions` / `staff_bootstrap_master`.

So a client cannot omit an entry, and cannot alter one afterwards. The console's
Audit tab is a read-only window onto it, answering exactly the question asked:
*which operator confirmed this participant, and at what time* — as
`update_registration` with `from_status` / `to_status` / `verified_by`.

## Pricing in the database

`public.pricing` holds `(kind, ref_id, price, is_active)` for 8 bundles and 11
events — **the real prices from `bundles.js` / `events.js`**, seeded by
`npm run db:sync-pricing`, not invented placeholders. The sync is insert-only by
default so re-running it cannot undo a price a master has since changed;
`--overwrite` is the explicit reset.

The split is deliberate: the *shape* of a bundle (realm, what's included, the
copy) stays in JS, because it changes with the design. The *number* moved,
because the number is what changes between event cycles.

`src/data/pricing.js` prefers the database and falls back to the JS constant
only when the database has not answered on a cold first paint. `getPrice()`
returns `null` rather than guessing, so a cold page renders `—` instead of a
confidently wrong price.

### The wiring, and why it was the hard part

The schema was right from the start; the path from the table to the screen was
not. Three separate defects meant an edited price never appeared anywhere, and
every existing test still passed — because they all asserted against the same
compiled-in constants that were being rendered:

1. **Nothing on the public site ever fetched `pricing`.** `loadPricing()` was
   only called from the console, so the store was empty everywhere else.
2. **The components read the raw constants anyway.** `BundleCard` rendered
   `bundle.price`; `EventRow`, `ParadoxCard`, `MetaRow` and `EventDetail`
   rendered `event.payment`. The DB-first accessors (`getBundlePrice`,
   `getEventFee`, `formatEventFee`) existed precisely for this and had no call
   sites. This is also what made the bug easy to miss on review: the helpers
   were right there in the file.
3. **Nothing subscribed to price changes.** The store is mutated outside React,
   so even a successful load would not have repainted anything.

The fix is `loadPricing()` once at app start (`App.jsx`) plus `usePricing()`, a
`useSyncExternalStore` subscription that each price-rendering component calls.
`loadPricing()` is single-flight, so a dozen subscribers produce one request.
Every price surface now reads through an accessor — including the UPI deep link
on `/register`, which encodes the amount, and the `purchase_label` persisted on
the registration row, which would otherwise have frozen a stale price into the
roster permanently.

`npm run verify:pricing` is the regression test. It moves a real price in the
database and asserts the *rendered* page changes to match, then restores it. It
is the only check that would have caught this, and it restores the price in a
`finally` block so a failure cannot leave a fictional price on the public site.

## Security decisions worth calling out

- **Tokens are stored hashed** (sha256). A database dump yields no usable
  session.
- **No username enumeration.** An unknown username and a wrong password return
  the identical message, and an unknown username still pays the bcrypt cost, so
  the two are not even distinguishable by timing.
- **Brute-force brake.** 5 failures locks an account for 15 minutes.
- **`staff_users` has no INSERT/UPDATE policy for anyone**, so account changes
  can only happen through the audited functions.
- **Staff have no INSERT on `registrations`.** They can read, update and (as
  master) delete, but only a signed-in participant may create a row.
- **The bootstrap path self-closes.** `staff_bootstrap_master()` works only
  while `staff_users` is empty, and writes an audit row saying so.

## Verification

```
npm run verify:staff      23/23 — real PostgREST, real token, real master account
npm run verify:staff-ui   23/23 — staff CRUD driven through the real console UI
npm run verify:pricing     6/6  — a price edit reaches the rendered public page
npm run verify:rls        30/30 — participant model, unchanged
npm run verify             pass — console gate: no roster, no social login
npm test                  13/13 — deploy/CSP/config invariants
npm run build              pass
```

The two new checks are the ones that would have caught the defects described
above. Both needed to exist: the features they cover were reported working by a
suite that could not observe them, because it asserted against the same stale
constants the UI was rendering. `verify:pricing` moves a real price and reads the
price back out of the rendered DOM; `verify:staff-ui` signs in as a real master
and creates, promotes and deactivates accounts through the actual form.

`verify:staff` drives the endpoints the browser actually uses, rather than
impersonating sessions inside SQL, so it would catch a header-name mismatch that
an in-database test never would. It creates its own admin and coordinator,
proves each tier's boundaries (a coordinator sees the roster but writes nothing;
a non-master sees no staff accounts; a coordinator sees no audit entries), then
removes the accounts, sessions and audit rows it made.

## What is left

- **Change the master passphrase** from the one used during setup, and add an
  admin and a coordinator from the Staff tab.
- **The pre-ownership registration** (`Sai Sujith BV`) is still unclaimed. It is
  reclaimed the same way as in Phase 2: the author signs in with the matching
  Google account and submits a reference.
- **Reclamation is still email-matched**, not name-matched, so two people who
  share an address at one college cannot silently merge. Deliberate.
- **A real payment webhook** is still deferred; the status transitions it would
  drive are in place.