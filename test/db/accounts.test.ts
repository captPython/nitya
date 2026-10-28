import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_REVIEW_SAMPLES } from "../../src/accounts/demo-samples";
import { supabaseBackend, type AuthPort, type FamilyQuestionsCall, type NewQuestionsCall } from "../../src/accounts/supabase-backend";
import { ALL_CONTENT } from "../../src/content";
import { UKG_TOPICS } from "../../src/content/ukg";
import { newQuestionsHandler } from "../../src/server/new-questions";
import { familyQuestionsHandler } from "../../src/server/family-questions";
import { familyDeps, supabaseDeps } from "../../src/server/supabase-deps";
import { checkQuestions, seedBank, topicInfo } from "../../src/supply";
import { PgQuestionStore } from "../../src/supply/pg-store";
import { checkUpload, parseTemplate, templateTopic, TEMPLATE_COLUMNS } from "../../src/supply/template";
import { accountContract } from "../accounts-contract";
import { as, createTestDb } from "./harness";
import { jwtFor, startPostgrest, userOf } from "./postgrest";

let db: pg.Client;
let drop: () => Promise<void>;
let api: Awaited<ReturnType<typeof startPostgrest>>;

/** Sign-in is Supabase Auth's job; here a parent is simply signed in as a known user, until they sign out. */
const signedInAs = (id: string, email: string): AuthPort => {
  let out = false;
  return {
    user: async () => (out ? null : { id, email }),
    signInWithGoogle: async () => {}, sendEmailLink: async () => {}, signOut: async () => { out = true; },
  };
};

async function newParent() {
  const id = randomUUID();
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@example.com`]);
  return id;
}

beforeAll(async () => {
  let url: string;
  ({ db, url, drop } = await createTestDb());
  // Answers refer to questions, so the bank has to be there.
  await seedBank(new PgQuestionStore(db), UKG_TOPICS);
  api = await startPostgrest(db, url);
}, 60_000);

afterAll(async () => {
  await api?.stop();
  await drop?.();
});

/** The New questions function running here, on the service role, as Supabase would run it. */
const callAs = (userId: string): NewQuestionsCall => {
  const handler = newQuestionsHandler({ ...supabaseDeps(api.serviceClient()), userFor: async t => userOf(t), contents: ALL_CONTENT });
  return async body => {
    const res = await handler(new Request("http://functions.test/new-questions", {
      method: "POST", headers: { Authorization: `Bearer ${jwtFor(userId)}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    return json;
  };
};

