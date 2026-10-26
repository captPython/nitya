import { CLASS_NAMES } from "../accounts/options";
import { contentKey, shortHash, variantGroup } from "../content/gen";
import { CLASS_ORDER, type ClassId, type Level, type TopicContent, type Visual, type Working } from "../types";
import { interpret, safetyProblems, validateQuestion, type CheckReport } from "../validation";
import { parseCsvRows, parsePicture, parseWorking, workingText } from "./csv";
import type { SuppliedQuestion } from "./types";
import { MAX_XLSX_BYTES, readWorkbook, writeWorkbook, type Cell, type SheetRow } from "./xlsx";

/**
 * The question template: a spreadsheet a parent (or later a school) fills in
 * with their own questions, and uploads. Its columns use the names a parent
 * sees in Nitya (class, topic, level, skill), not the database's ids, and
 * Nitya works out the rest: the question's format, its id and, when the row
 * has a sum, the right answer.
 */

/** The skill of an uploaded question whose row leaves the skill empty. */
export const OWN_SKILL = "own";
export const OWN_SKILL_NAME = "Your own questions";
export const LEVEL_LABELS = ["1 Easy", "2 Medium", "3 Hard", "4 Olympiad"] as const;
export const TEMPLATE_FILE_NAME = "nitya-question-template.xlsx";
/** The most questions one upload can hold. */
export const MAX_UPLOAD_ROWS = 500;

/** What the template needs to know about a topic. */
export interface TemplateTopic {
  classId: ClassId;
  id: string;
  title: string;
  /** Skill id → the name parents see. */
  skills: Record<string, string>;
}

export const templateTopic = (c: TopicContent): TemplateTopic => ({
  classId: c.topic.classId, id: c.topic.id, title: c.topic.title, skills: c.subSkillNames,
});

type ColumnKey =
  | "class" | "topic" | "level" | "question" | "choice1" | "choice2" | "choice3" | "choice4"
  | "answer" | "hint" | "explanation" | "skill" | "reason" | "picture" | "sum";

interface Column {
  key: ColumnKey;
  header: string;
  width: number;
  required: boolean;
  /** Other headers that mean the same column. */
  aliases?: string[];
  /** What to write, for the "How to fill" tab. */
  help: string;
}

const CHOICE_HELP = "The answers the child can tap: 2, 3 or 4 of them. Leave the ones you don't need empty.";

export const TEMPLATE_COLUMNS: Column[] = [
  { key: "class", header: "Class", width: 10, required: true, help: "The class, as Nitya names it: UKG, LKG, Class 1 and so on. Pick it from the list." },
  { key: "topic", header: "Topic", width: 30, required: true, help: "A topic in that class, as Nitya names it. Pick it from the list. The Lists tab shows each class's topics and their skills." },
  { key: "level", header: "Level", width: 12, required: true, help: "1 Easy, 2 Medium, 3 Hard or 4 Olympiad. A harder level gives more marks." },
  { key: "question", header: "Question", width: 40, required: true, aliases: ["prompt"], help: "What the child reads or hears. Keep it short: a UKG question should be 25 words or fewer." },
  { key: "choice1", header: "Choice 1", width: 11, required: true, aliases: ["option 1"], help: CHOICE_HELP },
  { key: "choice2", header: "Choice 2", width: 11, required: true, aliases: ["option 2"], help: CHOICE_HELP },
  { key: "choice3", header: "Choice 3", width: 11, required: false, aliases: ["option 3"], help: CHOICE_HELP },
  { key: "choice4", header: "Choice 4", width: 11, required: false, aliases: ["option 4"], help: CHOICE_HELP },
  { key: "answer", header: "Right answer", width: 12, required: true, aliases: ["answer", "correct answer"], help: "The right choice, written exactly as in its Choice column." },
  { key: "hint", header: "Hint", width: 30, required: true, help: "Shown after a wrong first try. Help the child think, without giving the answer away." },
  { key: "explanation", header: "Explanation", width: 40, required: true, help: "Shown after a wrong answer: how to work it out, ending with the answer." },
  { key: "skill", header: "Skill (optional)", width: 22, required: false, help: `The skill it practises, from the list. Leave it empty and Progress shows it under "${OWN_SKILL_NAME}".` },
  { key: "reason", header: "Why it's right (optional)", width: 30, required: false, aliases: ["reason"], help: "One short line, said with the praise after a right answer. Leave it empty and Nitya uses the first sentence of the explanation." },
  { key: "picture", header: "Picture (optional)", width: 18, required: false, help: 'Dots to show, like "4 blue, 3 orange", or "5 blue 2 crossed" for taking away. Add ", count each" when the child should count each colour on its own.' },
  { key: "sum", header: "Sum to check (optional)", width: 16, required: false, aliases: ["sum"], help: 'The sum behind the answer, like "4 + 3" or "9 - 2", or "count dots" for a "How many dots?" question. Nitya works it out, and doesn\'t add the row if the right answer is different. With no sum Nitya can\'t check the answer, so please check it yourself.' },
];

