/**
 * Structured event data — the SEED and the offline fallback.
 *
 * This array is no longer the authority for anything an operator can change.
 * `getEventView()` below merges the live catalogue over it, and every page that
 * renders an event goes through that, so a venue or a date changed in the admin
 * console reaches the public site without a redeploy. What is left here is the
 * two things the database genuinely does not hold: the long-form PROSE (about
 * paragraphs, tagline) and the presentation (sigil, accent, logo), neither of
 * which the console edits. scripts/gen-catalogue-seed.mjs generates the SQL seed
 * from this file, so it stays the source of that too.
 *
 * linkKey maps to src/config/eventLinks.js
 * payment = entry fee in ₹ — 0 means an explicitly FREE entry. Never omit the
 * field: consumers guard on `event.payment != null`, so a missing value reads
 * as "fee unknown" and hides the price line instead of saying FREE. It is a
 * FALLBACK only; the live fee comes from public.pricing at runtime.
 * entryType = "individual" or "team": who may enter. maxTeamMembers is the cap,
 * required when entryType is "team" and absent when it is "individual".
 * paymentMode = "per_person" (everyone pays their own fee, any team is formed
 * elsewhere afterwards) or "per_team" (one registration covers a squad and one
 * leader pays once for it).
 * teamFormUrl = where a paid participant goes to form a team off-site. Empty
 * means no such step. It is data rather than a constant so changing the
 * destination is a console edit, not a release.
 * teamSize is the free-text line the site prints ("2 — 5 MEMBERS"). It is
 * editorial copy; nothing reads it as a rule.
 */
import { getLiveEvent, getLiveEventsByRealm } from "./catalogue.js";
import { getPrice, registerFallbackPrice } from "./pricing.js";

