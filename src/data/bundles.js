/**
 * Payment bundles — single source of truth for the Bundled page.
 *
 * Each include is either a fixed seat ({ event: "<event id>" }) or a pool
 * the buyer picks from at checkout ({ pick: "<realm>", count,
 * excludeHackathon? }). Components never hardcode bundle contents — edit here.
 */
import { events, getEventById, getEventView } from "./events.js";
import { realms } from "./realms.js";
import { getLiveBundles, getLiveEventsByRealm } from "./catalogue.js";
import { getPrice, registerFallbackPrice } from "./pricing.js";

const HACKATHON_ID =
  events.find((event) => event.category === "HACKATHON")?.id ?? "nexus-breach";

const bundlesList = [
  /* ----------------------- NEXUS REBUILDERS BUNDLED ----------------------- */
  {
    id: "bundled-299",
    number: "01",
    name: "BUNDLED",
    price: "299",
    group: "nexus-forge",
    includes: [{ event: HACKATHON_ID }, { pick: "paradox", count: 1 }],
  },
  {
    id: "bundled-349",
    number: "02",
    name: "BUNDLED",
    price: "349",
    group: "nexus-forge",
    includes: [{ event: HACKATHON_ID }, { pick: "paradox", count: 2 }],
  },
  {
    id: "forge-bundled-349",
    number: "03",
    name: "NEXUS REBUILDERS BUNDLED",
    price: "349",
    group: "nexus-forge",
    includes: [
      { event: HACKATHON_ID },
      { pick: "forge", count: 1, excludeHackathon: true },
    ],
  },
  {
    id: "forge-bundled-399",
    number: "04",
    name: "NEXUS REBUILDERS BUNDLED",
    price: "399",
    group: "nexus-forge",
    includes: [
      { event: HACKATHON_ID },
      { pick: "forge", count: 2, excludeHackathon: true },
    ],
  },
  {
    id: "bundled-399",
    number: "05",
    name: "BUNDLED",
    price: "399",
    group: "nexus-forge",
    includes: [
      { pick: "forge", count: 2, excludeHackathon: true },
      { pick: "paradox", count: 3 },
    ],
  },
  {
    // same display name & price as #04 by spec — contents below differ
    id: "forge-paradox-bundled-399",
    number: "06",
    name: "NEXUS REBUILDERS BUNDLED",
    price: "399",
    group: "nexus-forge",
    includes: [
      { event: HACKATHON_ID },
      { pick: "forge", count: 1, excludeHackathon: true },
      { pick: "paradox", count: 2 },
    ],
  },

  /* -------------------------- NEXUS OFF-GRID BUNDLED -------------------------- */
  {
    id: "paradox-bundled-249",
    number: "07",
    name: "NEXUS OFF-GRID BUNDLED",
    price: "249",
    group: "paradox",
    includes: [{ pick: "paradox", count: 2 }],
  },
  {
    id: "paradox-bundled-349",
    number: "08",
    name: "NEXUS OFF-GRID BUNDLED",
    price: "349",
    group: "paradox",
    includes: [{ pick: "paradox", count: 3 }],
  },
];

/** Page sections — heading lines + card-grid layout per group. */
export const bundleGroups = [
  {
    id: "nexus-forge",
    kicker: "Payment bundles · 01 — 06",
    titleLines: ["NEXUS", "REBUILDERS BUNDLED"],
    grid: "md:grid-cols-2 lg:grid-cols-3",
    bundles: bundlesList.filter((bundle) => bundle.group === "nexus-forge"),
  },
  {
    id: "paradox",
    kicker: "Payment bundles · 07 — 08",
    titleLines: ["NEXUS", "OFF-GRID BUNDLED"],
    grid: "mx-auto w-full max-w-4xl md:grid-cols-2",
    bundles: bundlesList.filter((bundle) => bundle.group === "paradox"),
  },
];

export const bundles = bundlesList;

export function getBundleById(id) {
  return bundlesList.find((bundle) => bundle.id === id) ?? null;
}

