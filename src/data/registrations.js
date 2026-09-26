/**
 * Local registration store — a 1:1 mirror of the staged Supabase schema
 * (supabase/migrations/20260926000000_create_registrations.sql) so the Admin
 * console runs today with zero backend.
 *
 * Swap-in path: every export below maps to one future Supabase call
 * (select / update / delete). When keys land, replace the function bodies
 * with @supabase/supabase-js queries — the Admin page API stays identical.
 *
 * Payment flow (same invariants as the SQL CHECKs):
 *   awaiting_utr  — registered, no UTR yet
 *   unverified    — participant submitted a UTR, admin has NOT confirmed
 *   verified      — admin confirmed (payment_verified_at / _by stamped)
 *   rejected      — admin rejected; participant may submit a corrected UTR
 */
const STORAGE_KEY = "nexus.registrations.v1";

/** Who confirmed/rejected while auth is missing — future: signed-in admin. */
export const ADMIN_ACTOR = "admin@nexus.local";

const nowISO = () => new Date().toISOString();
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Seed roster — fake data covering every status of the UTR flow. */
const SEED = [
  {
    id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    name: "Aarav Sharma",
    roll_number: "21B81A0501",
    college_name: "AITS Tirupati",
    year: "3rd",
    department: "CSE",
    phone_number: "+91 90000 00001",
    email: "aarav.sharma@example.com",
    payment_status: "verified",
    utr_number: "402345678912",
    utr_submitted_at: "2026-09-18T10:24:00.000Z",
    payment_verified_at: "2026-09-19T06:10:00.000Z",
    payment_verified_by: "admin@nexus",
    created_at: "2026-09-17T09:00:00.000Z",
    updated_at: "2026-09-19T06:10:00.000Z",
  },
  {
    id: "8b1d2e6a-9c3f-4f0e-b2a7-1d5c6e7f8a90",
    name: "Meera Iyer",
    roll_number: "22B83A0214",
    college_name: "AITS Tirupati",
    year: "2nd",
    department: "ECE",
    phone_number: "9000000002",
    email: "meera.iyer@example.com",
    payment_status: "verified",
    utr_number: "402345678913",
    utr_submitted_at: "2026-09-18T12:05:00.000Z",
    payment_verified_at: "2026-09-19T06:12:00.000Z",
    payment_verified_by: "admin@nexus",
    created_at: "2026-09-18T11:40:00.000Z",
    updated_at: "2026-09-19T06:12:00.000Z",
  },
  {
    id: "c9e7f3b1-4a2d-4c88-9f6e-3b5a7d9c1e24",
    name: "Rohan Verma",
    roll_number: "23B95A1102",
    college_name: "JNTU Anantapur",
    year: "4th",
    department: "IT",
    phone_number: "+91-9000000003",
    email: "rohan.verma@example.com",
    payment_status: "verified",
    utr_number: "402345678914",
    utr_submitted_at: "2026-09-17T09:30:00.000Z",
    payment_verified_at: "2026-09-17T15:45:00.000Z",
    payment_verified_by: "admin@nexus",
    created_at: "2026-09-17T09:20:00.000Z",
    updated_at: "2026-09-17T15:45:00.000Z",
  },
  {
    id: "2a4f6b8c-0d1e-4a3b-8c5d-7e9f0a1b2c3d",
    name: "Sneha Reddy",
    roll_number: "21B87A0444",
    college_name: "SVU Tirupati",
    year: "3rd",
    department: "IT",
    phone_number: "9000000004",
    email: "sneha.reddy@example.com",
    payment_status: "verified",
    utr_number: "402345678915",
    utr_submitted_at: "2026-09-16T14:10:00.000Z",
    payment_verified_at: "2026-09-16T18:02:00.000Z",
    payment_verified_by: "admin@nexus",
    created_at: "2026-09-16T14:00:00.000Z",
    updated_at: "2026-09-16T18:02:00.000Z",
  },
  {
    id: "6d8e0f2a-4b6c-4d8e-9f0a-1b3c5d7e9f10",
    name: "Karthik Naidu",
    roll_number: "22B92A0331",
    college_name: "RVR & JC Guntur",
    year: "2nd",
    department: "ECE",
    phone_number: "+91 9000000005",
    email: "karthik.naidu@example.com",
    payment_status: "verified",
    utr_number: "402345678916",
    utr_submitted_at: "2026-09-15T08:45:00.000Z",
    payment_verified_at: "2026-09-15T11:30:00.000Z",
    payment_verified_by: "admin@nexus",
    created_at: "2026-09-15T08:30:00.000Z",
    updated_at: "2026-09-15T11:30:00.000Z",
  },
  {
    id: "7f3a9c1d-5e2b-4f60-8a74-0c9d1e3b5a76",
    name: "Vikram Patel",
    roll_number: "23B81A0666",
    college_name: "AITS Tirupati",
    year: "3rd",
    department: "MECH",
    phone_number: "9000000006",
    email: "vikram.patel@example.com",
    payment_status: "unverified",
    utr_number: "402345678917",
    utr_submitted_at: "2026-09-22T16:20:00.000Z",
    payment_verified_at: null,
    payment_verified_by: null,
    created_at: "2026-09-22T16:10:00.000Z",
    updated_at: "2026-09-22T16:20:00.000Z",
  },
  {
    id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    name: "Ananya Rao",
    roll_number: "22B95A0227",
    college_name: "JNTU Anantapur",
    year: "2nd",
    department: "CSE",
    phone_number: "+91 9000000007",
    email: "ananya.rao@example.com",
    payment_status: "unverified",
    utr_number: "402345678918",
    utr_submitted_at: "2026-09-23T09:05:00.000Z",
    payment_verified_at: null,
    payment_verified_by: null,
    created_at: "2026-09-23T08:55:00.000Z",
    updated_at: "2026-09-23T09:05:00.000Z",
  },
  {
    id: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
    name: "Imran Khan",
    roll_number: "24B87A0119",
    college_name: "SVU Tirupati",
    year: "1st",
    department: "ECE",
    phone_number: "9000000008",
    email: "imran.khan@example.com",
    payment_status: "unverified",
    utr_number: "402345678919",
    utr_submitted_at: "2026-09-23T11:47:00.000Z",
    payment_verified_at: null,
    payment_verified_by: null,
    created_at: "2026-09-23T11:30:00.000Z",
    updated_at: "2026-09-23T11:47:00.000Z",
  },
  {
    id: "3b5d7f9a-1c3e-4a6b-8d0c-2e4f6a8b0c2d",
    name: "Divya Menon",
    roll_number: "23B81A0812",
    college_name: "AITS Tirupati",
    year: "2nd",
    department: "CSE",
    phone_number: "+91 9000000009",
    email: "divya.menon@example.com",
    payment_status: "unverified",
    utr_number: "402345678920",
    utr_submitted_at: "2026-09-24T07:35:00.000Z",
    payment_verified_at: null,
    payment_verified_by: null,
    created_at: "2026-09-24T07:20:00.000Z",
    updated_at: "2026-09-24T07:35:00.000Z",
  },
  {
    id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    name: "Aditya Joshi",
    roll_number: "24B81A0044",
    college_name: "AITS Tirupati",
    year: "1st",
    department: "IT",
    phone_number: "9000000010",
    email: "aditya.joshi@example.com",
    payment_status: "awaiting_utr",
    utr_number: null,
    utr_submitted_at: null,
    payment_verified_at: null,
    payment_verified_by: null,
    created_at: "2026-09-24T10:00:00.000Z",
    updated_at: "2026-09-24T10:00:00.000Z",
  },
  {
    id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
    name: "Priya Deshpande",
    roll_number: "22B92A0508",
    college_name: "RVR & JC Guntur",
    year: "3rd",
    department: "CSE",
    phone_number: "+91-9000000011",
    email: "priya.deshpande@example.com",
    payment_status: "awaiting_utr",
    utr_number: null,
    utr_submitted_at: null,
    payment_verified_at: null,
    payment_verified_by: null,
    created_at: "2026-09-24T12:15:00.000Z",
    updated_at: "2026-09-24T12:15:00.000Z",
  },
  {
    id: "4a3b2c1d-0e9f-4a8b-7c6d-5e4f3a2b1c0d",
    name: "Suresh Kumar",
    roll_number: "23B87A0733",
    college_name: "SVU Tirupati",
    year: "2nd",
    department: "MECH",
    phone_number: "9000000012",
    email: "suresh.kumar@example.com",
    payment_status: "awaiting_utr",
    utr_number: null,
    utr_submitted_at: null,
    payment_verified_at: null,
    payment_verified_by: null,
    created_at: "2026-09-25T09:40:00.000Z",
    updated_at: "2026-09-25T09:40:00.000Z",
  },
  {
    id: "8c7b6a5d-4e3f-4b2a-9c1d-0e9f8a7b6c5d",
    name: "Tanya Gupta",
    roll_number: "22B95A0341",
    college_name: "JNTU Anantapur",
    year: "3rd",
    department: "ECE",
    phone_number: "+91 9000000013",
    email: "tanya.gupta@example.com",
    payment_status: "rejected",
    utr_number: "402345678991",
    utr_submitted_at: "2026-09-21T13:10:00.000Z",
    payment_verified_at: null,
    payment_verified_by: null,
    created_at: "2026-09-21T13:00:00.000Z",
    updated_at: "2026-09-21T17:25:00.000Z",
  },
  {
    id: "d0c9b8a7-6f5e-4d3c-b2a1-0f9e8d7c6b5a",
    name: "Nikhil Bansal",
    roll_number: "21B81A0955",
    college_name: "AITS Tirupati",
    year: "4th",
    department: "CSE",
    phone_number: "9000000014",
    email: "nikhil.bansal@example.com",
    payment_status: "rejected",
    utr_number: "402345678992",
    utr_submitted_at: "2026-09-20T18:55:00.000Z",
    payment_verified_at: null,
    payment_verified_by: null,
    created_at: "2026-09-20T18:40:00.000Z",
    updated_at: "2026-09-21T08:15:00.000Z",
  },
];
/* Demo purchase context for the seed roster — mirrors what the /register
 * wizard records from ?event= / ?bundle= so the admin panel shows a live
 * mix of event entries and bundles out of the box. */