export const events = [
  /* ------------------------- NEXUS REBUILDERS ------------------------- */
  {
    id: "nexus-breach",
    number: "01",
    title: "NEXUS BREACH",
    category: "HACKATHON",
    realm: "forge",
    tagline: "Break the boundaries.\nBuild beyond them.",
    about: [
      "Organised to encourage participants to develop efficient resource-management solutions addressing real-world problems — teams take on a live challenge and ship a working prototype before the final evaluation.",
      "Sessions: Oct 5, 11:00 AM – 12:30 PM (first session) and 1:30 PM – 4:00 PM (second session); Oct 6, 9:30 AM – 11:00 AM (final session & evaluation, followed by the valedictory). Participants must bring their own laptops and chargers, and an RJ45 connector if required.",
    ],
    date: "OCT 5 — 6, 2026",
    venue: "E-BLOCK · LABS A–E · SEMINAR HALL",
    teamSize: "2 — 5 MEMBERS",
    payment: 349,
    entryType: "team",
    maxTeamMembers: 5,
    // The ONE exception to "a team pays as a team". Every participant pays their
    // own fee and the team is formed on the hackathon's own website, so this
    // site never collects a teammate list and the leader is not paying for
    // anybody. The database derives payment_mode from this flag and from
    // entry_type (migration ...028), so it cannot be set independently.
    teamFormedOffsite: true,
    status: "REGISTRATION OPEN",
    accent: "violet",
    sigil: "fracture",
    linkKey: "nexusBreach",
  },
  {
    id: "vision-2065",
    number: "02",
    title: "VISION 2065",
    category: "IDEATHON",
    realm: "forge",
    tagline: "Imagine the future.\nEngineer the impossible.",
    about: [
      "Participants develop presentations on efficient resource management addressing real-world problems — pitch the vision of 2065 to a live jury.",
      "Oct 5, 1:30 PM – 4:00 PM. Advance registration required; participants must bring their own laptops and chargers. Auditorium facilities with high-speed Wi-Fi, power supply and projector/presentation setup.",
    ],
    date: "OCT 5, 2026",
    venue: "CLASS ROOMS",
    teamSize: "1 — 5 MEMBERS",
    payment: 249,
    entryType: "team",
    // 2, not 5 — the console lowered this cap, and this compiled copy still said
    // 5. The database is the authority (getEventView overlays it), so the live
    // page was right, but the OFFLINE fallback printed a cap that contradicted
    // it. On a payment line that is not a cosmetic difference: it decides whether
    // a participant believes a team owes Rs 1245 or Rs 249.
    maxTeamMembers: 2,
    paymentMode: "per_team",
    status: "REGISTRATION OPEN",
    accent: "gold",
    sigil: "temporal",
    linkKey: "vision2065",
  },
  {
    id: "circuits-of-nexus",
    number: "03",
    title: "CIRCUITS OF NEXUS",
    category: "CIRCUIT EXPO",
    realm: "forge",
    tagline: "Where ideas\nbecome machines.",
    about: [
      "Participants develop systems on efficient resource management addressing real-world problems and exhibit them live — every stall powered on, running and open to interrogation.",
      "Oct 7 — arrangements 11:00 AM – 12:30 PM, the Expo 1:30 PM – 4:00 PM. Advance registration required; bring your own materials and circuits. Dedicated display tables, power supply, electrical safety arrangements and exhibition space provided at the Main Block ground floor.",
    ],
    date: "OCT 7, 2026",
    venue: "MAIN BLOCK — GROUND FLOOR",
    teamSize: "1 — 5 MEMBERS",
    payment: 249,
    entryType: "team",
    // 3, not 5, and paid for by the leader — same reason as vision-2065: the
    // console is the authority and the offline copy must not contradict it.
    maxTeamMembers: 3,
    paymentMode: "per_team",
    status: "REGISTRATION OPEN",
    accent: "violet",
    sigil: "circuit",
    linkKey: "circuitsOfNexus",
  },
  {
    id: "ai-turing-gambit",
    number: "04",
    title: "AI TURING GAMBIT",
    category: "MANIPULATING THE AI",
    realm: "forge",
    tagline: "Don't ask what AI can do.\nAsk what you can make it do.",
    about: [
      "Challenge the NEXUS AI itself: communicate strategically, explore its responses and extract resource-related information through problem-solving — a duel of instruction, patience and cunning with machine intelligence.",
      "Oct 6, 10:00 AM – 12:30 PM at the Main Block. Advance registration required; participants must bring their own laptops and chargers.",
    ],
    date: "OCT 6, 2026",
    venue: "MAIN BLOCK — 2 CLASSROOMS",
    teamSize: "1",
    payment: 249,
    // Individual — see the note on code-rebuilding. A compiled "team, up to 5"
    // here would print a cap the console has removed.
    entryType: "individual",
    status: "REGISTRATION OPEN",
    accent: "violet",
    sigil: "neural",
    linkKey: "aiTuringGambit",
  },
  {
    id: "code-rebuilding",
    number: "05",
    title: "CODE REBUILDING",
    category: "CODE CRACK",
    realm: "forge",
    tagline: "The code is broken.\nCan you reconstruct it?",
    about: [
      "Analyse and reconstruct corrupted code, identify logical errors and develop efficient solutions for managing resources within the NEXUS system.",
      "Oct 6, 1:30 PM – 3:00 PM (event session) in Labs D & E. Bring laptops — speed and precision both count.",
    ],
    date: "OCT 6, 2026",
    venue: "LABS D & E",
    teamSize: "",
    payment: 249,
    // Individual, and this compiled copy used to say "team, up to 5". The console
    // is the authority and getEventView overlays it, so the live page already
    // rendered this as a solo event — but a cold first paint, or the moment the
    // catalogue call has not answered, printed a TEAM cap for an event that has
    // none. On a payment line that invents a rule the organiser never set.
    entryType: "individual",
    status: "REGISTRATION OPEN",
    accent: "lavender",
    sigil: "rebuild",
    linkKey: "codeRebuilding",
  },
  /* -------------------------- NEXUS OFF-GRID -------------------------- */
  {
    id: "the-scientist-files",
    number: "01",
    title: "THE SCIENTIST FILES",
    category: "MURDER MYSTERY",
    realm: "paradox",
    tagline: "Every clue matters.\nEvery suspect has a secret.",
    about: [
      "A story-driven murder-mystery investigation built to sharpen critical thinking, analytical reasoning, observation, teamwork and problem-solving.",
      "Oct 6, 10:00 AM – 12:30 PM across the college premises. Teams receive three fictional case files and must investigate all three, submitting a final report with evidence analysis, deductions, timeline and conclusion. Judging rewards evidence-based reasoning, scientific analysis, accuracy and clarity.",
    ],
    date: "OCT 6, 2026",
    venue: "COLLEGE PREMISES",
    teamSize: "",
    payment: 249,
    // Individual — see the note on code-rebuilding.
    entryType: "individual",
    status: "REGISTRATION OPEN",
    accent: "gold",
    sigil: "mystery",
    linkKey: "scientistFiles",
  },
  {
    id: "paradox-2065",
    number: "02",
    title: "PARADOX 2065",
    category: "FUTURE-BASED THINKING CHALLENGE",
    realm: "paradox",
    tagline: "What happens when\ntomorrow becomes today?",
    about: [
      "Futuristic \"What If?\" scenarios set in 2065 around resource management, technology and society — respond with creative, logical and detailed answers that defend every conclusion.",
      "Oct 6, 10:00 AM – 12:30 PM in the E-block classroom. Answers must be completed within the allotted time with clear reasoning; judging focuses on originality, logical thinking, depth, creativity and futuristic vision.",
    ],
    date: "OCT 6, 2026",
    venue: "E-BLOCK CLASSROOM",
    teamSize: "SOLO",
    payment: 149,
    entryType: "individual",
    status: "REGISTRATION OPEN",
    accent: "violet",
    sigil: "timeline",
    linkKey: "paradox2065",
  },
  {
    id: "shutter-quest",
    number: "03",
    title: "SHUTTER QUEST",
    category: "SPOT PHOTOGRAPHY",
    realm: "paradox",
    tagline: "One moment.\nOne frame. One story.",
    about: [
      "Capture the energy, creativity and unforgettable moments of NEXUS'65 while building visual-storytelling and observation skills — one frame at the event venue that interprets the theme 2065.",
      "Oct 6, 11:00 AM – 3:30 PM. Bring your own smartphone or camera; photographs must be original and taken during the allotted window (no AI-generated or pre-shot entries), with consent before shooting identifiable people. Judging weighs composition, creativity, storytelling, technical quality and interpretation of the theme.",
    ],
    date: "OCT 6, 2026",
    venue: "NEXUS OFF-GRID — CITY SECTORS",
    teamSize: "SOLO",
    payment: 149,
    entryType: "individual",
    status: "REGISTRATION OPEN",
    accent: "lavender",
    sigil: "lens",
    linkKey: "shutterQuest",
  },
  {
    id: "matrix",
    number: "04",
    title: "MATRIX",
    category: "MEME MAKING",
    realm: "paradox",
    tagline: "Enter the matrix.\nBreak reality.",
    about: [
      "Express creativity, humour and awareness through original memes that explore the future of 2065, resource management and real-world challenges — relatable, engaging and on-theme.",
      "Oct 6, 10:00 AM – 12:30 PM. Bring a laptop or smartphone; memes must be original, created within the allotted time and suitable for a college audience. Judging focuses on humour, creativity, originality and futuristic relevance.",
    ],
    date: "OCT 6, 2026",
    venue: "NEXUS OFF-GRID — GLITCH DECK",
    teamSize: "SOLO",
    payment: 149,
    entryType: "individual",
    status: "REGISTRATION OPEN",
    accent: "violet",
    sigil: "matrix",
    linkKey: "matrix",
  },
  {
    id: "pixel-resistance",
    number: "05",
    title: "PIXEL RESISTANCE",
    category: "POSTER DESIGN",
    realm: "paradox",
    tagline: "Create what cannot\nbe ignored.",
    about: [
      "Design original, visually impactful posters that promote awareness of resource management and inspire positive change — representing life, technology, society or challenges of the year 2065.",
      "Oct 6, 10:00 AM – 12:30 PM in two Main Block classrooms. Bring laptops and chargers; posters must be created during the competition with no plagiarism or pre-made work. Judging rewards creativity, concept, visual appeal and relevance to 2065.",
    ],
    date: "OCT 6, 2026",
    venue: "MAIN BLOCK — 2 CLASSROOMS",
    teamSize: "SOLO",
    payment: 149,
    entryType: "individual",
    status: "REGISTRATION OPEN",
    accent: "gold",
    sigil: "pixel",
    linkKey: "pixelResistance",
  },

  /* ---------------------------- THE ARENA ---------------------------- */
  {
    id: "free-fire",
    number: "GAME 01",
    title: "FREE FIRE",
    category: "ESPORTS",
    mode: "SQUAD BATTLE ROYALE",
    realm: "arena",
    tagline: "Drop in.\nOnly one squad survives.",
    about: [
      "Esports promotes teamwork, strategic thinking, healthy competition, and a positive sense of community among engineering students.",
      "Free Fire is the Arena's only title this season — squad up in fours, check in before the first drop and battle after college hours until one team owns the island.",
    ],
    date: "OCT 5 — 6, 2026 · AFTER COLLEGE HOURS",
    venue: "THE ARENA — MAIN STAGE",
    teamSize: "SQUAD OF 4",
    payment: 300,
    entryType: "team",
    // 4, not 5. The operator set this in the console to match "SQUAD OF 4" and
    // the compiled copy here still said 5, which is the disagreement
    // scripts/verify-catalogue.mjs exists to catch. The database is the
    // authority; this is the offline fallback and it has to agree with it.
    maxTeamMembers: 4,
    // The one event where payment is NOT per person. A squad pays once, the
    // leader pays it for everyone, and one registration covers the whole squad —
    // so the fee below is the squad's total, not a per-head rate. Every other
    // event leaves this unset and reads as per_person.
    paymentMode: "per_team",
    // ...but this site does not LIST the squad. The four of them team up in the
    // game lobby, and their names, roll numbers and phone numbers are of no use
    // to the operations team — so the leader is not asked for them (migration
    // ...035).
    //
    // Deliberately NOT `teamFormedOffsite: true`, which would also stop the
    // roster but would flip paymentMode to per_person and turn this Rs 300
    // squad fee into Rs 300 per head.
    rosterCollectedOnSite: false,
    status: "REGISTRATION OPEN",
    accent: "violet",
    sigil: "squad",
    linkKey: "freeFire",
    // A recognisable mark for the event. `logo` points at a file served from
    // this origin, so it works under the existing CSP (img-src 'self') — see
    // src/components/event/EventLogo.jsx for why that matters, and for how to
    // swap in an official asset without touching a component.
    logo: "free-fire",
    // An event-specific input the registration form must collect.
    //
    // Not decoration: a Free Fire ID is what the operations team checks a
    // player against their in-game account at the match and scores on, so a
    // blank one is a participant who cannot be entered into the lobby. Enforced
    // in the form here and, as the authority, by migration …011 — a client-side
    // rule alone would be bypassed by anyone posting to the REST API directly.
    //
    // ONE ID, not one per squad member. paymentMode is per_team, so a single
    // registration represents the whole squad, and this is the leader's ID —
    // which is exactly how the squad is identified and entered into the lobby.
    fields: [
      {
        name: "free_fire_id",
        label: "Squad leader's Free Fire ID",
        placeholder: "e.g. 2831945712",
        help: "One per squad, not per player: the leader registers and pays for the whole squad, and this is the ID checked at the match. Open Free Fire → your profile → the number under your name.",
        maxLength: 32,
      },
    ],
  },
];

