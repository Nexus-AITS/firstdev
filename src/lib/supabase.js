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

// Degrade instead of throwing: importing this module must never crash a route.
// Fresh clones, CI and deployments without VITE_SUPABASE_* still get the full
// wizard — `supabase` is simply null and `submitRegistration` reports
// { synced: false } so the success screen says "cloud sync unavailable".
// (Same contract as config/supabase.js and its `isAuthConfigured`.)
export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: false },
    })
  : null;

/**
 * Send a completed /register wizard row to the remote project.
 * Best-effort by design: the local store (src/data/registrations.js) is
 * always written first, so a cloud hiccup never loses a registration.
 * Returns { synced: true } or { synced: false, error }.
 */
export async function submitRegistration(row) {
  if (!supabase) {
    console.warn(
      "supabase insert skipped: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set in this build"
    );
    return { synced: false, error: "Supabase is not configured for this deployment." };
  }
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
      purchase_type: row.purchase_type ?? null,
      purchase_label: row.purchase_label ?? null,
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
