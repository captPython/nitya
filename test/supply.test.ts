import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { add, arith, contentKey } from "../src/content/gen";
import { UKG_TOPICS } from "../src/content/ukg";
import {
  addNewQuestions, bankQuestions, checkQuestions, fingerprint, generateQuestions, importCsvText, MemoryQuestionStore,
  parseCsv, parsePicture, parseQuestionCsv, parseWorking, seedBank, syncCsvFolder, toQuestionCsv, topicInfo,
  type CsvFolder,
} from "../src/supply";
import type { TopicContent } from "../src/types";

const TOPICS = UKG_TOPICS.map(topicInfo);
const ADDITION = UKG_TOPICS.find(t => t.topic.id === "ukg-addition-10")!;
const COMPARING = UKG_TOPICS.find(t => t.topic.id === "ukg-comparing")!;

const HEADER = "id,topic_id,level,sub_skill,format,prompt,options,answers,hint,explanation,reason,picture,working";
const ROW = 'add-1,ukg-addition-10,2,count-on,tap-picture,4 + 3 = ?,6 | 7 | 8,7,"Say 4, then count on 3.","Start at 4 and count on 3: 5, 6, 7. So 4 + 3 = 7.",3 more than 4 is 7.,,4 + 3';
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

const folder = (files: Record<string, string>): CsvFolder => ({
  files: async () => Object.entries(files).map(([name, text]) => ({ id: name, name, text: async () => text })),
});

describe("making new questions", () => {
  it("makes the number asked for at each level, all new and all passing the checks", () => {
    const known = COMPARING.bank.map(contentKey);
    const made = generateQuestions(COMPARING, { seed: 7, perLevel: 5, known });
    expect(made).toHaveLength(20);
    for (const l of [1, 2, 3, 4]) expect(made.filter(q => q.level === l)).toHaveLength(5);
    expect(made.some(q => known.includes(contentKey(q)))).toBe(false);
    expect(new Set(made.map(contentKey)).size).toBe(20);
    expect(checkQuestions(made, TOPICS).every(c => c.status === "approved")).toBe(true);
  });

  it("records where each question came from, seed included", () => {
    const [q] = generateQuestions(ADDITION, { seed: 7, perLevel: 1, levels: [2], known: [] });
    expect(q).toMatchObject({ source: "template", generatorVersion: "1", level: 2, topicId: "ukg-addition-10" });
    expect(q.sourceRef).toMatch(/^ukg-addition-10 L2 template \d+, seed 7$/);
    expect(q.variantGroup).toMatch(/^ukg-addition-10:/);
  });

  it("gives the same question the same id, and a different question a different id", () => {
    const first = generateQuestions(ADDITION, { seed: 7, perLevel: 5, known: [] });
    expect(generateQuestions(ADDITION, { seed: 7, perLevel: 5, known: [] }).map(q => q.id)).toEqual(first.map(q => q.id));
    // The same seed again, with the first batch now in the bank, must not reuse an old id for a new question.
    const second = generateQuestions(ADDITION, { seed: 7, perLevel: 5, known: first.map(contentKey) });
    expect(second.filter(q => first.some(f => f.id === q.id))).toEqual([]);
  });

  it("stops short, rather than repeat, when a level runs out of new questions", () => {
    // UKG adding's L1 templates can make 20 questions, and the built-in bank already has all of them.
    expect(generateQuestions(ADDITION, { seed: 1, perLevel: 5, levels: [1], known: ADDITION.bank.map(contentKey) })).toEqual([]);
    const all = generateQuestions(ADDITION, { seed: 1, perLevel: 50, levels: [1], known: [] });
    expect(all).toHaveLength(20);
  });
});

