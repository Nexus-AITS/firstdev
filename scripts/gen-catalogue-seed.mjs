/**
 * Generate the catalogue seed SQL from the JS data files.
 *
 * The event and bundle rows that migration 20260927000007 seeds are the SAME data
 * the site has always shipped in src/data/{events,bundles}.js. Transcribing
 * eleven events and eight bundles by hand into SQL is exactly the kind of task
 * where a quiet typo becomes a wrong price on a public page, so the INSERT
 * statements are generated from the real arrays instead.
 *
 *   node scripts/gen-catalogue-seed.mjs            # print the SQL
 *   node scripts/gen-catalogue-seed.mjs --sql-file # write supabase/seed-catalogue.sql
 *
 * The data modules are plain ES modules whose only imports are the pricing store
 * and the realm metadata, neither of which is needed to READ the arrays. They are
 * evaluated with the imports stripped and the price store stubbed, which keeps
 * the generator working in plain Node without Vite.
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

/**
 * Load a data module as plain data: drop the module syntax, stub the store.
 *
 * `deps` supplies the values the module would otherwise IMPORT. bundles.js
 * derives its hackathon seat from the events array, so that array has to be
 * handed in for real - stubbing it would seed the wrong fixed seat.
 */
function loadDataModule(relative, deps = {}) {
  const src = readFileSync(new URL(relative, root), "utf8")
    .replace(/^\s*import[^;]*;\s*$/gm, "")
    // ORDER MATTERS. `export default events;` is removed BEFORE `export ` is
    // stripped, otherwise it survives as a bare `default events;` and the
    // generated function body is not valid JS.
    .replace(/export\s+default\s+[^;]+;?/g, "")
    .replace(/^export\s+(const|function)\s/gm, "$1 ")
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, "");

  // Each module defines only the symbols it owns: events.js has no bundlesList
  // and bundles.js has no array of its own. Returning a missing name is a
  // ReferenceError, so the list is chosen per file.
  const names = /\bbundlesList\b/.test(src) ? "events, bundlesList, bundleGroups" : "events";
  const argNames = ["registerFallbackPrice", "getPrice", ...Object.keys(deps)];
  const argValues = [() => {}, () => null, ...Object.values(deps)];
  return new Function(...argNames, `${src}\nreturn { ${names} };`)(...argValues);
}

const { events } = loadDataModule("src/data/events.js");
const { bundlesList: bundles, bundleGroups } = loadDataModule("src/data/bundles.js", {
  events,
  realms: {},
});

/* ---------- SQL helpers ---------- */

/** A quoted SQL literal. Doubles apostrophes, so only for identifiers/short text. */
const lit = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);

/**
 * Dollar-quote anything that may contain prose.
 *
 * The event copy is full of typographic apostrophes, en dashes and quotation
 * marks, and doubling quotes by hand across a paragraph is how a seed ends up
 * with a mangled sentence. A dollar-quoted string passes all of it through
 * untouched, so prose uses one and identifiers use `lit`.
 */
const prose = (s) => `$n$${String(s)}$n$`;

const intOrNull = (v) => (v == null ? "null" : String(Number(v)));

/* ---------- events ---------- */

const eventRows = events.map((e, i) => {
  const about = e.about ?? [];
  return `    (${lit(e.id)}, ${lit(e.number)}, ${prose(e.title)}, ${lit(e.category)}, ${
    e.mode ? lit(e.mode) : "null"
  }, ${lit(e.realm)}, ${prose(e.tagline ?? "")},
     array[${about.map(prose).join(", ")}]::text[],
     ${prose(e.date ?? "")}, ${prose(e.venue ?? "")}, ${prose(e.teamSize ?? "")},
     ${lit(e.maxSize)}, ${prose(e.status ?? "")}, ${lit(e.accent)}, ${lit(e.sigil)}, ${lit(
    e.linkKey
  )}, ${i})`;
});

/* ---------- bundles ---------- */

/**
 * Bundles are inserted inactive.
 *
 * An ACTIVE bundle must carry a non-empty content_key (the CHECK in migration
 * section 2), but the key is computed by the trigger that fires when the include
 * lines land. So the parents go in retired, the lines go in, the trigger fills
 * every key, and the seed's final UPDATE publishes them. Writing `true` inline
 * is the obvious thing and it fails the CHECK on the very first bundle.
 */
const SEED_RETIRED = "false";

const groupKicker = new Map(bundleGroups.map((g) => [g.id, g]));

const bundleRows = bundles.map((b, i) => {
  const g = groupKicker.get(b.group);
  return `    (${lit(b.id)}, ${lit(b.number)}, ${prose(b.name)}, ${lit(b.group)}, ${
    g ? prose(g.kicker) : "null"
  }, array[${(g?.titleLines ?? []).map(prose).join(", ")}]::text[], ${i}, ${
    // FALSE here, and the seed publishes the bundles in a final UPDATE once
    // their include lines have given every row a content_key. An active bundle
    // with an empty key violates chk_bundle_catalogue_has_includes, so this
    // ordering is not cosmetic.
    SEED_RETIRED
  }, '')`;
});

