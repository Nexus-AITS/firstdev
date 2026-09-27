/**
 * Prove the participant-profile feature against the live project.
 *
 * public.user_profiles holds two different kinds of column, and they are the
 * reason this suite exists at all:
 *
 *   IDENTITY   — mirrored from auth.users by trg_user_profiles_sync. It must be
 *                captured automatically (nobody is going to type their Google
 *                subject id) and it must NOT be client-writable, or a
 *                participant could describe somebody else.
 *   DETAILS    — the participant's own (roll, college, year, department,
 *                phone). A later sign-in must not overwrite them; that is the
 *                whole point of saving them.
 *
 * So the checks below are about the SEAM between those two halves: the trigger
 * fills identity in and leaves details alone, and RLS lets a participant touch
 * their own row and nothing else.
 *
 * The trigger is exercised for real — a probe auth user is inserted, and the
 * profile row appearing is the assertion. Reading the policy definitions would
 * pass even with a trigger that never ran.
 *
 * Participant calls use `set local role authenticated` + forged
 * request.jwt.claims inside one Management-API transaction, which is what lets
 * a single statement behave the way a browser session would. Staff reads set
 * the request.headers GUC, which is exactly where staff_session() looks for the
 * console's token.
 *
 * Every row this creates is removed in a finally block.
 *
 *   node scripts/verify-profile.mjs
 */
import { readFileSync } from "node:fs";

const env = {};
for (const raw of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const url = env.SUPABASE_URL.replace(/\/+$/, "");
const key = env.SUPABASE_ANON_KEY;
const ref = new URL(url).hostname.split(".")[0];
const mgmt = `https://api.supabase.com/v1/projects/${ref}/database/query`;

let pass = 0;
let fail = 0;
const out = (ok, label, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${label}${detail ? `  |  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail ? `  |  ${detail}` : ""}`);
  }
};

async function sql(query) {
  const res = await fetch(mgmt, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

const rpc = (name, body, token) =>
  fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(token ? { "X-Nexus-Staff-Token": token } : {}),
    },
    body: JSON.stringify(body),
  });

const ME = "99999999-1111-4111-8111-999999999901";
const OTHER = "99999999-1111-4111-8111-999999999902";
const MY_EMAIL = "zz-profile-me@example.invalid";
const OTHER_EMAIL = "zz-profile-other@example.invalid";

/** Run a statement AS the participant, with a forged identity. */
const asMe = (body, uid = ME) => `
  set local role authenticated;
  select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
  ${body}`;

/** As the participant, but with a live console token in the request headers. */
const asStaff = (token, body) => `
  set local role anon;
  select set_config('request.headers', '{"x-nexus-staff-token":"${token}"}', true);
  ${body}`;

async function sqlAs(query) {
  try {
    return { ok: true, rows: await sql(query), error: "" };
  } catch (err) {
    return { ok: false, rows: [], error: String(err.message) };
  }
}

/** A live console session for a probe staff account of the given role. */
async function signInAs(role) {
  const username = `zz-profile-${role}`;
  await sql(`
    delete from public.staff_users where username = '${username}';
    insert into public.staff_users (username, password_hash, role, is_active)
    values ('${username}', extensions.crypt('zz-probe-pw', extensions.gen_salt('bf', 10)),
            '${role}', true);`);
  const res = await rpc("staff_login", { p_username: username, p_password: "zz-probe-pw" });
  return (await res.json()).token ?? null;
}

const cleanup = () => sql(`
  delete from public.staff_users where username like 'zz-profile-%';
  delete from auth.users where id in ('${ME}', '${OTHER}');
  -- The hand-made account used while this feature was being built, so it does
  -- not linger as an unowned row in auth.users.
  delete from auth.users where email = 'probe-wizard@example.com';`);

/* ------------------------------- seed ------------------------------- */

await cleanup();

const seedUser = (id, email, meta) => `
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000000', '${id}', 'authenticated', 'authenticated',
          '${email}', crypt('never-used', gen_salt('bf')), now(), now(), now(),
          '{"provider":"google","providers":["google"]}'::jsonb,
          '${JSON.stringify(meta)}'::jsonb);`;

