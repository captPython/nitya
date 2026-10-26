/**
 * Just enough of the Excel file format (.xlsx) for the question template:
 * writing a workbook with a few styled sheets and dropdown lists, and reading
 * back the cells of one sheet. An .xlsx is a zip of XML files. Files are
 * written uncompressed; files from Excel, Google Sheets or LibreOffice are
 * deflated, and are inflated with the platform's DecompressionStream.
 */

/** The biggest upload read, and the most its contents may unpack to, so a hostile file can't fill the memory. */
export const MAX_XLSX_BYTES = 5 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 40 * 1024 * 1024;

/* ---------- zip ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = new TextEncoder();

/** A zip of the files, stored without compression. Dates are fixed, so the same files give the same bytes. */
export function zip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x21, true); // 1 Jan 1980
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, 0, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, f.data.length, true);
    entry.setUint32(24, f.data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files in a zip, by name. Throws a plain sentence when the bytes aren't a zip this can read. */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const notZip = new Error("This file isn't an Excel file Nitya can read. Save it as .xlsx or .csv and try again.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw notZip;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  let unpacked = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw notZip;
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const skip = nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + skip;
    unpacked += size;
    if (packed === 0xffffffff || unpacked > MAX_UNPACKED_BYTES) throw new Error("This file is too big to read.");
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw notZip;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + packed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflate(data));
    else throw notZip;
  }
  return files;
}

/* ---------- writing a workbook ---------- */

export type CellStyle = "plain" | "header" | "text" | "title";
const STYLE_INDEX: Record<CellStyle, number> = { plain: 0, header: 1, text: 2, title: 3 };

export interface Cell { value: string; style?: CellStyle }

export interface SheetSpec {
  /** Up to 31 characters, without : \ / ? * [ ] */
  name: string;
  rows: (string | Cell)[][];
  /** Column widths in characters. */
  widths?: number[];
  /** Columns whose empty cells are text, so "1/2" or "4-3" stay as typed instead of turning into a date. */
  textColumns?: number;
  /** Keeps the first row in view while scrolling. */
  freezeHeader?: boolean;
  /** Dropdowns: a column (0-based) of rows 2 to `toRow`, picking from a range such as "Lists!$A$2:$A$9". */
  lists?: { column: number; toRow: number; source: string; title: string; message: string }[];
}

const escapeXml = (s: string) => s
  .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "A" for 0, "Z" for 25, "AA" for 26. */
export function columnName(index: number): string {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(sheet: SheetSpec, selected: boolean): string {
  const views = `<sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ""}>${sheet.freezeHeader
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
    : ""}</sheetView></sheetViews>`;
  const widths = sheet.widths ?? [];
  const textCols = sheet.textColumns ?? 0;
  const colCount = Math.max(widths.length, textCols);
  const cols = colCount
    ? `<cols>${Array.from({ length: colCount }, (_, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${widths[i] ?? 12}" customWidth="1"${i < textCols ? ' style="2"' : ""}/>`).join("")}</cols>`
    : "";
  const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
    const { value, style = c < textCols ? "text" : "plain" } = typeof cell === "string" ? { value: cell } : cell;
    return value === "" ? "" : `<c r="${columnName(c)}${r + 1}" t="inlineStr" s="${STYLE_INDEX[style]}"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const lists = sheet.lists?.length
    ? `<dataValidations count="${sheet.lists.length}">${sheet.lists.map(l =>
      `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="${escapeXml(l.title)}" error="${escapeXml(l.message)}" sqref="${columnName(l.column)}2:${columnName(l.column)}${l.toRow}"><formula1>${escapeXml(l.source)}</formula1></dataValidation>`).join("")}</dataValidations>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${views}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>${lists}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE0E7FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** An .xlsx file holding the sheets, in order. The first sheet opens first. */
export function writeWorkbook(sheets: SheetSpec[]): Uint8Array {
  const n = sheets.length;
  const files: { name: string; data: string }[] = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((s, i) =>
        `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, i === 0) })),
  ];
  return zip(files.map(f => ({ name: f.name, data: utf8.encode(f.data) })));
}

/* ---------- reading a workbook ---------- */

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()])
    // Excel writes some characters as _xHHHH_.
    .replace(/_x([0-9a-f]{4})_/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = unescapeXml(m[2] ?? m[3] ?? "");
  return out;
}

/** The text of every <t> inside, leaving out phonetic guides. */
const textOf = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map(m => unescapeXml(m[1] ?? "")).join("");

/** "C12" → 2 (the column, from 0). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase().match(/^[A-Z]+/)?.[0] ?? "") n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/** Numbers as a spreadsheet shows them: 15 significant digits, so 0.1 + 0.2 reads 0.3. */
const numberText = (v: string) => (/^-?[\d.]+(e[+-]?\d+)?$/i.test(v) ? String(Number(Number(v).toPrecision(15))) : v);

/** One row of a sheet: its row number as the spreadsheet shows it, and its cells from column A. */
export interface SheetRow { row: number; cells: string[] }

export interface Workbook {
  sheetNames: string[];
  /** The rows of a sheet that have any text. Leaving out the name reads the first sheet. */
  rows(name?: string): SheetRow[];
}

/** Reads an .xlsx. */
export async function readWorkbook(bytes: Uint8Array): Promise<Workbook> {
  if (bytes.length > MAX_XLSX_BYTES) throw new Error("This file is too big to read.");
  const files = await unzip(bytes);
  const text = (name: string) => {
    const f = files.get(name);
    return f ? new TextDecoder().decode(f) : null;
  };
  const book = text("xl/workbook.xml");
  if (!book) throw new Error("This file isn't an Excel workbook. Save it as .xlsx or .csv and try again.");
  const rels = new Map([...(text("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)].map(m => {
    const a = attrs(m[0]);
    const target = a.Target ?? "";
    return [a.Id, target.startsWith("/") ? target.slice(1) : `xl/${target}`];
  }));
  const sheets = [...book.matchAll(/<sheet\b[^>]*>/g)].map(m => {
    const a = attrs(m[0]);
    return { name: a.name ?? "", path: rels.get(a["r:id"] ?? "") ?? "" };
  });
  const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map(m => textOf(m[1] ?? ""));

  return {
    sheetNames: sheets.map(s => s.name),
    rows(name) {
      const sheet = name === undefined ? sheets[0] : sheets.find(s => s.name.toLowerCase() === name.toLowerCase());
      const xml = sheet ? text(sheet.path) : null;
      if (!xml) return [];
      const out: SheetRow[] = [];
      let lastRow = 0;
      for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const rowNo = Number(attrs(rm[1]).r) || lastRow + 1;
        lastRow = rowNo;
        const cells: string[] = [];
        let col = -1;
        for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const a = attrs(cm[1]);
          col = a.r ? columnIndex(a.r) : col + 1;
          const inner = cm[2] ?? "";
          const v = unescapeXml(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "");
          let value: string;
          if (a.t === "s") value = shared[Number(v)] ?? "";
          else if (a.t === "inlineStr") value = textOf(inner.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? "");
          else if (a.t === "b") value = v === "1" ? "TRUE" : "FALSE";
          else if (a.t === "str" || a.t === "e") value = v;
          else value = numberText(v);
          cells[col] = value;
        }
        const filled = Array.from({ length: cells.length }, (_, i) => cells[i] ?? "");
        if (filled.some(c => c.trim() !== "")) out.push({ row: rowNo, cells: filled });
      }
      return out;
    },
  };
}
