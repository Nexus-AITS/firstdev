/**
 * Registration repository — Supabase is the source of truth.
 *
 * There is no local mirror any more. The old design kept a localStorage copy
 * with a 14-row demo roster and pushed to Supabase best-effort, which meant
 * the admin console could show participants who had never registered and the
 * database could hold rows no browser had verified. Every function below is now
 * a real query against public.registrations, and RLS decides what each caller
 * may see (migration 20260926000003_participant_rls_and_admin_users.sql):
 *
 *   participant  — insert, and read/correct ONLY their own row (user_id)
 *   admin        — read every row, verify / reject / delete
 *   anon         — nothing at all
 *
 * Payment flow (identical to the SQL CHECKs):
 *   awaiting_utr  — registered, no UTR yet
 *   unverified    — participant submitted a UTR, admin has NOT confirmed
 *   verified      — admin confirmed (payment_verified_at / _by stamped)
 *   rejected      — admin rejected; participant may submit a corrected UTR
 *
 * Every function resolves to { data, error } instead of throwing: each caller
 * has a designed empty/failed state, and a rejected promise escaping into a
 * React event handler is exactly the unhandled rejection that blanks a route.
 */
import { getAuthClient } from "../config/supabase.js";
import { getEventFields } from "./events.js";

/** PostgREST error codes worth translating into something a human can act on. */
const UNIQUE_VIOLATION = "23505";
/** Raise the guard trigger's own errcode. */
const INSUFFICIENT_PRIVILEGE = "42501";

/** Resolve the shared client, or a report explaining why there isn't one. */
async function client() {
  const supabase = await getAuthClient();
  if (!supabase) {
    return { error: "The NEXUS database is not reachable from this deployment." };
  }
  return { supabase };
}

/**
 * Turn a PostgREST / trigger error into a sentence a participant can act on.
 * Raw messages leak constraint names and column lists, which is noise at best
 * and a small amount of schema information at worst.
 */
function explain(error, context) {
  if (!error) return null;
  if (error.code === UNIQUE_VIOLATION) {
    // Which unique index fired changes the fix, so name the constraint when
    // Postgres included it, and fall back to the generic case otherwise.
    const detail = String(error.message ?? "").toLowerCase();
    if (detail.includes("email")) return "This email is already registered.";
    if (detail.includes("utr"))
      return "That UTR has already been used for another registration.";
    if (detail.includes("roll"))
      return "This roll number is already registered for that college.";
    return "That registration already exists.";
  }
  if (error.code === INSUFFICIENT_PRIVILEGE) {
    return "Only the NEXUS operations team can change payment verification.";
  }
  return error.message ? `${context}: ${error.message}` : context;
}

/* ---------- admin gate ---------- */

/**
 * Is the signed-in user on the operations roster?
 *
 * public.admin_users carries a read policy scoped to `user_id = auth.uid()`,
 * so this asks the database "am I an admin?" and the answer is enforced there,
 * not asserted in the browser. Returns null when nobody is signed in, so the
 * caller can distinguish "not signed in" from "signed in, not an admin".
 */
export async function isAdminUser() {
  const { supabase, error } = await client();
  if (error || !supabase) return false;

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return null;

  const { data, error: queryError } = await supabase
    .from("admin_users")
    .select("user_id, email, full_name")
    .eq("user_id", userId)
    .maybeSingle();

  if (queryError) return false;
  return data ? { email: data.email, full_name: data.full_name ?? null } : null;
}

/* ---------- reads ---------- */

/**
 * The roster.
 *
 * One query serves both callers because RLS filters it: an admin gets every
 * row, a participant gets only their own. Order is applied in SQL rather than
 * by counting in the array — Supabase caps rows per request, so a client-side
 * sort would silently order a truncated page.
 */
export async function listRegistrations() {
  const { supabase, error } = await client();
  if (error) return { data: [], error };

  const { data, error: queryError } = await supabase
    .from("registrations")
    .select("*")
    .order("created_at", { ascending: false });

  if (queryError) return { data: [], error: explain(queryError, "Could not load registrations") };
  return { data: data ?? [], error: null };
}

/**
 * Dashboard totals — participants, distinct colleges, payment states.
 *
 * Computed from the rows the caller already has rather than a second set of
 * grouped queries: the roster is small, and deriving both from one fetch keeps
 * the numbers and the table provably consistent with each other (a separate
 * aggregate could be read between the two and disagree).
 */
