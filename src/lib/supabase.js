/**
 * Supabase client — single shared instance for the app.
 *
 * Credentials come from `.env` (Vite only exposes `VITE_`-prefixed vars to
 * client code):
 *   VITE_SUPABASE_URL       https://<project-ref>.supabase.co
 *   VITE_SUPABASE_ANON_KEY  public anon key (safe for the browser; RLS gates access)
 *
 * The admin console's data layer (src/data/registrations.js) still reads the
 * local mirror; this client is the swap-in point — replace each store function
 * body with a query against `registrations` when the remote table is live.
 * See docs/supabase-data-model.md for the schema and wiring checklist.
 */
import { createClient } from "@supabase/supabase-js";

const url = (import.meta.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fail loudly during development instead of sending undefined headers.
  throw new Error(
    "Missing Supabase credentials: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY " +
      "must be set in .env (see .env.example)."
  );
}

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: false },
});

/**
 * Send a completed /register wizard row to the remote project.
 * Best-effort by design: the local store (src/data/registrations.js) is
 * always written first, so a cloud hiccup never loses a registration.
 * Returns { synced: true } or { synced: false, error }.
 */
export async function submitRegistration(row) {
  try {
    const { error } = await supabase.from("registrations").insert({
      name: row.name,
      roll_number: row.roll_number,
      college_name: row.college_name,
      year: row.year,
      department: row.department,
      phone_number: row.phone_number,
      email: row.email,
      payment_status: row.payment_status,
      utr_number: row.utr_number,
    });
    if (error) {
      console.warn("supabase insert rejected:", error.message, error.code);
      return { synced: false, error: error.message };
    }
    return { synced: true };
  } catch (err) {
    console.warn("supabase insert unreachable:", err?.message || err);
    return { synced: false, error: String(err?.message || err) };
  }
}

export default supabase;