export function getEventById(id) {
  return events.find((event) => event.id === id) ?? null;
}

export function getEventsByRealm(realmId) {
  return events.filter((event) => event.realm === realmId);
}

/**
 * The event-specific inputs a registration for this event must collect.
 *
 * Read through this rather than hardcoding `free_fire_id` in the wizard: the
 * next event that needs something (a chess rating, a roll for a track) adds it
 * to its own entry here, and the form, the database check and the roster all
 * follow the same declaration. Always an array — callers must not assume the
 * field exists.
 */
export function getEventFields(id) {
  /* getEventView, NOT getEventById. The second matters more here than anywhere
     else: an event that asks for an ID is most likely to be one a master CREATED
     in the console, and a console-created event has no entry in the compiled
     array - so the old lookup returned [] for exactly the events this is for. */
  const view = getEventView(id);
  if (!view) return [];

  const compiled = getEventById(id)?.fields ?? [];
  // The console has not asked for one, and the compiled array is the authority
  // on anything else an event might declare.
  if (view.requiresEventId !== true) return compiled;

  /* The LABEL is written from the event's own title - "FREE FIRE ID", "VISION
     2065 ID" - so the field names itself and nobody has to go and find which
     event it belonged to. It used to be a literal string next to the one event
     it applied to, which is why the phrase "an event-specific ID" existed at
     all.

     Placeholder and help are carried over from a compiled entry when there is
     one, because FREE FIRE's explanation of where to find an in-game ID is
     genuinely useful prose that the console cannot hold. */
  const extra = compiled.find((f) => f.name === "event_id_value") ?? compiled[0] ?? null;
  return [
    {
      name: "event_id_value",
      label: `${view.title} ID`,
      placeholder: extra?.placeholder ?? "e.g. 2831945712",
      help:
        extra?.help ??
        "Required for this event. It is checked at the venue, so enter it exactly as the event shows it.",
      maxLength: extra?.maxLength ?? 32,
    },
  ];
}