export function getStats(rows = []) {
  const colleges = new Set();
  const stats = {
    total: rows.length,
    colleges: 0,
    verified: 0,
    unverified: 0,
    awaiting: 0,
    rejected: 0,
    events: 0,
    bundles: 0,
  };
  for (const r of rows) {
    colleges.add(String(r.college_name || "").trim().toLowerCase());
    if (r.purchase_type === "event") stats.events += 1;
    else if (r.purchase_type === "bundle") stats.bundles += 1;
    if (r.payment_status === "verified") stats.verified += 1;
    else if (r.payment_status === "unverified") stats.unverified += 1;
    else if (r.payment_status === "rejected") stats.rejected += 1;
    else stats.awaiting += 1;
  }
  stats.colleges = colleges.size;
  return stats;
}

/* ---------- writes ---------- */

/**
 * Apply a patch to one registration.
 *
 * The `.eq("id", id)` is the whole security story: RLS's USING clause decides
 * whether that row is visible at all, so a guessed UUID from a non-admin is not
 * "not found" by luck, it is filtered out. `.select()` afterwards is what
 * returns the post-trigger row (timestamps, utr_submitted_at) so the caller
 * re-renders real database state instead of its own optimistic guess.
 */
async function patchRegistration(id, patch, context) {
  const { supabase, error } = await client();
  if (error) return { data: null, error };

  const { data, error: queryError } = await supabase
    .from("registrations")
    .update(patch)
    .eq("id", id)
    .select()
    .maybeSingle();

  if (queryError) return { data: null, error: explain(queryError, context) };
  if (!data) {
    return {
      data: null,
      error: "That registration is no longer available — it may have been removed.",
    };
  }
  return { data, error: null };
}

/**
 * Admin confirms the UTR → payment_status "verified" with audit stamps.
 *
 * payment_verified_at is left to the database: trg_registrations_payment_audit
 * stamps it server-side, so the timestamp is the database's clock rather than
 * whatever the operator's machine believed. payment_verified_by is the signed-in
 * admin's email, which is the only audit identity the schema can be sure of.
 */
export async function confirmPayment(id, actor) {
  if (!actor) return { data: null, error: "Sign in as an administrator first." };
  return patchRegistration(
    id,
    { payment_status: "verified", payment_verified_by: actor },
    "Could not confirm that payment"
  );
}

/**
 * Admin rejects the UTR. The participant may submit a corrected one later —
 * their own UPDATE policy allows re-entering a UTR while not verified.
 */
export async function rejectPayment(id) {
  return patchRegistration(id, { payment_status: "rejected" }, "Could not reject that payment");
}

/** Remove a participant. */
export async function removeRegistration(id) {
  const { supabase, error } = await client();
  if (error) return { data: null, error };

  const { error: queryError } = await supabase.from("registrations").delete().eq("id", id);
  if (queryError) return { data: null, error: explain(queryError, "Could not remove that registration") };
  return { data: { id }, error: null };
}

/* ---------- registration intake (the /register wizard) ---------- */

/**
 * Client-side mirror of the SQL CHECKs — same rules the table enforces, so a
 * bad row costs one round trip instead of a constraint-violation error, and the
 * participant sees the message in their own language.
 *
 * This is a convenience, NOT the control: every rule here is re-checked by the
 * database. Duplicating them client-side is only safe because the server is
 * strict on every one, which is what the RLS WITH CHECK clause guarantees.
 *
 * Returns null when valid, or a human-readable error string.
 */
export function validateRegistration(v) {
  const t = (s) => String(s ?? "").trim();
  if (t(v.name).length < 2 || t(v.name).length > 120) return "Name must be 2–120 characters.";
  if (t(v.roll_number).length < 3 || t(v.roll_number).length > 40)
    return "Roll number must be 3–40 characters.";
  if (t(v.college_name).length < 2 || t(v.college_name).length > 160)
    return "College name must be 2–160 characters.";
  if (!["1st", "2nd", "3rd", "4th"].includes(v.year)) return "Select an academic year.";
  if (t(v.department).length < 2 || t(v.department).length > 80)
    return "Department must be 2–80 characters.";
  const phone = t(v.phone_number);
  if (phone.length < 8 || phone.length > 15 || !/^[+0-9][0-9 -]*[0-9]$/.test(phone)) {
    return "Phone must be 8–15 chars: digits with optional +, space or -.";
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t(v.email))) return "Enter a valid email address.";
  if (v.utr_number != null && v.utr_number !== "") {
    const utr = t(v.utr_number);
    if (!/^[A-Za-z0-9-]{6,30}$/.test(utr)) return "UTR must be 6–30 letters, digits or dashes.";
  }
  return null;
}