describe("reading CSV", () => {
  it("handles quotes, commas, line breaks inside cells, Windows line ends and a byte order mark", () => {
    expect(parseCsv('﻿a,"b, c","say ""hi""\r\nthere"\r\n1,,3\r\n\r\n')).toEqual([["a", "b, c", 'say "hi"\r\nthere'], ["1", "", "3"]]);
    expect(() => parseCsv('a,"b')).toThrow("ends inside a quoted cell");
  });

  it("reads pictures and sums the way an admin writes them", () => {
    expect(parsePicture("3 blue, 2 orange")).toEqual({ kind: "dots", groups: [{ count: 3, color: "blue" }, { count: 2, color: "orange" }] });
    expect(parsePicture("5 Blue 2 crossed")).toEqual({ kind: "dots", groups: [{ count: 5, color: "blue", crossed: 2 }] });
    expect(() => parsePicture("3 red")).toThrow('Can\'t read the picture "3 red"');
    expect(() => parsePicture("2 blue 3 crossed")).toThrow("crosses out more dots than it has");
    expect(parseWorking("9 − 2 − 3")).toEqual(arith({ op: "-", args: [9, 2, 3] }));
    expect(parseWorking("4 + 3 - 2")).toEqual(arith({ op: "-", args: [add(4, 3), 2] }));
    expect(parseWorking("Count dots")).toEqual({ kind: "count-dots" });
    expect(parseWorking('{"kind":"between","above":3,"below":6}')).toEqual({ kind: "between", above: 3, below: 6 });
    expect(() => parseWorking("4 +")).toThrow("Can't read the working");
    expect(() => parseWorking('{"kind":"guess"}')).toThrow('"kind" must be one of');
  });

  it("reads a sound row into a question that passes every check", () => {
    const { questions, errors } = parseQuestionCsv(csv(ROW), { fileName: "addition.csv", topics: TOPICS });
    expect(errors).toEqual([]);
    expect(questions[0]).toMatchObject({
      id: "add-1", level: 2, options: ["6", "7", "8"], answers: ["7"], source: "csv", sourceRef: "addition.csv row 2",
      working: arith(add(4, 3)), variantGroup: "ukg-addition-10:arith:(3+4)",
    });
    expect(checkQuestions(questions, TOPICS)[0].status).toBe("approved");
  });

  it("reports each row it can't read with the row number a spreadsheet shows, and keeps the rest", () => {
    const { questions, errors } = parseQuestionCsv(csv(
      ROW,
      ROW.replace("ukg-addition-10", "ukg-algebra"),
      ROW.replace("add-1,ukg-addition-10,2", "add-2,ukg-addition-10,L5"),
      ROW.replace("tap-picture", "essay").replace("add-1", "add-3"),
      ROW.replace(/,4 \+ 3$/, ",4 +").replace("add-1", "add-4"),
      ROW,
    ), { fileName: "addition.csv", topics: TOPICS });
    expect(questions.map(q => q.id)).toEqual(["add-1"]);
    expect(errors).toEqual([
      { row: 3, message: 'There is no topic "ukg-algebra".' },
      { row: 4, message: 'The level must be 1 to 4, not "L5".' },
      { row: 5, message: expect.stringContaining("The format must be one of") },
      { row: 6, message: expect.stringContaining("Can't read the working") },
      { row: 7, message: 'The id "add-1" is used twice in this file.' },
    ]);
  });

  it("refuses a file with missing or unknown columns", () => {
    expect(parseQuestionCsv("topic_id,level,colour\n", { fileName: "x.csv", topics: TOPICS }).errors).toEqual([
      { row: 1, message: "Unknown column: colour." },
      { row: 1, message: "Missing column: sub_skill, format, prompt, answers, hint, explanation, reason." },
    ]);
  });

  it("gives a row with no id a stable id made from its words and picture", () => {
    const read = () => parseQuestionCsv(csv(ROW.replace("add-1", "")), { fileName: "a.csv", topics: TOPICS }).questions[0].id;
    expect(read()).toMatch(/^ukg-addition-10-csv-[0-9a-f]{16}$/);
    expect(read()).toBe(read());
  });

  it("reads the sample template in docs/ with every row passing the checks", () => {
    const { questions, errors } = parseQuestionCsv(readFileSync("docs/question-template.csv", "utf8"), { fileName: "question-template.csv", topics: TOPICS });
    expect(errors).toEqual([]);
    expect(questions).toHaveLength(5);
    const checked = checkQuestions(questions, TOPICS);
    expect(checked.map(c => ({ id: c.question.id, problems: (["answer", "options", "scope", "level", "wording"] as const).flatMap(k => c.report[k].problems) })))
      .toEqual(questions.map(q => ({ id: q.id, problems: [] })));
  });

  it("imports the sample template next to the built-in banks without clashing", async () => {
    const store = new MemoryQuestionStore(TOPICS);
    await seedBank(store, UKG_TOPICS);
    const s = await importCsvText(store, readFileSync("docs/question-template.csv", "utf8"), "question-template.csv");
    expect({ added: s.added.length, duplicates: s.duplicates, inReview: s.inReview, errors: s.errors }).toEqual({ added: 5, duplicates: [], inReview: [], errors: [] });
  });

  it("round-trips all 400 built-in questions through CSV unchanged", () => {
    const bank = UKG_TOPICS.flatMap(bankQuestions);
    const { questions, errors } = parseQuestionCsv(toQuestionCsv(bank), { fileName: "bank.csv", topics: TOPICS });
    expect(errors).toEqual([]);
    expect(questions.map(fingerprint)).toEqual(bank.map(fingerprint));
    expect(questions.map(q => q.variantGroup)).toEqual(bank.map(q => q.variantGroup));
  });
});

