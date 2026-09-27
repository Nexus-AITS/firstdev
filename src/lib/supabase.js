/**
 * Supabase client for registration writes — built on demand from the runtime
 * config rather than at import time.
 *
 * Credentials come from `/api/config` (see runtime-config.js), which reads the
 * server environment. Nothing is inlined by Vite, so the anon key is absent
 * from the static bundle and can be rotated without a rebuild.
 *   SUPABASE_URL       https://<project-ref>.supabase.co   (server side)
 *   SUPABASE_ANON_KEY  public anon key — safe for the browser; RLS gates access
 *
 * The admin console's data layer (src/data/registrations.js) still reads the
 * local mirror; this client is the swap-in point — replace each store function
 * body with a query against `registrations` when the remote table is live.
 * See docs/supabase-data-model.md for the schema and wiring checklist.
 */
import { createClient } from "@supabase/supabase-js";
import { loadRuntimeConfig } from "../config/runtime-config.js";

/**
 * Resolve a ready client, or null when the deployment is unconfigured.
 *
 * Cached per page load: the auth flow and the registration wizard both need a
 * client, and two Supabase instances would mean two session stores fighting
 * over the same storage key.
 */
let clientPromise = null;

export function getSupabaseClient() {
  if (!clientPromise) {
    clientPromise = loadRuntimeConfig().then((config) => {
      if (!config) return null;
      try {
        return createClient(config.supabaseUrl, config.supabaseAnonKey, {
          auth: { persistSession: false },
        });
      } catch {
        return null;
      }
    });
  }
  return clientPromise;
}

/**
 * Whether a cloud sync is possible. Async for the same reason as the client:
 * the answer is not known until the config resolves.
 */
export async function isSupabaseConfigured() {
  return Boolean(await getSupabaseClient());
}

/**
 * Send a completed /register wizard row to the remote project.
 * Best-effort by design: the local store (src/data/registrations.js) is
 * always written first, so a cloud hiccup never loses a registration.
 * Returns { synced: true } or { synced: false, error }.
 */
export async function submitRegistration(row) {
  const supabase = await getSupabaseClient();
  if (!supabase) {
    console.warn(
      "supabase insert skipped: no runtime config — SUPABASE_URL / SUPABASE_ANON_KEY not set on this deployment"
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