const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const same = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/** Classes that have topics, in class order. */
const classesOf = (topics: TemplateTopic[]) => CLASS_ORDER.filter(c => topics.some(t => t.classId === c));

/* ---------- the template file ---------- */

interface Example { topicId: string; level: string; values: Partial<Record<ColumnKey, string>> }

const EXAMPLES: Example[] = [
  {
    topicId: "ukg-addition-10", level: LEVEL_LABELS[0],
    values: {
      question: "What is 4 + 3?", choice1: "6", choice2: "7", choice3: "8", answer: "7",
      hint: "Say 4, then count on 3.", explanation: "Start at 4 and count on 3: 5, 6, 7. So 4 + 3 = 7.",
      skill: "Counting on", reason: "3 more than 4 is 7.", sum: "4 + 3",
    },
  },
  {
    topicId: "ukg-counting-50", level: LEVEL_LABELS[0],
    values: {
      question: "How many dots are there?", choice1: "6", choice2: "7", choice3: "8", answer: "7",
      hint: "Touch each dot once as you count.", explanation: "Count 4 blue and 3 orange: 1, 2, 3, 4, 5, 6, 7. There are 7 dots.",
      picture: "4 blue, 3 orange", sum: "count dots",
    },
  },
  {
    topicId: "ukg-comparing", level: LEVEL_LABELS[1],
    values: {
      question: "Which number is bigger, 12 or 15?", choice1: "12", choice2: "15", answer: "15",
      hint: "Which one comes later when you count?", explanation: "15 comes after 12 when you count, so 15 is bigger.",
      skill: "Bigger and smaller",
    },
  },
];

const header = (): Cell[] => TEMPLATE_COLUMNS.map(c => ({ value: c.header, style: "header" }));