describe("filling the bank", () => {
  it("loads the built-in banks once; loading them again changes nothing", async () => {
    const store = new MemoryQuestionStore(TOPICS);
    const first = await seedBank(store, UKG_TOPICS);
    expect(first.added).toHaveLength(400);
    expect(first.inReview).toEqual([]);
    const again = await seedBank(store, UKG_TOPICS);
    expect({ added: again.added.length, updated: again.updated.length, unchanged: again.unchanged.length }).toEqual({ added: 0, updated: 0, unchanged: 400 });
  });

  it("New questions adds approved questions the bank doesn't have, and logs the request", async () => {
    const store = new MemoryQuestionStore(TOPICS);
    await seedBank(store, UKG_TOPICS);
    const summary = await addNewQuestions(store, ADDITION, { seed: 99, perLevel: 3, requestedBy: "parent-1", profileId: "child-1" });
    // 3 each for L2 to L4; L1 has no new questions left (see above).
    expect(summary).toMatchObject({ asked: 12, inReview: [] });
    expect(summary.approved).toHaveLength(9);
    const keys = (await store.existing(ADDITION.topic.id)).map(contentKey);
    expect(keys).toHaveLength(89);
    expect(new Set(keys).size).toBe(89);
    expect(store.requests).toEqual([{ topicId: ADDITION.topic.id, requestedBy: "parent-1", profileId: "child-1", added: 9, sentToReview: 0 }]);
    expect([...store.rows.values()].filter(r => summary.approved.includes(r.question.id)).every(r => r.status === "approved")).toBe(true);
  });

  it("holds a question that fails a check for the admin, with the reasons", async () => {
    const broken: TopicContent = {
      ...ADDITION,
      generator: {
        ...ADDITION.generator,
        templates: { ...ADDITION.generator.templates, 1: [() => ({
          subSkill: "count-on", format: "tap-picture", prompt: "2 + 2 = ?", options: ["4", "5", "6"], answers: ["5"],
          hint: "Say 2, then count on 2.", explanation: "Count on 2 from 2. So 2 + 2 = 5.", reason: "2 more than 2 is 5.",
          working: arith(add(2, 2)),
        })] },
      },
    };
    const store = new MemoryQuestionStore(TOPICS);
    const summary = await addNewQuestions(store, broken, { seed: 1, perLevel: 1, levels: [1] });
    expect(summary.approved).toEqual([]);
    expect(summary.inReview).toEqual([{ id: expect.any(String), problems: expect.arrayContaining(["Recomputing gives a different answer: 5 is wrong."]) }]);
    expect(store.rows.get(summary.inReview[0].id)!.status).toBe("in_review");
    expect(store.requests[0]).toMatchObject({ added: 0, sentToReview: 1 });
  });

  it("imports a CSV, skips a question the bank already has, and updates an edited row", async () => {
    const store = new MemoryQuestionStore(TOPICS);
    await seedBank(store, UKG_TOPICS);
    const copy = bankQuestions(ADDITION)[0];
    const copyRow = toQuestionCsv([{ ...copy, id: "my-copy" }]).split("\n")[1];
    const first = await importCsvText(store, csv(ROW, copyRow), "addition.csv");
    expect(first).toMatchObject({ added: ["add-1"], duplicates: ["my-copy"], errors: [] });

    const row = store.rows.get("add-1")!;
    row.timesShown = 40; row.firstTryCorrect = 30;
    expect((await importCsvText(store, csv(ROW), "addition.csv")).unchanged).toEqual(["add-1"]);
    expect(row.timesShown).toBe(40);

    const edited = await importCsvText(store, csv(ROW.replace(",2,count-on", ",3,count-on")), "addition.csv");
    expect(edited.updated).toEqual(["add-1"]);
    expect(store.rows.get("add-1")).toMatchObject({ question: { level: 3 }, timesShown: 0, firstTryCorrect: 0 });
    expect(store.rows.get("add-1")!.checks).toHaveLength(2);
  });

  it("syncs a folder of CSVs one way, reporting rows that disappeared without deleting them", async () => {
    const store = new MemoryQuestionStore(TOPICS);
    const second = ROW.replace("add-1", "add-2").replace(/4 \+ 3/g, "5 + 3").replace("6 | 7 | 8", "7 | 8 | 9")
      .replace("Say 4", "Say 5").replace("Start at 4 and count on 3: 5, 6, 7", "Start at 5 and count on 3: 6, 7, 8")
      .replace(",7,", ",8,").replace("3 more than 4 is 7", "3 more than 5 is 8");
    const before = await syncCsvFolder(store, folder({ "a.csv": csv(ROW), "b.csv": csv(second) }));
    expect(before).toMatchObject({ added: ["add-1", "add-2"], inReview: [], errors: [], files: ["a.csv", "b.csv"], missing: [] });

    const after = await syncCsvFolder(store, folder({ "a.csv": csv(ROW) }));
    expect(after).toMatchObject({ added: [], unchanged: ["add-1"], missing: ["add-2"] });
    expect(store.rows.has("add-2")).toBe(true);
  });

  it("refuses the same id in two files of the folder", async () => {
    const store = new MemoryQuestionStore(TOPICS);
    const s = await syncCsvFolder(store, folder({ "a.csv": csv(ROW), "b.csv": csv(ROW) }));
    expect(s.added).toEqual(["add-1"]);
    expect(s.errors).toEqual([{ file: "b.csv", row: 2, message: 'The id "add-1" is also used in a.csv.' }]);
  });
});