/** The event's logo file name (without a path), or null. */
export function getEventLogo(id) {
  return getEventById(id)?.logo ?? null;
}

/** The two entry types, for a select and for a value check. */
export const ENTRY_TYPES = [
  { id: "individual", label: "Individual" },
  { id: "team", label: "Team" },
];

/**
 * How an event's entry is paid for, defaulted to "per_person".
 *
 * Reads the DATABASE value, which migration ...028 now DERIVES from
 * entry_type and team_formed_offsite, so this is a read of a settled fact
 * rather than a second rule that could disagree with the first.
 *
 *   per_person  each participant pays their own fee, and any team is formed
 *               elsewhere afterwards (the hackathon)
 *   per_team    one registration covers the squad and a leader pays once
 */
export function getPaymentMode(event) {
  return event?.paymentMode === "per_team" ? "per_team" : "per_person";
}

/**
 * Does a leader have to LIST their teammates on this event?
 *
 * The single predicate the wizard, the event card and the console all ask, so
 * they cannot disagree about which events collect a roster.
 *
 * It is deliberately NOT `getEntryType(event) === "team"`. A team event whose
 * team is formed on another website is a team event, and asking its leader for
 * teammate details here would be asking for data the operations team will never
 * use - because they are entered, and paid for, somewhere else. The two
 * questions are different and this one is the second.
 *
 * THE THIRD CASE, ADDED BY MIGRATION ...035: a squad that pays as a squad but
 * is assembled somewhere else anyway - FREE FIRE, where one leader pays the
 * whole squad's fee and the four of them team up in game. That is NOT
 * `team_formed_offsite` (which would make every member pay their own fee) and it
 * is not an individual event. It is its own fact, and it is why the predicate
 * reads a separate flag rather than inferring from the payment mode.
 *
 * The check is `=== false` rather than a truthiness test on purpose: a row from
 * before the column existed, or an offline build with no live catalogue, reads
 * undefined, and undefined must mean "collect", because the DB default is true.
 * A participant losing their roster step to an inference would find out at the
 * venue.
 *
 * The cap is read, not hardcoded, because "up to 3" is a console decision: the
 * wizard renders the number the database returns rather than one compiled here.
 */
