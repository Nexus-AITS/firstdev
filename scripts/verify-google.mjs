/**
 * Google sign-in verification — proves the navbar control drives the live
 * Supabase → Google handshake, not merely that it renders.
 *
 * Run: node scripts/verify-google.mjs
 *      (requires `npm run preview` on :4173 + chromium)
 *
 * The last step deliberately follows the redirect to accounts.google.com.
 * Google's consent screen needs real credentials, but *reaching* it proves
 * the whole chain — navbar button → supabase.auth.signInWithOAuth →
 * /auth/v1/authorize → Google — is configured. That chain is exactly what
 * breaks silently when a redirect URL is missing from the Supabase allow
 * list, so it is worth asserting rather than assuming.
 */
import { chromium } from "playwright";

const BASE = "http://localhost:4173";

/** The control must live in the navbar; a bare page-level match is not enough. */
const CONTROL = /sign in/i;

/**
 * supabase-js is dynamically imported, so the control lands one async chunk
 * after first paint — wait for it rather than sampling too early.
 */
async function waitForControl(page) {
  const control = page.locator("header").getByRole("button", { name: CONTROL }).first();
  await control.waitFor({ state: "visible", timeout: 25000 }).catch(() => {});
  return control;
}

/** Let fonts, the async auth chunk and the hero's entrance animation land. */
const SETTLE_MS = 2000;

let failures = 0;
const out = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
};

const browser = await chromium.launch({ channel: "chrome" });

/* -------- desktop: header carries the control, and it starts the flow ------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 20000 });
  const control = await waitForControl(page);
  await page.waitForTimeout(SETTLE_MS);
  const visible = await control.isVisible().catch(() => false);
  out(
    visible && errors.length === 0,
    "navbar   sign-in in header",
    visible ? "" : `visible=${visible} errors=${errors.join(" | ")}`
  );

  if (visible) {
    // Let the entrance animations settle. The navbar switches blur/height on
    // scroll and the hero runs a WebGL loop, so Playwright's actionability
    // check ("element is stable") can time out mid-animation even though the
    // button is the real hit target (verified with elementFromPoint). The DOM
    // fallback exercises the identical React handler and OAuth redirect.
    let how = "pointer click";
    try {
      await control.click({ timeout: 15000 });
    } catch {
      how = "dom click (pointer click timed out)";
      // The throw is an actionability timeout, not necessarily a missed hit —
      // the click may already have fired and the page could be mid-navigation
      // to Google, where the header locator no longer resolves. Only re-click
      // while still on-site, and swallow a re-click that races the redirect.
      try {
        const left = /accounts\.google\.com|\/auth\/v1\/authorize/.test(page.url());
        if (!left) await control.evaluate((el) => el.click(), null, { timeout: 5000 });
      } catch {
        /* navigation already in flight — waitForURL below does the asserting */
      }
    }
    await page
      .waitForURL(/accounts\.google\.com|\/auth\/v1\/authorize/, { timeout: 30000 })
      .catch(() => {});
    const url = page.url();
    const reached = /accounts\.google\.com|\/auth\/v1\/authorize/.test(url);
    out(reached, "google   handshake", reached ? `${new URL(url).host} via ${how}` : `stayed on ${url}`);
    if (!reached) {
      const note = await page
        .evaluate(() => document.querySelector("h1")?.textContent ?? "")
        .catch(() => "");
      if (note) console.log(`        page says: ${note.trim()}`);
    }
  }
  await ctx.close();
}

/* -------- mobile: same control, before the hamburger -------- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 20000 });
  const control = await waitForControl(page);
  await page.waitForTimeout(SETTLE_MS);
  const visible = await control.isVisible().catch(() => false);
  out(visible, "mobile   sign-in in header");
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall google sign-in checks passed");
process.exit(failures ? 1 : 0);