/**
 * The bundles the site should render right now, grouped as the page groups them.
 *
 * Same rule as getEventViewsByRealm, and for the same reason: the LIST is the
 * operator's, not the bundle's. Before this, /bundled rendered `bundleGroups` —
 * a compiled array — so a bundle the master had retired in the console kept
 * appearing with its price, and a bundle they had just created never appeared at
 * all. Both are the bug this fixes.
 *
 * `null` when the database has not answered (offline, or the first paint), so the
 * caller can tell "not known yet" from "none published" and render the compiled
 * catalogue for the first and an honest empty state for the second.
 *
 * Group headings come from the database too (kicker / title_lines), so renaming a
 * section is a console edit. The grid CLASS is presentation and stays here.
 */
export function getBundleGroups() {
  const live = getLiveBundles();
  if (!live) return null;

  // Preserve the compiled order of the groups, so a new group the database has
  // not heard of still lands in a sensible place rather than at random.
  const order = new Map(bundleGroups.map((group, i) => [group.id, i]));
  const gridFor = new Map(bundleGroups.map((group) => [group.id, group.grid]));
  const byGroup = new Map();

  for (const row of live) {
    const id = row.group_id ?? "nexus-forge";
    if (!byGroup.has(id)) byGroup.set(id, []);
    byGroup.get(id).push({
      id: row.id,
      number: row.number ?? "",
      name: row.name ?? "",
      // The live price, carried on the card's object. 0 is a real price (FREE),
      // null means the database has no price for this bundle, which is a gap the
      // operator must fix — never a number to invent.
      price: row.price == null ? null : Number(row.price),
      includes: Array.isArray(row.includes) ? row.includes : [],
    });
  }

  return [...byGroup.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99))
    .map(([id, list]) => {
      // Headings: the database's if it gave any, the compiled copy otherwise.
      const source = live.find((row) => (row.group_id ?? "nexus-forge") === id);
      return {
        id,
        kicker:
          source?.kicker ??
          bundleGroups.find((g) => g.id === id)?.kicker ??
          "Payment bundles",
        titleLines: source?.title_lines?.length
          ? source.title_lines
          : bundleGroups.find((g) => g.id === id)?.titleLines ?? [],
        grid: gridFor.get(id) ?? "md:grid-cols-2 lg:grid-cols-3",
        bundles: list,
      };
    });
}

// Register the JS prices as fallbacks for the database values. The live price is
// fetched at runtime from public.pricing (see pricing.js); these are only used
// when the database has not answered, so a price is never *lost* by moving it
// into the database — only *changed* from there.
bundlesList.forEach((bundle) => registerFallbackPrice("bundle", bundle.id, bundle.price));

/**
 * The price to charge for a bundle right now.
 *
 * Prefers the database value and falls back to the JS constant. This is the
 * function every price-rendering call site should use, so the priority rule
 * lives in one place instead of being re-implemented per component.
 */
export function getBundlePrice(id) {
  const bundle = getBundleById(id);
  if (!bundle) return null;
  const live = getPrice("bundle", id);
  return live == null ? Number(bundle.price) : live;
}

/** The events a pick-pool can draw from (hackathon excluded when flagged). */
export function getPickPool({ pick, excludeHackathon = false }) {
  // The pool is what a buyer can actually choose from, so it comes from the
  // catalogue when the database has answered — an event retired in the console
  // must not still be offered as a choice on a card.
  const source = getLiveEventsByRealm(pick) ?? events;
  return source
    .map((event) => getEventView(event))
    .filter(
      (event) =>
        event.realm === pick && (!excludeHackathon || event.id !== HACKATHON_ID)
    );
}

/** Human label for one include line (cards, gateway chip, screen readers). */
export function describeInclude(item) {
  if (item.event) {
    // Through the live view, so a title renamed in the console is what the card
    // prints rather than the compiled one.
    const event = getEventView(getEventById(item.event) ?? { id: item.event });
    return event ? `${event.title} · ${event.category ?? ""}`.replace(/ · $/, "") : item.event;
  }
  const realm = realms[item.pick];
  const name = (realm?.name ?? item.pick).replace(/^THE /, "");
  const plural = item.count > 1 ? "S" : "";
  return `ANY ${item.count} ${name} EVENT${plural}${
    item.excludeHackathon ? " — EXCL. HACKATHON" : ""
  }`;
}

export default bundlesList;