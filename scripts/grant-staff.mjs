/**
 * Create a NEXUS operations account.
 *
 *   npm run staff:bootstrap -- <username> "<password>" ["Full Name"]
 *   npm run staff:create -- --master <username> "<password>" "Full Name"
 *   npm run staff:create -- --admin  <username> "<password>" "Full Name"
 *   npm run staff:create -- --coord  <username> "<password>" "Full Name"
 *
 * `bootstrap` is the ONLY way to create the very first master, and it works only
 * while public.staff_users is empty — after that the function refuses, because
 * the console's own "add account" form becomes the path (and it is audited).
 * `create` goes through the same audited path an existing master would use.
 *
 * Passwords are taken as an argument for scripting convenience. On a shared
 * machine prefer the console, or set it interactively — an argument lands in
 * your shell history.
 */
import { readFileSync } from "node:fs";

function loadEnv(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv(new URL("../.env", import.meta.url));
const token = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
const supabaseUrl = (process.env.SUPABASE_URL || env.SUPABASE_URL || "").replace(/\/+$/, "");
const anonKey = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;

if (!token || !supabaseUrl || !anonKey) {
  console.error("FAIL: SUPABASE_ACCESS_TOKEN / SUPABASE_URL / SUPABASE_ANON_KEY all required");
  process.exit(1);
}

const ref = new URL(supabaseUrl).hostname.split(".")[0];
const mgmt = `https://api.supabase.com/v1/projects/${ref}/database/query`;
const rest = `${supabaseUrl}/rest/v1`;

/** As postgres — for the bootstrap path, which by design has no session yet. */
async function sql(query) {
  const res = await fetch(mgmt, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`management API HTTP ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

/** As a staff member — anon role + the token header, exactly as the browser. */
async function rpc(name, params, staffToken) {
  const res = await fetch(`${rest}/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      ...(staffToken ? { "X-Nexus-Staff-Token": staffToken } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const ROLE_FLAG = { "--master": "master", "--admin": "admin", "--coord": "coordinator" };
const isBootstrap = process.argv[2] === "staff:bootstrap" || process.argv[2] === "bootstrap";
const rest1 = process.argv.slice(isBootstrap ? 3 : 2);
const roleFlag = rest1.find((a) => ROLE_FLAG[a]);
const positional = rest1.filter((a) => !ROLE_FLAG[a]);
const role = isBootstrap ? "master" : ROLE_FLAG[roleFlag];

const [username, password, fullName] = positional;

if (!username || !password || !role) {
  console.error(
    isBootstrap
      ? 'usage: npm run staff:bootstrap -- <username> "<password>" ["Full Name"]'
      : 'usage: npm run staff:create -- (--master|--admin|--coord) <username> "<password>" ["Full Name"]'
  );
  process.exit(1);
}

console.log(`project=${ref}\n`);

if (isBootstrap) {
  const count = await sql("select count(*)::int as n from public.staff_users;");
  if (count[0]?.n > 0) {
    console.error(
      `FAIL: ${count[0].n} staff account(s) already exist, so the bootstrap path is closed.\n` +
        "      Sign in as a master and use the console's Staff tab instead."
    );
    process.exit(1);
  }
  const result = await rpc("staff_bootstrap_master", {
    p_username: username,
    p_password: password,
    p_full_name: fullName ?? null,
  });
  if (!result?.ok) {
    console.error(`FAIL: ${result?.error ?? "bootstrap refused"}`);
    process.exit(1);
  }
  console.log(`OK — created the first MASTER administrator: ${username}`);
  console.log("     This account is recorded in the audit log as bootstrap_master.");
  process.exit(0);
}

// Non-bootstrap creation needs an existing master session, which this script
// does not have. Creating lower tiers is the console's job, and the database
// enforces that; the only thing this script can do as postgres is bypass the
// application entirely, which would defeat the audit trail.
console.error(
  "FAIL: creating an admin or coordinator requires a signed-in master, because that is\n" +
    "      what gets recorded in the audit log.\n\n" +
    "      Run `npm run staff:bootstrap` once (only works while no staff exist), then sign\n" +
    "      in at /nexus-admin and use the Staff tab to add the other tiers."
);
process.exit(1);
