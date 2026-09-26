/**
 * NEXUS runtime verification.
 * Run: node verify.mjs   (requires `npm run preview` on :4173 + chromium)
 */
import { chromium } from "playwright";

const BASE = "http://localhost:4173";

const ROUTES = [
  ["/", "NEXUS"],
  ["/events", "WELCOME TO THE NEXUS"],
  ["/events/forge", "NEXUS REBUILDERS"],
  ["/events/paradox", "NEXUS OFF-GRID"],
  ["/events/arena", "THE ARENA"],
  ["/events/nexus-breach", "NEXUS BREACH"],
  ["/events/the-scientist-files", "THE SCIENTIST FILES"],
  ["/events/free-fire", "FREE FIRE"],
  ["/ai", "THE NEXUS"],
  ["/about", "EVERYTHING"],
  ["/register", "EVENT REGISTER"],
  ["/gateway", "EVENT REGISTER"], // legacy hand-off redirects into /register
  ["/bundled", "BUNDLED"],
  ["/admin", "ADMIN CONSOLE"],
  ["/definitely-missing", "REALM NOT FOUND"],
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

const benign = (t) => /favicon|fonts\.g|Failed to load resource|net::ERR_/i.test(t);

let failures = 0;
const out = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
};

const browser = await chromium.launch({ channel: "chrome" });

/* -------- route x viewport matrix -------- */
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

  for (const [route, expect] of ROUTES) {
    errors.length = 0;
    try {
      await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch (e) {
      out(false, `${vp.name} ${route}`, `goto: ${e.message}`);
      continue;
    }
    await page.waitForTimeout(1000);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const h1 = (await page.evaluate(() => document.querySelector("h1")?.textContent)) || "";
    const bad = errors.filter((e) => !benign(e));
    const norm = (s) => s.replace(/\s+/g, "");
    const ok = overflow <= 2 && bad.length === 0 && norm(h1).includes(norm(expect));
    out(
      ok,
      `${vp.name.padEnd(7)} ${route}`,
      `h1="${h1.trim().slice(0, 40)}" overflow=${overflow}${bad.length ? ` errors=${bad.slice(0, 2).join(" || ")}` : ""}`
    );
  }
  await ctx.close();
}