/** The template as an .xlsx: a Questions tab with dropdowns, how to fill it, filled examples, and the lists. */
export function templateWorkbook(topics: TemplateTopic[]): Uint8Array {
  const classes = classesOf(topics);
  const titles = [...new Set(topics.map(t => t.title))];
  const skills = [...new Set(topics.flatMap(t => Object.values(t.skills)))];
  const col = (key: ColumnKey) => TEMPLATE_COLUMNS.findIndex(c => c.key === key);
  const range = (letter: string, n: number) => `Lists!$${letter}$2:$${letter}$${n + 1}`;
  const rows = MAX_UPLOAD_ROWS + 1;
  const pick = "Pick from the list";

  const examples = EXAMPLES.flatMap(e => {
    const topic = topics.find(t => t.id === e.topicId);
    return topic ? [TEMPLATE_COLUMNS.map(c =>
      c.key === "class" ? CLASS_NAMES[topic.classId] : c.key === "topic" ? topic.title : c.key === "level" ? e.level : e.values[c.key] ?? "")] : [];
  });

  const help: (string | Cell)[][] = [
    [{ value: "Nitya question template", style: "title" }],
    ["1. Fill it in", "Write one question on each row of the Questions tab. The Examples tab shows filled rows."],
    ["2. Upload it", "Open Grown-ups in Nitya, then Your own questions, and upload this file. Google Sheets works too: download it as .xlsx or .csv first."],
    ["3. Nitya checks it", "Questions that pass go into your children's quizzes at once, before Nitya's own questions at the same level. Questions with an issue wait under Review in Grown-ups, where you fix, approve or delete them. Rows Nitya can't read are listed with their row number, so you can fix them and upload the file again. Questions you've already added are skipped."],
    ["Community bank", "Questions that pass every check also go into Nitya's community bank, which other families can turn on. Your name is never shown with them. To keep a file to your own family, choose Keep these private when you upload it."],
    ["Please", "Don't write a child's full name, a phone number, an address or a link in any question."],
    [],
    [{ value: "Column", style: "header" }, { value: "What to write", style: "header" }, { value: "Needed?", style: "header" }],
    ...TEMPLATE_COLUMNS.map(c => [c.header.replace(/ \(optional\)$/, ""), c.help, c.required ? "Yes" : c.key === "choice3" || c.key === "choice4" ? "If you need it" : "No"]),
  ];

  const byClass = topics.map(t => [CLASS_NAMES[t.classId], t.title, Object.values(t.skills).join(", ")]);
  const lists: string[][] = [];
  const height = Math.max(classes.length, titles.length, skills.length, LEVEL_LABELS.length, byClass.length);
  for (let i = 0; i < height; i++) {
    lists.push([
      CLASS_NAMES[classes[i]] ?? "", titles[i] ?? "", skills[i] ?? "", LEVEL_LABELS[i] ?? "", "",
      ...(byClass[i] ?? ["", "", ""]),
    ]);
  }

  return writeWorkbook([
    {
      name: "Questions", rows: [header()], widths: TEMPLATE_COLUMNS.map(c => c.width),
      textColumns: TEMPLATE_COLUMNS.length, freezeHeader: true,
      lists: [
        { column: col("class"), toRow: rows, source: range("A", classes.length), title: pick, message: "Pick the class from the list." },
        { column: col("topic"), toRow: rows, source: range("B", titles.length), title: pick, message: "Pick a topic from the list. The Lists tab shows each class's topics." },
        { column: col("level"), toRow: rows, source: range("D", LEVEL_LABELS.length), title: pick, message: "Pick 1 Easy, 2 Medium, 3 Hard or 4 Olympiad." },
        { column: col("skill"), toRow: rows, source: range("C", skills.length), title: pick, message: "Pick a skill from the list, or leave it empty." },
      ],
    },
    { name: "How to fill", rows: help, widths: [24, 100, 14] },
    { name: "Examples", rows: [header(), ...examples], widths: TEMPLATE_COLUMNS.map(c => c.width), textColumns: TEMPLATE_COLUMNS.length, freezeHeader: true },
    {
      name: "Lists",
      rows: [[
        { value: "Class", style: "header" }, { value: "Topic", style: "header" }, { value: "Skill", style: "header" }, { value: "Level", style: "header" }, "",
        { value: "Class", style: "header" }, { value: "Topic", style: "header" }, { value: "Skills in this topic", style: "header" },
      ], ...lists],
      widths: [10, 30, 30, 12, 3, 10, 30, 80], freezeHeader: true,
    },
  ]);
}

/* ---------- reading an upload ---------- */

