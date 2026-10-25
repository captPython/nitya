import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UKG_TOPICS } from "../../src/content/ukg";
import { as, createTestDb } from "./harness";

const ADMIN = "00000000-0000-4000-8000-00000000000a";
const PARENT_A = "00000000-0000-4000-8000-0000000000a1";
const PARENT_B = "00000000-0000-4000-8000-0000000000b1";
const TOPIC = "ukg-counting-50";
const OTHER_TOPIC = "ukg-before-after";

let db: pg.Client;
let drop: () => Promise<void>;

/** Adds a question as the database owner, bypassing row-level security. */
async function addQuestion(id: string, opts: { topic?: string; status?: string; prompt?: string } = {}) {
  await db.query(
    `insert into public.questions
       (id, topic_id, sub_skill, level, format, prompt, options, answers, hint, explanation, reason, source, source_ref, status)
     values ($1, $2, 'count-on', 1, 'fill-blank', $3, '{3,4,5}', '{4}', 'Count on.', '3 then 4.', '4 comes after 3.',
             'template', 'whatsNext', $4)`,
    [id, opts.topic ?? TOPIC, opts.prompt ?? `Prompt for ${id}`, opts.status ?? "approved"],
  );
}

/** Signs up a parent, gives consent and creates one child profile. Returns the profile id. */
async function familyWithChild(parent: string, nickname: string): Promise<string> {
  return as(db, parent, async q => {
    await q.query("insert into public.parents (id) values ($1) on conflict do nothing", [parent]);
    await q.query("insert into public.consents (parent_id, consent_version) values ($1, 'v1')", [parent]);
    const { rows } = await q.query(
      `insert into public.profiles (parent_id, nickname, avatar, class_id, board, language)
       values ($1, $2, 'owl', 'UKG', 'CBSE', 'en') returning id`,
      [parent, nickname],
    );
    return rows[0].id as string;
  });
}

async function startAttempt(parent: string, profile: string, attemptNo: number, topic = TOPIC): Promise<string> {
  return as(db, parent, async q => {
    const { rows } = await q.query(
      "insert into public.quiz_attempts (profile_id, topic_id, attempt_no) values ($1, $2, $3) returning id",
      [profile, topic, attemptNo],
    );
    return rows[0].id as string;
  });
}

async function answer(parent: string, attempt: string, seq: number, question: string, right: boolean) {
  await as(db, parent, q =>
    q.query(
      `insert into public.quiz_responses (attempt_id, seq, question_id, level, first_try_correct, marks_delta)
       values ($1, $2, $3, 1, $4, $5)`,
      [attempt, seq, question, right, right ? 1 : 0],
    ),
  );
}

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [ADMIN, PARENT_A, PARENT_B]);
  await db.query("insert into public.admins (user_id) values ($1)", [ADMIN]);
}, 30_000);

afterAll(async () => {
  await drop?.();
});

