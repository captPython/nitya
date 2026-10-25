import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { add, arith } from "../../src/content/gen";
import { UKG_TOPICS } from "../../src/content/ukg";
import { addNewQuestions, importCsvText, seedBank, topicInfo } from "../../src/supply";
import { PgQuestionStore } from "../../src/supply/pg-store";
import type { TopicContent } from "../../src/types";
import { as, createTestDb } from "./harness";

const ADMIN = "00000000-0000-4000-8000-00000000000a";
const PARENT_A = "00000000-0000-4000-8000-0000000000a1";
const PARENT_B = "00000000-0000-4000-8000-0000000000b1";
const ADDITION = UKG_TOPICS.find(t => t.topic.id === "ukg-addition-10")!;

const HEADER = "id,topic_id,level,sub_skill,format,prompt,options,answers,hint,explanation,reason,picture,working";
// Worded unlike any template, so New questions in the tests above can't have made it already.
const ROW = 'add-1,ukg-addition-10,2,count-on,tap-picture,What is 4 + 3?,6 | 7 | 8,7,"Say 4, then count on 3.","Start at 4 and count on 3: 5, 6, 7. So 4 + 3 = 7.",3 more than 4 is 7.,,4 + 3';

let db: pg.Client;
let drop: () => Promise<void>;
let store: PgQuestionStore;

const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0].n);

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  store = new PgQuestionStore(db);
  await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [ADMIN, PARENT_A, PARENT_B]);
  await db.query("insert into public.admins (user_id) values ($1)", [ADMIN]);
}, 30_000);

afterAll(async () => {
  await drop?.();
});

