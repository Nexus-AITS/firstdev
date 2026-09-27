/**
 * NEXUS runtime verification.
 * Run: node scripts/verify.mjs   (requires `npm run preview` + Chrome)
 *
 * BASE defaults to :4173 but is overridable: vite preview silently falls back
 * to :4174/4175 when 4173 is already taken (another checkout's preview server,
 * for example), and assertions against the wrong build are worse than none.
 *   VERIFY_BASE=http://localhost:4175 npm run verify
 */
import { chromium } from "playwright";

const BASE = process.env.VERIFY_BASE || "http://localhost:4173";

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
["/contact", "REACH"],
  ["/about", "EVERYTHING"],
  ["/register", "EVENT REGISTER"],
  ["/profile", "YOUR ACCOUNT"], // participant account, gated like /register
  ["/gateway", "EVENT REGISTER"], // legacy hand-off redirects into /register
  ["/bundled", "BUNDLED"],
  ["/nexus-admin", "Staff sign in"], // console gate: heading is the sign-in prompt
  ["/admin123456789", "Staff sign in"], // the retired path redirects here
  ["/admin", "REALM NOT FOUND"], // old console URL must stay dead
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
  // The headline depends on whether the runtime config resolved with
  // credentials: an unconfigured deployment must say so, a configured one must
  // be mid-exchange (a bare `?code=` visit resolves to a refused state after
  // the watchdog).
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
  // Signed out, the wizard stops at the identity gate: the details step is
  // intentionally not reachable until a Google session exists.
  out(
    (await page.locator("#reg-auth-gate").isVisible().catch(() => false)) &&
      (await page.locator("#reg-step-details").isVisible().catch(() => false)) === false,
    "register stops at the identity gate",
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
      (await page.locator("#reg-auth-gate").isVisible().catch(() => false)),
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

  /* FREE FIRE is a PAID, ranked event: ₹149 per person, because it is scored
   * on the player's in-game account. It used to be checked as a free entry —
   * and when the catalogue said `payment: 0` while the database said 149, the
   * page quietly charged for a "free" event. The two now have to agree on a
   * price, so the assertion is that the price is shown, not that it is absent. */
  await page.goto(BASE + "/events/free-fire", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const ffFee = await page.getByText("₹149", { exact: true }).count();
  const ffFree = await page.getByText("FREE", { exact: true }).count();
  const ffLogo = await page.locator('[data-event-logo="free-fire"]').count();
  out(ffFee >= 1, "FREE FIRE shows its ₹149 entry fee", `count=${ffFee}`);
  out(ffFree === 0, "FREE FIRE never renders as a free entry", `free=${ffFree}`);
  out(ffLogo === 1, "FREE FIRE renders its logo on the event page", `logos=${ffLogo}`);

  // …and its wizard is a paid one: fee strip, four steps, QR/UTR copy.
  await page.goto(BASE + "/register?event=free-fire", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  // The stepper is hidden while signed out, so the step COUNT is read from the
  // rendered list rather than its visibility.
  const ffSteps = await page
    .locator('ol[aria-label="Registration progress"] li')
    .count();
  const ffFeeStrip = await page.getByText("entry fee", { exact: true }).count();
  const ffQrCopy = await page.getByText("pay with the QR below").count();
  out(
    ffSteps === 4 && ffFeeStrip >= 1 && ffQrCopy >= 1,
    "FREE FIRE wizard charges (4 steps, fee strip, QR/UTR)",
    `steps=${ffSteps} feeStrip=${ffFeeStrip} qrCopy=${ffQrCopy}`
  );

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

/* -------- register wizard: the Google sign-in gate -------- */
/*
 * This suite cannot complete a registration: doing so needs a real Google
 * account, and asserting against a stubbed session would prove only that the
 * stub works. So what is checked here is the part that IS the security
 * boundary — an unsigned visitor must not be able to reach the form at all.
 * The RLS rules behind it are proven separately, against the live project, by
 * `npm run verify:rls`.
 */
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

  // The gate is the decisive assertion: the details form must NOT be reachable.
  // Before phase 2 the form rendered for anyone and the database rejected the
  // insert; now the page refuses first, so a signed-out visitor is told why
  // instead of watching a submission silently fail.
  const gate = await page.locator("#reg-auth-gate").isVisible().catch(() => false);
  const form = await page.locator("#reg-step-details").isVisible().catch(() => false);
  out(gate && !form, "register gates the form behind Google sign-in", `gate=${gate} form=${form}`);

  const signInCta = await page.getByRole("button", { name: /sign in to register/i }).count();
  out(signInCta === 1, "register gate offers the sign-in action", `count=${signInCta}`);

  // The stepper is progress toward a wizard you cannot start yet, so it is
  // hidden rather than shown in a permanently unreachable state.
  const steps = await page.locator('ol[aria-label="Registration progress"] li').count();
  const stepperVisible = await page
    .locator('ol[aria-label="Registration progress"]')
    .isVisible()
    .catch(() => false);
  out(
    !stepperVisible || steps === 0,
    "register hides the stepper while signed out",
    `visible=${stepperVisible} items=${steps}`
  );

  // Event context must still be advertised above the gate — the visitor is
  // choosing what to register for before being asked to identify themselves.
  const ctxCard = await page.getByRole("heading", { name: /NEXUS BREACH/i }).count();
  const fee = await page.getByText("₹349").count();
  out(ctxCard === 1 && fee >= 1, "register keeps event context above the gate", `heading=${ctxCard} fee=${fee}`);

  await page.goto(BASE + "/register?event=free-fire", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);

  out(
    (await page.locator("#reg-auth-gate").isVisible().catch(() => false)) &&
      (await page.locator("#reg-step-details").isVisible().catch(() => false)) === false,
    "free event wizard is gated too",
    ""
  );

  out(errs.length === 0, "register gate console errors", errs[0] || "none");
  await ctx.close();
}

/* -------- operations console: the staff gate, and nothing behind it -------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`PAGEERROR: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !benign(m.text())) errs.push(m.text());
  });

  // The console now lives at /nexus-admin. The old path is a redirect, checked
  // below, so a stale bookmark lands on the real console instead of a 404.
  await page.goto(BASE + "/nexus-admin", { waitUntil: "domcontentloaded" });
  // Waits on the runtime-config fetch and the staff session resolve before the
  // gate can be decided either way.
  await page.waitForTimeout(3000);

  const signIn = await page.locator("#admin-signin").isVisible().catch(() => false);
  out(signIn, "operations console requires staff sign-in", `signin=${signIn}`);

  // The critical one: no roster and no participant data may exist in the DOM
  // for a visitor with no staff session. This is the regression the original
  // console would have failed — it rendered a demo roster to anyone.
  const table = await page.locator("#admin-table-wrap").count();
  const rows = await page.locator("#admin-table-wrap > li").count();
  out(
    table === 0 && rows === 0,
    "operations console leaks no roster without a staff session",
    `table=${table} rows=${rows}`
  );

  // No social login on this page, ever. This is the specific requirement: a
  // participant's Google session must not be able to reach the roster, and the
  // only credential form offered here is username + password.
  const social = await page.getByRole("button", { name: /continue with google/i }).count();
  out(social === 0, "operations console offers no social login", `googleButtons=${social}`);

  // Bad credentials must be refused by the DATABASE, not merely hidden client
  // side, and the message is deliberately generic so the form is not a
  // username-enumeration oracle.
  await page.fill("#staff-username", `nobody.${Date.now()}`);
  await page.fill("#staff-password", "definitely-not-the-password");
  await page.click("#admin-signin-submit");
  const refused = await page
    .locator("#admin-signin-error")
    .waitFor({ state: "visible", timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  const msg = refused ? (await page.locator("#admin-signin-error").innerText()).trim() : "";
  out(
    refused && /not recognised/i.test(msg),
    "operations console rejects unknown credentials",
    msg || "no error surfaced"
  );

  // A failed attempt must not have left the roster in the DOM behind the form.
  const tableAfter = await page.locator("#admin-table-wrap").count();
  out(tableAfter === 0, "roster stays hidden after a failed sign-in", `table=${tableAfter}`);

  // The retired path redirects rather than 404-ing, so an operator with an old
  // bookmark still reaches the console.
  await page.goto(BASE + "/admin123456789", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  out(
    page.url().includes("/nexus-admin"),
    "the old console path redirects to /nexus-admin",
    new URL(page.url()).pathname
  );

  out(errs.length === 0, "operations console gate console errors", errs[0] || "none");
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
process.exit(failures === 0 ? 0 : 1);