describe("reference data", () => {
  it("has the 5 UKG topics exactly as the app's content defines them", async () => {
    const { rows } = await db.query("select id, class_id, position, title, sub_skills from public.topics order by position");
    expect(rows).toEqual(
      [...UKG_TOPICS]
        .sort((a, b) => a.topic.order - b.topic.order)
        .map(t => ({
          id: t.topic.id, class_id: t.topic.classId, position: t.topic.order, title: t.topic.title,
          sub_skills: t.subSkillNames,
        })),
    );
  });

  it("starts the level bands at L1 85%+, L2 65-85%, L3 50-65%, L4 under 50%", async () => {
    const { rows } = await db.query("select level, min_rate::float, max_rate::float from public.level_bands order by level");
    expect(rows).toEqual([
      { level: 1, min_rate: 0.85, max_rate: 1 },
      { level: 2, min_rate: 0.65, max_rate: 0.85 },
      { level: 3, min_rate: 0.5, max_rate: 0.65 },
      { level: 4, min_rate: 0, max_rate: 0.5 },
    ]);
  });

  it("gives every class a pass mark of 65% and a 1-mark penalty", async () => {
    const { rows } = await db.query("select class_id, pass_percent, wrong_penalty from public.class_settings order by class_id");
    expect(rows.map(r => r.class_id)).toEqual(["LKG", "UKG", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11", "C12"]);
    for (const r of rows) expect(r).toMatchObject({ pass_percent: 65, wrong_penalty: 1 });
  });
});

describe("level bands", () => {
  it("lets an admin move a boundary when both bands change together", async () => {
    await as(db, ADMIN, async q => {
      await q.query("update public.level_bands set min_rate = 0.45 where level = 3");
      await q.query("update public.level_bands set max_rate = 0.45 where level = 4");
      await q.query("set constraints all immediate");
    }, { rollback: true });
  });

  it("refuses bands that overlap or leave a gap", async () => {
    await expect(as(db, ADMIN, async q => {
      await q.query("update public.level_bands set min_rate = 0.40 where level = 3");
      await q.query("set constraints all immediate");
    })).rejects.toThrow(/no gaps or overlaps/);
  });

  it("does not let a parent change them", async () => {
    const res = await as(db, PARENT_A, q => q.query("update public.level_bands set min_rate = 0.9 where level = 1"));
    expect(res.rowCount).toBe(0);
  });
});

describe("questions", () => {
  beforeAll(async () => {
    await addQuestion("q-approved");
    await addQuestion("q-pending", { status: "pending" });
  });

  it("shows parents only approved questions", async () => {
    const { rows } = await as(db, PARENT_A, q => q.query("select id from public.questions order by id"));
    expect(rows.map(r => r.id)).toEqual(["q-approved"]);
  });

  it("shows admins every question", async () => {
    const { rows } = await as(db, ADMIN, q => q.query("select id from public.questions order by id"));
    expect(rows.map(r => r.id)).toEqual(["q-approved", "q-pending"]);
  });

  it("lets only admins add questions", async () => {
    const insert = (q: pg.Client) =>
      q.query(`insert into public.questions
                 (id, topic_id, sub_skill, level, format, prompt, answers, hint, explanation, reason, source)
               values ('q-new', $1, 'count-on', 2, 'numeric', 'What is 9 + 1?', '{10}', 'h', 'e', 'r', 'template')`, [TOPIC]);
    await expect(as(db, PARENT_A, insert)).rejects.toThrow(/row-level security/);
    await as(db, ADMIN, insert, { rollback: true });
  });

  it("refuses the same prompt and picture twice in one topic", async () => {
    await expect(addQuestion("q-copy", { prompt: "Prompt for q-approved" })).rejects.toThrow(/duplicate key/);
  });

  it("needs a source link for a question from a website", async () => {
    await expect(db.query(
      `insert into public.questions (id, topic_id, sub_skill, level, format, prompt, answers, hint, explanation, reason, source)
       values ('q-web', $1, 'count-on', 1, 'numeric', 'From the web', '{1}', 'h', 'e', 'r', 'website')`, [TOPIC],
    )).rejects.toThrow(/check constraint/);
  });

  it("keeps live stats out of reach, even for admins", async () => {
    await expect(as(db, ADMIN, q => q.query("update public.questions set times_shown = 999 where id = 'q-approved'")))
      .rejects.toThrow(/permission denied/);
  });
});

describe("families", () => {
  let childA: string;

  beforeAll(async () => {
    childA = await familyWithChild(PARENT_A, "Asha");
    await familyWithChild(PARENT_B, "Ben");
  });

  it("saves no child profile before the parent gives consent", async () => {
    const NEW_PARENT = "00000000-0000-4000-8000-0000000000c1";
    await db.query("insert into auth.users (id) values ($1)", [NEW_PARENT]);
    await expect(as(db, NEW_PARENT, async q => {
      await q.query("insert into public.parents (id) values ($1)", [NEW_PARENT]);
      await q.query(`insert into public.profiles (parent_id, nickname, avatar, class_id, board, language)
                     values ($1, 'Kai', 'owl', 'LKG', 'CBSE', 'en')`, [NEW_PARENT]);
    })).rejects.toThrow(/row-level security/);
  });

  it("does not let a parent sign up as someone else", async () => {
    const STRANGER = "00000000-0000-4000-8000-0000000000d1";
    await db.query("insert into auth.users (id) values ($1)", [STRANGER]);
    await expect(as(db, PARENT_A, q => q.query("insert into public.parents (id) values ($1)", [STRANGER])))
      .rejects.toThrow(/row-level security/);
  });

  it("shows each parent only their own children", async () => {
    const a = await as(db, PARENT_A, q => q.query("select nickname from public.profiles"));
    const b = await as(db, PARENT_B, q => q.query("select nickname from public.profiles"));
    expect(a.rows).toEqual([{ nickname: "Asha" }]);
    expect(b.rows).toEqual([{ nickname: "Ben" }]);
  });

  it("does not let a parent write progress or quizzes for another family's child", async () => {
    await expect(as(db, PARENT_B, q =>
      q.query("insert into public.topic_progress (profile_id, topic_id, state) values ($1, $2, 'current')", [childA, TOPIC]),
    )).rejects.toThrow(/row-level security/);
    await expect(startAttempt(PARENT_B, childA, 1)).rejects.toThrow(/row-level security/);
  });

  it("keeps one family's quizzes and answers hidden from another", async () => {
    await addQuestion("q-family");
    const attempt = await startAttempt(PARENT_A, childA, 1);
    await answer(PARENT_A, attempt, 1, "q-family", true);
    const attempts = await as(db, PARENT_B, q => q.query("select * from public.quiz_attempts"));
    const answers = await as(db, PARENT_B, q => q.query("select * from public.quiz_responses"));
    expect(attempts.rows).toEqual([]);
    expect(answers.rows).toEqual([]);
  });

  it("gives admins no access to family data", async () => {
    const profiles = await as(db, ADMIN, q => q.query("select * from public.profiles"));
    const attempts = await as(db, ADMIN, q => q.query("select * from public.quiz_attempts"));
    expect(profiles.rows).toEqual([]);
    expect(attempts.rows).toEqual([]);
  });

  it("keeps tables added by later migrations private until granted", async () => {
    await db.query("create table public.later_table (id int primary key)");
    await db.query("alter table public.later_table enable row level security");
    await expect(as(db, PARENT_A, q => q.query("select * from public.later_table"))).rejects.toThrow(/permission denied/);
    await db.query("drop table public.later_table");
  });

  it("gives signed-out users nothing", async () => {
    await expect(as(db, null, q => q.query("select * from public.topics"))).rejects.toThrow(/permission denied/);
    await expect(as(db, null, q => q.query("select * from public.profiles"))).rejects.toThrow(/permission denied/);
  });

  it("deletes a child's progress, quizzes and answers with the profile", async () => {
    const extra = await as(db, PARENT_B, async q => {
      const { rows } = await q.query(`insert into public.profiles (parent_id, nickname, avatar, class_id, board, language)
                                      values ($1, 'Temp', 'panda', 'UKG', 'CBSE', 'en') returning id`, [PARENT_B]);
      return rows[0].id as string;
    });
    await addQuestion("q-temp");
    const attempt = await startAttempt(PARENT_B, extra, 1);
    await answer(PARENT_B, attempt, 1, "q-temp", false);
    await as(db, PARENT_B, q =>
      q.query("insert into public.topic_progress (profile_id, topic_id, state) values ($1, $2, 'current')", [extra, TOPIC]));

    await as(db, PARENT_B, q => q.query("delete from public.profiles where id = $1", [extra]));

    const left = await db.query(
      `select (select count(*) from public.quiz_attempts where profile_id = $1)::int as attempts,
              (select count(*) from public.quiz_responses where attempt_id = $2)::int as answers,
              (select count(*) from public.topic_progress where profile_id = $1)::int as progress`,
      [extra, attempt],
    );
    expect(left.rows[0]).toEqual({ attempts: 0, answers: 0, progress: 0 });
  });
});

describe("settings", () => {
  let child: string;
  const effective = (parent: string) =>
    as(db, parent, q => q.query("select * from public.effective_quiz_settings($1)", [child]));
  const choose = (parent: string, passPercent: number | null, wrongPenalty: number | null = null) =>
    as(db, parent, q => q.query("update public.profiles set pass_percent = $2, wrong_penalty = $3 where id = $1", [child, passPercent, wrongPenalty]));

  beforeAll(async () => {
    child = await familyWithChild(PARENT_A, "Settings kid");
  });

  it("refuses a choice outside what a quiz allows", async () => {
    await expect(choose(PARENT_A, 0)).rejects.toThrow("check");
    await expect(choose(PARENT_A, 101)).rejects.toThrow("check");
    await expect(choose(PARENT_A, null, 5)).rejects.toThrow("check");
  });

  it("uses the parent's choice, higher or lower, and the class default otherwise", async () => {
    expect((await effective(PARENT_A)).rows).toEqual([{ pass_percent: 65, wrong_penalty: 1 }]);
    await as(db, ADMIN, q => q.query("update public.class_settings set pass_percent = 75 where class_id = 'UKG'"));
    expect((await effective(PARENT_A)).rows).toEqual([{ pass_percent: 75, wrong_penalty: 1 }]);
    await choose(PARENT_A, 50, 0);
    expect((await effective(PARENT_A)).rows).toEqual([{ pass_percent: 50, wrong_penalty: 0 }]);
    await choose(PARENT_A, 90, null);
    expect((await effective(PARENT_A)).rows).toEqual([{ pass_percent: 90, wrong_penalty: 1 }]);
    await as(db, ADMIN, q => q.query("update public.class_settings set pass_percent = 65 where class_id = 'UKG'"));
  });

  it("does not let a parent change a class default, or another family's child", async () => {
    const res = await as(db, PARENT_A, q => q.query("update public.class_settings set pass_percent = 70 where class_id = 'UKG'"));
    expect(res.rowCount).toBe(0);
    const other = await choose(PARENT_B, 90);
    expect(other.rowCount).toBe(0);
    await expect(as(db, ADMIN, q => q.query("update public.class_settings set pass_percent = 101 where class_id = 'UKG'"))).rejects.toThrow("check");
  });
});

describe("quiz answers", () => {
  let child: string;

  beforeAll(async () => {
    child = await familyWithChild(PARENT_A, "Quiz kid");
    for (const id of ["q-s1", "q-s2", "q-p1", "q-p2", "q-p3", "q-p4"]) await addQuestion(id);
    await addQuestion("q-other-topic", { topic: OTHER_TOPIC });
  });

  it("updates a question's live stats with each answer", async () => {
    const attempt = await startAttempt(PARENT_A, child, 1);
    await answer(PARENT_A, attempt, 1, "q-s1", true);
    await answer(PARENT_A, attempt, 2, "q-s2", false);
    const { rows } = await db.query(
      "select id, times_shown, first_try_correct from public.questions where id in ('q-s1', 'q-s2') order by id");
    expect(rows).toEqual([
      { id: "q-s1", times_shown: 1, first_try_correct: 1 },
      { id: "q-s2", times_shown: 1, first_try_correct: 0 },
    ]);
  });

  it("refuses the same question twice in one quiz", async () => {
    const attempt = await startAttempt(PARENT_A, child, 2);
    await answer(PARENT_A, attempt, 1, "q-s1", true);
    await expect(answer(PARENT_A, attempt, 2, "q-s1", true)).rejects.toThrow(/duplicate key/);
  });

  it("refuses an answer to a question from another topic", async () => {
    const attempt = await startAttempt(PARENT_A, child, 3);
    await expect(answer(PARENT_A, attempt, 1, "q-other-topic", true)).rejects.toThrow(/not in this quiz's topic/);
  });

  it("lists the questions from the child's last 3 plays of a topic", async () => {
    const kid = await familyWithChild(PARENT_A, "Replay kid");
    const played = ["q-p1", "q-p2", "q-p3", "q-p4"];
    for (const [i, question] of played.entries()) {
      const attempt = await startAttempt(PARENT_A, kid, i + 1);
      await answer(PARENT_A, attempt, 1, question, true);
    }
    const { rows } = await as(db, PARENT_A, q =>
      q.query("select * from public.recent_question_ids($1, $2) as id order by id", [kid, TOPIC]));
    expect(rows.map(r => r.id)).toEqual(["q-p2", "q-p3", "q-p4"]);

    const other = await as(db, PARENT_B, q => q.query("select * from public.recent_question_ids($1, $2)", [kid, TOPIC]));
    expect(other.rows).toEqual([]);
  });
});
