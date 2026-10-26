import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_CONTENT } from "../src/content";
import { nextQuestion, startQuiz } from "../src/engine";
import { planUpload, sanitizeOwnQuestion } from "../src/supply/family";
import {
  checkUpload, familyQuestionId, MAX_UPLOAD_ROWS, OWN_SKILL, parseTemplate, readTemplateFile, sameQuestionKey,
  TEMPLATE_COLUMNS, templateTopic, templateWorkbook,
} from "../src/supply/template";
import { columnName, readWorkbook, unzip, writeWorkbook, zip } from "../src/supply/xlsx";
import type { Question } from "../src/types";

const TOPICS = ALL_CONTENT.map(templateTopic);
const HEADER = TEMPLATE_COLUMNS.map(c => c.header);
const utf8 = (s: string) => new TextEncoder().encode(s);

/** One template row, by column name; the rest empty. */
function cells(values: Partial<Record<string, string>>): string[] {
  return TEMPLATE_COLUMNS.map(c => values[c.header] ?? "");
}
const GOOD = {
  Class: "UKG", Topic: "Adding with objects up to 10", Level: "1 Easy", Question: "Mia has 2 apples and gets 3 more. How many apples now?",
  "Choice 1": "4", "Choice 2": "5", "Choice 3": "6", "Right answer": "5", Hint: "Count on from 2.", Explanation: "2 and 3 more makes 5. So the answer is 5.",
  "Sum to check (optional)": "2 + 3",
};
const sheetOf = (...rows: string[][]) => rows.map((c, i) => ({ row: i + 1, cells: c }));
const parse = (...rows: Partial<Record<string, string>>[]) =>
  parseTemplate(sheetOf(HEADER, ...rows.map(cells)), { fileName: "mine.xlsx", topics: TOPICS });

