/**
 * A minimal, dependency-free .xlsx writer.
 *
 * WHY NOT A LIBRARY
 *
 * SheetJS is the obvious choice and it is also ~900 kB of JavaScript plus a
 * Content-Security-Policy question, for the sake of writing one sheet of text
 * that a finance coordinator opens twice a month. An .xlsx file is a ZIP
 * container holding a few XML parts, and everything needed to produce one is
 * about 150 lines: a CRC32, a stored (uncompressed) ZIP entry, and the
 * SpreadsheetML for a single worksheet.
 *
 * The output is a real .xlsx — Excel, LibreOffice and Google Sheets all open it —
 * with no dependencies added to package.json and no CSP change.
 *
 * The ZIP uses STORE (method 0) rather than DEFLATE. That costs file size and
 * buys the entire compression layer being absent: no deflate implementation, no
 * edge cases around stored-block boundaries. A 5,000-row roster is a couple of
 * hundred kB uncompressed, which is irrelevant for a file that gets emailed and
 * opened once.
 */

/* ---------- CRC32 (zip entry checksums) ---------- */

/**
 * The standard CRC-32 table, built once on first use.
 *
 * Bitwise and byte-wise CRC both compute the same value; the table exists so
 * each byte costs one lookup instead of eight shifts. A 5,000-row export would
 * do this ~5 million times without it.
 */
let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

function crc32(bytes) {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ---------- ZIP ---------- */

const encoder = new TextEncoder();

/** MS-DOS date/time, the only timestamp format the ZIP header understands. */
function dosDateTime(date) {
  // The ZIP epoch starts in 1980; anything earlier is not representable, so a
  // pre-1980 clock is clamped rather than wrapped into a nonsense date.
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build a ZIP archive from named byte arrays.
 *
 * Written by hand because this is the only ZIP the app ever produces: one sheet,
 * no directories, STORE only. Each entry needs a local header, the bytes, a
 * central-directory record, and a trailing end-of-central-directory block.
 */
function zip(entries, when = new Date()) {
  const { time, date } = dosDateTime(when);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    // Local file header. The two version fields are 20 (2.0), which is the
    // minimum for STORE and what every reader expects.
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 filename
    lv.setUint16(8, 0, true); // method 0 = stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(name, 30);

    // Central directory record for this entry.
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // offset of local header
    cd.set(name, 46);

    chunks.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total =
    chunks.reduce((n, c) => n + c.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const chunk of [...chunks, ...central, end]) {
    out.set(chunk, p);
    p += chunk.length;
  }
  return out;
}

/* ---------- SpreadsheetML ---------- */

/**
 * XML text escaping.
 *
 * Not optional: participant-supplied names and colleges routinely contain `&`
 * and `<` ("A & B College"), and an unescaped one produces a file Excel refuses
 * to open, so the export would fail on exactly the rows that matter most.
 * Control characters that are illegal in XML 1.0 are dropped rather than
 * escaped, because there is no escape for them.
 */
function esc(value) {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 1 -> A, 27 -> AA. */
export function columnName(index) {
  let n = index;
  let name = "";
  while (n >= 0) {
    name = String.fromCharCode((n % 26) + 65) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

/** A cell. `styleIndex` 1 is the bold header style from STYLES below. */
function cellXml(ref, value, styleIndex) {
  const style = styleIndex != null ? ` s="${styleIndex}"` : "";
  if (value == null || value === "") return `<c r="${ref}"${style}/>`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"${style}><v>${value}</v></c>`;
  }
  // Inline strings rather than a sharedStrings table. A shared-string index
  // would be smaller for repeated values, but it needs a second part, a second
  // count, and a second thing to get wrong; inline strings are one attribute.
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(
    value
  )}</t></is></c>`;
}

/** Numbers only when the value really is one, so "01" never becomes 1. */
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a single worksheet.
 *
 * `columns` is `[{ header, width?, type? }]` and `rows` an array of arrays
 * positionally matching it. Positional rather than key-based because the export
 * already knows its own column order, and a key lookup here would add a way for
 * a column to silently come out blank when a header is renamed.
 */
function sheetXml({ columns, rows }) {
  const cols = columns
    .map(
      (c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 18}" customWidth="1"/>`
    )
    .join("");

  const header = `<row r="1">${columns
    .map((c, i) => cellXml(`${columnName(i)}1`, c.header, 1))
    .join("")}</row>`;

  const body = rows
    .map((row, r) => {
      const n = r + 2; // row 1 is the header
      const cells = row
        .map((value, i) => {
          const c = columns[i] ?? {};
          // `type` is explicit per column rather than inferred, because a phone
          // number must stay text (it loses its leading zero as a number) while
          // an amount must become one (so Excel can total it).
          const typed = c.type === "number" ? toNumber(value) : value;
          return cellXml(`${columnName(i)}${n}`, typed);
        })
        .join("");
      return `<row r="${n}">${cells}</row>`;
    })
    .join("");

  // A frozen header row: the whole point of the file is scrolling a long roster
  // while reading names, and a header that scrolls away is the first thing an
  // operator complains about.
  const pane =
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}<cols>${cols}</cols><sheetData>${header}${body}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF3B0764"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>`;



/**
 * Produce the bytes of an .xlsx file.
 *
 * Returns a Uint8Array rather than a Blob so this is testable in Node
 * (scripts/verify-catalogue.mjs unzips the result and asserts on the XML) and
 * so the browser can wrap it in whatever the download needs.
 */
export function buildXlsx({ sheetName = "Sheet1", columns = [], rows = [] }) {
  // Excel forbids these in a sheet name and caps it at 31 characters. A filter
  // combination like `roster:2026-08-14_to_2026-08-14` overflows that easily.
  const safeName =
    String(sheetName).replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31) || "Sheet1";

  const files = [
    {
      name: "[Content_Types].xml",
      data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    },
    {
      name: "_rels/.rels",
      data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(
        safeName
      )}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    },
    { name: "xl/styles.xml", data: encoder.encode(STYLES) },
    {
      name: "xl/worksheets/sheet1.xml",
      data: encoder.encode(sheetXml({ columns, rows })),
    },
  ];

  return zip(files);
}