export function requiresTeamRoster(event) {
  if (getEntryType(event) !== "team") return false;
  if (getPaymentMode(event) !== "per_team") return false;
  // Migration ...035. A squad this site does not list collects no roster, however
  // it pays. See the note above on why this is `=== false`.
  if (event?.rosterCollectedOnSite === false) return false;
  return Number.isInteger(Number(event?.maxTeamMembers)) && Number(event.maxTeamMembers) > 0;
}

/**
 * How many teammates a leader may add, or null when the event asks for no list.
 *
 * The cap COUNTS THE LEADER, so the number a leader may add is one less. This
 * is the distinction the requirement turns on: a cap of 3 means a team of three
 * people, so a leader with one teammate has entered two and can add one more.
 * Returning the decrement here rather than at each call site is what stops one
 * screen saying "3" and another saying "2" for the same event.
 */
export function maxTeammatesFor(event) {
  if (!requiresTeamRoster(event)) return null;
  return Math.max(Number(event.maxTeamMembers) - 1, 0);
}

/**
 * Human label for who pays, for the price line beside a fee.
 *
 *   per_team  -> "PER TEAM"    (one leader pays this for the whole squad)
 *   a TEAM event whose members each pay -> "PER PERSON"
 *   individual -> ""           (one person pays one fee; saying so is noise)
 *
 * The middle case is the one this function exists for. A card used to read
 * "₹349 · TEAM · MAX 5" for NEXUS BREACH, which is the one thing it must not
 * say: the price is per HEAD, so a team of five owes ₹1,745 and a participant
 * reading "₹349, team of 5" believes they owe ₹349. The database has always
 * stored that distinction — payment_mode is per_person for this event because
 * its team is formed on another website and the leader pays for nobody — but a
 * team event printed only its cap, and the cap says nothing about money.
 *
 * So the rule is: whenever an event is entered as a team, the payment mode is
 * stated, because that is exactly the situation where the bare number is
 * ambiguous. An individual event never needs it.
 */
export function formatPaymentMode(event) {
  if (getPaymentMode(event) === "per_team") return "PER TEAM";
  if (getEntryType(event) === "team") return "PER PERSON";
  return "";
}

/**
 * The sentence that removes the ambiguity, or null when there is nothing to
 * disambiguate.
 *
 * It is derived from the same two facts the cards already carry — payment_mode
 * and max_team_members — and it states the ARITHMETIC as well as the rule,
 * because "each member pays ₹349 separately, so a full team of 5 is ₹1,745"
 * cannot be misread the way "₹349 · TEAM · MAX 5" is.
 *
 * The full-team figure is the point, and it is only shown when it is knowable:
 * a team event always carries a cap (the database refuses one without), and an
 * individual event never needs the sentence. A cap of 1 makes the multiplication
 * pointless, so it is left out rather than printed as a restatement of the fee.
 *
 * Returns null for an individual event, so a caller can render it conditionally
 * rather than having to decide which events "need" it — that decision belongs
 * here, or it drifts between the card and the detail page.
 */