/* -------- auth callback: always renders a decisive state -------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`PAGEERROR: ${e.message}`));
  await page.goto(BASE + "/auth/callback", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(1200);
  const h1 = (await page.evaluate(() => document.querySelector("h1")?.textContent)) || "";
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  // The headline depends on whether VITE_SUPABASE_* were present at build time:
  // an unconfigured build must say so, a configured one must be mid-exchange
  // (a bare `?code=` visit resolves to a refused state after the watchdog).
  const decisive =
    /CROSSING THE THRESHOLD|SIGNATURE ACCEPTED|THE THRESHOLD REFUSED|SIGN-IN UNAVAILABLE/.test(
      h1
    );
  out(
    decisive && overflow <= 2 && errs.length === 0,
    `auth callback   /auth/callback`,
    `h1="${h1.trim().slice(0, 40)}" overflow=${overflow}${errs.length ? ` errors=${errs[0]}` : ""}`
  );
  await ctx.close();
}

/* -------- ENTER NEXUS full cinematic transition -------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1400);
  // the sole entry CTA sits at the end of the scroll story
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: /enter the nexus/i }).click();
  await page.waitForTimeout(2300);
  const midVisible = await page.locator('[role="status"]').isVisible().catch(() => false);
  await page.waitForTimeout(4400);
  const path = new URL(page.url()).pathname;
  const overlayGone = (await page.locator('[role="status"]').count()) === 0;
  const portals = await page
    .locator('main a[href="/events/forge"], main a[href="/events/paradox"], main a[href="/events/arena"]')
    .count();
  out(
    path === "/events" && midVisible && overlayGone && portals === 3 && errs.length === 0,
    "ENTER NEXUS transition",
    `path=${path} midWelcome=${midVisible} gone=${overlayGone} portals=${portals}${errs[0] ? ` err=${errs[0]}` : ""}`
  );
  await ctx.close();
}

/* -------- portal navigation + external CTA + keyboard focus -------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/events", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.locator('a[href="/events/paradox"]').first().click();
  await page.waitForTimeout(900);
  out(new URL(page.url()).pathname === "/events/paradox", "portal navigation", new URL(page.url()).pathname);

  await page.goto(BASE + "/events/forge", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const explores = await page.locator('a[data-cursor="open"]').count();
  out(explores >= 5, "forge explore links", `count=${explores}`);

  await page.goto(BASE + "/events/nexus-breach", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const enter = await page.getByRole("link", { name: /enter event/i }).getAttribute("href");
  out(
    Boolean(enter && enter.startsWith("/register?event=nexus-breach")),
    "event CTA routes to register wizard",
    enter || "missing"
  );

  await page.goto(BASE + "/register?event=nexus-breach", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const ctxCard = await page.getByRole("heading", { name: /NEXUS BREACH/i }).count();
  out(ctxCard === 1, "register event context card", `count=${ctxCard}`);
  out(
    await page.locator("#reg-step-details").isVisible(),
    "register opens on details step",
    ""
  );

  /* bundle cards all hand off to the register wizard */
  await page.goto(BASE + "/bundled", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const claims = await page.locator('main a[href^="/register?bundle="]').count();
  out(claims === 8, "bundle CTAs route to register", `count=${claims}`);
  await page.locator('main a[href^="/register?bundle="]').first().click();
  await page.waitForTimeout(900);
  const bUrl = new URL(page.url());
  out(
    bUrl.pathname === "/register" &&
      bUrl.searchParams.get("bundle") === "bundled-299" &&
      (await page.locator("#reg-step-details").isVisible()),
    "bundle register hand-off",
    `${bUrl.pathname}${bUrl.search}`
  );

  /* per-event pricing: payment cell + CTA billing line on the detail page */
  await page.goto(BASE + "/events/nexus-breach", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const payLabel = await page.getByText("Payment", { exact: true }).count();
  const payPrice = await page.getByText("₹349", { exact: true }).count();
  out(
    payLabel === 1 && payPrice >= 2,
    "event payment data surfaced (meta + CTA)",
    `label=${payLabel} price=${payPrice}`
  );

  /* register fee strip and paradox list carry the same price data */
  await page.goto(BASE + "/register?event=nexus-breach", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const gwPrice = await page.getByText("₹349").count();
  out(gwPrice >= 1, "register card shows event price", `count=${gwPrice}`);

  await page.goto(BASE + "/events/paradox", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const soloPrice = await page.getByText("₹149 · INDIVIDUAL").count();
  out(soloPrice >= 4, "paradox list shows individual pricing", `count=${soloPrice}`);

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => document.activeElement?.className || "");
  out(String(focus).includes("skip-link"), "keyboard focus (skip link first)", String(focus).slice(0, 40));
  await ctx.close();
}

/* -------- mobile menu -------- */
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.locator("#nexus-mobile-menu").waitFor({ state: "visible", timeout: 4000 });
  await page.locator('#nexus-mobile-menu a[href="/about"]').click();
  await page.waitForTimeout(1000);
  out(new URL(page.url()).pathname === "/about", "mobile menu navigation", new URL(page.url()).pathname);
  await ctx.close();
}

/* -------- reduced-motion transition -------- */
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /enter the nexus/i }).click();
  await page.waitForTimeout(4000);
  const path = new URL(page.url()).pathname;
  out(
    path === "/events" && errs.length === 0,
    "reduced-motion transition",
    `path=${path}${errs[0] ? ` err=${errs[0]}` : ""}`
  );
  await ctx.close();
}