[
  ["event", "NEXUS BREACH"],
  ["event", "VISION 2065"],
  ["bundle", "BUNDLED #01 · ₹299"],
  ["event", "THE SCIENTIST FILES"],
  ["event", "MATRIX"],
  ["bundle", "NEXUS REBUILDERS BUNDLED #04 · ₹399"],
  ["event", "FREE FIRE"],
  ["event", "CIRCUITS OF NEXUS"],
  ["bundle", "BUNDLED #02 · ₹349"],
  ["event", "PIXEL RESISTANCE"],
  ["bundle", "NEXUS OFF-GRID BUNDLED #08 · ₹349"],
  ["event", "AI TURING GAMBIT"],
  ["bundle", "BUNDLED #05 · ₹399"],
  ["event", "SHUTTER QUEST"],
].forEach(([type, label], i) => {
  if (SEED[i]) {
    SEED[i].purchase_type = type;
    SEED[i].purchase_label = label;
  }
});

/* ---------- persistence (localStorage today, Supabase tomorrow) ---------- */

function persist(rows) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    /* private mode / quota — in-memory state still works for the session */
  }
  return rows;
}

/** All participants, newest first. Maps to: supabase.from("registrations").select() */
export function listRegistrations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* fall through to seed */
  }
  return clone(SEED);
}