export function paymentNote(event) {
  if (getEntryType(event) !== "team") return null;

  const cap = Number(event?.maxTeamMembers);
  const team = Number.isInteger(cap) && cap > 0 ? cap : null;
  const fee = getEventFee(event?.id);
  const money = formatFee(fee);

  if (getPaymentMode(event) === "per_team") {
    return team
      ? `One leader pays ${money} for the whole team — up to ${team} people, and nobody else is charged.`
      : `One leader pays ${money} for the whole team.`;
  }

  // The per-person team: the hackathon. Every member settles their own seat,
  // because the team is formed elsewhere and the leader is not paying for
  // anybody. The total is stated so the cost of a full team is never a surprise
  // at the registration desk.
  if (!team || team <= 1 || fee == null || Number(fee) <= 0) {
    return "Each member pays this separately — the team leader does not pay for the others.";
  }
  return `Each of the ${team} members pays ${money} separately, so a full team is ₹${Number(fee) * team}. Teams are formed after payment.`;
}

/**
 * An event's entry type, defaulted to "individual".
 *
 * Always one of the two ids, so a caller can compare against a literal without
 * a null check. An event that declares no entryType is one nobody has stated a
 * cap for, and reading it as individual is the safe direction: it is the only
 * reading that does not promise a team seat that may not exist.
 */
export function getEntryType(event) {
  return event?.entryType === "team" ? "team" : "individual";
}

/**
 * Human label for an event's entry rule — the one place that decides what it
 * renders as, so the two can never disagree between the card and the page:
 *
 *   individual  -> "INDIVIDUAL"
 *   team, cap 5 -> "TEAM · MAX 5"
 *
 * A team event with no usable cap renders as "", never as a cap it does not
 * have. formatFee below makes the same call about a missing fee, and for the
 * same reason: a data gap must not masquerade as a real value.
 */
export function formatEntryType(event) {
  if (getEntryType(event) === "individual") return "INDIVIDUAL";
  const cap = Number(event?.maxTeamMembers);
  return Number.isInteger(cap) && cap > 0 ? `TEAM · MAX ${cap}` : "";
}

/**
 * Human label for an entry fee — the single place that decides what a fee
 * renders as, so a free event can never print "₹0" and a missing fee can never
 * masquerade as free:
 *   349 -> "₹349"  charged
 *   0   -> "FREE"  explicitly free (events.js requires `payment`, 0 = free)
 *   null -> "—"    data gap — not the same thing as free
 */
export function formatFee(payment) {
  if (payment == null || payment === "") return "—";
  return Number(payment) > 0 ? `₹${payment}` : "FREE";
}

// Register the JS fees as fallbacks for the database prices (see pricing.js).
// The live value comes from public.pricing at runtime, so changing an event fee
// is a console action rather than a code change.
//
// Keyed by the event's OWN entry type, not a default. A team event's fallback has
// to sit under the 'team' key or the store would answer with nothing for it and
// the card would render "—" for a price that plainly exists.
events.forEach((event) => {
  if (event.payment != null && event.payment !== "") {
    registerFallbackPrice("event", event.id, event.payment, getEntryType(event));
  }
});

/**
 * The live fee for an event.
 *
 * Read in this order, and the order is the point:
 *
 *   1. the catalogue row's own price, because public_catalogue is the same row
 *      the console edits, so this is the live authority;
 *   2. the pricing store, which is the same number reached a different way and
 *      is the fallback if the catalogue call failed;
 *   3. the compiled-in `payment`, for a cold first paint with no network.
 *
 * The subtlety is step 1 returning null. getEventView only sets `livePrice` from
 * a real value, so `livePrice != null` is not enough to tell "the database says
 * nothing" from "the database has not answered". Those must differ:
 *
 *   DB answered, no price   -> null, so the card renders "—" and registration is
 *                             refused. Falling through to the compiled number here
 *                             is how a retired price keeps being charged: the
 *                             operator deleted the price, the page carried on
 *                             quoting the old one, and the two disagreed forever.
 *   DB has NOT answered     -> the store, then the compiled constant.
 *
 * getLiveEvent is what tells the two apart, so the check is explicit rather than
 * inferred from the merged shape.
 *
 * Returns null when the event declares no fee at all, which formatFee renders as
 * "—" (a data gap) rather than "FREE" — a missing price is not a free seat.
 */
export function getEventFee(id) {
  /* getEventView, NOT getEventById. Resolving through the compiled array alone
     meant an event created in the console had NO fee here: this returned null,
     and a null fee is not "unknown", it is what formatFee renders as "—" AND
     what `paid = fee > 0` reads as FREE. A master could set Rs 249 on a new
     event, see the price on its page, and the register wizard would still route
     that participant past the payment steps entirely.

     The order below is unchanged; only the resolver is, and it now answers from
     whichever source has the event. */
  const view = getEventView(id);
  if (!view) return null;
  if (view.livePrice != null) return Number(view.livePrice);
  // The catalogue answered for this event and still has no price: that is the
  // answer, and it is not the compiled one.
  if (getLiveEvent(id)) return null;
  if (view.payment == null || view.payment === "") return null;
  const live = getPrice("event", id, getEntryType(view));
  return live == null ? view.payment : live;
}