/** The rows of an uploaded template, from an .xlsx (its Questions tab) or a CSV. */
export async function readTemplateFile(bytes: Uint8Array): Promise<SheetRow[]> {
  if (bytes.length > MAX_XLSX_BYTES) throw new Error("This file is too big. Upload at most 500 questions at a time.");
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const book = await readWorkbook(bytes);
    const sheet = book.sheetNames.find(n => n.trim().toLowerCase() === "questions") ?? book.sheetNames[0];
    return book.rows(sheet);
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
    throw new Error("This is an old Excel file (.xls). In Excel, choose Save As, pick Excel Workbook (.xlsx), and upload that.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Nitya can't read this file. Upload the template as .xlsx, or save it as CSV UTF-8.");
  }
  if (text.includes("\u0000")) throw new Error("Nitya can't read this file. Upload the template as .xlsx, or save it as CSV UTF-8.");
  return parseCsvRows(text.replace(/^﻿/, ""));
}

/** One question read from a row, before the checks. Its id is set when it is saved. */
export interface TemplateRow { row: number; question: SuppliedQuestion; classId: ClassId }

export interface RowProblems { row: number; problems: string[] }

export interface ParsedTemplate {
  rows: TemplateRow[];
  /** Rows that can't be read, and problems with the whole file (row 0 or the header's row). */
  refused: RowProblems[];
  /** Columns Nitya doesn't use, such as a parent's own notes. */
  ignoredColumns: string[];
}

function findClass(text: string, topics: TemplateTopic[]): ClassId | string {
  const t = norm(text);
  if (!t) return "The class is empty.";
  const id = CLASS_ORDER.find(c => norm(c) === t || norm(CLASS_NAMES[c]) === t || (/^\d+$/.test(t) && c === `C${t}`));
  if (!id) return `"${text}" isn't a class. Write UKG, LKG, or Class 1 to Class 12.`;
  if (!topics.some(x => x.classId === id)) {
    const have = classesOf(topics).map(c => CLASS_NAMES[c]);
    return `Nitya has no topics for ${CLASS_NAMES[id]} yet. For now, questions can go in ${have.join(", ")}.`;
  }
  return id;
}

function parseLevel(text: string): Level | null {
  const t = norm(text);
  const n = t.match(/^l?\s*([1-4])\b/)?.[1] ?? { easy: "1", medium: "2", hard: "3", olympiad: "4" }[t];
  return n ? (Number(n) as Level) : null;
}

/** "4", "4 and 7", "4, 7 and 9". */
const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The first sentence, for the praise line when a row leaves it empty. */
const firstSentence = (text: string) => text.trim().split(/(?<=[.!?])\s+/)[0];

