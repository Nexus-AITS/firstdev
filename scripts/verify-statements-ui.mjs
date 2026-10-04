/**
 * The /problem-statements event + category filters, in a real browser, against
 * real published briefs.
 *
 *   VERIFY_BASE=http://localhost:4173 node scripts/verify-statements-ui.mjs
 *
 * WHY THIS SEEDS ITS OWN CONTENT
 *
 * verify-content-ui.mjs deliberately checks the page in whatever state the
 * database happens to be in, so it passes before anything is published. That is
 * the right default for "is this route wired" and the wrong test for "does the
 * category filter work", because with no published briefs there are no dropdowns
 * to operate at all — the suite would pass while proving nothing. This one
 * writes two events x two categories, drives both dropdowns, and removes
 * everything it wrote.
 *
 * The interesting assertions are about COMBINATIONS. A filter checked only on its
 * own would also pass as a client-side `Array.filter`, which is precisely the
 * implementation this replaced.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

function loadEnv(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
const env = { ...loadEnv(new URL("../.env", import.meta.url)), ...process.env };
const BASE = process.env.VERIFY_BASE || "http://localhost:4173";
const STAMP = Date.now().toString(36);
const TITLE = `ZZ ui statements ${STAMP}`;
const DB = env.SUPABASE_URL.replace(/\/+$/, "");

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const anon = {
  apikey: env.SUPABASE_ANON_KEY,
  Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};
const post = (fn, body, headers = anon) =>
  fetch(`${DB}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(body) }).then((r) =>
    r.json()
  );

/* Cleanup goes through SQL, not the API: there is no staff_delete_problem_statement,
   and RETIRING the probes would leave four permanent rows in the operator's list
   saying "nothing written yet" is a lie. */
const sql = async (query) => {
  if (!env.SUPABASE_ACCESS_TOKEN) return null;
  const ref = new URL(env.SUPABASE_URL).hostname.split(".")[0];
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  try {
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
};

const token = (await post("staff_login", {
  p_username: env.SUPABASE_STAFF_EMAIL,
  p_password: env.SUPABASE_STAFF_PASSWORD,
}))?.token;
if (!token) {
  console.error("FAIL: could not sign in — the filters were NOT tested");
  process.exit(1);
}
const staff = { ...anon, "X-Nexus-Staff-Token": token };

const CAT_A = "uicat-alpha";
const CAT_B = "uicat-beta";
console.log("=== PROBLEM STATEMENT FILTERS (UI) ===\n");
const written = [];

/* Clear residue from a previous CRASHED run before seeding. A run that dies
   part-way leaves its briefs behind, and the next run then asserts against its
   own leftovers and fails for a reason that has nothing to do with the code. */
await sql("delete from public.problem_statements where title like 'ZZ ui statements%';");
/* Hoisted: the browser half needs to know WHICH event it is clicking on, and a
   variable scoped to the seeding block would not survive to it. */
let evs = [];

try {
  /* Two real events, so the two filters can disagree with each other. */
  const all = (await post("public_problem_statements", { p_event_id: null, p_track: null })) ?? {};
  evs = all.events ?? [];
  if (evs.length < 2) {
    const r = await sql(
      "select c.id, c.title from public.event_catalogue c where c.is_active order by c.title limit 2;"
    );
    if (Array.isArray(r) && r.length >= 2) {
      evs = r.map((x) => ({ id: x.id, title: x.title }));
    }
  }
  out(evs.length >= 2, "two catalogue events to browse", evs.map((e) => e?.id).join(", "));

  const seed = [
    { event_id: evs[0]?.id ?? null, track: CAT_A },
    { event_id: evs[0]?.id ?? null, track: CAT_B },
    { event_id: evs[1]?.id ?? null, track: CAT_B },
  ];
  for (const [i, s] of seed.entries()) {
    const r = await post(
      "staff_upsert_problem_statement",
      {
        p_statement: {
          title: `${TITLE} ${i}`,
          summary: `probe brief ${i}`,
          event_id: s.event_id,
          track: s.track,
          is_active: true,
        },
      },
      staff
    );
    if (r?.id) written.push(r.id);
  }
  out(written.length === 3, "three briefs published across two events and two categories", `${written.length}/3`);
} catch (e) {
  out(false, "the probes could not be published", String(e?.message ?? e));
}

const browser = await chromium.launch();
const errors = [];
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(`${e?.message ?? e}`));
const eventBox = page.locator('[data-select="statement-event-filter"]');
const trackBox = page.locator('[data-select="statement-track-filter"]');
const opt = (id, text) =>
  page.locator(`[data-select-list="${id}"] [role="option"]`, { hasText: text });
const listed = async () =>
  (await page.locator('[data-action="problem-statement"] h2').allInnerTexts())
    .map((t) => t.trim())
    .filter((t) => t.startsWith(TITLE));
const waitCount = (n) =>
  page.waitForFunction(
    ({ want, mine }) =>
      [...document.querySelectorAll('[data-action="problem-statement"] h2')].filter((h) =>
        h.textContent.trim().startsWith(mine)
      ).length === want,
    { want: n, mine: TITLE },
    { timeout: 15000 }
  );
