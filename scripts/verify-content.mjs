/**
 * Prove the announcements, problem statements and the new college option against
 * the LIVE project.
 *
 *   npm run verify:content
 *
 * The checks that matter, and the failure each one was written against:
 *
 *   1. public_announcements() / public_problem_statements() answer ok:true WITH
 *      rows. A silent ok:true carrying two EMPTY lists is the quiet failure â€” no
 *      error anywhere, just a page rendering nothing, which is indistinguishable
 *      from "nothing published yet".
 *   2. an UNPUBLISHED row stays off the page; publishing puts it on; retiring
 *      takes it off AND leaves it in the console list. Without that last part
 *      there is no way to re-publish what was retired.
 *   3. a future-dated row is hidden until its date â€” the entire point of
 *      published_at.
 *   4. half a link is refused. That is the shape that produces a dead "Read more".
 *   5. a COORDINATOR cannot write either table. Hiding the console tab proves
 *      nothing; only the database refusing proves it.
 *   6. the Annamacharya college exists and is offered by the roster's filter.
 *
 * Cleans up after itself whatever happens.
 */
import { readFileSync } from "node:fs";

function loadEnv(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadEnv(new URL("../.env", import.meta.url)), ...process.env };
const url = (env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const anon = env.SUPABASE_ANON_KEY;

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const rpc = async (token, name, params) => {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      "Content-Type": "application/json",
      ...(token ? { "X-Nexus-Staff-Token": token } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20_000),
  });
  return res.json().catch(() => null);
};

/* As postgres, for setup and teardown. Seeding through the RPCs would prove
   nothing about a row the RPCs themselves made. */
const sql = (() => {
  const token = env.SUPABASE_ACCESS_TOKEN;
  if (!token) return null;
  const ref = new URL(url).hostname.split(".")[0];
  return async (query) => {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    /* An expired or revoked PAT answers 401 with a JSON body, and a bad statement
       answers 400. BOTH are returned as [] and BOTH print â€” a swallowed error here
       showed up downstream as "a coordinator could not sign in", which points at
       the role test when the real fault was this insert. */
    if (!res.ok) {
      console.log(`  note: the Management API refused a statement (${res.status}) ${text.slice(0, 200)}`);
      return [];
    }
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
    } catch {
      console.log(`  note: unreadable answer from the Management API: ${text.slice(0, 200)}`);
      return [];
    }
  };
})();

console.log("=== PUBLIC CONTENT (LIVE) VERIFIED ===\n");

const login = await rpc(null, "staff_login", {
  p_username: env.SUPABASE_STAFF_EMAIL,
  p_password: env.SUPABASE_STAFF_PASSWORD,
});
const token = login?.token;
out(Boolean(token), "signed in as a master", env.SUPABASE_STAFF_EMAIL);
if (!token) {
  console.error("SKIP: no staff credentials in .env");
  process.exit(0);
}

const STAMP = Date.now().toString(36);
const TITLE = `ZZ content probe ${STAMP}`;
const ids = { announcement: null, future: null, statement: null };

const titles = async () => (await rpc(null, "public_announcements", { p_limit: 50 }))?.announcements ?? [];
const has = (list, title) => list.some((a) => a.title === title);