/** One row per include line, in the order the card prints them. */
const includeRows = [];
for (const b of bundles) {
  b.includes.forEach((item, position) => {
    if (item.event) {
      includeRows.push(`    (${lit(b.id)}, ${position}, ${lit(item.event)}, null, null, false)`);
      return;
    }
    includeRows.push(
      `    (${lit(b.id)}, ${position}, null, ${lit(item.pick)}, ${intOrNull(
        item.count
      )}, ${item.excludeHackathon ? "true" : "false"})`
    );
  });
}

const pricedEvents = events.filter((e) => e.payment != null && e.payment !== "");

/* PLACEHOLDER_OUTPUT */

/* ---------- output ---------- */

const header = `-- GENERATED by scripts/gen-catalogue-seed.mjs from src/data/{events,bundles}.js.
-- Do not hand-edit: regenerate with \`node scripts/gen-catalogue-seed.mjs --sql-file\`,
-- so the database and the site cannot drift apart. Re-running is safe.
`;

const body = `
-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
insert into public.event_catalogue
  (id, number, title, category, mode, realm, tagline, about, event_date, venue,
   team_size, max_size, status, accent, sigil, link_key, sort_order)
values
${eventRows.join(",\n")}
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- bundles
-- ---------------------------------------------------------------------------
-- Bundles are inserted RETIRED and activated at the end, in one statement.
--
-- The order is forced by the schema: an ACTIVE bundle must have a non-empty
-- content_key (the CHECK from migration section 2), but content_key is computed
-- by the trigger that fires when the include lines land. So the parents go in
-- inactive, the lines go in, the trigger fills each key, and only then does the
-- final UPDATE publish them. Activating inline in the VALUES list is the obvious
-- thing to write and it fails the CHECK on the very first bundle.
insert into public.bundle_catalogue
  (id, number, name, group_id, kicker, title_lines, sort_order, is_active, content_key)
values
${bundleRows.join(",\n")}
on conflict (id) do nothing;

insert into public.bundle_includes
  (bundle_id, position, event_id, pick_realm, pick_count, exclude_hackathon)
values
${includeRows.join(",\n")}
on conflict (bundle_id, position) do nothing;

-- Publish. Scoped to the rows this seed just inserted, so re-running never
-- revives a bundle a master deliberately retired, and never disturbs a bundle
-- whose lines a master has since edited.
update public.bundle_catalogue bc
   set is_active = true
 where bc.is_active = false
   and bc.content_key <> ''
   and exists (select 1 from public.bundle_includes bi where bi.bundle_id = bc.id);

-- public.pricing is the price authority and the console edits it, so this seed
-- only fills ABSENT rows. ON CONFLICT DO NOTHING is what stops a regenerated seed
-- from overwriting a price a master has since changed.
insert into public.pricing (kind, ref_id, price)
values
${bundles.map((b) => `    ('bundle', ${lit(b.id)}, ${Number(b.price)})`).join(",\n")}
on conflict (kind, ref_id) do nothing;

insert into public.pricing (kind, ref_id, price)
values
${pricedEvents.map((e) => `    ('event', ${lit(e.id)}, ${Number(e.payment)})`).join(",\n")}
on conflict (kind, ref_id) do nothing;
`;

const sql = header + body;

/* ---------- write ---------- */

const MIGRATION = new URL(
  "../supabase/migrations/20260927000007_catalogue_and_bundle_rules.sql",
  import.meta.url
);
const BEGIN = "-- == SEED BEGIN (generated - do not edit by hand) ==";
const END = "-- == SEED END ==";

/**
 * Splice the seed between the markers in the migration.
 *
 * The seed has to live INSIDE the migration rather than in a file it includes:
 * migrations here run through the Supabase Management API, which is a plain
 * SQL endpoint with no psql meta-commands, so `\i seed-catalogue.sql` would
 * arrive at Postgres as a syntax error.
 */
function inlineIntoMigration() {
  const original = readFileSync(MIGRATION, "utf8");
  const from = original.indexOf(BEGIN);
  const to = original.indexOf(END);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(
      `Could not find the SEED markers in ${MIGRATION.pathname}. ` +
        `Expected a "${BEGIN}" line followed by "${END}".`
    );
  }
  const next =
    original.slice(0, from + BEGIN.length) + "\n" + header + body + original.slice(to);
  if (next === original) {
    console.log("migration seed block already up to date");
    return false;
  }
  writeFileSync(MIGRATION, next, "utf8");
  return true;
}

if (process.argv.includes("--sql-file")) {
  // Also written standalone, so the seed can be applied to a database that has
  // the schema but not this migration (a fresh preview project, for instance).
  const out = new URL("../supabase/seed-catalogue.sql", import.meta.url);
  writeFileSync(out, sql, "utf8");
  console.log(`wrote ${out.pathname}`);
  console.log(inlineIntoMigration() ? "spliced seed into the migration" : "migration unchanged");
} else {
  process.stdout.write(sql);
}

console.error(
  `\ngenerated ${events.length} events, ${bundles.length} bundles, ` +
    `${includeRows.length} includes, ${pricedEvents.length} event prices`
);