try {
  await sql(
    seedUser(ME, MY_EMAIL, { name: "ZZ Profile", picture: "https://example.invalid/me.png" }) +
      seedUser(OTHER, OTHER_EMAIL, { name: "ZZ Other", picture: "https://example.invalid/o.png" })
  );

  /* ---------------- 1. the trigger captured the social login ---------------- */

  const mine = await sql(
    `select * from public.user_profiles where user_id = '${ME}'`
  );
  out(mine.length === 1, "inserting an auth user creates its profile row", `rows=${mine.length}`);
  const row = mine[0] ?? {};
  out(row.email === MY_EMAIL, "the profile carries the social email", row.email ?? "(none)");
  out(
    row.auth_provider === "google",
    "the profile records WHICH social provider signed in",
    row.auth_provider ?? "(none)"
  );
  out(
    row.full_name === "ZZ Profile",
    "the social display name is seeded into full_name",
    row.full_name ?? "(none)"
  );
  out(
    row.avatar_url === "https://example.invalid/me.png",
    "the social avatar url is stored",
    row.avatar_url ?? "(none)"
  );

  /* ---------------- 2. the subject id arrives on the next sign-in ---------------- */

  // GoTrue writes the identity row AFTER the user row, so provider_id is
  // expected to be null on the first pass and filled by the next sync. Both
  // halves are asserted: the null is the honest state, not a bug.
  out(
    row.provider_id == null,
    "provider_id is empty on the first pass (the identity row does not exist yet)",
    String(row.provider_id)
  );

  await sql(`
    insert into auth.identities (id, user_id, provider_id, provider, identity_data,
                                 last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), '${ME}', 'zz-google-subject-1', 'google',
            '{"sub":"zz-google-subject-1","email":"${MY_EMAIL}"}'::jsonb, now(), now(), now());
    insert into auth.identities (id, user_id, provider_id, provider, identity_data,
                                 last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), '${OTHER}', 'zz-google-subject-2', 'google',
            '{"sub":"zz-google-subject-2","email":"${OTHER_EMAIL}"}'::jsonb, now(), now(), now());
    update auth.users set last_sign_in_at = now() where id in ('${ME}', '${OTHER}');`);

  const afterSignIn = await sql(
    `select provider_id, last_sign_in_at from public.user_profiles where user_id = '${ME}'`
  );
  out(
    afterSignIn[0]?.provider_id === "zz-google-subject-1",
    "a later sign-in fills in the social subject id from auth.identities",
    String(afterSignIn[0]?.provider_id)
  );

  /* ---------------- 3. a sign-in must not overwrite the participant's own data --- */

  await sql(`
    update public.user_profiles
       set roll_number = '21ZZZ01', college_name = 'ZZ Institute',
           year = '3rd', department = 'CSE', phone_number = '9000000002',
           full_name = 'Name I Typed Myself'
     where user_id = '${ME}';`);

  await sql(
    `update auth.users
        set last_sign_in_at = now() + interval '1 minute',
            raw_user_meta_data = '{"name":"Google Renamed Me","picture":"https://example.invalid/me2.png"}'::jsonb
      where id = '${ME}';`
  );

  const preserved = await sql(
    `select full_name, roll_number, college_name, year, department, phone_number, avatar_url
       from public.user_profiles where user_id = '${ME}'`
  );
  const kept = preserved[0] ?? {};
  out(
    kept.full_name === "Name I Typed Myself" &&
      kept.roll_number === "21ZZZ01" &&
      kept.college_name === "ZZ Institute" &&
      kept.year === "3rd" &&
      kept.department === "CSE" &&
      kept.phone_number === "9000000002",
    "a later sign-in leaves the participant's own details untouched",
    `name=${kept.full_name} roll=${kept.roll_number}`
  );
  out(
    kept.avatar_url === "https://example.invalid/me2.png",
    "a changed social avatar IS refreshed",
    String(kept.avatar_url)
  );

  /* ---------------- 4. the shape of the table ---------------- */

  const meta = await sql(`
    select c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'user_profiles';`);
  out(meta[0]?.rls === true, "row level security is enabled on user_profiles");

  const cols = await sql(`
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'user_profiles'`);
  const names = cols.map((c) => c.column_name);
  const wanted = [
    "email", "full_name", "avatar_url", "auth_provider", "provider_id", "user_metadata",
    "last_sign_in_at", "roll_number", "college_name", "year", "department", "phone_number",
  ];
  const missing = wanted.filter((c) => !names.includes(c));
  out(missing.length === 0, "every identity + registration column exists", missing.join(",") || "all present");

  const policies = await sql(`
    select policyname, cmd from pg_policies
     where schemaname = 'public' and tablename = 'user_profiles'`);
  const byName = new Map(policies.map((p) => [p.policyname, p.cmd]));
  out(byName.has("participant_read_own_profile"), "a participant may read their own profile");
  out(byName.has("participant_update_own_profile"), "a participant may edit their own profile");
  out(byName.has("staff_read_user_profiles"), "the operations team may read profiles");
  out(
    !policies.some((p) => p.cmd === "INSERT" || p.cmd === "DELETE"),
    "there is NO insert and NO delete policy — creation belongs to the trigger",
    policies.map((p) => `${p.policyname}:${p.cmd}`).join(" ")
  );

  const grants = await sql(`
    select grantee, privilege_type from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'user_profiles'`);
  const auth = grants.filter((g) => g.grantee === "authenticated").map((g) => g.privilege_type);
  const anon = grants.filter((g) => g.grantee === "anon").map((g) => g.privilege_type);
  out(auth.includes("SELECT") && auth.includes("UPDATE"), "authenticated has select + update", auth.join(","));
  out(
    !["INSERT", "DELETE", "TRUNCATE"].some((p) => auth.includes(p)),
    "authenticated has no insert / delete",
    auth.join(",")
  );
  // anon is the console's role (a staff member has no Supabase session), so it
  // needs SELECT for the staff policy to be reachable — but never a write.
  const anonWrites = anon.filter((p) =>
    ["INSERT", "UPDATE", "DELETE", "TRUNCATE"].includes(p)
  );
  out(
    anon.includes("SELECT") && anonWrites.length === 0,
    "anon can only SELECT (the console's staff read), never write",
    anon.join(",") || "none"
  );

  const triggers = await sql(`
    select tgname from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and t.tgname in ('trg_user_profiles_sync', 'trg_user_profiles_touch')`);
  const tnames = triggers.map((t) => t.tgname);
  out(
    tnames.includes("trg_user_profiles_sync") && tnames.includes("trg_user_profiles_touch"),
    "both triggers exist (auth.users sync + updated_at)",
    tnames.join(",")
  );

  /* ---------------- 5. RLS: the participant sees and touches only their own ------- */

  const asMeRead = await sqlAs(
    asMe(`select user_id from public.user_profiles order by user_id;`)
  );
  const seen = asMeRead.rows.map((r) => r.user_id);
  out(
    asMeRead.ok && seen.length === 1 && seen[0] === ME,
    "a participant reads exactly one profile: their own",
    `rows=${JSON.stringify(seen)}`
  );

  const hijack = await sqlAs(
    asMe(`
      with attempted as (
        update public.user_profiles
           set college_name = 'HIJACKED'
         where user_id = '${OTHER}'
        returning 1
      )
      select count(*)::int as n from attempted;`)
  );
  out(
    hijack.ok && (hijack.rows[0]?.n ?? -1) === 0,
    "a participant cannot edit somebody else's profile",
    `updated=${hijack.rows[0]?.n ?? hijack.error}`
  );

  const otherStill = await sql(
    `select college_name from public.user_profiles where user_id = '${OTHER}'`
  );
  out(
    otherStill[0]?.college_name !== "HIJACKED",
    "the other participant's row is unchanged by that attempt",
    String(otherStill[0]?.college_name)
  );

  const ownWrite = await sqlAs(
    asMe(`
      with updated as (
        update public.user_profiles set phone_number = '9000000003'
         where user_id = '${ME}' returning phone_number
      )
      select phone_number from updated;`)
  );
  out(
    ownWrite.ok && ownWrite.rows[0]?.phone_number === "9000000003",
    "a participant can save their own details",
    ownWrite.rows[0]?.phone_number ?? ownWrite.error
  );

  const insertTry = await sqlAs(
    asMe(`insert into public.user_profiles (user_id, email)
          values ('${ME}', 'forged@example.invalid');`)
  );
  out(!insertTry.ok, "a participant cannot INSERT a profile row", insertTry.error.slice(0, 80));

  const deleteTry = await sqlAs(
    asMe(`delete from public.user_profiles where user_id = '${ME}';`)
  );
  out(!deleteTry.ok, "a participant cannot DELETE a profile row", deleteTry.error.slice(0, 80));

  const anonRead = await sqlAs(`
    set local role anon;
    select count(*)::int as n from public.user_profiles;`);
  out(
    anonRead.ok && (anonRead.rows[0]?.n ?? -1) === 0,
    "an anonymous visitor sees no profiles at all",
    `rows=${anonRead.rows[0]?.n ?? anonRead.error}`
  );

  /* ---------------- 6. ensure_my_profile() repairs a missing row ---------------- */

  await sql(`delete from public.user_profiles where user_id = '${ME}';`);
  const gone = await sql(
    `select count(*)::int as n from public.user_profiles where user_id = '${ME}'`
  );
  out(gone[0]?.n === 0, "probe row removed, ready to test the self-healing read");

  const ensure = await sqlAs(asMe(`select user_id, email, full_name from public.ensure_my_profile();`));
  out(
    ensure.ok && ensure.rows.length === 1 && ensure.rows[0].user_id === ME,
    "ensure_my_profile() recreates a missing row for its caller only",
    `rows=${ensure.rows.length}`
  );
  out(
    ensure.rows[0]?.email === MY_EMAIL,
    "the recreated row repopulates the identity from auth.users",
    String(ensure.rows[0]?.email)
  );

  const ensureAnon = await sqlAs(`
    set local role anon;
    select count(*)::int as n from public.ensure_my_profile();`);
  out(
    !ensureAnon.ok || (ensureAnon.rows[0]?.n ?? 0) === 0,
    "an anonymous caller cannot create a profile through ensure_my_profile()",
    ensureAnon.ok ? `rows=${ensureAnon.rows[0]?.n}` : ensureAnon.error.slice(0, 60)
  );

  /* ---------------- 7. the operations team can read, and that is all -------------- */

  const coordToken = await signInAs("coordinator");
  out(Boolean(coordToken), "a coordinator session could be created for the check");
  if (coordToken) {
    const staffRead = await sqlAs(asStaff(coordToken, `select count(*)::int as n from public.user_profiles;`));
    out(
      staffRead.ok && (staffRead.rows[0]?.n ?? 0) >= 2,
      "a coordinator can read profiles (the support view)",
      `rows=${staffRead.rows[0]?.n ?? staffRead.error}`
    );

    const staffWrite = await sqlAs(
      asStaff(coordToken, `update public.user_profiles set college_name = 'STAFF EDIT';`)
    );
    out(!staffWrite.ok, "a coordinator still cannot edit a profile", staffWrite.error.slice(0, 80));
  }

  const noToken = await sqlAs(asStaff("not-a-real-token", `select count(*)::int as n from public.user_profiles;`));
  out(
    noToken.ok && (noToken.rows[0]?.n ?? -1) === 0,
    "the anon role WITHOUT a staff token still sees nothing",
    `rows=${noToken.rows[0]?.n ?? noToken.error}`
  );

  /* ---------------- 8. nobody was left without a profile ---------------- */

  const uncovered = await sql(`
    select count(*)::int as missing from auth.users u
     where not exists (select 1 from public.user_profiles p where p.user_id = u.id)`);
  out(
    uncovered[0]?.missing === 0,
    "every auth user has a profile (trigger + backfill leave none behind)",
    `missing=${uncovered[0]?.missing}`
  );
} catch (err) {
  fail += 1;
  console.log(`FAIL  suite aborted  |  ${String(err.message).slice(0, 300)}`);
} finally {
  await cleanup();
  const leftovers = await sql(`
    select
      (select count(*)::int from auth.users where id in ('${ME}', '${OTHER}')) as users,
      (select count(*)::int from public.user_profiles where user_id in ('${ME}', '${OTHER}')) as profiles,
      (select count(*)::int from public.staff_users where username like 'zz-profile-%') as staff`);
  out(
    leftovers[0]?.users === 0 && leftovers[0]?.profiles === 0 && leftovers[0]?.staff === 0,
    "every probe row was removed",
    JSON.stringify(leftovers[0] ?? {})
  );
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);

