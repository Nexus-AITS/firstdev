/**
 * Centralized external application links.
 *
 * The NEXUS frontend never registers users itself — every "ENTER / EXPLORE"
 * CTA hands the user over to the real application. Replace the URLs below
 * with the production application URLs. Nothing else in the codebase should
 * ever hardcode a URL.
 */

export const APPLICATION_BASE_URL = "https://YOUR-REAL-APP-URL";

export const eventLinks = {
  // The Forge
  nexusBreach: "https://YOUR-REAL-APP-URL/events/nexus-breach",
  vision2065: "https://YOUR-REAL-APP-URL/events/vision-2065",
  circuitsOfNexus: "https://YOUR-REAL-APP-URL/events/circuits-of-nexus",
  aiTuringGambit: "https://YOUR-REAL-APP-URL/events/ai-turing-gambit",
  codeRebuilding: "https://YOUR-REAL-APP-URL/events/code-rebuilding",

  // The Paradox
  scientistFiles: "https://YOUR-REAL-APP-URL/events/the-scientist-files",
  paradox2065: "https://YOUR-REAL-APP-URL/events/paradox-2065",
  shutterQuest: "https://YOUR-REAL-APP-URL/events/shutter-quest",
  matrix: "https://YOUR-REAL-APP-URL/events/matrix",
  pixelResistance: "https://YOUR-REAL-APP-URL/events/pixel-resistance",

  // The Arena
  freeFire: "https://YOUR-REAL-APP-URL/events/free-fire",

  // Systems
  nexusAI: "https://YOUR-REAL-APP-URL/ai",
};

/**
 * Resolve the external link for an event's `linkKey`.
 * Falls back to the application base URL if the key is unknown.
 */
export function getEventLink(linkKey) {
  if (!linkKey) return APPLICATION_BASE_URL;
  return eventLinks[linkKey] ?? APPLICATION_BASE_URL;
}

export default eventLinks;