describe("the xlsx writer and reader", () => {
  it("names columns as a spreadsheet does", () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });

  it("zips and unzips files unchanged", async () => {
    const files = [{ name: "a.txt", data: utf8("hello") }, { name: "dir/b.xml", data: utf8("<x>नित्य</x>") }];
    const back = await unzip(zip(files));
    expect([...back.keys()]).toEqual(["a.txt", "dir/b.xml"]);
    expect(new TextDecoder().decode(back.get("dir/b.xml"))).toBe("<x>नित्य</x>");
    await expect(unzip(utf8("not a zip at all, just text"))).rejects.toThrow("isn't an Excel file");
  });

  it("reads back what it writes, sheet by sheet, with the row numbers a spreadsheet shows", async () => {
    const bytes = writeWorkbook([
      { name: "One", rows: [["a", "b & <c>"], [], ["", "quote \" and 'apos'"], ["नित्य", "₹5"]] },
      { name: "Two", rows: [["x"]] },
    ]);
    const book = await readWorkbook(bytes);
    expect(book.sheetNames).toEqual(["One", "Two"]);
    expect(book.rows()).toEqual([
      { row: 1, cells: ["a", "b & <c>"] }, { row: 3, cells: ["", "quote \" and 'apos'"] }, { row: 4, cells: ["नित्य", "₹5"] },
    ]);
    expect(book.rows("two")).toEqual([{ row: 1, cells: ["x"] }]);
    expect(book.rows("Three")).toEqual([]);
  });

  it("reads a workbook saved by LibreOffice: compressed, with shared strings", async () => {
    const book = await readWorkbook(new Uint8Array(readFileSync("test/fixtures/template-libreoffice.xlsx")));
    expect(book.sheetNames).toEqual(["Questions", "How to fill", "Examples", "Lists"]);
    const examples = book.rows("Examples");
    expect(examples[0].cells.slice(0, 4)).toEqual(["Class", "Topic", "Level", "Question"]);
    expect(examples[1].cells[3]).toBe("What is 4 + 3?");
  });

  it("reads rich text, numbers and booleans the way Excel stores them", async () => {
    const xml = (s: string) => utf8(`<?xml version="1.0"?>${s}`);
    const bytes = zip([
      { name: "xl/workbook.xml", data: xml('<workbook><sheets><sheet name="Questions" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: xml('<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>') },
      { name: "xl/sharedStrings.xml", data: xml('<sst><si><r><t>Bold</t></r><r><t xml:space="preserve"> part</t></r><rPh><t>x</t></rPh></si><si><t>Line_x000D_</t></si></sst>') },
      { name: "xl/worksheets/sheet1.xml", data: xml('<worksheet><sheetData><row r="2"><c r="A2" t="s"><v>0</v></c><c r="C2"><v>0.30000000000000004</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="s"><v>1</v></c></row></sheetData></worksheet>') },
    ]);
    expect((await readWorkbook(bytes)).rows()).toEqual([{ row: 2, cells: ["Bold part", "", "0.3", "TRUE", "Line\r"] }]);
  });
});

describe("the question template", () => {
  it("has a Questions tab with text columns and dropdowns, how to fill it, examples and the lists", async () => {
    const bytes = templateWorkbook(TOPICS);
    const book = await readWorkbook(bytes);
    expect(book.sheetNames).toEqual(["Questions", "How to fill", "Examples", "Lists"]);
    expect(book.rows("Questions")).toEqual([{ row: 1, cells: HEADER }]);
    const sheet = new TextDecoder().decode((await unzip(bytes)).get("xl/worksheets/sheet1.xml"));
    for (const range of [`A2:A${MAX_UPLOAD_ROWS + 1}`, "B2:B", "C2:C", "L2:L"]) expect(sheet).toContain(`sqref="${range}`);
    expect(sheet).toContain('state="frozen"');
    const lists = book.rows("Lists").map(r => r.cells);
    expect(lists.map(r => r[1]).filter(Boolean)).toEqual(["Topic", ...TOPICS.map(t => t.title)]);
    const help = book.rows("How to fill").map(r => r.cells[0]);
    for (const c of TEMPLATE_COLUMNS) expect(help).toContain(c.header.replace(/ \(optional\)$/, ""));
  });

  it("gives examples that pass every check, except the one with no sum to check", async () => {
    const book = await readWorkbook(templateWorkbook(TOPICS));
    const checked = checkUpload(parseTemplate(book.rows("Examples"), { fileName: "t.xlsx", topics: TOPICS }), TOPICS);
    expect(checked.refused).toEqual([]);
    expect(checked.rows.map(r => [r.status, r.passedAll, r.unchecked])).toEqual([["ready", true, false], ["ready", true, false], ["ready", false, true]]);
  });

  it("reads a CSV with or without a byte-order mark, and refuses old Excel files and other encodings", async () => {
    const csv = `${HEADER.join(",")}\r\n\r\n${cells(GOOD).map(c => (c.includes(",") ? `"${c}"` : c)).join(",")}\r\n`;
    for (const text of [csv, `﻿${csv}`]) {
      const rows = await readTemplateFile(utf8(text));
      expect(rows.map(r => r.row)).toEqual([1, 3]);
      expect(parseTemplate(rows, { fileName: "x.csv", topics: TOPICS }).rows).toHaveLength(1);
    }
    await expect(readTemplateFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))).rejects.toThrow("old Excel file");
    await expect(readTemplateFile(new Uint8Array([0x41, 0xe9, 0x42]))).rejects.toThrow("CSV UTF-8");
  });
});

