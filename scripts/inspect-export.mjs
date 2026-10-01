/**
 * Produce a real .xlsx of the live roster and print what is in it, so the export
 * can be inspected without opening Excel. Read-only.
 *
 *   node scripts/inspect-export.mjs [college] [year] [department] [status]
 *
 * Unzipping the result is deliberately not done with a library: the writer emits
 * STORE-only entries, so the sheet XML can be read straight out of the bytes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { buildRosterWorkbook } from "../src/lib/xlsx.js";

function loadEnv(p) {
  const env = {};
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv(new URL("../.env", import.meta.url));
const url = env.SUPABASE_URL.replace(/\/+$/, "");
const key = env.SUPABASE_ANON_KEY;

const login = await fetch(`${url}/rest/v1/rpc/staff_login`, {
  method: "POST",
  headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    p_username: env.SUPABASE_STAFF_EMAIL,
    p_password: env.SUPABASE_STAFF_PASSWORD,
    p_ip: "127.0.0.1",
    p_agent: "inspect-export",
  }),
});
const token = (await login.json()).token;
if (!token) {
  console.error("FAIL: could not open a staff session");
  process.exit(1);
}

const [, , college, year, department, status] = process.argv;
const res = await fetch(`${url}/rest/v1/rpc/staff_export_registrations`, {
  method: "POST",
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "X-Nexus-Staff-Token": token,
  },
  body: JSON.stringify({
    p_from_date: null,
    p_to_date: null,
    p_event: null,
    p_status: status || null,
    p_college: college || null,
    p_year: year || null,
    p_department: department || null,
  }),
});
const rows = await res.json();
if (!Array.isArray(rows)) {
  console.error("FAIL: export RPC returned", JSON.stringify(rows).slice(0, 300));
  process.exit(1);
}

console.log(`filters: college=${college || "-"} year=${year || "-"} department=${department || "-"} status=${status || "-"}`);
console.log(`rows returned by the RPC: ${rows.length}`);
console.log(`fields the RPC returns : ${Object.keys(rows[0] ?? {}).join(", ")}\n`);

const bytes = buildRosterWorkbook(rows, "inspect");
const out = new URL("../artifacts/roster-inspect.xlsx", import.meta.url);
writeFileSync(out, Buffer.from(bytes));
console.log(`wrote ${out.pathname.split("/").pop()} (${bytes.length} bytes)`);

/* ---- pull the sheet back out of the ZIP and read the header + first rows ---- */
// The writer stores entries uncompressed, so the payload is the raw bytes at the
// offset in the local header. Reading it here rather than trusting the writer is
// the point: this is what Excel will actually see.
/* ---- pull the sheet back out of the ZIP and read the header + first rows ---- */
/* Read the CENTRAL DIRECTORY, not the local header. The two disagree whenever
   a data descriptor is present, and hand-computing offsets from the local
   header is how this first attempt read a buffer starting mid-row-23. The
   central directory is the index the format actually provides for this. */
function readZipEntries(buf) {
  // The end-of-central-directory record ends with the directory's own offset.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record: not a ZIP");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    // The local header repeats the name and extra lengths, and the two `extra`
    // fields are NOT the same length - so the payload offset comes from here.
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataAt, dataAt + compSize);
    entries.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const entries = readZipEntries(Buffer.from(bytes));
console.log(`\nzip entries: ${[...entries.keys()].join(", ")}`);

const sheet = entries.get("xl/worksheets/sheet1.xml") ?? "";
if (!sheet) {
  console.error("FAIL: xl/worksheets/sheet1.xml is not in the archive");
  process.exit(1);
}
if (process.env.XLSX_DEBUG) {
  console.log(`  sheet1.xml is ${sheet.length} chars, starts: ${JSON.stringify(sheet.slice(0, 120))}`);
}


/* A cell is <c r="A1" t="inlineStr" s="1"><is><t>text</t></is></c> for a string
   and <c r="I2" s="2"><v>349</v></c> for a number. The `t` attribute and the
   `s` attribute appear in either order and both are optional, so the type is
   read from the whole tag rather than by assuming a position.

   Scoped to <sheetData> on purpose. The <cols> block above it also contains
   tags, and a match that starts there swallows the first thirty rows - which
   reads as "the header is empty" rather than as the parse error it is. */
const data = /<sheetData>([\s\S]*)<\/sheetData>/.exec(sheet)?.[1] ?? sheet;
const CELL = /<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g;
const grid = new Map();
const types = new Map();
for (const [, col, rowNum, attrs, inner] of data.matchAll(CELL)) {
  const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
  const value = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
  const key = `${col}${rowNum}`;
  grid.set(key, value);
  types.set(key, type);
}

const unescape = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const maxRow = Math.max(...[...grid.keys()].map((k) => Number(k.replace(/^\D+/, ""))));
const cols = [...new Set([...grid.keys()].map((k) => k.replace(/\d+$/, "")))].sort(
  (a, b) => a.length - b.length || a.localeCompare(b)
);
console.log(`\nsheet: ${maxRow} rows (1 header + ${maxRow - 1} data), ${cols.length} columns\n`);
if (process.env.XLSX_DEBUG) {
  console.log("first 3 raw cells:");
  for (const [, col, rowNum, attrs, inner] of [...data.matchAll(CELL)].slice(0, 3)) {
    console.log(`  ${col}${rowNum} attrs=${JSON.stringify(attrs)} inner=${JSON.stringify(inner)}`);
  }
  console.log(`grid size ${grid.size}, A1=${JSON.stringify(grid.get("A1"))}\n`);
}

for (let r = 1; r <= Math.min(maxRow, 4); r += 1) {
  const line = cols
    .map((c) => unescape(grid.get(`${c}${r}`) ?? ""))
    .join(" | ");
  console.log(r === 1 ? `HDR  ${line}` : `R${r}  ${line}`);
}
if (maxRow > 4) console.log(`...  (${maxRow - 4} more rows)`);

/* The things that make a reconciliation sheet wrong rather than ugly. */
const header = cols.map((c) => unescape(grid.get(`${c}1`) ?? ""));
const amountCol = header.indexOf("AMOUNT");
if (amountCol >= 0) {
  const letter = cols[amountCol];
  const asText = [];
  let total = 0;
  for (let r = 2; r <= maxRow; r += 1) {
    const t = types.get(`${letter}${r}`) ?? "n";
    if (t !== "n") asText.push(r);
    total += Number(grid.get(`${letter}${r}`)) || 0;
  }
  console.log(`\nAMOUNT column ${letter}: ${maxRow - 1 - asText.length} numeric, ${asText.length} text`);
  console.log(`column totals to: ${total}`);
  console.log(asText.length ? `  text cells on rows ${asText.slice(0, 10).join(", ")} - Excel would skip these` : "  every amount is a number, so SUM() sees all of them");
}