try {
  await page.goto(`${BASE}/problem-statements`, { waitUntil: "networkidle", timeout: 45000 });
  await page.locator('[data-action="statement-list"]').first().waitFor({ timeout: 20000 });

  out((await eventBox.count()) === 1, "the EVENT filter is on the page");
  out((await trackBox.count()) === 1, "the CATEGORY filter is on the page");
  out(
    (await page.getByText(/No brief for this event/i).count()) === 0,
    "and the old event-only empty state is gone"
  );

  const start = await listed();
  out(start.length === 3, "all three briefs are listed", start.join(", "));

  /* The counts are the mechanism that prevents a dead end, so they are asserted
     rather than assumed. Opening the list is the only way to see them. */
  await trackBox.click();
  const trackLabels = await page
    .locator('[data-select-list="statement-track-filter"] [role="option"]')
    .allInnerTexts();
  await page.keyboard.press("Escape");
  out(trackLabels.length === 3, "the category list offers All + both categories", trackLabels.join(" | "));
  const realCats = trackLabels.filter((l) => !/^All categories/i.test(l));
  out(
    realCats.length > 0 && realCats.every((l) => /\(\d+\)/.test(l)),
    "…and every real category carries a count",
    realCats.join(" | ")
  );
  out(
    !/\(\d+\)/.test(trackLabels[0] ?? ""),
    "…while 'All categories' carries none, because there is nothing to count yet",
    trackLabels[0] ?? ""
  );

  /* CATEGORY ALONE — the axis that did not exist before. */
  await trackBox.click();
  await opt("statement-track-filter", CAT_A).click();
  await waitCount(1);
  const byCat = await listed();
  out(
    byCat.length === 1 && byCat[0].endsWith(" 0"),
    "picking a category narrows the list to that category",
    byCat.join(", ")
  );

  /* The selection must SURVIVE the refetch. Had the option's value changed shape
     between responses, the control would show its placeholder while the filter
     was still applied — exactly the bug the SQL's lowercase value exists to stop. */
  out(
    (await trackBox.innerText()).includes(CAT_A),
    "the control still shows the chosen category after refetching",
    (await trackBox.innerText()).replace(/\s+/g, " ")
  );

  /* The event that has nothing in this category must stay OFFERED and be
     DISABLED, not dropped. Dropping it was the first implementation and it was
     wrong twice over: the reader cannot see that the combination is empty, and
     with only one event left the whole control unmounted — taking their only way
     to widen the search with it. */
  await eventBox.click();
  const evLabels = await page
    .locator('[data-select-list="statement-event-filter"] [role="option"]')
    .allInnerTexts();
  const disabled = await page
    .locator('[data-select-list="statement-event-filter"] [role="option"][aria-disabled="true"]')
    .allInnerTexts();
  await page.keyboard.press("Escape");
  out(evLabels.length >= 3, "the event list still offers every event", evLabels.join(" | "));
  out(
    disabled.length === 1 && disabled[0].includes(evs[1].title),
    "…and the one with no brief in this category is offered but cannot be chosen",
    disabled.join(" | ") || "none disabled"
  );
  out(
    evLabels.some((l) => l.includes(evs[1].title)),
    "…it is shown, not hidden, so the empty combination is visible",
    evLabels.join(" | ")
  );

  /* EVENT AND CATEGORY TOGETHER — the intersection. */
  await eventBox.click();
  await opt("statement-event-filter", evs[0].title).click();
  await waitCount(1);
  out((await listed()).length === 1, "event AND category together show the intersection");

  /* Clearing one filter must keep the other applied and usable, or the reader is
     stuck. Alpha exists only in the first event, so clearing the event must NOT
     change the result — which is exactly what it would do if the two filters were
     not really both applied. */
  await eventBox.click();
  await opt("statement-event-filter", "All events").click();
  await waitCount(1);
  out(
    (await listed()).length === 1,
    "clearing the event leaves the category applied (alpha lives in one event only)",
    (await listed()).join(", ")
  );

  await trackBox.click();
  await opt("statement-track-filter", "All categories").click();
  await waitCount(3);
  out((await listed()).length === 3, "clearing both filters restores every brief");
  out((await eventBox.count()) === 1 && (await trackBox.count()) === 1, "both controls are still offered");

  out(errors.length === 0, "no uncaught errors", errors.join(" | "));
/* ---------- cleanup, on every path ---------- */

await sql(`delete from public.problem_statements where title like '${TITLE}%';`);
const after = (await post("public_problem_statements", { p_event_id: null, p_track: null })) ?? {};
const strays = (after.statements ?? []).filter((s) => (s.title ?? "").startsWith(TITLE));
out(strays.length === 0, "no probe briefs left behind", `${strays.length}`);

console.log(
  failures === 0
    ? "\n=== STATEMENT FILTER UI CHECKS PASSED ==="
    : `\n=== ${failures} STATEMENT FILTER UI CHECK(S) FAILED ===`
);
process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
}