/** The family-questions function, the same way. */
const familyCallAs = (userId: string): FamilyQuestionsCall => {
  const handler = familyQuestionsHandler({ ...familyDeps(api.serviceClient()), userFor: async t => userOf(t), contents: ALL_CONTENT });
  return async body => {
    const res = await handler(new Request("http://functions.test/family-questions", {
      method: "POST", headers: { Authorization: `Bearer ${jwtFor(userId)}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    return json;
  };
};

const backendFor = (id: string) => supabaseBackend(api.clientFor(id), signedInAs(id, `${id}@example.com`), callAs(id), familyCallAs(id));

/** Puts the planted mistakes back in the review queue, empties the community bank, and puts the settings back to how they start. */
async function resetWorld() {
  await db.query("delete from public.questions where id like 'demo-%' or source = 'upload'");
  await db.query("delete from public.question_uploads");
  await new PgQuestionStore(db).save(checkQuestions(DEMO_REVIEW_SAMPLES, ALL_CONTENT.map(topicInfo)));
  await db.query("update public.class_settings set pass_percent = 65, wrong_penalty = 1");
  await db.query("delete from public.question_flags");
  await db.query("delete from public.flag_suggestions");
  await db.query("delete from public.family_trust");
  await db.query("delete from public.question_choice_picks");
  await db.query("update public.questions set flag_review_at = null, flag_hide_all = false where flag_review_at is not null");
  await db.query("delete from public.flag_settings");
  await db.query("insert into public.flag_settings default values");
  await db.query("begin");
  await db.query(`update public.level_bands set min_rate = case level when 1 then 0.85 when 2 then 0.65 when 3 then 0.5 else 0 end,
    max_rate = case level when 1 then 1 when 2 then 0.85 when 3 then 0.65 else 0.5 end`);
  await db.query("commit");
}

accountContract("the Supabase backend", async () => {
  await resetWorld();
  return {
    family: async () => backendFor(await newParent()),
    async admin() {
      const id = await newParent();
      await db.query("insert into public.admins (user_id) values ($1)", [id]);
      return backendFor(id);
    },
    // The database's clock can't move, so everything the flag rules time moves back instead.
    async travel(days) {
      const back = [days * 86400];
      await db.query("update public.question_flags set flagged_at = flagged_at - make_interval(secs => $1), hide_until = hide_until - make_interval(secs => $1), resolved_at = resolved_at - make_interval(secs => $1)", back);
      await db.query("update public.flag_suggestions set suggested_at = suggested_at - make_interval(secs => $1)", back);
      await db.query("update public.family_trust set muted_until = muted_until - make_interval(secs => $1)", back);
      await db.query("update public.questions set flag_review_at = flag_review_at - make_interval(secs => $1) where flag_review_at is not null", back);
      await db.query("update public.parents set created_at = created_at - make_interval(secs => $1)", back);
    },
  };
});

describe("the Supabase backend", () => {
  it("makes the parent's row on first sign-in, once", async () => {
    const id = await newParent();
    const b = supabaseBackend(api.clientFor(id), signedInAs(id, "new@example.com"));
    expect(await b.account()).toEqual({ userId: id, email: "new@example.com", consentVersion: null, pinHash: null, isAdmin: false });
    await b.account();
    expect((await db.query("select count(*)::int n from public.parents where id = $1", [id])).rows[0].n).toBe(1);
  });

  it("returns nothing when signed out", async () => {
    const id = await newParent();
    const b = supabaseBackend(api.clientFor(id), { ...signedInAs(id, ""), user: async () => null });
    expect(await b.account()).toBeNull();
    await expect(b.giveConsent("v")).rejects.toThrow("Sign in first.");
  });

  it("asks again after the consent text changes, by giving the newest version", async () => {
    const id = await newParent();
    const b = supabaseBackend(api.clientFor(id), signedInAs(id, "x@example.com"));
    await b.account();
    await b.giveConsent("2026-10-25");
    await b.giveConsent("2027-01-01");
    expect((await b.account())?.consentVersion).toBe("2027-01-01");
  });
});

describe("withdrawing consent on Supabase", () => {
  it("deletes the sign-in and every row of the family's, and keeps the admin's request log without their ids", async () => {
    const id = await newParent();
    const b = backendFor(id);
    await b.giveConsent("2026-10-25");
    await b.setPinHash("pbkdf2-sha256$100000$c2FsdA==$aGFzaA==");
    const riya = await b.createProfile({ nickname: "Riya", avatar: "owl", classId: "UKG", board: "CBSE", language: "en" });
    await b.startAttempt(riya.id, { id: randomUUID(), topicId: UKG_TOPICS[0].topic.id, attemptNo: 1, practice: false, startedAt: new Date().toISOString() });
    await b.newQuestions(UKG_TOPICS[0].topic.id, riya.id);
    await b.deleteAccount();
    const count = async (sql: string) => (await db.query(sql, [id])).rows[0].n;
    expect(await count("select count(*)::int n from auth.users where id = $1")).toBe(0);
    expect(await count("select count(*)::int n from public.parents where id = $1")).toBe(0);
    expect(await count("select count(*)::int n from public.consents where parent_id = $1")).toBe(0);
    expect(await count("select count(*)::int n from public.profiles where parent_id = $1")).toBe(0);
    expect((await db.query("select count(*)::int n from public.quiz_attempts where profile_id = $1", [riya.id])).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from public.question_requests where profile_id is null and requested_by is null and topic_id = $1", [UKG_TOPICS[0].topic.id])).rows[0].n).toBeGreaterThan(0);
  });

  it("can't be called signed out", async () => {
    await expect(as(db, null, d => d.query("select public.delete_my_account()"), { rollback: true })).rejects.toThrow();
  });
});

describe("the New questions function on Supabase", () => {
  it("lets a family ask 10 times a day", async () => {
    const id = await newParent();
    await db.query("insert into public.parents (id) values ($1)", [id]);
    await db.query(`insert into public.question_requests (topic_id, requested_by, requested_at)
      select 'ukg-counting-50', $1, now() - make_interval(hours => g) from generate_series(1, 10) g`, [id]);
    await expect(callAs(id)({ topicId: "ukg-counting-50" })).rejects.toThrow("Try again tomorrow");
    // Presses from yesterday don't count.
    await db.query("update public.question_requests set requested_at = now() - interval '25 hours' where requested_by = $1", [id]);
    await expect(callAs(id)({ topicId: "ukg-counting-50" })).resolves.toMatchObject({ topicId: "ukg-counting-50" });
  });
});

describe("the accounts migration", () => {
  it("lets a parent set only their own PIN, and only as a hash", async () => {
    const a = await newParent(), b = await newParent();
    await db.query("insert into public.parents (id) values ($1), ($2)", [a, b]);
    await expect(as(db, a, q => q.query("update public.parents set pin_hash = '1234' where id = $1", [a])))
      .rejects.toThrow("violates check constraint");
    const changed = await as(db, a, q => q.query("update public.parents set pin_hash = 'pbkdf2-sha256$1$c2FsdA==$aA==' where id = $1", [b]));
    expect(changed.rowCount).toBe(0);
    await expect(as(db, a, q => q.query("update public.parents set created_at = now() where id = $1", [a])))
      .rejects.toThrow("permission denied");
  });

  it("keeps a profile to the onboarding choices", async () => {
    const a = await newParent();
    await db.query("insert into public.parents (id) values ($1)", [a]);
    await db.query("insert into public.consents (parent_id, consent_version) values ($1, 'v1')", [a]);
    const add = (avatar: string, board: string, language: string, nickname = "Riya") => as(db, a, q => q.query(
      "insert into public.profiles (parent_id, nickname, avatar, class_id, board, language) values ($1, $2, $3, 'UKG', $4, $5)",
      [a, nickname, avatar, board, language]), { rollback: true });
    await expect(add("owl", "CBSE", "en")).resolves.toBeDefined();
    await expect(add("dragon", "CBSE", "en")).rejects.toThrow("profiles_avatar_choice");
    await expect(add("owl", "IB", "en")).rejects.toThrow("profiles_board_choice");
    await expect(add("owl", "CBSE", "English")).rejects.toThrow("profiles_language_choice");
    await expect(add("owl", "CBSE", "en", " Riya")).rejects.toThrow("profiles_nickname_trimmed");
  });
});

describe("a family's own questions on Supabase", () => {
  const FILE = "mine.xlsx";
  const sheet = (question: string, answer: string, sum: string) => checkUpload(parseTemplate([
    { row: 1, cells: TEMPLATE_COLUMNS.map(c => c.header) },
    { row: 2, cells: ["UKG", "Adding with objects up to 10", "1 Easy", question, "4", "5", "6", "", answer, "Count on.", `So it is ${answer}.`, "", "", "", sum] },
  ], { fileName: FILE, topics: ALL_CONTENT.map(templateTopic) }), ALL_CONTENT.map(templateTopic)).rows;
  async function familyWith(question: string, opts: { private?: boolean } = {}) {
    const id = await newParent();
    const b = backendFor(id);
    await b.giveConsent("2026-10-25");
    const r = await b.saveUpload({ fileName: FILE, private: opts.private ?? false, rows: sheet(question, "5", "2 + 3") });
    const [own] = await b.ownQuestions();
    return { id, b, uploadId: r.uploadId!, questionId: own.question.id };
  }
  const visible = (userId: string, questionId: string) =>
    as(db, userId, q => q.query("select id from public.questions where id = $1", [questionId])).then(r => r.rowCount);

  it("shows a family's questions only to that family, and shared ones to everyone signed in, but never private ones to an admin", async () => {
    const shared = await familyWith("Tia has 2 hats and gets 3 more. How many hats now?");
    const kept = await familyWith("Jo has 2 caps and gets 3 more. How many caps now?", { private: true });
    const stranger = await newParent();
    const admin = await newParent();
    await db.query("insert into public.admins (user_id) values ($1)", [admin]);
    expect(await visible(stranger, shared.questionId)).toBe(1);
    expect(await visible(stranger, kept.questionId)).toBe(0);
    expect(await visible(admin, kept.questionId)).toBe(0);
    expect(await visible(kept.id, kept.questionId)).toBe(1);
    expect(await visible(stranger, kept.questionId)).toBe(0);
    expect((await as(db, stranger, q => q.query("select id from public.question_uploads where id = $1", [kept.uploadId]))).rowCount).toBe(0);
  });

  it("lets families write their questions only through the server function and their own review", async () => {
    const f = await familyWith("Lea has 2 cups and gets 3 more. How many cups now?", { private: true });
    // Straight into the table: refused, so nothing unchecked reaches the community bank.
    await expect(as(db, f.id, q => q.query("update public.questions set shared = true where id = $1", [f.questionId])))
      .rejects.toThrow("permission denied");
    await expect(as(db, f.id, q => q.query("update public.questions set status = 'approved', answers = '{4}' where id = $1", [f.questionId])))
      .resolves.toMatchObject({ rowCount: 0 });
    await expect(as(db, f.id, q => q.query(
      `insert into public.questions (id, topic_id, sub_skill, level, format, prompt, answers, hint, explanation, reason, source, owner, upload_id, status, shared)
       values ('own-x', 'ukg-addition-10', 'own', 1, 'mcq', 'Sneaky?', '{1}', 'h', 'e', 'r', 'upload', $1, $2, 'approved', true)`, [f.id, f.uploadId])))
      .rejects.toThrow(/row-level security|permission denied/);
    expect((await db.query("select shared from public.questions where id = $1", [f.questionId])).rows[0].shared).toBe(false);
    // The admin's review is for the official bank only.
    const admin = await newParent();
    await db.query("insert into public.admins (user_id) values ($1)", [admin]);
    await db.query("update public.questions set status = 'in_review' where id = $1", [f.questionId]);
    await expect(as(db, admin, q => q.query("select public.review_question($1, 'approved')", [f.questionId]))).rejects.toThrow("There is no question");
  });

  it("keeps a played question when its upload is removed, so the child's answers keep it", async () => {
    const f = await familyWith("Max has 2 balls and gets 3 more. How many balls now?");
    const riya = await f.b.createProfile({ nickname: "Riya", avatar: "owl", classId: "UKG", board: "CBSE", language: "en" });
    const attemptId = randomUUID();
    await f.b.startAttempt(riya.id, { id: attemptId, topicId: "ukg-addition-10", attemptNo: 1, practice: false, startedAt: new Date().toISOString() });
    await f.b.recordResponse({ attemptId, seq: 1, questionId: f.questionId, level: 1, subSkill: "own", firstTryCorrect: true, retryCorrect: null, marksDelta: 1 });
    await f.b.removeUpload(f.uploadId);
    expect((await db.query("select status, shared from public.questions where id = $1", [f.questionId])).rows[0]).toEqual({ status: "rejected", shared: false });
    expect((await db.query("select removed_at is not null removed from public.question_uploads where id = $1", [f.uploadId])).rows[0].removed).toBe(true);
    expect(await f.b.questionUploads()).toEqual([]);
    expect((await f.b.profileData(riya.id)).responses[0].subSkill).toBe("own");
  });

  it("deletes a leaving family's questions, but keeps one another family's child answered, without the family", async () => {
    const f = await familyWith("Ana has 2 bags and gets 3 more. How many bags now?");
    const unplayedRows = sheet("Ana has 2 pots and gets 3 more. How many pots now?", "5", "2 + 3");
    await f.b.saveUpload({ fileName: FILE, private: false, rows: unplayedRows });
    const other = backendFor(await newParent());
    await other.giveConsent("2026-10-25");
    const kid = await other.createProfile({ nickname: "Kabir", avatar: "tiger", classId: "UKG", board: "CBSE", language: "en" });
    const attemptId = randomUUID();
    await other.startAttempt(kid.id, { id: attemptId, topicId: "ukg-addition-10", attemptNo: 1, practice: false, startedAt: new Date().toISOString() });
    await other.recordResponse({ attemptId, seq: 1, questionId: f.questionId, level: 1, subSkill: "own", firstTryCorrect: true, retryCorrect: null, marksDelta: 1 });
    await f.b.deleteAccount();
    const rows = (await db.query("select id, owner, upload_id, shared from public.questions where source = 'upload' and prompt like 'Ana has%'")).rows;
    expect(rows).toEqual([{ id: f.questionId, owner: null, upload_id: null, shared: true }]);
    expect((await other.profileData(kid.id)).responses).toHaveLength(1);
    expect((await other.questions("ukg-addition-10", { community: true })).some(q => q.id === f.questionId)).toBe(true);
  });
});

describe("question flags on Supabase", () => {
  const TAKING = UKG_TOPICS.find(t => t.topic.id === "ukg-subtraction-10")!;
  const q = (n: number) => TAKING.bank[n].id;
  const family = async () => {
    const id = await newParent();
    const b = backendFor(id);
    await b.giveConsent("2026-10-25");
    return { id, b };
  };
  const admin = async () => {
    const id = await newParent();
    await db.query("insert into public.admins (user_id) values ($1)", [id]);
    return { id, b: backendFor(id) };
  };

  it("lets families change flags only through the flag functions, and read only their own", async () => {
    const [a, other] = [await family(), await family()];
    await a.b.flagQuestion({ questionId: q(60), boxes: ["question"] });
    await expect(as(db, a.id, d => d.query(
      "insert into public.question_flags (question_id, kind, parent_id, boxes) values ($1, 'family', $2, '{safety}')", [q(61), a.id])))
      .rejects.toThrow(/row-level security|permission denied/);
    await expect(as(db, a.id, d => d.query("update public.question_flags set weight = 2 where parent_id = $1", [a.id])))
      .rejects.toThrow("permission denied");
    await expect(as(db, a.id, d => d.query("insert into public.family_trust (parent_id, upheld) values ($1, 100)", [a.id])))
      .rejects.toThrow("permission denied");
    await expect(as(db, a.id, d => d.query("update public.questions set flag_review_at = now() where id = $1", [q(60)])))
      .rejects.toThrow("permission denied");
    await expect(as(db, a.id, d => d.query("select public.flag_evaluate($1)", [q(60)]))).rejects.toThrow("permission denied");
    await expect(as(db, a.id, d => d.query("select public.flag_system($1, 'safety', null, 'x')", [q(60)]))).rejects.toThrow("permission denied");
    expect((await as(db, other.id, d => d.query("select id from public.question_flags where question_id = $1", [q(60)]))).rowCount).toBe(0);
    expect((await as(db, a.id, d => d.query("select id from public.question_flags where question_id = $1", [q(60)]))).rowCount).toBe(1);
    await expect(as(db, a.id, d => d.query("select * from public.flag_settings"))).resolves.toMatchObject({ rowCount: 0 });
    await expect(as(db, a.id, d => d.query("select public.flagger_cards()"))).rejects.toThrow("Only an admin");
  });

  it("keeps a question hidden for everyone out of reach of every family but an admin, even read directly", async () => {
    const [a, other] = [await family(), await family()];
    const { id: adminId } = await admin();
    expect(await a.b.flagQuestion({ questionId: q(62), boxes: ["safety"] })).toBe("review");
    const read = (userId: string) => as(db, userId, d => d.query("select id from public.questions where id = $1", [q(62)])).then(r => r.rowCount);
    expect(await read(other.id)).toBe(0);
    expect(await read(adminId)).toBe(1);
  });

  it("keeps the admin's numbers in range even past the app, and records why a flagger's email was looked up", async () => {
    const [a, ad] = [await family(), await admin()];
    await expect(as(db, ad.id, d => d.query("update public.flag_settings set burst_flags = 2"))).rejects.toThrow("flag_settings_burst_flags_check");
    await expect(as(db, a.id, d => d.query("update public.flag_settings set burst_flags = 20"))).resolves.toMatchObject({ rowCount: 0 });
    expect(await ad.b.revealFlagger(a.id, "Checking a burst of flags on one topic")).toBe(`${a.id}@example.com`);
    expect((await db.query("select parent_id, reason, revealed_by from public.flagger_reveals where parent_id = $1", [a.id])).rows)
      .toEqual([{ parent_id: a.id, reason: "Checking a burst of flags on one topic", revealed_by: ad.id }]);
    expect((await as(db, a.id, d => d.query("select id from public.flagger_reveals"))).rowCount).toBe(0);
  });

  it("forgets a leaving family but keeps its flags, and drops a deleted child's taps", async () => {
    const a = await family();
    const riya = await a.b.createProfile({ nickname: "Riya", avatar: "owl", classId: "UKG", board: "CBSE", language: "en" });
    await a.b.suggestFlag(riya.id, q(63), true);
    await a.b.flagQuestion({ questionId: q(64), profileId: riya.id, boxes: ["level"], levelDirection: "easy" });
    await a.b.deleteProfile(riya.id);
    expect((await db.query("select count(*)::int n from public.flag_suggestions where parent_id = $1", [a.id])).rows[0].n).toBe(0);
    expect((await db.query("select profile_id from public.question_flags where question_id = $1", [q(64)])).rows).toEqual([{ profile_id: null }]);
    await a.b.deleteAccount();
    expect((await db.query("select parent_id, kind from public.question_flags where question_id = $1", [q(64)])).rows).toEqual([{ parent_id: null, kind: "family" }]);
  });
});
