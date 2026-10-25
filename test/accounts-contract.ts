import { describe, expect, it } from "vitest";
import { applyEdits, editsOf, recheck } from "../src/admin/review";
import { defaultClassSettings, type ChildSettings } from "../src/admin/settings";
import { DEMO_REVIEW_SAMPLES } from "../src/accounts/demo-samples";
import { ALL_CONTENT } from "../src/content";
import { UKG_TOPICS } from "../src/content/ukg";
import type { AccountBackend } from "../src/accounts/backend";
import type { ProfileDetails } from "../src/accounts/options";
import type { Look } from "../src/looks";
import { topicInfo } from "../src/supply";
import { CLASS_ORDER } from "../src/types";
import { DEFAULT_BANDS } from "../src/validation";

const RIYA: ProfileDetails = { nickname: "Riya", avatar: "owl", classId: "UKG", board: "CBSE", language: "en" };
const KABIR: ProfileDetails = { nickname: "Kabir", avatar: "tiger", classId: "UKG", board: "ICSE", language: "hi" };
const COUNTING = UKG_TOPICS[0];
const [Q1, Q2] = COUNTING.bank;
const HASH = "pbkdf2-sha256$100000$c2FsdA==$aGFzaA==";

/**
 * One Nitya: its question bank (the built-in questions, plus the planted
 * mistakes in DEMO_REVIEW_SAMPLES waiting for review), the starting settings,
 * and the people signed in to it.
 */
export interface ContractWorld {
  /** A parent nobody has seen before, signed in. */
  family(): Promise<AccountBackend>;
  /** A signed-in admin. */
  admin(): Promise<AccountBackend>;
}

const V = "2026-10-25";
const sampleIds = (ids: string[]) => ids.filter(id => id.startsWith("demo-")).sort();

/**
 * What every account backend must do, run against the demo backend and the
 * Supabase one alike. Each `newWorld` starts from the same bank and settings.
 */
