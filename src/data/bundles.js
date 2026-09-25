/**
 * Payment bundles — single source of truth for the Bundled page.
 *
 * Each include is either a fixed seat ({ event: "<event id>" }) or a pool
 * the buyer picks from at checkout ({ pick: "<realm>", count,
 * excludeHackathon? }). Components never hardcode bundle contents — edit here.
 */
import { events, getEventById } from "./events.js";
import { realms } from "./realms.js";

const HACKATHON_ID =
  events.find((event) => event.category === "HACKATHON")?.id ?? "nexus-breach";

const bundlesList = [
  /* ----------------------- NEXUS · THE FORGE BUNDLED ----------------------- */
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
    name: "FORGE BUNDLED",
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
    name: "FORGE BUNDLED",
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
    name: "FORGE BUNDLED",
    price: "399",
    group: "nexus-forge",
    includes: [
      { event: HACKATHON_ID },
      { pick: "forge", count: 1, excludeHackathon: true },
      { pick: "paradox", count: 2 },
    ],
  },

  /* --------------------------- PARADOX BUNDLED --------------------------- */
  {
    id: "paradox-bundled-249",
    number: "07",
    name: "PARADOX BUNDLED",
    price: "249",
    group: "paradox",
    includes: [{ pick: "paradox", count: 2 }],
  },
  {
    id: "paradox-bundled-349",
    number: "08",
    name: "PARADOX BUNDLED",
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
    titleLines: ["NEXUS", "THE FORGE BUNDLED"],
    grid: "md:grid-cols-2 lg:grid-cols-3",
    bundles: bundlesList.filter((bundle) => bundle.group === "nexus-forge"),
  },
  {
    id: "paradox",
    kicker: "Payment bundles · 07 — 08",
    titleLines: ["PARADOX BUNDLED"],
    grid: "mx-auto w-full max-w-4xl md:grid-cols-2",
    bundles: bundlesList.filter((bundle) => bundle.group === "paradox"),
  },
];

export const bundles = bundlesList;

export function getBundleById(id) {
  return bundlesList.find((bundle) => bundle.id === id) ?? null;
}

/** The events a pick-pool can draw from (hackathon excluded when flagged). */
export function getPickPool({ pick, excludeHackathon = false }) {
  return events.filter(
    (event) =>
      event.realm === pick && (!excludeHackathon || event.id !== HACKATHON_ID)
  );
}

/** Human label for one include line (cards, gateway chip, screen readers). */
export function describeInclude(item) {
  if (item.event) {
    const event = getEventById(item.event);
    return event ? `${event.title} · ${event.category}` : item.event;
  }
  const realm = realms[item.pick];
  const name = (realm?.name ?? item.pick).replace(/^THE /, "");
  const plural = item.count > 1 ? "S" : "";
  return `ANY ${item.count} ${name} EVENT${plural}${
    item.excludeHackathon ? " — EXCL. HACKATHON" : ""
  }`;
}

export default bundlesList;