/**
 * The event-specific inputs this purchase must carry.
 *
 * Same rules as the database trigger, and for the same reason: the trigger
 * (migration …011) is the authority, this is the round trip saved and the
 * message written in the participant's own language.
 *
 * Driven entirely by what the catalogue declares for the event, so adding a
 * field to events.js needs no change here.
 */
export function validateEventFields(purchaseRef, values) {
  for (const field of getEventFields(purchaseRef)) {
    const value = String(values?.[field.name] ?? "").trim();
    if (!value) {
      return `${field.label} is required for this event.`;
    }
    const max = field.maxLength ?? 32;
    if (value.length > max) {
      return `${field.label} must be ${max} characters or fewer.`;
    }
  }
  return null;
}



/**
 * Copy the catalogue's declared event inputs onto a row.
 *
 * Driven by `getEventFields(purchaseRef)` rather than by the keys the caller
 * sent, so an arbitrary key in the payload can never become a column — the
 * caller asks for a value, the catalogue decides which values exist.
 */
function declaredEventFieldValues(purchaseRef, values) {
  const out = {};
  for (const field of getEventFields(purchaseRef)) {
    out[field.name] = String(values?.[field.name] ?? "").trim() || null;
  }
  return out;
}

/**
 * Record a completed /register wizard submission.
 *
 * End state matches the schema: paid flow → "unverified" (UTR in, waiting for
 * admin confirm); free event → "awaiting_utr" (registered, nothing due).
 *
 * user_id is deliberately NOT sent. trg_registrations_set_user_id stamps it
 * from the JWT and the INSERT policy requires `user_id = auth.uid()`, so a
 * client that tried to supply someone else's id would be rejected — and a
 * client that supplied nothing gets the correct value for free.
 *
 * The timestamps are likewise absent: created_at, updated_at and utr_submitted_at
 * are all database concerns, and a browser clock is not a trustworthy source
 * for a payment audit trail.
 */
export async function addRegistration(input) {
  const invalid = validateRegistration(input);
  if (invalid) return { data: null, error: invalid };

  const { supabase, error } = await client();
  if (error) return { data: null, error };

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user?.id) {
    return { data: null, error: "Sign in with Google before registering." };
  }

  const hasUtr = input.utr_number != null && String(input.utr_number).trim() !== "";
  /* CASH vs UTR, decided once, at signup.
     A cash registration has no reference and never will - the money moves at
     the desk - so it is stored as awaiting_cash rather than reusing
     awaiting_utr, which would put "awaiting UTR" on the roster beside somebody
     who will never paste one. The two states are mutually exclusive and the
     table CHECK refuses a cash row carrying a reference, so this cannot produce
     a row that claims to have been paid electronically.

     The method is NOT changeable afterwards: the guard trigger does not let a
     participant move a row between the two, and that is deliberate. A
     participant who picks wrong asks the operations team. */
  const isCash = input.payment_method === "cash";
  const row = {
    name: String(input.name).trim(),
    roll_number: String(input.roll_number).trim(),
    college_name: String(input.college_name).trim(),
    year: input.year,
    department: String(input.department).trim(),
    phone_number: String(input.phone_number).trim(),
    email: String(input.email).trim().toLowerCase(),
    payment_method: isCash ? "cash" : "utr",
    payment_status: isCash ? "awaiting_cash" : hasUtr ? "unverified" : "awaiting_utr",
    utr_number: isCash ? null : hasUtr ? String(input.utr_number).trim() : null,
    purchase_type: input.purchase_type ?? null,
    purchase_label: input.purchase_label ?? null,
    // The catalogue id (?event= / ?bundle=), so the profile page can hand the
    // participant back to this exact wizard. Nullable by design: the column is
    // new, and a null here simply means "no resume target" rather than a
    // guessed one.
    purchase_ref: input.purchase_ref ?? null,
    // The team this leader brings, for an event whose team is formed here.
    // Sent on the insert rather than in a second call so a resumed leader
    // cannot end up with a registration that is missing the name they already
    // typed. Null on every individual event.
    team_name: input.team_name ? String(input.team_name).trim() : null,
    // Event-specific inputs, e.g. the in-game Free Fire ID.
    ...declaredEventFieldValues(input.purchase_ref, input.eventFields),
  };

  // .select() asks PostgREST to return the stored row (with id and the
  // database's own timestamps) instead of a bare 201, so the confirmation
  // screen can show the real reference the participant will be verified on.
  const { data, error: queryError } = await supabase
    .from("registrations")
    .insert(row)
    .select()
    .single();

  if (queryError) {
    return { data: null, error: explain(queryError, "Could not save that registration") };
  }
  return { data, error: null };
}