/**
 * Dashboard totals — participants, distinct colleges, payment states.
 * Mirrors the SQL the admin will eventually run as grouped selects.
 */
export function getStats(rows = listRegistrations()) {
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

/**
 * Admin confirms the UTR → payment_status "verified" with audit stamps.
 * Invariant (same as chk_registrations_utr_state): only rows that actually
 * hold a UTR and are waiting in "unverified" can be confirmed.
 * Maps to: supabase.from("registrations").update({...}).eq("id", id)
 */
export function confirmPayment(id, actor = ADMIN_ACTOR) {
  return persist(
    listRegistrations().map((r) =>
      r.id === id && r.payment_status === "unverified" && r.utr_number
        ? {
            ...r,
            payment_status: "verified",
            payment_verified_at: nowISO(),
            payment_verified_by: actor,
            updated_at: nowISO(),
          }
        : r,
    ),
  );
}

/** Admin rejects the UTR (participant may submit a corrected one later). */
export function rejectPayment(id) {
  return persist(
    listRegistrations().map((r) =>
      r.id === id && r.payment_status === "unverified"
        ? {
            ...r,
            payment_status: "rejected",
            payment_verified_at: null,
            payment_verified_by: null,
            updated_at: nowISO(),
          }
        : r,
    ),
  );
}

/** Remove a participant. Maps to: supabase.from("registrations").delete() */
export function removeRegistration(id) {
  return persist(listRegistrations().filter((r) => r.id !== id));
}

/** Restore the fake roster (dev/verify helper). */
export function resetRegistrations() {
  return persist(clone(SEED));
}

/* ---------- registration intake (the /register wizard) ---------- */

/**
 * Client-side mirror of the SQL CHECKs — same rules the remote table enforces,
 * so bad rows never reach localStorage or PostgREST.
 * Returns null when valid, or a human-readable error string.
 */
export function validateRegistration(v) {
  const t = (s) => String(s ?? "").trim();
  if (t(v.name).length < 2 || t(v.name).length > 120) return "Name must be 2–120 characters.";
  if (t(v.roll_number).length < 3 || t(v.roll_number).length > 40) return "Roll number must be 3–40 characters.";
  if (t(v.college_name).length < 2 || t(v.college_name).length > 160) return "College name must be 2–160 characters.";
  if (!["1st", "2nd", "3rd", "4th"].includes(v.year)) return "Select an academic year.";
  if (t(v.department).length < 2 || t(v.department).length > 80) return "Department must be 2–80 characters.";
  const phone = t(v.phone_number);
  if (phone.length < 8 || phone.length > 15 || !/^[+0-9][0-9 -]*[0-9]$/.test(phone)) {
    return "Phone must be 8–15 chars: digits with optional +, space or -.";
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t(v.email))) return "Enter a valid email address.";
  if (v.utr_number != null) {
    const utr = t(v.utr_number);
    if (!/^[A-Za-z0-9-]{6,30}$/.test(utr)) return "UTR must be 6–30 letters, digits or dashes.";
  }
  return null;
}

