import { contentKey, shortHash, variantGroup } from "../content/gen";
import { QUESTION_FORMATS, type DotGroup, type Expr, type Level, type QuestionFormat, type Visual, type Working } from "../types";
import type { SuppliedQuestion, TopicInfo } from "./types";
import type { SheetRow } from "./xlsx";

/**
 * The columns of a question CSV, in the order the template uses. Options and
 * answers are separated by "|", because an option can contain commas.
 */
export const CSV_COLUMNS = [
  "id", "topic_id", "level", "sub_skill", "format", "prompt", "options", "answers",
  "hint", "explanation", "reason", "picture", "working",
] as const;
const REQUIRED = ["topic_id", "level", "sub_skill", "format", "prompt", "answers", "hint", "explanation", "reason"];

export interface CsvRowError {
  /** The row number as a spreadsheet shows it: the header is row 1. */
  row: number;
  message: string;
}

/** Splits CSV text into rows of cells, following RFC 4180 quoting, and leaves out empty rows. */
export function parseCsv(text: string): string[][] {
  return records(text).filter(r => r.some(c => c.trim() !== ""));
}

/** The rows that have any text, each with its row number as a spreadsheet shows it. */
export function parseCsvRows(text: string): SheetRow[] {
  return records(text).map((cells, i) => ({ row: i + 1, cells })).filter(r => r.cells.some(c => c.trim() !== ""));
}

/** Every record, empty ones included, so row numbers match the spreadsheet's. */
function records(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("The file ends inside a quoted cell.");
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * "3 blue, 2 orange" or "5 blue 2 crossed". A last part "count each" means each colour is counted on its own, as in
 * comparing, and "frames" draws each group as a ten-frame.
 */
export function parsePicture(text: string): Visual {
  const parts = text.split(",").map(p => p.trim());
  const flags = { each: false, frames: false };
  while (parts.length > 1 && /^(count each|frames)$/i.test(parts[parts.length - 1])) {
    flags[/each/i.test(parts.pop()!) ? "each" : "frames"] = true;
  }
  const groups: DotGroup[] = parts.map(part => {
    const m = part.trim().match(/^(\d+)\s+(blue|orange)(?:\s+(\d+)\s+crossed)?$/i);
    if (!m) throw new Error(`Can't read the picture "${part.trim()}". Write it like "3 blue, 2 orange" or "5 blue 2 crossed".`);
    const group: DotGroup = { count: Number(m[1]), color: m[2].toLowerCase() as DotGroup["color"] };
    if (m[3]) group.crossed = Number(m[3]);
    if ((group.crossed ?? 0) > group.count) throw new Error(`The picture crosses out more dots than it has: "${part.trim()}".`);
    return group;
  });
  return { kind: "dots", groups, ...(flags.each ? { count: "each" as const } : {}), ...(flags.frames ? { frames: true } : {}) };
}

const KINDS = ["arith", "count-dots", "missing", "sequence", "between", "extreme", "equals", "order", "number-word"];

/** A sum like "4 + 3" or "9 − 2 − 3", "count dots" for counting the picture, or a working written as JSON. */
export function parseWorking(text: string): Working {
  const t = text.trim();
  if (/^count dots$/i.test(t)) return { kind: "count-dots" };
  if (t.startsWith("{")) {
    let w: unknown;
    try { w = JSON.parse(t); } catch { throw new Error("The working looks like JSON but can't be read."); }
    if (!w || typeof w !== "object" || !KINDS.includes((w as { kind?: string }).kind ?? "")) {
      throw new Error(`The working's "kind" must be one of: ${KINDS.join(", ")}.`);
    }
    return w as Working;
  }
  const tokens = t.replace(/−/g, "-").match(/\d+|[+-]|\S/g) ?? [];
  if (tokens.length < 3 || tokens.length % 2 === 0 || tokens.some((x, i) => (i % 2 === 0 ? !/^\d+$/.test(x) : !/^[+-]$/.test(x)))) {
    throw new Error(`Can't read the working "${t}". Write a sum like "4 + 3" or "9 - 2 - 3", "count dots", or JSON.`);
  }
  let expr: Expr = Number(tokens[0]);
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i] as "+" | "-", n = Number(tokens[i + 1]);
    expr = typeof expr === "object" && "op" in expr && expr.op === op
      ? { op, args: [...expr.args, n] }
      : { op, args: [expr, n] };
  }
  return { kind: "arith", expr };
}

const splitList = (cell: string) => cell.split("|").map(s => s.trim()).filter(Boolean);

/**
 * Reads a question CSV. A row that can't be read is reported with its row
 * number and left out; every other row comes back ready for the checks.
 */