describe("the Postgres question store", () => {
  it("knows each topic's class and sub-skills, as the app's content does", async () => {
    const sorted = (ts: { subSkills: string[] }[]) => ts.map(t => ({ ...t, subSkills: [...t.subSkills].sort() }));
    expect(sorted(await store.topics())).toEqual(expect.arrayContaining(sorted(UKG_TOPICS.map(topicInfo))));
  });

  it("loads the 400 built-in questions as approved, each with a check record", async () => {
    const s = await seedBank(store, UKG_TOPICS);
    expect(s.added).toHaveLength(400);
    expect(await count("select count(*) n from public.questions where status = 'approved' and source = 'template'")).toBe(400);
    expect(await count("select count(*) n from public.question_checks where reason = 'release' and passed")).toBe(400);
  });

  it("reads back every question exactly as it was saved, so loading again changes nothing", async () => {
    const again = await seedBank(store, UKG_TOPICS);
    expect({ added: again.added.length, updated: again.updated.length, unchanged: again.unchanged.length }).toEqual({ added: 0, updated: 0, unchanged: 400 });
    expect(await count("select count(*) n from public.question_checks")).toBe(400);
  });

  it("New questions saves only questions the bank doesn't have, and logs who asked", async () => {
    const profile = await as(db, PARENT_A, async q => {
      await q.query("insert into public.parents (id) values ($1)", [PARENT_A]);
      await q.query("insert into public.consents (parent_id, consent_version) values ($1, 'v1')", [PARENT_A]);
      const { rows } = await q.query(
        `insert into public.profiles (parent_id, nickname, avatar, class_id, board, language)
         values ($1, 'Riya', 'owl', 'UKG', 'CBSE', 'en') returning id`, [PARENT_A]);
      return rows[0].id as string;
    });
    for (const seed of [1, 2, 3]) {
      const s = await addNewQuestions(store, ADDITION, { seed, perLevel: 5, requestedBy: PARENT_A, profileId: profile });
      expect(s.approved.length).toBeGreaterThan(0);
      expect(s.inReview).toEqual([]);
    }
    expect(await count("select count(*) n from public.questions where topic_id = 'ukg-addition-10'"))
      .toBe(await count("select count(distinct content_key) n from public.questions where topic_id = 'ukg-addition-10'"));
    expect(await count("select count(*) n from public.question_requests where requested_by = $1 and profile_id = $2", [PARENT_A, profile])).toBe(3);
  });

  it("holds a question that fails a check for the admin, with the report", async () => {
    const broken: TopicContent = {
      ...ADDITION,
      generator: { ...ADDITION.generator, templates: { ...ADDITION.generator.templates, 2: [() => ({
        subSkill: "count-on", format: "tap-picture", prompt: "6 + 3 = ?", options: ["8", "9", "10"], answers: ["10"],
        hint: "Say 6, then count on 3.", explanation: "Count on 3 from 6. So 6 + 3 = 10.", reason: "3 more than 6 is 10.",
        working: arith(add(6, 3)),
      })] } },
    };
    const s = await addNewQuestions(store, broken, { seed: 1, perLevel: 1, levels: [2], requestedBy: ADMIN });
    expect(s.inReview).toHaveLength(1);
    const { rows } = await db.query(
      `select q.status, c.passed, c.report from public.questions q join public.question_checks c on c.question_id = q.id where q.id = $1`,
      [s.inReview[0].id]);
    expect(rows).toEqual([{ status: "in_review", passed: false, report: expect.objectContaining({ passed: false }) }]);
    expect(rows[0].report.answer.problems).toContain("Recomputing gives a different answer: 10 is wrong.");
  });

  it("imports a CSV, updates an edited row and starts its live results again", async () => {
    const first = await importCsvText(store, [HEADER, ROW, "x,ukg-algebra,1,a,mcq,p,,1,h,e,r,,"].join("\n"), "addition.csv");
    expect(first).toMatchObject({ added: ["add-1"], errors: [{ file: "addition.csv", row: 3, message: 'There is no topic "ukg-algebra".' }] });
    await db.query("update public.questions set times_shown = 40, first_try_correct = 30 where id = 'add-1'");

    expect((await importCsvText(store, [HEADER, ROW].join("\n"), "addition.csv")).unchanged).toEqual(["add-1"]);
    // Moving the row within the file keeps the question and its results; only the reference changes.
    const moved = await importCsvText(store, [HEADER, ROW.replace("add-1", "add-0").replace(/4 \+ 3/g, "4 + 2").replace("6 | 7 | 8", "5 | 6 | 7")
      .replace("count on 3", "count on 2").replace("Start at 4 and count on 2: 5, 6, 7", "Start at 4 and count on 2: 5, 6")
      .replace(",7,", ",6,").replace("4 + 2 = 7", "4 + 2 = 6").replace("3 more than 4 is 7", "2 more than 4 is 6"), ROW].join("\n"), "addition.csv");
    expect(moved).toMatchObject({ added: ["add-0"], unchanged: ["add-1"], inReview: [] });
    expect((await db.query("select source_ref, times_shown from public.questions where id = 'add-1'")).rows[0])
      .toEqual({ source_ref: "addition.csv row 3", times_shown: 40 });

    const edited = await importCsvText(store, [HEADER, ROW.replace(",2,count-on", ",3,count-on")].join("\n"), "addition.csv");
    expect(edited.updated).toEqual(["add-1"]);
    expect((await db.query("select level, times_shown, first_try_correct from public.questions where id = 'add-1'")).rows[0])
      .toEqual({ level: 3, times_shown: 0, first_try_correct: 0 });
    expect(await count("select count(*) n from public.question_checks where question_id = 'add-1'")).toBe(2);
  });

  it("skips a CSV row that repeats a question already in the bank", async () => {
    const copy = ROW.replace("add-1", "add-copy").replace(",2,count-on", ",3,count-on");
    expect((await importCsvText(store, [HEADER, copy].join("\n"), "more.csv")).duplicates).toEqual(["add-copy"]);
  });
});

describe("the New questions log", () => {
  it("shows a family only its own requests, and the admin all of them", async () => {
    const total = await count("select count(*) n from public.question_requests");
    expect(total).toBe(4);
    expect(await as(db, PARENT_A, q => q.query("select requested_by from public.question_requests"), { rollback: true }).then(r => r.rowCount)).toBe(3);
    expect(await as(db, PARENT_B, q => q.query("select * from public.question_requests"), { rollback: true }).then(r => r.rowCount)).toBe(0);
    expect(await as(db, ADMIN, q => q.query("select * from public.question_requests"), { rollback: true }).then(r => r.rowCount)).toBe(total);
    await expect(as(db, null, q => q.query("select * from public.question_requests"))).rejects.toThrow("permission denied");
  });

  it("can't be written by the app, only by the server", async () => {
    await expect(as(db, PARENT_A, q => q.query(
      "insert into public.question_requests (topic_id, requested_by, added) values ('ukg-addition-10', $1, 999)", [PARENT_A],
    ))).rejects.toThrow("permission denied");
    await expect(as(db, ADMIN, q => q.query("delete from public.question_requests"))).rejects.toThrow("permission denied");
  });

  it("keeps the log when a family deletes its account, without the link to them", async () => {
    await db.query("delete from auth.users where id = $1", [PARENT_A]);
    expect(await count("select count(*) n from public.question_requests where requested_by is null and profile_id is null")).toBe(3);
  });
});