/**
 * Submit or correct a UTR on a registration that is not yet verified.
 *
 * Used when a payment was rejected. The UPDATE policy scopes the row to the
 * signed-in participant and the guard trigger forbids moving a verified row, so
 * this can never be used to re-open a confirmed payment.
 */
export async function submitUtr(id, utr) {
  const value = String(utr ?? "").trim();
  if (!/^[A-Za-z0-9-]{6,30}$/.test(value)) {
    return { data: null, error: "UTR must be 6–30 letters, digits or dashes." };
  }

  const { supabase, error } = await client();
  if (error) return { data: null, error };

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return { data: null, error: "Sign in before submitting a reference." };

  // user_id is sent on purpose. For a row we already own it equals the stored
  // value, so the guard's "is distinct from" check is false and nothing changes.
  // For a row inserted before migration ...0003 it is NULL, so this is the claim:
  // the UPDATE policy admits the row (its email matches this account) and the
  // guard trigger's claim branch allows the ownership change. That is how a
  // pre-migration registration becomes visible to its author again instead of
  // being orphaned forever.
  const { data, error: queryError } = await supabase
    .from("registrations")
    .update({ utr_number: value, payment_status: "unverified", user_id: userId })
    .eq("id", id)
    .select()
    .maybeSingle();

  if (queryError) {
    return { data: null, error: explain(queryError, "Could not submit that reference") };
  }
  if (!data) {
    return { data: null, error: "That registration is no longer available." };
  }
  return { data, error: null };
}

/* ---------- resume + profile reads ---------- */

/**
 * The events one of the caller's registrations covers.
 *
 * Needed to answer "has this participant already made their choice?", which is
 * what decides whether resuming a bundle registration lands on the selection
 * step or goes straight to the QR. RLS scopes it: participant_read_own_events
 * only admits a row whose registration belongs to the signed-in user, so this
 * can never read someone else's picks by guessing a registration id.
 */
export async function listRegistrationEvents(registrationId) {
  const { supabase, error } = await client();
  if (error) return { data: [], error };

  const { data, error: queryError } = await supabase
    .from("registration_events")
    .select("event_id")
    .eq("registration_id", registrationId)
    .order("event_id");

  if (queryError) {
    return { data: [], error: explain(queryError, "Could not load your selected events") };
  }
  return { data: data ?? [], error: null };
}

/**
 * The participant's own registrations WITH their selected events, in one query.
 *
 * Used by the profile page. The embedded join is a left join rather than
 * `!inner`: a registration with no selection yet (a single event, or a bundle
 * whose choice was never made) is exactly the row the page must show, and an
 * inner join would hide it — silently making a half-finished registration
 * invisible on the very screen that exists to resume it.
 */
export async function listMyRegistrationsDetailed() {
  const { supabase, error } = await client();
  if (error) return { data: [], error };

  const { data, error: queryError } = await supabase
    .from("registrations")
    .select("*, registration_events(event_id)")
    .order("created_at", { ascending: false });

  if (queryError) {
    return { data: [], error: explain(queryError, "Could not load your registrations") };
  }
  // Flatten the embed to a plain `events` array so the page never has to know
  // PostgREST's response shape, and so an absent embed is [] rather than null.
  const rows = (data ?? []).map((row) => ({
    ...row,
    events: (row.registration_events ?? []).map((line) => line.event_id),
    registration_events: undefined,
  }));
  return { data: rows, error: null };
}


/* ---------- the team a leader brings ---------- */

/**
 * Check one teammate, in the browser, against the same rules the table holds
 * them to.
 *
 * A convenience, never the control — registration_set_team_members re-checks
 * every field and trg_registration_members_cap re-checks the size, so a client
 * that skipped this would still be refused. What this buys is a message in the
 * leader's own language while they are still typing, instead of a 23514 after
 * they press save.
 *
 * `position` is 1-based and names WHICH teammate is wrong, because "a field is
 * invalid" on a list of four is not something anybody can act on.
 */
export function validateTeamMember(member, position) {
  const t = (s) => String(s ?? "").trim();
  const who = `Teammate ${position}`;
  if (t(member.name).length < 2 || t(member.name).length > 120)
    return `${who}: name must be 2–120 characters.`;
  if (t(member.roll_number).length < 3 || t(member.roll_number).length > 40)
    return `${who}: roll number must be 3–40 characters.`;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t(member.email)))
    return `${who}: enter a valid email address.`;
  if (t(member.college_name).length < 2 || t(member.college_name).length > 160)
    return `${who}: college must be 2–160 characters.`;
  if (!["1st", "2nd", "3rd", "4th"].includes(member.year))
    return `${who}: select an academic year.`;
  if (t(member.department).length < 2 || t(member.department).length > 80)
    return `${who}: department must be 2–80 characters.`;
  const phone = t(member.phone_number);
  if (phone && (phone.length < 8 || phone.length > 15 || !/^[+0-9][0-9 -]*[0-9]$/.test(phone)))
    return `${who}: phone must be 8–15 chars, or leave it blank.`;
  return null;
}