try {
  /* ---------- 1. the public reads answer, with rows ---------- */

  const pub = await rpc(null, "public_announcements", { p_limit: 50 });
  out(pub?.ok === true, "public_announcements answers ok:true");
  out(Array.isArray(pub?.announcements), "â€¦and returns an array", `count=${(pub?.announcements ?? []).length}`);

  const stmts = await rpc(null, "public_problem_statements", { p_event_id: null });
  out(stmts?.ok === true, "public_problem_statements answers ok:true");
  out(Array.isArray(stmts?.statements), "â€¦returns a statements array");
  out(Array.isArray(stmts?.events), "â€¦plus the event list its filter is built from");

  /* ---------- 2. unpublished off, published on, retired off but kept ---------- */

  const created = await rpc(token, "staff_upsert_announcement", {
    p_announcement: { title: TITLE, body: "probe", is_active: false },
  });
  out(created?.ok === true, "a master can write an announcement", created?.error ?? "");
  ids.announcement = created?.id ?? null;

  out(!has(await titles(), TITLE), "an UNPUBLISHED announcement is off the public page");

  await rpc(token, "staff_upsert_announcement", {
    p_announcement: { id: ids.announcement, title: TITLE, body: "probe", is_active: true },
  });
  out(has(await titles(), TITLE), "and it appears once Published is ticked");

  await rpc(token, "staff_retire_announcement", { p_announcement_id: ids.announcement });
  out(!has(await titles(), TITLE), "retiring takes it off the page");

  const listed = await rpc(token, "staff_list_announcements", {});
  out(
    (listed?.announcements ?? []).some((a) => a.id === ids.announcement),
    "the console still lists it â€” retired, not deleted"
  );

  /* ---------- 3. a future date hides it ---------- */

  const future = await rpc(token, "staff_upsert_announcement", {
    p_announcement: {
      title: `${TITLE} future`,
      body: "probe",
      is_active: true,
      published_at: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  ids.future = future?.id ?? null;
  out(!has(await titles(), `${TITLE} future`), "a future-dated announcement is hidden until its date");

  /* ---------- 4. half a link is refused ---------- */

  const half = await rpc(token, "staff_upsert_announcement", {
    p_announcement: { title: `${TITLE} half`, body: "probe", link_label: "Read more" },
  });
  out(half?.ok === false, "half a link is refused", half?.error ?? "");

  /* ---------- 5. problem statements ---------- */

  /* Two events and two categories, so the two filters can be checked AGAINST EACH
     OTHER rather than in isolation — a filter proved only on its own passes just
     as well when it is a client-side `Array.filter`.

     The events come from the catalogue, NOT from `stmts.events`. That list holds
     only events that already have a published brief, so on a database where
     nothing is published yet it is empty — and reading the event under test out
     of it made this whole block skip silently, which is the failure mode this
     suite exists to prevent. An event is something that exists whether or not
     anybody has written about it. */
  const CATS = ["sustainability", "fintech"];
  const evtRows = sql
    ? await sql(
        `select c.id from public.event_catalogue c
          where c.is_active
          order by c.title limit 2;`
      )
    : null;
  const evts = Array.isArray(evtRows) ? evtRows.map((r) => r?.id).filter(Boolean) : [];
  out(
    evts.length >= 1,
    "at least one catalogue event is available to file briefs against",
    evts.join(", ") || "none — the filter checks below did NOT run"
  );

  const event = evts[0] ?? null;
  const event2 = evts[1] ?? event;

  /* One brief carries a category, one carries a differently-cased and padded one
     (free text typed by an operator is rarely tidy, and a category filter that
     cannot find its own category has failed at the only thing it exists to do),
     one belongs to the SECOND event under the second category, and one has no
     event and no category at all. */
  const seeds = [
    { event_id: event, track: CATS[0] },
    { event_id: event, track: `  ${CATS[1][0].toUpperCase()}${CATS[1].slice(1)}  ` },
    { event_id: event2, track: CATS[1] },
    { event_id: null, track: null },
  ];

  const made = await rpc(token, "staff_upsert_problem_statement", {
    p_statement: {
      title: TITLE,
      summary: "probe summary",
      detail: "probe detail",
      event_id: event,
      is_active: true,
    },
  });
  out(made?.ok === true, "a master can write a problem statement", made?.error ?? "");
  ids.statement = made?.id ?? null;

  const extra = [];
  for (const [i, seed] of seeds.entries()) {
    const r = await rpc(token, "staff_upsert_problem_statement", {
      p_statement: {
        title: `${TITLE} ${i}`,
        summary: "probe summary",
        event_id: seed.event_id,
        track: seed.track,
        is_active: true,
      },
    });
    if (r?.id) extra.push(r.id);
  }
  ids.statements = extra;
  out(extra.length === seeds.length, "…and several more, across events and categories");

  const pubStmts = await rpc(null, "public_problem_statements", { p_event_id: null, p_track: null });
  out(
    (pubStmts?.statements ?? []).some((s) => s.title === TITLE),
    "and it appears on the public page"
  );

  /* THE POINT OF THE FEATURE: both filters reach the database, not the browser.
     Each is proved by narrowing, and each is proved to leave the OTHER list
     usable — a category filter that returned the right rows but emptied the event
     dropdown would leave the reader unable to switch back. */
  if (event) {
    const narrowed = await rpc(null, "public_problem_statements", {
      p_event_id: event,
      p_track: null,
    });
    out(
      (narrowed?.statements ?? []).some((s) => s.title === TITLE),
      "narrowing to one event keeps that event's briefs",
      event
    );

    const byCat = await rpc(null, "public_problem_statements", {
      p_event_id: null,
      p_track: CATS[0],
    });
    const byCatTitles = (byCat?.statements ?? []).map((s) => s.title);
    out(
      byCatTitles.includes(`${TITLE} 0`) && !byCatTitles.includes(`${TITLE} 1`),
      "narrowing to a category drops the briefs filed under another",
      byCatTitles.join(", ")
    );

    const messy = await rpc(null, "public_problem_statements", {
      p_event_id: null,
      p_track: `  ${CATS[1][0].toUpperCase()}${CATS[1].slice(1)}  `,
    });
    out(
      (messy?.statements ?? []).some((s) => s.title === `${TITLE} 1`),
      "a category typed in a different case, padded with spaces, still finds its brief"
    );

    const both = await rpc(null, "public_problem_statements", {
      p_event_id: event,
      p_track: CATS[0],
    });
    out(
      (both?.statements ?? []).length === 1 && both.statements[0].title === `${TITLE} 0`,
      "event AND category together narrow to exactly their intersection",
      (both?.statements ?? []).map((s) => s.title).join(", ")
    );

    /* The faceted counts, and the dead end they exist to prevent. The LIST is not
       narrowed — only the COUNT is — because narrowing the list made the event
       dropdown vanish the moment one category matched one event, taking the
       reader's only route back with it. So the event with nothing in this
       category is still listed, carrying a zero. */
    const evsUnderCat = (byCat?.events ?? []).map((e) => e.id);
    const mine = (byCat?.events ?? []).find((e) => e.id === event);
    const theirs = (byCat?.events ?? []).find((e) => e.id === event2 && e.id !== event);
    out(
      mine != null && mine.count > 0,
      "the event with a brief in this category is offered, with a count",
      mine ? `${mine.title}=${mine.count}` : "not offered"
    );
    out(
      evsUnderCat.includes(event),
      "the event list is NOT narrowed by the category, so the control cannot collapse",
      evsUnderCat.join(", ")
    );
    if (theirs) {
      out(
        theirs.count === 0,
        "an event with no brief in this category is listed with a count of ZERO, for the page to disable",
        `${theirs.title}=${theirs.count}`
      );

      /* …and the zero is honest: that combination really is an empty page. */
      const deadEnd = await rpc(null, "public_problem_statements", {
        p_event_id: event2,
        p_track: CATS[0],
      });
      out(
        (deadEnd?.statements ?? []).length === 0,
        "…and that combination would indeed have been an empty page"
      );
    }

    const catNames = (byCat?.tracks ?? []).map((t) => t.name);
    out(
      catNames.includes(CATS[0]) && catNames.includes(CATS[1]),
      "the category list survives an event filter",
      catNames.join(", ")
    );
    out(
      catNames.every((n) => n === n.toLowerCase()),
      "…and every category value is lowercased, so a selection survives a refetch"
    );

    /* A brief with no category stays reachable under "all categories" and never
       appears as an empty row in the category dropdown. */
    const allCats = await rpc(null, "public_problem_statements", {
      p_event_id: null,
      p_track: null,
    });
    out(
      (allCats?.statements ?? []).some((s) => s.title === `${TITLE} 3`) &&
        (allCats?.tracks ?? []).every((t) => (t.name ?? "").trim() !== ""),
      "a brief with no category is browsable, and the category list has no blank row"
    );
  }

  const noSummary = await rpc(token, "staff_upsert_problem_statement", {
    p_statement: { title: TITLE, summary: "   " },
  });
  out(noSummary?.ok === false, "a blank summary is refused", noSummary?.error ?? "");

  /* ---------- 6. the college option, and 7. the coordinator refusal ---------- */

  if (!sql) {
    // Said plainly rather than skipped quietly: without the PAT these two are the
    // checks most worth running, and a green summary would imply they passed.
    out(false, "SUPABASE_ACCESS_TOKEN absent â€” the college and role checks were NOT run");
  } else {
    const [college] = await sql(
      `select count(*)::int as n from public.colleges
        where lower(btrim(name)) = lower('Annamacharya Institute of Technology and Sciences')`
    );
    out(Number(college?.n) === 1, "the Annamacharya college is in the lookup table", `n=${college?.n}`);

    const options = await rpc(token, "staff_filter_options", {});
    out(
      (options?.colleges ?? []).some(
        (c) => c.name === "Annamacharya Institute of Technology and Sciences"
      ),
      "â€¦and is offered by the roster's college filter",
      `${(options?.colleges ?? []).length} options`
    );

    /* Hyphenated and lowercase, because chk_staff_users_username is
       `^[a-z0-9._-]{3,32}$`. "zz coord <stamp>" fails that constraint, the insert
       is refused, and the only visible symptom is a coordinator who cannot sign
       in â€” which reads as a failure of the ROLE test rather than of this line. */
    const probe = `zz-coord-${STAMP}`;
    await sql(
      `insert into public.staff_users (username, password_hash, role, is_active)
       values ('${probe}', extensions.crypt('probe', extensions.gen_salt('bf', 10)), 'coordinator', true);`
    );
    const coordToken = (await rpc(null, "staff_login", { p_username: probe, p_password: "probe" }))?.token;
    if (coordToken) {
      const coordAnn = await rpc(coordToken, "staff_upsert_announcement", {
        p_announcement: { title: "coordinator should not", body: "x" },
      });
      out(coordAnn?.ok === false, "a coordinator cannot write an announcement", coordAnn?.error ?? "");

      const coordList = await rpc(coordToken, "staff_list_announcements", {});
      out(coordList?.ok === false, "a coordinator cannot read the console list", coordList?.error ?? "");

      const coordStmt = await rpc(coordToken, "staff_upsert_problem_statement", {
        p_statement: { title: "coordinator should not", summary: "x" },
      });
      out(coordStmt?.ok === false, "a coordinator cannot write a problem statement", coordStmt?.error ?? "");
    } else {
      out(false, "a coordinator could not sign in â€” the role refusal was NOT tested");
    }
  }
/* ---------- 8. delete, and who may do it ---------- */

  /* Delete is not just "retire but harder": it is the only way to clear a draft
     off the list, which is exactly the state the tab could previously not
     recover from. Retiring keeps the row; this must actually REMOVE it. */
  const doomed = await rpc(token, "staff_upsert_announcement", {
    p_announcement: { title: `${TITLE} doomed`, body: "probe", is_active: false },
  });
  const doomedId = doomed?.id ?? null;
  out(doomed?.ok === true && Boolean(doomedId), "a doomed draft was created", doomed?.error ?? "");

  if (doomedId) {
    const before = await rpc(token, "staff_list_announcements", {});
    const wasListed = (before?.announcements ?? []).some((a) => a.id === doomedId);

    const deleted = await rpc(token, "staff_delete_announcement", { p_announcement_id: doomedId });
    out(deleted?.ok === true, "a MASTER can delete an announcement outright", deleted?.error ?? "");

    const after = await rpc(token, "staff_list_announcements", {});
    out(
      wasListed && !(after?.announcements ?? []).some((a) => a.id === doomedId),
      "and the row is GONE — not merely hidden",
      `was listed: ${wasListed}`
    );

    const gone = await rpc(token, "staff_delete_announcement", { p_announcement_id: doomedId });
    out(gone?.ok === false, "deleting it again reports 'no such announcement'", gone?.error ?? "");
  }

  const random = await rpc(token, "staff_delete_announcement", {
    p_announcement_id: "00000000-0000-0000-0000-000000000000",
  });
  out(random?.ok === false, "deleting a non-existent id is refused, not a silent success");

  if (sql) {
    const adminName = `zz-admin-${STAMP}`;
    await sql(
      `insert into public.staff_users (username, password_hash, role, is_active)
       values ('${adminName}', extensions.crypt('probe', extensions.gen_salt('bf', 10)), 'admin', true);`
    );
    const adminToken = (await rpc(null, "staff_login", { p_username: adminName, p_password: "probe" }))
      ?.token;
    if (adminToken) {
      const adminDelete = await rpc(adminToken, "staff_delete_announcement", {
        p_announcement_id: doomedId ?? "00000000-0000-0000-0000-000000000000",
      });
      out(
        adminDelete?.ok === false,
        "an ADMIN cannot delete — retire is theirs, delete is the master's",
        adminDelete?.error ?? ""
      );
    } else {
      out(false, "the admin could not sign in — the role refusal was NOT tested");
    }
  } else {
    out(false, "SUPABASE_ACCESS_TOKEN absent — the admin refusal was NOT tested");
  }
} finally {
  /* Cleanup, always. By id rather than by title, so a concurrent probe with a
     similar title is never caught by this cleanup. */
  for (const [id, kind] of [
    [ids.announcement, "announcement"],
    [ids.future, "announcement"],
    [ids.statement, "statement"],
  ]) {
    if (!id) continue;
    await rpc(
      token,
      kind === "announcement" ? "staff_retire_announcement" : "staff_retire_problem_statement",
      kind === "announcement" ? { p_announcement_id: id } : { p_statement_id: id }
    );
  }

  if (sql) {
    await sql(
      `delete from public.staff_users where username like 'zz-coord-%' or username like 'zz-admin-%';
       delete from public.announcements where title like 'ZZ content probe%';
       delete from public.problem_statements where title like 'ZZ content probe%';`
    );
    const left = await sql(
      `select
         (select count(*)::int from public.announcements where title like 'ZZ content probe%') as a,
         (select count(*)::int from public.problem_statements where title like 'ZZ content probe%') as s,
         (select count(*)::int from public.staff_users where username like 'zz-%') as u;`
    );
    out(
      Number(left?.[0]?.a) === 0 && Number(left?.[0]?.s) === 0 && Number(left?.[0]?.u) === 0,
      "no test rows left behind",
      JSON.stringify(left?.[0] ?? {})
    );
  }
}

console.log(
  failures === 0
    ? "\n=== PUBLIC CONTENT CHECKS PASSED ==="
    : `\n=== ${failures} PUBLIC CONTENT CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);