/** formatFee, but DB-first. The call sites that render a live price use this. */
export function formatEventFee(id) {
  return formatFee(getEventFee(id));
}

/* ------------------------------------------------------------------ */
/* the live view                                                        */
/* ------------------------------------------------------------------ */

/**
 * Column -> the JS field it overrides. Explicit on purpose.
 *
 * A blind spread of the catalogue row over the event would be shorter and
 * wrong: it would overwrite `id`, and it would map snake_case keys onto a
 * camelCase object so every call site would need to know which shape it is
 * holding. This table is the whole contract between the two, so adding a column
 * to public_catalogue is a one-line change here rather than a hunt through the
 * components.
 *
 * `null` in the third column means the field is AUTHORITATIVE even when empty,
 * and is listed separately below rather than inferred. See BLANKABLE.
 */
const LIVE_OVERRIDES = [
  ["title", "title"],
  ["number", "number"],
  ["category", "category"],
  ["mode", "mode"],
  ["tagline", "tagline"],
  ["event_date", "date"],
  ["venue", "venue"],
  ["team_size", "teamSize"],
  ["entry_type", "entryType"],
  ["max_team_members", "maxTeamMembers"],
  ["payment_mode", "paymentMode"],
  ["team_formed_offsite", "teamFormedOffsite"],
  ["roster_collected_on_site", "rosterCollectedOnSite"],
  ["requires_event_id", "requiresEventId"],
  ["status", "status"],
  ["price", "livePrice"],
  ["registration_closes_on", "registrationClosesOn"],
];

/**
 * Fields where an empty database value is the operator's DECISION, not a gap.
 *
 * These are the two an operator legitimately clears:
 *
 *   max_registrations  null is the documented "no limit" state, and is how
 *                      every event starts. Treating it as missing would mean an
 *                      uncapped event kept a hardcoded cap forever.
 *   team_form_url      null means "this event has no team-formation step". A
 *                      compiled fallback would re-add a link to a destination
 *                      somebody deliberately removed.
 *   registration_closes_on
 *                      null means "no deadline" (migration ...034). It is
 *                      BLANKABLE rather than an override because there is no
 *                      compiled fallback worth keeping: an offline build must
 *                      not invent a date the database never set.
 *
 * Everything in LIVE_OVERRIDES still refuses a blank, because there a blank
 * means the row predates the column (a console edit on an older schema) and the
 * compiled copy is a better answer than an empty venue.
 */
const BLANKABLE = new Set(["maxRegistrations", "teamFormUrl", "registrationClosesOn"]);

/**
 * The event as the site should render it RIGHT NOW: the compiled-in shape with
 * the live catalogue laid over it.
 *
 * This is the answer to "the backend must reflect the frontend". Before it, every
 * event page read this file directly, so an operator editing a date or a venue in
 * the console changed the database and not the page. Now the console and the page
 * read the same row.
 *
 * Two rules, and the difference between them is the whole point:
 *
 *   1. NO LIVE ROW  -> the compiled event, unchanged. That is the offline path
 *      and the cold first paint, and it is the only time a hardcoded value is
 *      allowed to answer.
 *   2. LIVE ROW     -> the database wins, including when it says nothing. A null
 *      in BLANKABLE overwrites the compiled value rather than deferring to it.
 *
 * `livePrice` is kept SEPARATE from `payment`. `payment` is the offline fallback
 * and is what the pricing store was seeded with; the live figure is the
 * database's, and getEventFee decides which to show. Overwriting payment here
 * would make the fallback depend on a network call.
 */