const uuid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });

/**
 * Record a completed /register wizard submission locally.
 * End state matches the schema: paid flow → "unverified" (UTR in, waiting for
 * admin confirm); free event → "awaiting_utr" (registered, nothing due).
 * Maps to: supabase.from("registrations").insert(row) — src/lib/supabase.js
 * sends the same row to the remote project.
 * Returns { row } on success or { error } with a message.
 */
export function addRegistration(input) {
  const error = validateRegistration(input);
  if (error) return { error };
  const rows = listRegistrations();
  const email = String(input.email).trim().toLowerCase();
  if (rows.some((r) => String(r.email).trim().toLowerCase() === email)) {
    return { error: "This email is already registered." };
  }
  const hasUtr = input.utr_number != null && String(input.utr_number).trim() !== "";
  const ts = nowISO();
  const row = {
    id: uuid(),
    name: String(input.name).trim(),
    roll_number: String(input.roll_number).trim(),
    college_name: String(input.college_name).trim(),
    year: input.year,
    department: String(input.department).trim(),
    phone_number: String(input.phone_number).trim(),
    email,
    payment_status: hasUtr ? "unverified" : "awaiting_utr",
    utr_number: hasUtr ? String(input.utr_number).trim() : null,
    utr_submitted_at: hasUtr ? ts : null,
    payment_verified_at: null,
    payment_verified_by: null,
    purchase_type: input.purchase_type ?? null,
    purchase_label: input.purchase_label ?? null,
    created_at: ts,
    updated_at: ts,
  };
  persist([row, ...rows]);
  return { row };
}