export function accountContract(name: string, newWorld: () => Promise<ContractWorld>) {
  const newFamily = async () => (await newWorld()).family();

  describe(`${name}: an account`, () => {
    it("starts with no consent, no PIN and no profiles", async () => {
      const b = await newFamily();
      expect(await b.account()).toMatchObject({ consentVersion: null, pinHash: null, isAdmin: false });
      expect(await b.profiles()).toEqual([]);
    });

    it("saves no child before the parent gives consent", async () => {
      const b = await newFamily();
      await expect(b.createProfile(RIYA)).rejects.toThrow();
      expect(await b.profiles()).toEqual([]);
    });

    it("records consent and the PIN", async () => {
      const b = await newFamily();
      await b.giveConsent("2026-10-25");
      await b.setPinHash(HASH);
      expect(await b.account()).toMatchObject({ consentVersion: "2026-10-25", pinHash: HASH });
    });

    it("holds several children, edits and deletes them", async () => {
      const b = await newFamily();
      await b.giveConsent("2026-10-25");
      const riya = await b.createProfile({ ...RIYA, nickname: "  Riya " });
      const kabir = await b.createProfile(KABIR);
      expect(riya).toEqual({ id: expect.any(String), ...RIYA });
      expect((await b.profiles()).map(p => p.nickname)).toEqual(["Riya", "Kabir"]);
      expect(await b.updateProfile(kabir.id, { ...KABIR, avatar: "panda" })).toEqual({ id: kabir.id, ...KABIR, avatar: "panda" });
      await b.deleteProfile(riya.id);
      expect((await b.profiles()).map(p => p.id)).toEqual([kabir.id]);
    });

    it("keeps each child's plays apart", async () => {
      const b = await newFamily();
      await b.giveConsent("2026-10-25");
      const riya = await b.createProfile(RIYA);
      const kabir = await b.createProfile(KABIR);
      const attempt = crypto.randomUUID();
      await b.startAttempt(riya.id, { id: attempt, topicId: COUNTING.topic.id, attemptNo: 1, practice: false, startedAt: "2026-10-25T10:00:00.000Z" });
      await b.recordResponse({ attemptId: attempt, seq: 1, questionId: Q1.id, level: Q1.level, subSkill: Q1.subSkill, firstTryCorrect: true, retryCorrect: null, marksDelta: 1 });
      await b.recordResponse({ attemptId: attempt, seq: 2, questionId: Q2.id, level: Q2.level, subSkill: Q2.subSkill, firstTryCorrect: false, retryCorrect: true, marksDelta: -1 });
      await b.finishAttempt(attempt, { marks: 50, cleared: true, stars: 1, passMarks: 44, maxMarks: 68, correct: 17 });
      await b.saveTopicProgress(riya.id, [{ topicId: COUNTING.topic.id, state: "cleared", attempts: 1, bestMarks: 50 }]);
      await b.saveTopicProgress(riya.id, [{ topicId: COUNTING.topic.id, state: "cleared", attempts: 2, bestMarks: 55 }]);

      const data = await b.profileData(riya.id);
      expect(data.attempts).toEqual([{
        id: attempt, topicId: COUNTING.topic.id, attemptNo: 1, practice: false, startedAt: expect.any(String),
        finishedAt: expect.any(String), marks: 50, cleared: true, stars: 1,
      }]);
      expect(new Date(data.attempts[0].startedAt).toISOString()).toBe("2026-10-25T10:00:00.000Z");
      expect([...data.responses].sort((x, y) => x.seq - y.seq)).toEqual([
        { attemptId: attempt, seq: 1, questionId: Q1.id, level: Q1.level, subSkill: Q1.subSkill, firstTryCorrect: true, retryCorrect: null, marksDelta: 1 },
        { attemptId: attempt, seq: 2, questionId: Q2.id, level: Q2.level, subSkill: Q2.subSkill, firstTryCorrect: false, retryCorrect: true, marksDelta: -1 },
      ]);
      expect(data.topics).toEqual([{ topicId: COUNTING.topic.id, state: "cleared", attempts: 2, bestMarks: 55 }]);
      expect(await b.profileData(kabir.id)).toEqual({ attempts: [], responses: [], topics: [] });
    });

    it("refuses the same play number twice", async () => {
      const b = await newFamily();
      await b.giveConsent("2026-10-25");
      const riya = await b.createProfile(RIYA);
      const play = { topicId: COUNTING.topic.id, attemptNo: 1, practice: false, startedAt: new Date().toISOString() };
      await b.startAttempt(riya.id, { id: crypto.randomUUID(), ...play });
      await expect(b.startAttempt(riya.id, { id: crypto.randomUUID(), ...play })).rejects.toThrow();
    });

    it("deletes the whole account when the parent withdraws consent, and leaves other families alone", async () => {
      const w = await newWorld();
      const b = await w.family();
      await b.giveConsent(V);
      await b.setPinHash(HASH);
      const riya = await b.createProfile(RIYA);
      await b.saveChildSettings(riya.id, { passPercent: 80, wrongPenalty: null, look: null, voice: null });
      const other = await w.family();
      await other.giveConsent(V);
      const kabir = await other.createProfile(KABIR);
      await b.deleteAccount();
      expect(await b.account()).toBeNull();
      await expect(b.profiles()).resolves.toEqual([]);
      expect(await other.profiles()).toEqual([kabir]);
      await expect(other.profileData(riya.id)).rejects.toThrow();
    });

    it("never shows or changes another family's children", async () => {
      const a = await newFamily();
      await a.giveConsent("2026-10-25");
      const riya = await a.createProfile(RIYA);
      const b = await newFamily();
      await b.giveConsent("2026-10-25");
      expect(await b.profiles()).toEqual([]);
      await expect(b.profileData(riya.id)).rejects.toThrow("That profile isn't in this account.");
      await expect(b.updateProfile(riya.id, KABIR)).rejects.toThrow();
      await expect(b.deleteProfile(riya.id)).rejects.toThrow();
      await expect(b.startAttempt(riya.id, { id: crypto.randomUUID(), topicId: COUNTING.topic.id, attemptNo: 1, practice: false, startedAt: new Date().toISOString() })).rejects.toThrow();
      expect((await a.profiles()).map(p => p.nickname)).toEqual(["Riya"]);
    });
  });

  describe(`${name}: questions, settings and the admin panel`, () => {
    it("serves only approved questions", async () => {
      const b = await (await newWorld()).family();
      const served = await b.questions("ukg-addition-10");
      expect(served.length).toBeGreaterThanOrEqual(80);
      expect(served.every(q => q.topicId === "ukg-addition-10")).toBe(true);
      expect(sampleIds(served.map(q => q.id))).toEqual([]);
    });

    it("starts every class at a pass mark of 65% and 1 mark off", async () => {
      const b = await (await newWorld()).family();
      expect(await b.classSettings()).toEqual(CLASS_ORDER.map(id => defaultClassSettings(id)));
      expect(await b.levelBands()).toEqual(DEFAULT_BANDS);
    });

    it("keeps a parent's choice for one child, for all of that child's topics, inside what a quiz allows", async () => {
      const w = await newWorld();
      const b = await w.family();
      await b.giveConsent(V);
      const riya = await b.createProfile(RIYA);
      const kabir = await b.createProfile(KABIR);
      const none = { passPercent: null, wrongPenalty: null, look: null, voice: null };
      const choose = (c: Partial<ChildSettings>): ChildSettings => ({ ...none, ...c });
      expect(await b.childSettings(riya.id)).toEqual(none);
      await b.saveChildSettings(riya.id, choose({ passPercent: 80, wrongPenalty: 2 }));
      expect(await b.childSettings(riya.id)).toEqual(choose({ passPercent: 80, wrongPenalty: 2 }));
      expect(await b.childSettings(kabir.id)).toEqual(none);
      await expect(b.saveChildSettings(riya.id, choose({ passPercent: 101 }))).rejects.toThrow("1% to 100%");
      await expect(b.saveChildSettings(riya.id, choose({ passPercent: 0 }))).rejects.toThrow("1% to 100%");
      await expect(b.saveChildSettings(riya.id, choose({ wrongPenalty: 5 }))).rejects.toThrow("0 to 4");
      expect(await b.childSettings(riya.id)).toEqual(choose({ passPercent: 80, wrongPenalty: 2 }));
      // Easier than the default is fine too.
      await b.saveChildSettings(kabir.id, choose({ passPercent: 50, wrongPenalty: 0 }));
      expect(await b.childSettings(kabir.id)).toEqual(choose({ passPercent: 50, wrongPenalty: 0 }));
      // Editing the profile keeps the choice.
      await b.updateProfile(riya.id, { ...RIYA, nickname: "Riya S" });
      expect(await b.childSettings(riya.id)).toEqual(choose({ passPercent: 80, wrongPenalty: 2 }));
      const other = await w.family();
      await other.giveConsent(V);
      await expect(other.saveChildSettings(riya.id, choose({ passPercent: 90 }))).rejects.toThrow("isn't in this account");
      await expect(other.childSettings(riya.id)).rejects.toThrow("isn't in this account");
      await b.saveChildSettings(riya.id, none);
      expect(await b.childSettings(riya.id)).toEqual(none);
    });

    it("keeps a parent's choice of look and voice for each child, with the class deciding until then", async () => {
      const w = await newWorld();
      const b = await w.family();
      await b.giveConsent(V);
      const riya = await b.createProfile(RIYA);
      const kabir = await b.createProfile(KABIR);
      const quiz = { passPercent: 75, wrongPenalty: null, voice: null };
      await b.saveChildSettings(riya.id, { ...quiz, look: "focus" });
      expect(await b.childSettings(riya.id)).toEqual({ ...quiz, look: "focus" });
      expect((await b.childSettings(kabir.id)).look).toBeNull();
      await expect(b.saveChildSettings(kabir.id, { ...quiz, look: "neon" as Look })).rejects.toThrow("playful or clean");
      expect((await b.childSettings(kabir.id)).look).toBeNull();
      await b.saveChildSettings(riya.id, { ...quiz, look: null });
      expect(await b.childSettings(riya.id)).toEqual({ ...quiz, look: null });
      // The voice is kept with the child, so every device the family signs in on reads aloud, or doesn't.
      await b.saveChildSettings(kabir.id, { ...quiz, look: null, voice: false });
      expect(await b.childSettings(kabir.id)).toEqual({ ...quiz, look: null, voice: false });
      expect((await b.childSettings(riya.id)).voice).toBeNull();
      await expect(b.saveChildSettings(kabir.id, { ...quiz, look: null, voice: "loud" as unknown as boolean })).rejects.toThrow("on or off");
      expect((await b.childSettings(kabir.id)).voice).toBe(false);
    });

    it("lets only an admin see the review queue", async () => {
      const w = await newWorld();
      const b = await w.family();
      const admin = await w.admin();
      expect((await admin.account())?.isAdmin).toBe(true);
      await expect(b.reviewQueue()).rejects.toThrow(/only an admin/i);
      const queue = await admin.reviewQueue();
      expect(sampleIds(queue.map(e => e.question.id))).toEqual(sampleIds(DEMO_REVIEW_SAMPLES.map(q => q.id)));
      for (const e of queue) expect(e.report?.passed).toBe(false);
      await expect(b.reviewQuestion("demo-wrong-level", { decision: "approved" })).rejects.toThrow(/only an admin/i);
    });

    it("approves, rejects and fixes questions, and serves only the approved ones", async () => {
      const w = await newWorld();
      const admin = await w.admin();
      const b = await w.family();
      const served = async (topicId: string) => (await b.questions(topicId)).map(q => q.id);

      expect(await served("ukg-addition-10")).not.toContain("demo-wrong-level");
      await admin.reviewQuestion("demo-wrong-level", { decision: "approved", note: "Fine as a warm-up." });
      expect(await served("ukg-addition-10")).toContain("demo-wrong-level");

      await admin.reviewQuestion("demo-out-of-range", { decision: "rejected" });
      expect(await served("ukg-before-after")).not.toContain("demo-out-of-range");
      await expect(admin.reviewQuestion("demo-out-of-range", { decision: "approved" })).rejects.toThrow("already reviewed");

      const queue = await admin.reviewQueue();
      const wrong = queue.find(e => e.question.id === "demo-wrong-answer")!;
      const fixed = applyEdits(wrong.question, { ...editsOf(wrong.question), answers: "7" });
      const report = recheck(fixed, ALL_CONTENT.map(topicInfo));
      expect(report.passed).toBe(true);
      await admin.reviewQuestion(fixed.id, { decision: "fixed", question: fixed, report });
      expect((await b.questions("ukg-addition-10")).find(q => q.id === "demo-wrong-answer")).toMatchObject({ prompt: "What is 4 + 3?", answers: ["7"] });

      // A CSV question is fixed in its Drive file instead.
      const csv = queue.find(e => e.question.id === "demo-csv-no-working")!;
      await expect(admin.reviewQuestion(csv.question.id, { decision: "fixed", question: csv.question, report: csv.report! })).rejects.toThrow("Drive");
      // A fix can't turn a question into one the bank already has.
      const dup = queue.find(e => e.question.id === "demo-duplicate-options")!;
      const copy = applyEdits(dup.question, { ...editsOf(dup.question), prompt: "What comes just after 5?", options: "6 | 4 | 7" });
      await expect(admin.reviewQuestion(dup.question.id, { decision: "fixed", question: copy, report: recheck(copy, ALL_CONTENT.map(topicInfo)) }))
        .rejects.toThrow("already has this question");

      expect(sampleIds((await admin.reviewQueue()).map(e => e.question.id))).toEqual(["demo-csv-no-working", "demo-duplicate-options"]);
    });

    it("lets only an admin change a class's defaults and the level bands", async () => {
      const w = await newWorld();
      const admin = await w.admin();
      const b = await w.family();
      const harder = { classId: "UKG", passPercent: 75, wrongPenalty: 2 } as const;
      await expect(b.saveClassSettings(harder)).rejects.toThrow(/only an admin/i);
      await expect(admin.saveClassSettings({ ...harder, passPercent: 101 })).rejects.toThrow("1% to 100%");
      await admin.saveClassSettings(harder);
      expect((await b.classSettings()).find(c => c.classId === "UKG")).toEqual(harder);
      expect((await b.classSettings()).find(c => c.classId === "C1")).toEqual(defaultClassSettings("C1"));

      await expect(b.saveLevelBands({ l1: 80, l2: 60, l3: 45 })).rejects.toThrow(/only an admin/i);
      await expect(admin.saveLevelBands({ l1: 60, l2: 80, l3: 45 })).rejects.toThrow();
      await admin.saveLevelBands({ l1: 80, l2: 60, l3: 45 });
      expect(await b.levelBands()).toEqual([
        { level: 1, minRate: 0.8, maxRate: 1 }, { level: 2, minRate: 0.6, maxRate: 0.8 },
        { level: 3, minRate: 0.45, maxRate: 0.6 }, { level: 4, minRate: 0, maxRate: 0.45 },
      ]);
    });

    it("makes new questions when asked, for the asking family's own child, and logs it for the admin", async () => {
      const w = await newWorld();
      const b = await w.family();
      await b.giveConsent(V);
      const riya = await b.createProfile(RIYA);
      const topicId = "ukg-comparing";
      const before = (await b.questions(topicId)).length;
      const r = await b.newQuestions(topicId, riya.id);
      expect(r).toMatchObject({ topicId, asked: 80 });
      expect(r.added).toBeGreaterThan(0);
      expect((await b.questions(topicId)).length).toBe(before + r.added);
      await expect(b.newQuestions("ukg-nothing", riya.id)).rejects.toThrow("no question templates");

      const other = await w.family();
      await other.giveConsent(V);
      await expect(other.newQuestions(topicId, riya.id)).rejects.toThrow("That profile isn't in this account.");

      const admin = await w.admin();
      expect((await admin.questionRequests(5))[0]).toMatchObject({ topicId, by: "child", added: r.added, sentToReview: r.sentToReview });
      await expect(b.questionRequests()).rejects.toThrow(/only an admin/i);
    });
  });
}