/* -------- register wizard: details → payment QR → UTR → success -------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`PAGEERROR: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !benign(m.text())) errs.push(m.text());
  });

  await page.goto(BASE + "/events/nexus-breach", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.getByRole("link", { name: /enter event/i }).click();
  await page.waitForTimeout(900);
  const u = new URL(page.url());
  out(
    u.pathname === "/register" && u.searchParams.get("event") === "nexus-breach",
    "wizard entry (event CTA → /register)",
    `${u.pathname}${u.search}`
  );

  // step 1 — details form
  out(await page.locator("#reg-step-details").isVisible(), "wizard step 1: details form");
  await page.fill("#reg-name", "Tessa Verify");
  await page.fill("#reg-roll", "24T99A0007");
  await page.fill("#reg-college", "AITS Tirupati");
  await page.selectOption("#reg-year", "2nd");
  await page.fill("#reg-dept", "ECE");
  await page.fill("#reg-phone", "9000000099");
  await page.fill("#reg-email", `tessa.verify+${Date.now()}@example.com`);
  await page.click("#reg-details-next");
  await page.waitForTimeout(700);

  // step 2 — payment QR
  const payVisible = await page.locator("#reg-step-pay").isVisible().catch(() => false);
  const qrVisible = await page.locator("#reg-qr").isVisible().catch(() => false);
  const feeShown = (await page.getByText("₹349").count()) >= 1;
  out(
    payVisible && qrVisible && feeShown,
    "wizard step 2: payment QR + fee",
    `pay=${payVisible} qr=${qrVisible} fee=${feeShown}`
  );
  await page.click("#reg-pay-next");
  await page.waitForTimeout(500);

  // step 3 — UTR field
  out(await page.locator("#reg-step-utr").isVisible(), "wizard step 3: UTR field");
  await page.fill("#reg-utr", "998877665511");
  await page.click("#reg-utr-submit");
  // local write is instant; the screen appears after the best-effort cloud
  // sync resolves (may take a few seconds on a cold connection)
  const success = await page
    .locator("#reg-success")
    .waitFor({ state: "visible", timeout: 12000 })
    .then(() => true)
    .catch(() => false);
  out(success, "wizard success screen");

  // the row must land in the store /admin reads, unverified with the UTR
  const stored = await page.evaluate(() => {
    try {
      const rows = JSON.parse(localStorage.getItem("nexus.registrations.v1") || "[]");
      return rows.find((r) => r.email && r.email.startsWith("tessa.verify+")) || null;
    } catch {
      return null;
    }
  });
  out(
    Boolean(stored && stored.payment_status === "unverified" && stored.utr_number === "998877665511"),
    "wizard persists to admin store (unverified + UTR)",
    stored ? `status=${stored.payment_status} utr=${stored.utr_number}` : "row missing"
  );
  out(errs.length === 0, "wizard console errors", errs[0] || "none");
  await ctx.close();
}

/* -------- admin console: dashboard stats, UTR confirm, remove -------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`PAGEERROR: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !benign(m.text())) errs.push(m.text());
  });
  await page.goto(BASE + "/admin", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const num = async (sel) => Number((await page.locator(sel).innerText()).trim());
  const total0 = await num("#stat-participants");
  const colleges = await num("#stat-colleges");
  const note = await page.locator("#admin-auth-note").count();
  out(
    total0 >= 10 && colleges >= 3 && note === 1,
    "admin dashboard stats + auth note",
    `participants=${total0} colleges=${colleges} note=${note}`
  );

  // sorting beside the search bar — name A–Z must put the alphabetically
  // first roster name on top, and the control must reset cleanly
  const rowName = async () =>
    (await page.locator("#admin-table-wrap tbody tr td").nth(1).innerText())
      .split("\n")[0]
      .trim();
  const names = await page.$$eval(
    "#admin-table-wrap tbody tr td:nth-child(2)",
    (cells) => cells.map((c) => c.innerText.split("\n")[0].trim())
  );
  const expectedFirst = [...names].sort((a, b) => a.localeCompare(b))[0];
  await page.selectOption("#admin-sort", "name");
  await page.waitForTimeout(300);
  const firstAfter = await rowName();
  out(
    names.length === total0 && firstAfter === expectedFirst,
    "admin sort beside search (name A-Z)",
    `first "${firstAfter}" expected "${expectedFirst}" rows=${names.length}`
  );
  await page.selectOption("#admin-sort", "newest");
  await page.waitForTimeout(300);

  const confirms = page.locator('button[data-action="confirm"]');
  const queued = await confirms.count();
  const verified0 = await num("#stat-verified");
  if (queued > 0) {
    await confirms.first().click();
    await page.waitForTimeout(400);
    const verified1 = await num("#stat-verified");
    out(
      verified1 === verified0 + 1,
      "admin confirm UTR -> verified",
      `verified ${verified0} -> ${verified1}`
    );
  } else {
    out(false, "admin confirm UTR -> verified", "no unverified rows in seed");
  }

  const totalR = await num("#stat-participants");
  await page.locator('button[data-action="remove"]').first().click();
  await page.waitForTimeout(250);
  await page.locator('button[data-action="remove-confirm"]').first().click();
  await page.waitForTimeout(400);
  const totalD = await num("#stat-participants");
  out(
    totalD === totalR - 1,
    "admin remove participant (two-step)",
    `participants ${totalR} -> ${totalD}`
  );

  out(errs.length === 0, "admin console errors", errs[0] || "none");
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
process.exit(failures === 0 ? 0 : 1);

