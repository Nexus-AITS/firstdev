import { readFileSync } from "node:fs";
import { chromium } from "playwright";
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
const supabaseUrl = (env.SUPABASE_URL || "").replace(/\/+$/, "");
const ref = new URL(supabaseUrl).hostname.split(".")[0];
const mgmt = `https://api.supabase.com/v1/projects/${ref}/database/query`;

async function sql(query) {
  const res = await fetch(mgmt, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const parsed = JSON.parse(await res.text());
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}
const countSessions = async () => (await sql("select count(*)::int as n from public.staff_sessions"))[0].n;

const BASE = process.env.VERIFY_BASE || "http://localhost:4173";
let pass = 0, fail = 0;
const out = (ok, label, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${label}${detail ? `  |  ${detail}` : ""}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? `  |  ${detail}` : ""}`); }
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const signedIn = async () => (await page.locator('nav[aria-label="Console sections"]').count()) > 0;

  await page.goto(`${BASE}/nexus-admin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#staff-username", { timeout: 20000 });
  await page.fill("#staff-username", env.SUPABASE_STAFF_EMAIL);
  await page.fill("#staff-password", env.SUPABASE_STAFF_PASSWORD);
  await page.click('#admin-signin button[type="submit"]');
  await page.waitForSelector('nav[aria-label="Console sections"] button', { timeout: 20000 });
  await page.waitForTimeout(2500);
  out(await signedIn(), "signed in");

  const afterSignIn = await countSessions();

  for (let i = 1; i <= 3; i++) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    out(
      (await signedIn()) && (await page.locator("#staff-username").count()) === 0,
      `reload #${i} keeps the session - no sign-in form`,
      await signedIn() ? "still signed in" : "SIGNED OUT"
    );
  }

  const afterReloads = await countSessions();
  out(
    afterReloads === afterSignIn,
    "and three reloads mint NO new session rows",
    `${afterSignIn} -> ${afterReloads}`
  );

  const tab = await ctx.newPage();
  await tab.goto(`${BASE}/nexus-admin`, { waitUntil: "domcontentloaded" });
  await tab.waitForTimeout(3000);
  out(
    (await tab.locator('nav[aria-label="Console sections"]').count()) > 0,
    "a second tab on the same device is already signed in"
  );
  await tab.close();

  const afterTab = await countSessions();
  out(afterTab === afterSignIn, "…and that costs no session either", `${afterSignIn} -> ${afterTab}`);

  // Sign out must still clear it, or "remember me" has no off switch.
  await page.click('button:has-text("Sign out")');
  await page.waitForTimeout(3000);
  out(
    (await page.locator("#staff-username").count()) === 1,
    "Sign out still clears the stored token"
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  out(
    (await page.locator("#staff-username").count()) === 1,
    "…and stays cleared after a reload"
  );
} catch (err) {
  fail += 1;
  console.log(`FAIL  suite aborted  |  ${String(err.message).slice(0, 300)}`);
} finally {
  await browser.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
}
process.exit(fail ? 1 : 0);