/**
 * Build the roster spreadsheet.
 *
 * The column order is the order a reconciler works in: who, how to reach them,
 * what they bought, what they owe. `si_no` first because the database already
 * numbered the rows, and re-deriving it here would invite a second, different
 * ordering than the one the operator sees on screen.
 *
 * Amounts are typed as numbers, not text. A text "₹349" cannot be summed in
 * Excel, and a reconciler totalling a column of text cells gets zero — which
 * looks like a real answer. The rupee sign belongs in the header or nowhere.
 */
export function buildRosterWorkbook(rows, scope) {
  const columns = [
    { header: "SI.NO", width: 8, type: "number" },
    { header: "NAME", width: 26 },
    { header: "PHONE", width: 16 },
    { header: "UTR NUMBER", width: 20 },
    { header: "REG DATE", width: 13 },
    { header: "REG TIME", width: 11 },
    { header: "STATUS", width: 15 },
    { header: "PURCHASE", width: 32 },
    { header: "AMOUNT", width: 11, type: "number" },
    { header: "EVENTS", width: 34 },
    { header: "FINAL", width: 8 },
    { header: "FROZEN BY", width: 16 },
    { header: "EMAIL", width: 28 },
    { header: "COLLEGE", width: 26 },
    { header: "ROLL NUMBER", width: 16 },
    { header: "YEAR", width: 8 },
    { header: "DEPARTMENT", width: 20 },
  ];

  const body = rows.map((r) => [
    r.si_no,
    r.name,
    r.phone_number,
    r.utr_number,
    r.reg_date,
    r.reg_time,
    r.payment_status,
    r.purchase_label,
    // A null amount is a real state (a registration whose price was never set).
    // Coerced to 0 so the cell stays numeric and the column still totals; an
    // empty string here would reintroduce the text-in-a-number-column problem.
    r.purchase_amount == null ? 0 : Number(r.purchase_amount),
    r.events,
    // "YES"/"" rather than true/false: this column is read by a person
    // reconciling a payment, and a blank is easier to scan past than the word
    // FALSE on every one of four hundred open rows.
    r.selection_frozen ? "YES" : "",
    r.frozen_by,
    r.email,
    r.college_name,
    r.roll_number,
    r.year,
    r.department,
  ]);

  return buildXlsx({
    sheetName: scope || "Roster",
    columns,
    rows: body,
  });
}

/** Hand a Uint8Array to the browser as a download. */
export function downloadXlsx(bytes, filename) {
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; one turn of
  // the event loop is enough for the click to have been consumed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default buildXlsx;
