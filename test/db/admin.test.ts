import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_REVIEW_SAMPLES } from "../../src/accounts/demo-samples";
import { ALL_CONTENT } from "../../src/content";
import { checkQuestions, seedBank, topicInfo } from "../../src/supply";
import { PgQuestionStore } from "../../src/supply/pg-store";
import { toRow } from "../../src/supply/rows";
import { as, createTestDb } from "./harness";

let db: pg.Client;
let drop: () => Promise<void>;
let admin: string, parent: string;

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  const store = new PgQuestionStore(db);
  await seedBank(store, ALL_CONTENT);
  await store.save(checkQuestions(DEMO_REVIEW_SAMPLES, ALL_CONTENT.map(topicInfo)));
  admin = randomUUID();
  parent = randomUUID();
  await db.query("insert into auth.users (id) values ($1), ($2)", [admin, parent]);
  await db.query("insert into public.admins (user_id) values ($1)", [admin]);
}, 60_000);

afterAll(async () => { await drop?.(); });

const status = async (id: string) => (await db.query("select status from public.questions where id = $1", [id])).rows[0].status;
const review = (user: string | null, id: string, decision: string, fixed: unknown = null, report: unknown = null) =>
  as(db, user, q => q.query("select public.review_question($1, $2, 'checked', $3, $4)", [id, decision, fixed, report]));

describe("the admin panel migration", () => {
  it("lets parents raise a topic's pass mark to 60 and the penalty to 2, and no further", async () => {
    const { rows } = await db.query("select distinct pass_marks, pass_marks_min, pass_marks_max, wrong_penalty, wrong_penalty_min, wrong_penalty_max from public.topic_settings");
    expect(rows).toEqual([{ pass_marks: 44, pass_marks_min: 44, pass_marks_max: 60, wrong_penalty: 1, wrong_penalty_min: 1, wrong_penalty_max: 2 }]);
  });

  it("lets only an admin review a question, once, and records who did", async () => {
    await expect(review(null, "demo-wrong-level", "approved")).rejects.toThrow("permission denied");
    await expect(review(parent, "demo-wrong-level", "approved")).rejects.toThrow("Only an admin can review questions.");
    expect(await status("demo-wrong-level")).toBe("in_review");
    await review(admin, "demo-wrong-level", "approved");
    expect(await status("demo-wrong-level")).toBe("approved");
    await expect(review(admin, "demo-wrong-level", "rejected")).rejects.toThrow("already reviewed");
    const { rows } = await db.query("select reviewer_id, decision, note from public.question_reviews where question_id = 'demo-wrong-level'");
    expect(rows).toEqual([{ reviewer_id: admin, decision: "approved", note: "checked" }]);
    await review(admin, "demo-out-of-range", "rejected");
    expect(await status("demo-out-of-range")).toBe("rejected");
    await expect(review(admin, "demo-duplicate-options", "maybe")).rejects.toThrow("approved, fixed or rejected");
  });

  it("saves a fix with its new check run, starting its live results again", async () => {
    await db.query("update public.questions set times_shown = 5, first_try_correct = 1 where id = 'demo-wrong-answer'");
    const q = DEMO_REVIEW_SAMPLES.find(s => s.id === "demo-wrong-answer")!;
    const fixed = toRow({ ...q, answers: ["7"] });
    const report = { version: "1", passed: true };
    await review(admin, q.id, "fixed", fixed, report);
    const { rows } = await db.query("select answers, options, working, visual, status, times_shown, first_try_correct from public.questions where id = $1", [q.id]);
    expect(rows[0]).toEqual({ answers: ["7"], options: ["6", "7", "8"], working: q.working, visual: null, status: "approved", times_shown: 0, first_try_correct: 0 });
    const checks = await db.query("select passed from public.question_checks where question_id = $1 order by checked_at", [q.id]);
    expect(checks.rows.map(r => r.passed)).toEqual([false, true]);
  });

  it("sends a CSV question's fix back to its Drive file", async () => {
    const q = DEMO_REVIEW_SAMPLES.find(s => s.id === "demo-csv-no-working")!;
    await expect(review(admin, q.id, "fixed", toRow(q), { passed: true })).rejects.toThrow("Drive file");
    await expect(review(admin, "demo-duplicate-options", "fixed")).rejects.toThrow("needs the new question");
    expect(await status(q.id)).toBe("in_review");
  });

  it("lets only an admin move the level bands, all four at once", async () => {
    const set = (user: string | null, a: number, b: number, c: number) =>
      as(db, user, q => q.query("select public.set_level_bands($1, $2, $3)", [a, b, c]));
    await expect(set(null, 0.8, 0.6, 0.4)).rejects.toThrow("permission denied");
    await expect(set(parent, 0.8, 0.6, 0.4)).rejects.toThrow("Only an admin can change the level bands.");
    await expect(set(admin, 0.6, 0.8, 0.4)).rejects.toThrow("lower than the one before");
    await set(admin, 0.8, 0.6, 0.4);
    const { rows } = await db.query("select level, min_rate::float8 min, max_rate::float8 max from public.level_bands order by level");
    expect(rows).toEqual([
      { level: 1, min: 0.8, max: 1 }, { level: 2, min: 0.6, max: 0.8 }, { level: 3, min: 0.4, max: 0.6 }, { level: 4, min: 0, max: 0.4 },
    ]);
  });
});
