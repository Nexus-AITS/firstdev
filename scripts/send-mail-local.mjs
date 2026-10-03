/**
 * Drain the mail queue against Resend from your own machine.
 *
 *   npm run mail:send            -- send for real
 *   npm run mail:send -- --dry   -- report what WOULD go, claim nothing
 *
 * Why this exists rather than "just deploy it": the cron and the API function both
 * need Vercel environment variables and a deployed build, and the first real send
 * of a season should not be the first time anybody has run this code. This calls
 * the SAME handler the deployment calls, with the same credentials from .env, so
 * what passes here passes there.
 *
 * It is a LOCAL operator tool. It reads .env and talks to Resend; it is not wired
 * into the app and nothing in src/ imports it.
 */
import { readFileSync } from "node:fs";
import { default as handler } from "../api/send-mail.js";

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
/* RESEND_API_KEY / SENDER_EMAIL are read here rather than inside api/send-mail.js's
   own env, because the handler reads them off process.env exactly as it does on
   Vercel. Local and deployed then run the SAME code against the SAME values. */
for (const k of [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_STAFF_EMAIL",
  "SUPABASE_STAFF_PASSWORD",
  "RESEND_API_KEY",
  "SENDER_EMAIL",
]) {
  if (env[k]) process.env[k] = env[k];
}

const dry = process.argv.includes("--dry");

/* The staff token is minted here rather than pasted into .env, because it is
   SHORT-LIVED and tied to the signed-in operator. Long-lived credentials belong
   in .env; this one deliberately does not. */
async function staffToken() {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/staff_login`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_username: env.SUPABASE_STAFF_EMAIL, p_password: env.SUPABASE_STAFF_PASSWORD }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  const token = Array.isArray(body) ? body[0]?.token : body?.token;
  if (!token) {
    console.error("FAIL: could not sign in to the console. Check SUPABASE_STAFF_EMAIL/PASSWORD in .env");
    process.exit(1);
  }
  return token;
}

const token = await staffToken();

/* A tiny stand-in for the Vercel req/res pair, so the real handler runs unmodified
   rather than a copy of it that can drift from the deployed one. */
function mockRes() {
  const r = { statusCode: null, payload: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.payload = o; return r; };
  return r;
}

const res = mockRes();
await handler(
  {
    method: "POST",
    query: dry ? { dry_run: "1", limit: "5" } : { limit: "5" },
    headers: { "x-nexus-staff-token": token },
  },
  res
);

const body = res.payload ?? {};
console.log(`\n  HTTP ${res.statusCode}${dry ? "  (dry run - nothing was sent, nothing claimed)" : ""}`);
console.log(
  dry
    ? `  would_claim=${body.would_claim ?? 0}  (claimed=${body.claimed ?? 0}, sent=0)`
    : `  claimed=${body.claimed ?? 0}  sent=${body.sent ?? 0}  failed=${body.failed ?? 0}`
);
for (const r of body.results ?? []) {
  const mark = dry ? "peek" : r.ok ? "ok  " : "FAIL";
  console.log(`   [${mark}] ${r.to}  ${r.error ?? ""}`);
}
if (!body.ok && body.error) console.log(`  error: ${body.error}`);