describe("reading an upload", () => {
  it("builds the question from the friendly columns", () => {
    const { rows, refused } = parse({ ...GOOD, Level: "medium", Topic: "adding with OBJECTS up to 10", Class: "ukg", "Skill (optional)": "counting on" });
    expect(refused).toEqual([]);
    expect(rows[0].question).toMatchObject({
      topicId: "ukg-addition-10", level: 2, subSkill: "count-on", format: "mcq", options: ["4", "5", "6"], answers: ["5"],
      reason: "2 and 3 more makes 5.", source: "upload", sourceRef: "mine.xlsx row 2", working: { kind: "arith" },
    });
    const pictured = parse({ ...GOOD, "Picture (optional)": "2 blue, 3 orange", "Sum to check (optional)": "count dots", "Why it's right (optional)": "There are 5." });
    expect(pictured.rows[0].question).toMatchObject({ format: "tap-picture", visual: { kind: "dots" }, subSkill: OWN_SKILL, reason: "There are 5." });
    for (const level of ["1", "L3", "4 Olympiad", "Hard"]) expect(parse({ ...GOOD, Level: level }).rows).toHaveLength(1);
  });

  it("finds the column names under a title row, ignores extra columns, and says which are missing", () => {
    const titled = parseTemplate(sheetOf(["My questions"], [...HEADER, "Notes"], [...cells(GOOD), "for Riya"]), { fileName: "f", topics: TOPICS });
    expect(titled.rows).toHaveLength(1);
    expect(titled.ignoredColumns).toEqual(["Notes"]);
    expect(parseTemplate(sheetOf(HEADER.filter(h => h !== "Hint"), ["x"]), { fileName: "f", topics: TOPICS }).refused[0].problems[0])
      .toBe("The file has no Hint column. Start from the template, so every column is there.");
    expect(parseTemplate(sheetOf(["a", "b"], ["c", "d"]), { fileName: "f", topics: TOPICS }).refused[0].problems[0]).toMatch(/can't find the column names/);
    expect(parseTemplate([], { fileName: "f", topics: TOPICS }).refused[0].problems).toEqual(["The file has no questions."]);
    const many = Array.from({ length: MAX_UPLOAD_ROWS + 1 }, () => cells(GOOD));
    expect(parseTemplate(sheetOf(HEADER, ...many), { fileName: "f", topics: TOPICS }).refused[0].problems[0]).toMatch(/at most 500/);
  });

  it("lists every problem in a row, with its row number", () => {
    const { rows, refused } = parse(
      GOOD,
      { ...GOOD, Class: "Class 3", Level: "Tricky", "Choice 2": "", "Choice 3": "", "Right answer": "", Hint: "" },
      { ...GOOD, Topic: "Fractions", "Picture (optional)": "3 green" },
      { ...GOOD, "Choice 2": "4", "Right answer": "9", "Skill (optional)": "Juggling", "Sum to check (optional)": "two plus three" },
      { ...GOOD, Class: "Sixth" },
    );
    expect(rows.map(r => r.row)).toEqual([2]);
    expect(refused).toEqual([
      { row: 3, problems: [
        "Nitya has no topics for Class 3 yet. For now, questions can go in UKG.",
        '"Tricky" isn\'t a level. Write 1 Easy, 2 Medium, 3 Hard or 4 Olympiad.',
        "There is only one choice. Give 2 to 4 for the child to tap.",
        "The right answer is empty.",
        "The hint is empty. It shows after a wrong first try.",
      ] },
      { row: 4, problems: ['There is no topic "Fractions" in UKG. Pick one from the list.', 'Can\'t read the picture "3 green". Write it like "3 blue, 2 orange" or "5 blue 2 crossed".'] },
      { row: 5, problems: [
        '"4" is a choice twice.', 'The right answer "9" isn\'t one of the choices.',
        '"Juggling" isn\'t a skill in Adding with objects up to 10. Pick one from the list, or leave it empty.',
        'Nitya can\'t read the sum "two plus three". Write it like "4 + 3" or "9 - 2", or "count dots".',
      ] },
      { row: 6, problems: ['"Sixth" isn\'t a class. Write UKG, LKG, or Class 1 to Class 12.'] },
    ]);
  });
});

describe("checking an upload", () => {
  const check = (...rows: Partial<Record<string, string>>[]) => checkUpload(parse(...rows), TOPICS);

  it("makes a question ready when it passes, and keeps its issues for the family's review", () => {
    const { rows, refused } = check(
      GOOD,
      { ...GOOD, "Sum to check (optional)": "" },
      { ...GOOD, "Right answer": "6", Explanation: "So the answer is 6." },
      { ...GOOD, Question: "Mia has 2 ugly apples and gets 3 more. How many now?" },
      { ...GOOD, Question: "Mia has 20 apples and gets 30 more. How many now?", "Choice 1": "49", "Choice 2": "50", "Choice 3": "51", "Right answer": "50", Explanation: "So it is 50.", "Sum to check (optional)": "20 + 30" },
      { ...GOOD, Hint: "See www.example.com" },
    );
    expect(rows.map(r => [r.row, r.status, r.passedAll, r.unchecked])).toEqual([
      [2, "ready", true, false], [3, "ready", false, true], [4, "review", false, false], [5, "review", false, false], [6, "review", false, false],
    ]);
    expect(rows[2].problems).toEqual(['The right answer says 6, but the sum "2 + 3" gives 5.']);
    expect(rows[3].problems).toEqual(['It uses "ugly", which is not right for a child.']);
    expect(rows[4].problems.join(" ")).toMatch(/past this topic's limit of 10/);
    expect(refused).toEqual([{ row: 7, problems: ["It has a link. Children must never see links, so Nitya can't add it."] }]);
  });
});

describe("saving a family's questions", () => {
  const [good] = checkUpload(parse(GOOD), TOPICS).rows;

  it("rebuilds each question from its fields, and refuses anything else", () => {
    expect(sanitizeOwnQuestion(good.question, ALL_CONTENT, "f.xlsx", 2)).toMatchObject({ source: "upload", topicId: "ukg-addition-10", id: "" });
    const bad = [
      null, "text", { ...good.question, topicId: "nope" }, { ...good.question, level: 5 }, { ...good.question, options: ["5"] },
      { ...good.question, answers: ["9"] }, { ...good.question, subSkill: "hacking" }, { ...good.question, prompt: "x".repeat(601) },
      { ...good.question, visual: { kind: "img", src: "x" } },
    ];
    for (const q of bad) expect(sanitizeOwnQuestion(q, ALL_CONTENT, "f.xlsx", 2)).toBeNull();
    const extra = sanitizeOwnQuestion({ ...good.question, family: true, status: "approved", source: "template" }, ALL_CONTENT, "f.xlsx", 2)!;
    expect(extra.source).toBe("upload");
    expect("family" in extra || "status" in extra).toBe(false);
  });

  it("gives each family its own id for the same question, and leaves out repeats", () => {
    expect(familyQuestionId("a", good.question)).not.toBe(familyQuestionId("b", good.question));
    expect(familyQuestionId("a", good.question)).toBe(familyQuestionId("a", { ...good.question, answers: ["4"] } as typeof good.question));
    const plan = planUpload({
      owner: "a", fileName: "f", private: false, rows: [good, good], contents: ALL_CONTENT,
      officialKeys: new Set(), ownKeys: new Set(),
    });
    expect(plan.result).toMatchObject({ ready: 1, shared: 1, alreadyAdded: 1 });
    expect(planUpload({ owner: "a", fileName: "f", private: true, rows: [good], contents: ALL_CONTENT, officialKeys: new Set([sameQuestionKey(good.question)]), ownKeys: new Set() }).result)
      .toMatchObject({ ready: 0, inNitya: 1 });
    expect(planUpload({ owner: "a", fileName: "f", private: true, rows: [good], contents: ALL_CONTENT, officialKeys: new Set(), ownKeys: new Set() }).result)
      .toMatchObject({ ready: 1, shared: 0 });
    expect(() => planUpload({ owner: "a", fileName: "f", private: true, rows: Array(MAX_UPLOAD_ROWS + 1).fill(good), contents: ALL_CONTENT, officialKeys: new Set(), ownKeys: new Set() }))
      .toThrow("at most 500");
  });
});

describe("a quiz with the family's own questions", () => {
  const official = ALL_CONTENT.find(c => c.topic.id === "ukg-addition-10")!.bank;
  const own = (n: number): Question => ({ ...official.find(q => q.level === 1)!, id: `own-${n}`, prompt: `Own ${n}?`, family: true, variantGroup: `own-${n}` });

  it("asks them before Nitya's questions at the same level", () => {
    const s = startQuiz({ classId: "UKG", topicId: "ukg-addition-10", attemptNo: 1 });
    expect(nextQuestion(s, [...official, own(1), own(2)]).family).toBe(true);
  });

  it("asks a question the child hasn't seen before one of theirs the child has", () => {
    const s = startQuiz({ classId: "UKG", topicId: "ukg-addition-10", attemptNo: 2, seenBefore: ["own-1"] });
    expect(nextQuestion(s, [...official, own(1)]).family).toBeFalsy();
  });
});
