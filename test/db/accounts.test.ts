import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_REVIEW_SAMPLES } from "../../src/accounts/demo-samples";
import { supabaseBackend, type AuthPort, type NewQuestionsCall } from "../../src/accounts/supabase-backend";
import { ALL_CONTENT } from "../../src/content";
import { UKG_TOPICS } from "../../src/content/ukg";
import { newQuestionsHandler } from "../../src/server/new-questions";
import { supabaseDeps } from "../../src/server/supabase-deps";
import { checkQuestions, seedBank, topicInfo } from "../../src/supply";
import { PgQuestionStore } from "../../src/supply/pg-store";
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
  await db.query("insert into auth.users (id) values ($1)", [id]);
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

const backendFor = (id: string) => supabaseBackend(api.clientFor(id), signedInAs(id, `${id}@example.com`), callAs(id));

/** Puts the planted mistakes back in the review queue, and the settings back to how they start. */
async function resetWorld() {
  await db.query("delete from public.questions where id like 'demo-%'");
  await new PgQuestionStore(db).save(checkQuestions(DEMO_REVIEW_SAMPLES, ALL_CONTENT.map(topicInfo)));
  await db.query("update public.class_settings set pass_percent = 65, wrong_penalty = 1");
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
