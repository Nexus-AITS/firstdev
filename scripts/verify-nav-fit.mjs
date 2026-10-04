/**
 * The header's link bar: does it fit, and is every destination still reachable?
 *
 *   VERIFY_BASE=http://localhost:4173 node scripts/verify-nav-fit.mjs
 *
 * WHY THIS NEEDS A BROWSER AND NOT A LOOK
 *
 * App.jsx sets `overflow-x-hidden` on the page shell. That is right for the
 * decorative full-bleed sections, and it means a navbar wider than its viewport
 * is CLIPPED rather than scrolled â€” so `document.scrollWidth` still equals
 * `clientWidth` and every "did it overflow?" check written against the document
 * reports a clean pass while links sit off the right edge of the screen.
 *
 * That is not hypothetical. Adding PROBLEM STATEMENTS to a seven-item bar pushed
 * it to x=1015 inside a 768px viewport, and the only symptom was that the last
 * links were not there. The bar had ALREADY been ~120px too wide at 1024px,
 * before this change; the seven-item version wrapped one label and hid the rest.
 *
 * So this asserts against the VIEWPORT and the element boxes, and it checks
 * reachability at the widths where the bar is hidden.
 */
import { chromium } from "playwright";

const BASE = process.env.VERIFY_BASE || "http://localhost:4173";
/* Either side of the bar's own breakpoint, plus the phone and laptop widths. */
const WIDTHS = [375, 768, 1024, 1280, 1440, 1680];
const BAR_MIN = 1280;

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const EXPECTED = [
  "HOME",
  "EVENTS",
  "BUNDLED",
  "ANNOUNCEMENTS",
  "PROBLEM STATEMENTS",
  "ABOUT",
  "CONTACT",
];

console.log("=== HEADER LINK FIT (UI) ===\n");
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`${e?.message ?? e}`));

await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 45000 });
/* Waited for, not sampled: the header is part of a lazily-chunked shell, and an
   evaluate that ran before it mounted threw inside the page and took the run down
   with it. */
await page.locator('nav[aria-label="Primary"]').waitFor({ timeout: 30000 });

for (const w of WIDTHS) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(350);

  const m = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Primary"]');
    if (!nav) return { noNav: true };
    const ul = nav.querySelector("ul");
    const burger = nav?.querySelector('button[aria-controls="nexus-mobile-menu"]');
    const cs = getComputedStyle(nav);
    const padR = parseFloat(cs.paddingRight);
    const ur = ul?.getBoundingClientRect();
    const br = burger?.getBoundingClientRect();
    const items = [...(ul?.querySelectorAll("li") ?? [])].map((li) => {
      const b = li.getBoundingClientRect();
      return {
        text: li.innerText.trim(),
        right: Math.round(b.right),
        h: Math.round(b.height),
      };
    });
    return {
      vw: window.innerWidth,
      padR,
      barVisible: ul ? getComputedStyle(ul).display !== "none" : false,
      burgerVisible: br ? getComputedStyle(burger).display !== "none" : false,
      ulRight: ur ? Math.round(ur.right) : null,
      items,
      /* Measured against the VIEWPORT, not the document â€” the document cannot
         report this, because overflow-x-hidden has already hidden it. */
      overflowPx: ur ? Math.round(Math.max(0, ur.right - (window.innerWidth - padR))) : 0,
    };
  });

  if (m.noNav) {
    out(false, `${String(w).padStart(4)}px  the header bar is present`, "no <nav aria-label=Primary>");
    continue;
  }

  const barExpected = w >= BAR_MIN;
  out(
    m.barVisible === barExpected,
    `${String(w).padStart(4)}px  bar is ${m.barVisible ? "shown" : "hidden"}`,
    `expected ${barExpected ? "shown" : "hidden"}`
  );
  out(
    m.burgerVisible === !barExpected,
    `${String(w).padStart(4)}px  menu button is ${m.burgerVisible ? "shown" : "hidden"}`,
    `expected ${!barExpected ? "shown" : "hidden"}`
  );

  if (m.barVisible) {
    out(
      m.overflowPx === 0,
      `${String(w).padStart(4)}px  nothing is clipped past the right edge`,
      m.overflowPx > 0 ? `${m.overflowPx}px off-screen` : "fits"
    );
    const labels = m.items.map((i) => i.text);
    out(
      JSON.stringify(labels) === JSON.stringify(EXPECTED),
      `${String(w).padStart(4)}px  the bar carries every destination`,
      labels.join(" / ")
    );
    const tall = m.items.filter((i) => i.h > 34).map((i) => i.text);
    out(
      tall.length === 0,
      `${String(w).padStart(4)}px  no label wraps onto a second line`,
      tall.join(", ")
    );
  } else {
    /* Hidden must mean reachable, not merely out of the way. */
    await page.locator('button[aria-controls="nexus-mobile-menu"]').click();
    await page.waitForTimeout(450);
    const menu = await page.evaluate(() => {
      const el = document.querySelector("#nexus-mobile-menu");
      if (!el) return null;
      return [...el.querySelectorAll("a")].map((a) => a.innerText.trim());
    });
    out(
      menu != null && EXPECTED.every((t) => menu.includes(t)),
      `${String(w).padStart(4)}px  the menu opens and offers every destination, PROBLEM STATEMENTS included`,
      menu ? menu.join(" / ") : "NO MENU OPENED"
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
}
/* The point of the change: the new link is in the HEADER BAR, and it works.
   Scoped to the primary nav on purpose â€” the footer has carried this link all
   along, and an unscoped query matches both and dies on strict mode, which is a
   confusing way to fail a check about the header. */
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);
const primary = page.getByRole("navigation", { name: "Primary" });
const link = primary.getByRole("link", { name: "PROBLEM STATEMENTS", exact: true });
out((await link.count()) === 1, "PROBLEM STATEMENTS is in the header bar");
await link.click();
await page.waitForURL(/\/problem-statements$/, { timeout: 15000 });
out(/\/problem-statements$/.test(page.url()), "â€¦and clicking it opens the page", page.url());

out(errors.length === 0, "no uncaught errors", errors.join(" | "));

await browser.close();
console.log(
  failures === 0
    ? "\n=== HEADER LINK FIT CHECKS PASSED ==="
    : `\n=== ${failures} HEADER LINK FIT CHECK(S) FAILED ===`
);
process.exitCode = failures === 0 ? 0 : 1;
