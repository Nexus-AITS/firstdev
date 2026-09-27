/**
 * Participant profile repository — public.user_profiles.
 *
 * What the table is for, and what each half costs:
 *
 *   identity (email, avatar, provider, subject id, raw metadata) is MIRRORED
 *   from auth.users by trg_user_profiles_sync. It is not editable here: a
 *   profile that could claim a different email would be a way to describe
 *   someone else, and the database has no UPDATE path for those columns that
 *   the client is even granted (only `authenticated` + the owner policy, and
 *   the columns the participant may change are enforced by the whitelist
 *   below).
 *
 *   registration details (roll number, college, year, department, phone) belong
 *   to the participant. They are what /register prefill uses, so entering them
 *   once on the profile page means never retyping them for a second event.
 *
 * Every function resolves to { data, error } rather than throwing — the shape
 * every caller in this codebase already handles.
 */
import { getAuthClient } from "../config/supabase.js";

/** The columns a participant may write. Anything else is silently dropped. */
export const PROFILE_EDITABLE = [
  "full_name",
  "roll_number",
  "college_name",
  "year",
  "department",
  "phone_number",
];

/** Resolve the shared client, or a report explaining why there isn't one. */
async function client() {
  const supabase = await getAuthClient();
  if (!supabase) {
    return { error: "The NEXUS database is not reachable from this deployment." };
  }
  return { supabase };
}

/**
 * Read (creating if necessary) the signed-in participant's profile.
 *
 * Goes through ensure_my_profile() rather than a bare select: the function
 * inserts the row from auth.users when it is missing, so a participant whose
 * profile was never written — a sign-up that raced a migration, a restored
 * database — gets a profile instead of an empty form with nothing to save
 * against. RLS still scopes the returned row to auth.uid().
 */
export async function loadMyProfile() {
  const { supabase, error } = await client();
  if (error) return { data: null, error };

  const { data, error: rpcError } = await supabase.rpc("ensure_my_profile");
  if (rpcError) {
    return { data: null, error: `Could not load your profile: ${rpcError.message}` };
  }
  const row = Array.isArray(data) ? data[0] ?? null : data ?? null;
  return { data: row, error: null };
}

/**
 * Save the participant's own details.
 *
 * The whitelist is the point: `purchase_type`, `user_id`, `payment_status` and
 * every identity column live in the same table, and a spread of an arbitrary
 * form object would hand the caller a way to rewrite them. Only the six
 * personal fields survive, and the WHERE clause is the signed-in user id — RLS
 * would refuse anything else anyway, but failing here says why instead of
 * returning an empty update.
 */
export async function saveMyProfile(patch) {
  const { supabase, error } = await client();
  if (error) return { data: null, error };

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return { data: null, error: "Sign in before saving your details." };

  const values = {};
  for (const key of PROFILE_EDITABLE) {
    if (key in patch) values[key] = patch[key] == null ? null : String(patch[key]).trim();
  }
  if (Object.keys(values).length === 0) {
    return { data: null, error: "Nothing to save." };
  }

  const { data, error: saveError } = await supabase
    .from("user_profiles")
    .update(values)
    .eq("user_id", userId)
    .select()
    .maybeSingle();

  if (saveError) return { data: null, error: `Could not save your details: ${saveError.message}` };
  if (!data) {
    return {
      data: null,
      error: "Your profile could not be found — close this page and sign in again.",
    };
  }
  return { data, error: null };
}