export function getEventView(eventOrId) {
  /* A compiled entry OR a live catalogue row, whichever exists.

     getEventById() searches the compiled array in this file, and that used to be
     the ONLY place an event could come from. But the Catalogue tab writes rows to
     the database, and public_catalogue() publishes them - so a master could
     create an event, see it listed on its realm page, click it, and land on a
     404. The site was advertising a page it could not render, which is the worst
     version of this bug: the link worked, so nothing looked broken until the
     click.

     The two sources answer DIFFERENT questions and both are needed. The compiled
     copy holds prose and presentation - the `about` paragraphs, the sigil, the
     logo - that the console cannot edit. The row holds everything an operator
     CAN change. So the compiled copy stays the base when there is one, and a
     DB-only event is built from its own row and simply carries none of the
     presentation extras. Rendering its title, venue, date and fee is the point;
     the long copy can wait for a developer. */
  const byId = typeof eventOrId === "string" ? eventOrId : null;
  const base = byId !== null ? getEventById(byId) ?? getLiveEvent(byId) : eventOrId;
  if (!base) return null;
  const live = getLiveEvent(base.id);
  if (!live) return base;

  const out = { ...base };
  for (const [column, field] of LIVE_OVERRIDES) {
    const value = live[column];
    // `!= null && !== ""` rather than a truthiness test: 0 is a real price (a
    // deliberately free event) and must win over the fallback.
    if (value != null && value !== "") out[field] = value;
  }
  // Authoritative even when null — see BLANKABLE.
  for (const [column, field] of [
    ["max_registrations", "maxRegistrations"],
    ["team_form_url", "teamFormUrl"],
    ["registration_closes_on", "registrationClosesOn"],
  ]) {
    if (BLANKABLE.has(field)) out[field] = live[column] ?? null;
  }
  out.registeredCount = Number.isInteger(live.registered_count) ? live.registered_count : null;
  /* `about` is the long-form prose, and it is the one piece of an event the
     console cannot write - it lives only in the compiled file. A DB-only event
     therefore usually has none, and the column's NOT NULL DEFAULT '{}' means it
     arrives as an empty array rather than null.

     Both shapes are normalised here because the page calls `event.about.map(...)`
     directly, and an array built from a row that predates the column - or one
     whose operator left it out - must not be able to render a blank page. */
  out.about = Array.isArray(base.about) ? base.about : Array.isArray(out.about) ? out.about : [];
  return out;
}

/**
 * Today in Asia/Kolkata as a plain calendar day, "YYYYMMDD" for comparison.
 *
 * Deliberately NOT `toLocaleDateString("en-CA")` here: this module is imported by
 * the offline seed path and the console alike, and the IST offset is spelled out
 * so the answer does not depend on the machine's timezone the way a bare
 * `new Date()` comparison would.
 */
function istTodayKey() {
  const now = new Date();
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  return `${ist.getFullYear()}${String(ist.getMonth() + 1).padStart(2, "0")}${String(
    ist.getDate()
  ).padStart(2, "0")}`;
}

/**
 * Has registration closed for this event? null when there is no deadline.
 *
 * The SAME comparison trg_event_registration_cap makes, in the same zone and
 * with the same strict inequality - "closes on 5 Oct" includes 5 Oct. This is a
 * convenience for the page, never the authority: a participant who sees false
 * here can still be refused at the database, and that is correct.
 */
export function isRegistrationClosed(eventOrId) {
  const view = typeof eventOrId === "string" ? getEventView(eventOrId) : eventOrId;
  const closes = view?.registrationClosesOn;
  if (!closes) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(closes).trim());
  if (!m) return false;
  return `${m[1]}${m[2]}${m[3]}` < istTodayKey();
}

/**
 * "Registration closed on 5 Oct 2026", or null when there is no deadline.
 *
 * Assembled from the three numbers in the value, never through `new Date(...)`:
 * "2026-10-05" is midnight UTC, and formatting that back in IST prints the 4th.
 * A one-day error on a closing date is how somebody misses a registration they
 * were entitled to.
 */
export function formatRegistrationCloses(eventOrId) {
  const view = typeof eventOrId === "string" ? getEventView(eventOrId) : eventOrId;
  const closes = view?.registrationClosesOn;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(closes ?? "").trim());
  if (!m) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // Group 2 is the MONTH, group 3 the DAY. Reading them the other way round
  // renders "5 Oct 2026" as "31 Oct 2026".
  const month = months[Number(m[2]) - 1];
  if (!month) return null;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/**
 * A whole realm's events, live, in the database's order.
 *
 * The three realm pages render this, so the list itself has to come from the
 * catalogue rather than from the compiled array. Two things follow from that,
 * and both are the requirement rather than a nicety:
 *
 *   * an event created in the console APPEARS, because it is a row the database
 *     returned and the compiled array has never heard of it;
 *   * an event RETIRED in the console DISAPPEARS, because a static list would
 *     otherwise keep selling a withdrawn event forever.
 *
 * The compiled array is still the fallback for the two cases where the database
 * has not answered: offline, and the very first paint. getEventView is applied
 * on top either way, so a row that is live in both places still shows the live
 * values.
 */
export function getEventViewsByRealm(realmId) {
  const liveList = getLiveEventsByRealm(realmId);
  if (!liveList) return getEventsByRealm(realmId).map((event) => getEventView(event));

  // A DB-only event has no compiled prose (the `about` paragraphs and sigil live
  // in JS), so it is built from its own row and simply carries none. Rendering
  // the title, price, date and venue is the point; the long copy can wait for an
  // operator to add it.
  return liveList.map((row) => getEventView(getEventById(row.id) ?? row));
}

export default events;