/** Reads the rows of an uploaded template into questions. Every problem in a row is reported, so it can be fixed in one go. */
export function parseTemplate(sheet: SheetRow[], opts: { fileName: string; topics: TemplateTopic[] }): ParsedTemplate {
  const fileProblem = (row: number, problem: string): ParsedTemplate => ({ rows: [], refused: [{ row, problems: [problem] }], ignoredColumns: [] });
  if (!sheet.length) return fileProblem(0, "The file has no questions.");

  const headerAt = sheet.slice(0, 5).findIndex(r => {
    const cells = r.cells.map(norm);
    return cells.includes("question") || cells.includes("prompt");
  });
  if (headerAt < 0) {
    return fileProblem(sheet[0].row, "Nitya can't find the column names. The first row should be the template's: Class, Topic, Level, Question and so on.");
  }
  const columns = new Map<ColumnKey, number>();
  const ignoredColumns: string[] = [];
  sheet[headerAt].cells.forEach((cell, i) => {
    const h = norm(cell);
    if (!h) return;
    const c = TEMPLATE_COLUMNS.find(x => norm(x.header) === h || x.aliases?.includes(h));
    if (c && !columns.has(c.key)) columns.set(c.key, i);
    else if (!c) ignoredColumns.push(cell.trim());
  });
  const missing = TEMPLATE_COLUMNS.filter(c => c.required && !columns.has(c.key)).map(c => c.header);
  if (missing.length) return fileProblem(sheet[headerAt].row, `The file has no ${missing.join(", ")} column. Start from the template, so every column is there.`);

  const body = sheet.slice(headerAt + 1);
  if (!body.length) return fileProblem(sheet[headerAt].row, "The file has no questions under the column names.");
  if (body.length > MAX_UPLOAD_ROWS) {
    return fileProblem(0, `The file has ${body.length} questions. Upload at most ${MAX_UPLOAD_ROWS} at a time.`);
  }

  const rows: TemplateRow[] = [];
  const refused: RowProblems[] = [];
  for (const { row, cells } of body) {
    const get = (key: ColumnKey) => (columns.has(key) ? (cells[columns.get(key)!] ?? "").trim() : "");
    const problems: string[] = [];

    const classId = findClass(get("class"), opts.topics);
    const inClass = CLASS_ORDER.includes(classId as ClassId) ? opts.topics.filter(t => t.classId === classId) : [];
    if (!inClass.length) problems.push(classId);
    const topicText = get("topic");
    const topic = inClass.find(t => same(t.title, topicText) || t.id === topicText);
    if (inClass.length && !topicText) problems.push("The topic is empty.");
    else if (inClass.length && !topic) problems.push(`There is no topic "${topicText}" in ${CLASS_NAMES[classId as ClassId]}. Pick one from the list.`);

    const level = parseLevel(get("level"));
    if (!level) problems.push(get("level") ? `"${get("level")}" isn't a level. Write 1 Easy, 2 Medium, 3 Hard or 4 Olympiad.` : "The level is empty.");

    const prompt = get("question");
    if (!prompt) problems.push("The question is empty.");

    const choices = (["choice1", "choice2", "choice3", "choice4"] as const).map(get).filter(Boolean);
    if (choices.length < 2) problems.push(choices.length ? "There is only one choice. Give 2 to 4 for the child to tap." : "There are no choices. Give 2 to 4 for the child to tap.");
    const repeated = choices.filter((c, i) => choices.findIndex(d => same(c, d)) !== i);
    for (const c of new Set(repeated)) problems.push(`"${c}" is a choice twice.`);

    const answerText = get("answer");
    const answers: string[] = [];
    if (!answerText) problems.push("The right answer is empty.");
    for (const a of answerText.split("|").map(s => s.trim()).filter(Boolean)) {
      const match = choices.find(c => same(c, a));
      if (match) answers.push(match);
      else if (choices.length) problems.push(`The right answer "${a}" isn't one of the choices.`);
    }

    const hint = get("hint"), explanation = get("explanation");
    if (!hint) problems.push("The hint is empty. It shows after a wrong first try.");
    if (!explanation) problems.push("The explanation is empty. It shows after a wrong answer.");

    let subSkill = OWN_SKILL;
    const skillText = get("skill");
    if (skillText && topic) {
      const found = Object.entries(topic.skills).find(([id, name]) => same(name, skillText) || id === skillText);
      if (found) subSkill = found[0];
      else problems.push(`"${skillText}" isn't a skill in ${topic.title}. Pick one from the list, or leave it empty.`);
    }

    let visual: Visual | undefined;
    if (get("picture")) {
      try { visual = parsePicture(get("picture")); } catch (e) { problems.push((e as Error).message); }
    }
    let working: Working | undefined;
    if (get("sum")) {
      try {
        working = parseWorking(get("sum"));
      } catch {
        problems.push(`Nitya can't read the sum "${get("sum")}". Write it like "4 + 3" or "9 - 2", or "count dots".`);
      }
    }

    if (problems.length || !topic || !level) { refused.push({ row, problems }); continue; }
    const question: SuppliedQuestion = {
      id: `upload-${shortHash(`${topic.id}|${contentKey({ prompt, visual })}`)}`,
      topicId: topic.id, subSkill, level, format: visual ? "tap-picture" : "mcq", prompt,
      ...(visual ? { visual } : {}),
      options: choices, answers, hint, explanation, reason: get("reason") || firstSentence(explanation),
      ...(working ? { working, variantGroup: variantGroup(topic.id, working, visual) } : {}),
      source: "upload", sourceRef: `${opts.fileName} row ${row}`,
    };
    rows.push({ row, question, classId: topic.classId });
  }
  return { rows, refused, ignoredColumns };
}