export function parseQuestionCsv(
  text: string,
  opts: { fileName: string; topics: TopicInfo[] },
): { questions: SuppliedQuestion[]; errors: CsvRowError[] } {
  const errors: CsvRowError[] = [];
  let rows: string[][];
  try { rows = parseCsv(text); } catch (err) { return { questions: [], errors: [{ row: 0, message: (err as Error).message }] }; }
  if (rows.length === 0) return { questions: [], errors: [{ row: 1, message: "The file is empty." }] };

  const header = rows[0].map(h => h.trim().toLowerCase());
  const unknown = header.filter(h => !(CSV_COLUMNS as readonly string[]).includes(h));
  const missing = REQUIRED.filter(c => !header.includes(c));
  if (unknown.length) errors.push({ row: 1, message: `Unknown column: ${unknown.join(", ")}.` });
  if (missing.length) errors.push({ row: 1, message: `Missing column: ${missing.join(", ")}.` });
  if (errors.length) return { questions: [], errors };

  const topicIds = new Set(opts.topics.map(t => t.id));
  const ids = new Set<string>();
  const questions: SuppliedQuestion[] = [];
  rows.slice(1).forEach((cells, i) => {
    const row = i + 2;
    const get = (col: string) => (cells[header.indexOf(col)] ?? "").trim();
    try {
      const topicId = get("topic_id");
      if (!topicIds.has(topicId)) throw new Error(`There is no topic "${topicId}".`);
      const levelText = get("level").replace(/^L/i, "");
      if (!/^[1-4]$/.test(levelText)) throw new Error(`The level must be 1 to 4, not "${get("level")}".`);
      const format = get("format") as QuestionFormat;
      if (!QUESTION_FORMATS.includes(format)) throw new Error(`The format must be one of: ${QUESTION_FORMATS.join(", ")}.`);
      const prompt = get("prompt");
      if (!prompt) throw new Error("The prompt is empty.");
      const answers = splitList(get("answers"));
      if (!answers.length) throw new Error("The answers cell is empty.");
      const options = splitList(get("options"));
      const visual = get("picture") ? parsePicture(get("picture")) : undefined;
      const working = get("working") ? parseWorking(get("working")) : undefined;
      const id = get("id") || `${topicId}-csv-${shortHash(contentKey({ prompt, visual }))}`;
      if (ids.has(id)) throw new Error(`The id "${id}" is used twice in this file.`);
      ids.add(id);
      questions.push({
        id, topicId, level: Number(levelText) as Level, subSkill: get("sub_skill"), format, prompt,
        ...(visual ? { visual } : {}),
        ...(options.length ? { options } : {}),
        answers, hint: get("hint"), explanation: get("explanation"), reason: get("reason"),
        ...(working ? { working, variantGroup: variantGroup(topicId, working, visual) } : {}),
        source: "csv", sourceRef: `${opts.fileName} row ${row}`,
      });
    } catch (err) {
      errors.push({ row, message: (err as Error).message });
    }
  });
  return { questions, errors };
}

const quote = (cell: string) => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

/** A picture as the CSV writes it, like "3 blue, 2 orange": the reverse of parsePicture. */
export const pictureText = (v?: Visual) =>
  v ? [...v.groups.map(g => `${g.count} ${g.color}${g.crossed ? ` ${g.crossed} crossed` : ""}`), ...(v.count === "each" ? ["count each"] : []), ...(v.frames ? ["frames"] : [])].join(", ") : "";

/** A working as the CSV writes it: "count dots", a plain sum like "9 - 2 - 3", or JSON. The reverse of parseWorking. */
export function workingText(w?: Working): string {
  if (!w) return "";
  if (w.kind === "count-dots") return "count dots";
  if (w.kind === "arith") {
    const chain = (e: Expr): string | null => {
      if (typeof e === "number") return String(e);
      if (typeof e !== "object" || !("op" in e)) return null;
      const [head, ...rest] = e.args;
      const start = chain(head);
      return start !== null && rest.every(a => typeof a === "number") ? [start, ...rest].join(` ${e.op} `) : null;
    };
    // Written as a sum only when it reads back as the same working.
    const text = chain(w.expr);
    if (text !== null && /[+-]/.test(text) && JSON.stringify(parseWorking(text)) === JSON.stringify(w)) return text;
  }
  return JSON.stringify(w);
}

/** Writes questions as a CSV in the template's columns, so the admin can edit them in a spreadsheet. */
export function toQuestionCsv(questions: SuppliedQuestion[]): string {
  const lines = questions.map(q => [
    q.id, q.topicId, String(q.level), q.subSkill, q.format, q.prompt, (q.options ?? []).join(" | "),
    q.answers.join(" | "), q.hint, q.explanation, q.reason, pictureText(q.visual), q.working ? JSON.stringify(q.working) : "",
  ].map(quote).join(","));
  return [CSV_COLUMNS.join(","), ...lines].join("\n") + "\n";
}
