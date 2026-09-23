/** Realm metadata — the three gateways of the Nexus. */
export const realms = {
  forge: {
    id: "forge",
    route: "/events/forge",
    name: "THE FORGE",
    kicker: "TECHNICAL EVENTS",
    subtitle: "THE TECHNICAL REALM",
    mantra: "BUILD • BREAK • REBUILD",
    tagline: ["BUILD.", "BREAK.", "REBUILD."],
    fx: "circuit",
    accent: "#a855f7",
    blurb: "Where engineers breach the impossible — and rebuild it stronger.",
  },
  paradox: {
    id: "paradox",
    route: "/events/paradox",
    name: "THE PARADOX",
    kicker: "NON-TECHNICAL EVENTS",
    subtitle: "THE NON-TECHNICAL REALM",
    mantra: "IMAGINE • QUESTION • CREATE",
    tagline: ["IMAGINE.", "QUESTION.", "CREATE."],
    fx: "paradox",
    accent: "#d8b4fe",
    blurb: "A realm for the curious, the strange and the beautifully unproven.",
  },
  arena: {
    id: "arena",
    route: "/events/arena",
    name: "THE ARENA",
    kicker: "ESPORTS",
    subtitle: "THE NEXUS COMPETITIVE REALM",
    mantra: "COMPETE • CONQUER • ASCEND",
    tagline: ["READY?"],
    fx: "hud",
    accent: "#a855f7",
    blurb: "Neon brackets. Zero mercy. Enter as a player, leave as a legend.",
  },
};

export const realmList = ["forge", "paradox", "arena"].map((id) => realms[id]);

export function getRealm(id) {
  return realms[id] ?? null;
}

export default realms;