/* ---------- checking an upload ---------- */

/** What Nitya's checks make of one of a family's own questions. */
export interface OwnVerdict {
  /** "ready": the family's children get it now. "review": it has issues, and waits for the family to approve, fix or delete it. */
  status: "ready" | "review";
  /** The issues, in words for a parent. Empty when ready. */
  problems: string[];
  /** The row has no sum, so Nitya couldn't work the answer out. Not an issue for the family's own children. */
  unchecked: boolean;
  /** It passed every check, the answer included, so it may go into the community bank. */
  passedAll: boolean;
  report: CheckReport;
}

/** Links are refused outright: children must never see one, so not even their own family can approve it. */
export const safetyLink = (q: SuppliedQuestion) => safetyProblems(q).some(p => p.includes("link"));

/**
 * Checks one of a family's own questions. Every check that fails is an issue
 * for the family to look at, except a missing sum: then the answer can't be
 * worked out, and the family's own children still get the question.
 */
export function judgeOwnQuestion(question: SuppliedQuestion, topic: TemplateTopic): OwnVerdict {
  const report = validateQuestion(question, { classId: topic.classId, subSkills: [...Object.keys(topic.skills), OWN_SKILL] });
  const problems: string[] = [];
  const unchecked = !question.working;
  if (question.working && report.answer.wrongKeys?.length) {
    const follow = interpret(question.working, question.visual);
    const right = question.options?.filter(o => follow.accepts(o)) ?? [];
    problems.push(right.length
      ? `The right answer says ${listOf(report.answer.wrongKeys)}, but the sum "${workingText(question.working)}" gives ${listOf(right)}.`
      : `The right answer says ${listOf(report.answer.wrongKeys)}, but the sum "${workingText(question.working)}" gives an answer that isn't one of the choices.`);
    problems.push(...report.answer.problems.filter(p => !p.startsWith("Recomputing gives")));
  } else if (!unchecked) {
    problems.push(...report.answer.problems);
  }
  problems.push(
    ...report.options.problems,
    ...report.scope.problems,
    ...(unchecked ? [] : report.level.problems),
    ...report.wording.problems,
  );
  const words = problems.map(p => p.replace(/\bworking\b/g, "sum").replace(/\bThe working\b/g, "The sum"));
  return { status: words.length ? "review" : "ready", problems: words, unchecked, passedAll: report.passed, report };
}

export interface UploadRow extends OwnVerdict { row: number; question: SuppliedQuestion }

export interface UploadCheck {
  rows: UploadRow[];
  /** Rows that couldn't become questions: unreadable ones, and any with a link. */
  refused: RowProblems[];
  ignoredColumns: string[];
}

/** Checks every question read from an upload. */
export function checkUpload(parsed: ParsedTemplate, topics: TemplateTopic[]): UploadCheck {
  const rows: UploadRow[] = [];
  const refused = [...parsed.refused];
  for (const { row, question } of parsed.rows) {
    if (safetyLink(question)) {
      refused.push({ row, problems: ["It has a link. Children must never see links, so Nitya can't add it."] });
      continue;
    }
    rows.push({ row, question, ...judgeOwnQuestion(question, topics.find(t => t.id === question.topicId)!) });
  }
  refused.sort((a, b) => a.row - b.row);
  return { rows, refused, ignoredColumns: parsed.ignoredColumns };
}

/** The id a family's question is saved under: the same question from the same family always gets the same id. */
export const familyQuestionId = (owner: string, q: { topicId: string; prompt: string; visual?: Visual }) =>
  `own-${shortHash(`${owner}|${q.topicId}|${contentKey(q)}`)}`;

/** Same words and picture in the same topic: the same question. */
export const sameQuestionKey = (q: { topicId: string; prompt: string; visual?: Visual }) => `${q.topicId}|${contentKey(q)}`;