/**
 * The whole roster at once, so a leader fixing one mistake is told about all of
 * them rather than one per attempt.
 */
export function validateTeam(teamName, members) {
  const name = String(teamName ?? "").trim();
  if (name.length < 2 || name.length > 60)
    return "Give the team a name of 2 to 60 characters.";
  for (let i = 0; i < members.length; i += 1) {
    const problem = validateTeamMember(members[i], i + 1);
    if (problem) return problem;
  }
  const seen = new Set();
  for (let i = 0; i < members.length; i += 1) {
    const email = String(members[i]?.email ?? "").trim().toLowerCase();
    if (seen.has(email)) return `${email} appears twice in the teammate list.`;
    seen.add(email);
  }
  return null;
}


/**
 * Save a leader's team: the name, and every teammate, in one call.
 *
 * The browser sends FACTS. It does not send how many teammates there are, what
 * the cap is, or what the team size works out to — the database reads those from
 * the catalogue and enforces the cap on the table, so a client cannot talk its
 * way past a team of three.
 *
 * Replaces the whole roster rather than appending, so a leader who mistypes a
 * roll number fixes it with one save and the list on screen is the list on disk.
 */
export async function setRegistrationTeam({ registrationId, teamName, members }) {
  const { supabase, error } = await client();
  if (error) return { data: null, error };

  const { data, error: callError } = await supabase.rpc("registration_set_team_members", {
    p_registration_id: registrationId,
    // Only the fields the database reads. Anything else a caller put in the
    // object is dropped here rather than arriving as an unknown key.
    p_members: (members ?? []).map((m) => ({
      name: String(m?.name ?? "").trim(),
      roll_number: String(m?.roll_number ?? "").trim(),
      email: String(m?.email ?? "").trim().toLowerCase(),
      college_name: String(m?.college_name ?? "").trim(),
      year: m?.year ?? "",
      department: String(m?.department ?? "").trim(),
      phone_number: String(m?.phone_number ?? "").trim() || null,
    })),
    p_team_name: String(teamName ?? "").trim(),
  });

  if (callError) return { data: null, error: explainTeamError(callError) };
  const body = Array.isArray(data) ? data[0] : data;
  return { data: body ?? null, error: null };
}

/**
 * Turn a team rejection into something a leader can act on.
 *
 * The database raises 22023 with a sentence written for a human — "A team may
 * have at most 3 people and the leader counts as one, so you can add 2" — so
 * that text is passed through rather than replaced. Replacing it with something
 * generic would throw away the one message that explains the rule.
 */
function explainTeamError(error) {
  const message = String(error?.message ?? "");
  if (
    error?.code === "22023" ||
    /at most|leader counts|is missing|appears twice|not a team|is not yours|is final|2 to 60/i.test(
      message
    )
  ) {
    return message.replace(/^.*?:\s*/, "") || "That team could not be saved.";
  }
  if (error?.code === "42501") {
    return message.replace(/^.*?:\s*/, "") || "That team can no longer be changed.";
  }
  if (error?.code === "23514") {
    return message.replace(/^.*?:\s*/, "") || "That team is larger than the event allows.";
  }
  return "That team could not be saved. Please try again.";
}

/**
 * One registration's team: the name, the cap, the leader and the members.
 *
 * Read through registration_team() rather than a select on registration_members
 * so the SHAPE is the database's — the same shape the operations console and
 * the partner API both render, which is the point of having one function own
 * it. RLS scopes it to a registration the signed-in participant owns.
 */
export async function loadTeam(registrationId) {
  const { supabase, error } = await client();
  if (error) return { data: null, error };

  const { data, error: queryError } = await supabase.rpc("registration_team", {
    p_registration_id: registrationId,
  });
  if (queryError) {
    return { data: null, error: explain(queryError, "Could not load your team") };
  }
  const body = Array.isArray(data) ? data[0] : data;
  // No team for this purchase - an individual event, or the hackathon. Null
  // rather than an empty object, so a caller can tell "no team here" from
  // "this person's team is empty".
  return { data: body ?? null, error: null };
}

