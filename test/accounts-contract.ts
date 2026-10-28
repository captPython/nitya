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
import { checkUpload, parseTemplate, templateTopic, TEMPLATE_COLUMNS, type UploadRow } from "../src/supply/template";
import { DEFAULT_FLAG_SETTINGS, type FlagRequest } from "../src/flags/rules";
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
  /** Moves this Nitya's clock forward, for the flag rules' weeks and days. */
  travel(days: number): Promise<void>;
}

const V = "2026-10-25";

/** Rows of an uploaded template, read and checked as the app does before it sends them. */
const TOPICS = ALL_CONTENT.map(templateTopic);
const ADDING = "ukg-addition-10";
const row = (question: string, choices: string[], answer: string, sum = "", topic = "Adding with objects up to 10") =>
  ["UKG", topic, "1 Easy", question, ...choices, ...Array(4 - choices.length).fill(""), answer, "Count on from the first number.", `So the answer is ${answer}.`, "", "", "", sum];
function upload(...lines: string[][]): UploadRow[] {
  const sheet = [{ row: 1, cells: TEMPLATE_COLUMNS.map(c => c.header) }, ...lines.map((cells, i) => ({ row: i + 2, cells }))];
  return checkUpload(parseTemplate(sheet, { fileName: "mine.xlsx", topics: TOPICS }), TOPICS).rows;
}
const GOOD = row("Mia has 2 apples and gets 3 more. How many apples now?", ["4", "5", "6"], "5", "2 + 3");
const NO_SUM = row("Ravi has 4 kites and gets 1 more. How many kites now?", ["4", "5", "6"], "5");
const WRONG_SUM = row("Asha has 3 pens and gets 3 more. How many pens now?", ["5", "6", "7"], "7", "3 + 3");
const promptOf = (line: string[]) => line[3];
/** The flag tests' questions, each test with its own: on a shared database, one test's decisions mustn't reach another's. */
const TAKING = UKG_TOPICS.find(t => t.topic.id === "ukg-subtraction-10")!;
const SUB = (n: number) => TAKING.bank[n].id;
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
      await b.saveChildSettings(riya.id, { passPercent: 80, wrongPenalty: null, look: null, voice: null, community: null });
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
      const none = { passPercent: null, wrongPenalty: null, look: null, voice: null, community: null };
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
      const quiz = { passPercent: 75, wrongPenalty: null, voice: null, community: null };
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

  });

  describe(`${name}: a family's own questions and the community bank`, () => {
    const fromUpload = (q: object) => (q as { source?: string }).source === "upload";
    const served = async (b: AccountBackend, community = false) => (await b.questions(ADDING, { community })).filter(fromUpload);

    it("gives a family's passing questions to their own children at once, first, and keeps the rest for their review", async () => {
      const w = await newWorld();
      const b = await w.family();
      await expect(b.saveUpload({ fileName: "mine.xlsx", private: false, rows: upload(GOOD) })).rejects.toThrow(/consent/i);
      await b.giveConsent(V);
      const official = (await b.questions(ADDING))[0];
      const copy = row(official.prompt, official.options!, official.answers[0]);
      const r = await b.saveUpload({ fileName: "mine.xlsx", private: false, rows: upload(GOOD, NO_SUM, WRONG_SUM, GOOD, ...(official.visual ? [] : [copy])) });
      expect(r).toMatchObject({ ready: 2, inReview: 1, shared: 1, alreadyAdded: 1, inNitya: official.visual ? 0 : 1, refused: 0 });
      expect(r.uploadId).toBeTruthy();

      const mine = await served(b);
      expect(mine.map(q => q.prompt).sort()).toEqual([promptOf(GOOD), promptOf(NO_SUM)].sort());
      expect(mine.every(q => q.family)).toBe(true);
      expect((await b.questions(ADDING)).filter(q => !q.family).some(fromUpload)).toBe(false);

      const own = await b.ownQuestions();
      expect(own.map(q => [q.question.prompt, q.status, q.shared])).toEqual([
        [promptOf(GOOD), "ready", true], [promptOf(NO_SUM), "ready", false], [promptOf(WRONG_SUM), "review", false],
      ]);
      expect(own[2].problems[0]).toBe('The right answer says 7, but the sum "3 + 3" gives 6.');
      expect(await b.questionUploads()).toEqual([expect.objectContaining({ id: r.uploadId, fileName: "mine.xlsx", private: false, ready: 2, inReview: 1, shared: 1 })]);

      // Another family gets none of it, until a child of theirs has the community bank on; then only the shared one.
      const other = await w.family();
      await other.giveConsent(V);
      expect(await served(other)).toEqual([]);
      expect((await served(other, true)).map(q => q.prompt)).toEqual([promptOf(GOOD)]);
      expect((await served(other, true))[0].family).toBeFalsy();
      expect(await other.ownQuestions()).toEqual([]);
      // The family's review isn't the admin's.
      const admin = await w.admin();
      expect((await admin.reviewQueue()).some(e => e.question.source === "upload")).toBe(false);
    });

    it("checks every question again where the family can't change the outcome", async () => {
      const w = await newWorld();
      const b = await w.family();
      await b.giveConsent(V);
      const [good, wrong] = upload(GOOD, WRONG_SUM);
      // The app's own verdicts claim both are fine; the answer of one is changed after its check.
      const tampered = { ...wrong, status: "ready" as const, problems: [], passedAll: true };
      const linked = { ...good, question: { ...good.question, prompt: "See www.example.com. How many apples now?" } };
      const r = await b.saveUpload({ fileName: "mine.xlsx", private: false, rows: [tampered, linked, { row: 9, question: { prompt: "?" } } as unknown as UploadRow] });
      expect(r).toMatchObject({ ready: 0, inReview: 1, shared: 0, refused: 2 });
      expect((await b.ownQuestions())[0]).toMatchObject({ status: "review", shared: false });
    });

    it("lets the family approve, fix or delete a question under review", async () => {
      const w = await newWorld();
      const b = await w.family();
      await b.giveConsent(V);
      const other = await w.family();
      await other.giveConsent(V);
      const sixes = row("Om has 3 cars and gets 3 more. How many cars now?", ["5", "6", "7"], "7", "3 + 3");
      await b.saveUpload({ fileName: "mine.xlsx", private: false, rows: upload(WRONG_SUM, sixes) });
      const [first, second] = await b.ownQuestions();
      await expect(other.reviewOwnQuestion(first.question.id, { decision: "approve" })).rejects.toThrow("isn't in this account");

      // Approved as it is: for the family's own children, never shared.
      expect(await b.reviewOwnQuestion(first.question.id, { decision: "approve" })).toBeNull();
      expect((await b.ownQuestions())[0]).toMatchObject({ status: "ready", shared: false });
      expect((await served(b)).map(q => q.prompt)).toEqual([promptOf(WRONG_SUM)]);
      await expect(b.reviewOwnQuestion(first.question.id, { decision: "approve" })).rejects.toThrow("already reviewed");

      // Fixed: checked again, and shared once it passes everything.
      const fixed = { ...second.question, answers: ["6"], explanation: "3 and 3 more makes 6.", reason: "3 and 3 more makes 6." };
      const verdict = await b.reviewOwnQuestion(second.question.id, { decision: "fix", question: fixed });
      expect(verdict).toMatchObject({ status: "ready", passedAll: true, problems: [] });
      expect((await b.ownQuestions())[1]).toMatchObject({ status: "ready", shared: true });
      expect((await served(other, true)).map(q => q.answers)).toEqual([["6"]]);

      await b.reviewOwnQuestion(second.question.id, { decision: "delete" });
      expect((await b.ownQuestions()).map(q => q.question.id)).toEqual([first.question.id]);
      expect(await served(other, true)).toEqual([]);
    });

    it("keeps a private upload out of the community bank, and takes an upload away", async () => {
      const w = await newWorld();
      const b = await w.family();
      await b.giveConsent(V);
      const other = await w.family();
      await other.giveConsent(V);
      const r = await b.saveUpload({ fileName: "ours.csv", private: true, rows: upload(GOOD) });
      expect(r).toMatchObject({ ready: 1, shared: 0 });
      expect(await served(other, true)).toEqual([]);
      expect((await served(b)).length).toBe(1);
      // The same file again adds nothing.
      expect(await b.saveUpload({ fileName: "ours.csv", private: true, rows: upload(GOOD) })).toMatchObject({ uploadId: null, alreadyAdded: 1 });
      await expect(other.removeUpload(r.uploadId!)).rejects.toThrow("isn't in this account");
      await b.removeUpload(r.uploadId!);
      expect(await served(b)).toEqual([]);
      expect(await b.questionUploads()).toEqual([]);
      expect(await b.ownQuestions()).toEqual([]);
    });

    it("takes a community question out of quizzes once two families flag it, until an admin keeps it or takes it out", async () => {
      const w = await newWorld();
      const owner = await w.family();
      await owner.giveConsent(V);
      const [f1, f2, f3] = [await w.family(), await w.family(), await w.family()];
      const admin = await w.admin();
      await owner.saveUpload({ fileName: "mine.xlsx", private: false, rows: upload(GOOD) });
      const [shared] = await served(f1, true);
      expect(await f1.flagQuestion({ questionId: shared.id, boxes: ["question"], note: "The apples are too hard" })).toBe("watching");
      expect(await served(f1, true)).toEqual([]);
      expect((await served(f3, true)).length).toBe(1);
      // A second family is enough for a community question, which only Nitya's checker has looked at.
      expect(await f2.flagQuestion({ questionId: shared.id, boxes: ["question"] })).toBe("review");
      expect(await served(f3, true)).toEqual([]);
      expect((await served(owner)).length).toBe(1);
      expect(await admin.flagQueue()).toEqual([expect.objectContaining({
        question: expect.objectContaining({ id: shared.id }), community: true, hiddenForAll: true, boxes: { question: 2 }, notes: ["The apples are too hard"],
      })]);
      await expect(admin.decideFlags(shared.id, { kind: "level", level: 2 })).rejects.toThrow("can only be kept or taken out");

      await admin.decideFlags(shared.id, { kind: "keep" });
      expect((await served(f1, true)).length).toBe(1);
      expect(await admin.flagQueue()).toEqual([]);

      // One flag per family for each version of a question: Keep leaves it as it was.
      await expect(f1.flagQuestion({ questionId: shared.id, boxes: ["safety"] })).rejects.toThrow("kept it as it is");
      expect(await f3.flagQuestion({ questionId: shared.id, boxes: ["safety"] })).toBe("review");
      await admin.decideFlags(shared.id, { kind: "remove" });
      expect(await served(f3, true)).toEqual([]);
      expect((await served(owner)).length).toBe(1);
      expect((await owner.ownQuestions())[0].shared).toBe(false);
      await expect(admin.decideFlags(shared.id, { kind: "keep" })).rejects.toThrow("isn't waiting for review");
    });

    it("sends a family's own question to its own Review when the family flags it", async () => {
      const w = await newWorld();
      const b = await w.family();
      await b.giveConsent(V);
      await b.saveUpload({ fileName: "mine.xlsx", private: false, rows: upload(GOOD) });
      const [mine] = await served(b);
      expect(await b.flagQuestion({ questionId: mine.id, boxes: ["options"], note: "Two answers fit" })).toBe("own-review");
      expect(await served(b)).toEqual([]);
      expect(await b.ownQuestions()).toEqual([expect.objectContaining({
        status: "review", shared: false, problems: [expect.stringContaining('You flagged it: Wrong options ("Two answers fit").')],
      })]);
      const admin = await w.admin();
      expect(await admin.flagQueue()).toEqual([]);
    });

    it("keeps the community bank switch for each child, off until a parent turns it on", async () => {
      const w = await newWorld();
      const b = await w.family();
      await b.giveConsent(V);
      const riya = await b.createProfile(RIYA);
      const kabir = await b.createProfile(KABIR);
      expect((await b.childSettings(riya.id)).community).toBeNull();
      const now = await b.childSettings(riya.id);
      await b.saveChildSettings(riya.id, { ...now, community: true });
      expect((await b.childSettings(riya.id)).community).toBe(true);
      expect((await b.childSettings(kabir.id)).community).toBeNull();
      await b.saveChildSettings(riya.id, { ...now, community: null });
      expect((await b.childSettings(riya.id)).community).toBeNull();
    });
  });

  describe(`${name}: New questions`, () => {
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

  describe(`${name}: question flags`, () => {
    const taking = async (b: AccountBackend, profileId?: string) => (await b.questions(TAKING.topic.id, profileId ? { profileId } : {})).map(q => q.id);
    const consenting = async (w: ContractWorld) => { const b = await w.family(); await b.giveConsent(V); return b; };
    const flag = (b: AccountBackend, n: number, boxes: FlagRequest["boxes"], more: Partial<FlagRequest> = {}) => b.flagQuestion({ questionId: SUB(n), boxes, ...more });

    it("hides a flagged question from the flagging family for a week, and starts the week again on another family's flag", async () => {
      const w = await newWorld();
      const a = await consenting(w);
      const riya = await a.createProfile(RIYA);
      const b = await consenting(w);
      await expect(flag(a, 0, [])).rejects.toThrow("Tick at least one box.");
      await expect(flag(a, 0, ["level"])).rejects.toThrow("too easy or too hard");
      await expect(flag(a, 0, ["question"], { note: "x".repeat(301) })).rejects.toThrow("300 characters");
      await expect(a.flagQuestion({ questionId: "no-such-question", boxes: ["question"] })).rejects.toThrow("isn't in Nitya's quizzes");
      await expect(b.flagQuestion({ questionId: SUB(0), profileId: riya.id, boxes: ["question"] })).rejects.toThrow("isn't in this account");

      expect(await flag(a, 0, ["explanation"], { profileId: riya.id, note: "The hint says add", answeredWrong: true, secondsAfterAnswer: 4 })).toBe("watching");
      expect(await taking(a)).not.toContain(SUB(0));
      expect(await taking(b)).toContain(SUB(0));
      expect(await a.myFlags()).toEqual([expect.objectContaining({ question: expect.objectContaining({ id: SUB(0) }), boxes: ["explanation"], state: "watching", until: expect.any(String) })]);
      expect(await b.myFlags()).toEqual([]);

      await w.travel(6);
      expect(await flag(b, 0, ["explanation"])).toBe("watching");
      await w.travel(2);
      expect(await taking(a)).not.toContain(SUB(0));
      await w.travel(6);
      expect(await taking(a)).toContain(SUB(0));
      expect(await taking(b)).toContain(SUB(0));
      expect((await a.myFlags())[0]).toMatchObject({ state: "back", until: null });
    });

    it("sends a question to review once three families flag it, and hides it for everyone only when it may teach something wrong", async () => {
      const w = await newWorld();
      const [f1, f2, f3, f4, f5] = [await consenting(w), await consenting(w), await consenting(w), await consenting(w), await consenting(w)];
      const admin = await w.admin();
      expect(await flag(f1, 1, ["level"], { levelDirection: "hard" })).toBe("watching");
      expect(await flag(f2, 1, ["level"], { levelDirection: "hard" })).toBe("watching");
      // The same family again is still one family.
      expect(await flag(f2, 1, ["level"], { levelDirection: "hard" })).toBe("watching");
      expect((await admin.flagQueue()).map(q => q.question.id)).not.toContain(SUB(1));
      expect(await flag(f3, 1, ["level"], { levelDirection: "hard" })).toBe("review");
      await expect(f1.flagQueue()).rejects.toThrow(/only an admin/i);
      expect((await admin.flagQueue()).find(q => q.question.id === SUB(1))).toMatchObject({
        community: false, hiddenForAll: false, boxes: { level: 3 }, levelDirections: { easy: 0, hard: 3 }, answerCheck: "agrees",
      });
      expect((await f1.myFlags())[0].state).toBe("review");
      // A level flag leaves it in quizzes; a wrong options flag takes it out for everyone until the admin decides.
      expect(await taking(f5)).toContain(SUB(1));
      expect(await flag(f4, 1, ["options"])).toBe("review");
      expect(await taking(f5)).not.toContain(SUB(1));
      expect((await admin.flagQueue()).find(q => q.question.id === SUB(1))).toMatchObject({ hiddenForAll: true, boxes: { level: 3, options: 1 } });

      await expect(admin.decideFlags(SUB(1), { kind: "level", level: 5 as never })).rejects.toThrow("level from 1 to 4");
      await admin.decideFlags(SUB(1), { kind: "level", level: 2 });
      const back = (await f5.questions(TAKING.topic.id)).find(q => q.id === SUB(1));
      expect(back?.level).toBe(2);
      expect(await taking(f1)).toContain(SUB(1));
      expect((await f1.myFlags())[0].state).toBe("upheld");
      expect((await admin.flagQueue()).map(q => q.question.id)).not.toContain(SUB(1));
    });

    it("sends a question to review at once for Not right for a child, hidden for everyone, and Keep brings it back", async () => {
      const w = await newWorld();
      const [f1, f2] = [await consenting(w), await consenting(w)];
      const admin = await w.admin();
      expect(await flag(f1, 2, ["safety"], { note: "Scary picture" })).toBe("review");
      expect(await taking(f2)).not.toContain(SUB(2));
      expect((await admin.flagQueue()).find(q => q.question.id === SUB(2))).toMatchObject({ hiddenForAll: true, boxes: { safety: 1 }, notes: ["Scary picture"] });
      await admin.decideFlags(SUB(2), { kind: "keep" });
      expect(await taking(f2)).toContain(SUB(2));
      expect(await taking(f1)).toContain(SUB(2));
      expect((await f1.myFlags())[0].state).toBe("dismissed");
      await expect(admin.decideFlags(SUB(2), { kind: "keep" })).rejects.toThrow("isn't waiting for review");
    });

    it("fixes a flagged question, then finds the questions from its template to send to review", async () => {
      const w = await newWorld();
      const [f1, f2] = [await consenting(w), await consenting(w)];
      const admin = await w.admin();
      await flag(f1, 3, ["safety"]);
      const entry = (await admin.flagQueue()).find(q => q.question.id === SUB(3))!;
      const siblings = await admin.templateSiblings(SUB(3));
      await expect(f1.templateSiblings(SUB(3))).rejects.toThrow(/only an admin/i);
      expect(siblings.length).toBeGreaterThan(5);
      expect(siblings.every(q => q.id !== SUB(3) && q.subSkill === entry.question.subSkill && q.level === entry.question.level)).toBe(true);

      const fixed = applyEdits(entry.question, { ...editsOf(entry.question), explanation: "Count what is left after taking away." });
      await admin.decideFlags(SUB(3), { kind: "fix", question: fixed, report: recheck(fixed, ALL_CONTENT.map(topicInfo)) });
      expect((await f2.questions(TAKING.topic.id)).find(q => q.id === SUB(3))?.explanation).toBe("Count what is left after taking away.");
      expect((await f1.myFlags())[0].state).toBe("upheld");

      const sibling = siblings.find(q => q.id === SUB(4))!;
      await admin.sendToReview([{ questionId: sibling.id, report: recheck(sibling, ALL_CONTENT.map(topicInfo)) }]);
      expect(await taking(f2)).not.toContain(SUB(4));
      expect((await admin.reviewQueue()).map(e => e.question.id)).toContain(SUB(4));
      await admin.reviewQuestion(SUB(4), { decision: "approved" });
      expect(await taking(f2)).toContain(SUB(4));
    });

    it("removes a flagged question from every quiz", async () => {
      const w = await newWorld();
      const [f1, f2] = [await consenting(w), await consenting(w)];
      const admin = await w.admin();
      await flag(f1, 5, ["options"], { note: "Two right answers" });
      await flag(f2, 5, ["options"]);
      await flag(await consenting(w), 5, ["question"]);
      await admin.decideFlags(SUB(5), { kind: "remove" });
      expect(await taking(f2)).not.toContain(SUB(5));
      expect(await taking(await consenting(w))).not.toContain(SUB(5));
      expect((await f1.myFlags())[0].state).toBe("upheld");
    });

    it("hides a young child's Something's wrong? tap from that child until a parent checks it", async () => {
      const w = await newWorld();
      const b = await consenting(w);
      const riya = await b.createProfile(RIYA);
      const kabir = await b.createProfile(KABIR);
      const other = await consenting(w);
      await b.suggestFlag(riya.id, SUB(6), true);
      await b.suggestFlag(riya.id, SUB(6), true);
      expect(await taking(b, riya.id)).not.toContain(SUB(6));
      expect(await taking(b, kabir.id)).toContain(SUB(6));
      expect(await b.flagChecks()).toEqual([{ profileId: riya.id, question: expect.objectContaining({ id: SUB(6) }), answeredWrong: true, suggestedAt: expect.any(String) }]);
      expect(await other.flagChecks()).toEqual([]);
      await expect(other.suggestFlag(riya.id, SUB(6), true)).rejects.toThrow("isn't in this account");
      await expect(b.suggestFlag(riya.id, "no-such-question", null)).rejects.toThrow("isn't in Nitya's quizzes");

      await b.dismissFlagCheck(riya.id, SUB(6));
      expect(await taking(b, riya.id)).toContain(SUB(6));
      expect(await b.flagChecks()).toEqual([]);

      // The parent agrees: their flag answers the tap, and hides the question for the whole family.
      await b.suggestFlag(riya.id, SUB(6), false);
      await flag(b, 6, ["question"], { profileId: riya.id, answeredWrong: false });
      expect(await b.flagChecks()).toEqual([]);
      expect(await taking(b, kabir.id)).not.toContain(SUB(6));
    });

    it("turns 10 flags in a week into one Flagger check, keeps those questions for everyone else, and mutes a family found not helpful", async () => {
      const w = await newWorld();
      const heavy = await consenting(w);
      await heavy.createProfile(RIYA);
      const [f2, f3, f4] = [await consenting(w), await consenting(w), await consenting(w)];
      const admin = await w.admin();
      for (let n = 10; n < 20; n++) await flag(heavy, n, ["question"], { note: n === 10 ? "All wrong" : null, answeredWrong: n % 2 === 0, secondsAfterAnswer: 2 });
      const [check, ...more] = await admin.flaggerChecks();
      expect(more).toEqual([]);
      expect(check).toMatchObject({
        code: expect.stringMatching(/^F-[A-Z2-9]{4}$/), classes: ["UKG"], flagsThisWeek: 10, flagsTotal: 10, upheld: 0, dismissed: 0,
        answeredWrong: 5, answered: 10, averageSeconds: 2, boxes: { question: 10 }, notes: ["All wrong"],
      });
      expect(check.accountAgeDays).toBe(0);
      expect(check.questions.map(q => q.id).sort()).toEqual(Array.from({ length: 10 }, (_, i) => SUB(10 + i)).sort());
      await expect(heavy.flaggerChecks()).rejects.toThrow(/only an admin/i);
      expect(await taking(f4)).toContain(SUB(10));
      expect((await taking(heavy)).filter(id => check.questions.some(q => q.id === id))).toEqual([]);

      // Waiting on the check, the heavy flagger's flags don't count.
      await flag(f2, 10, ["question"]);
      expect(await flag(f3, 10, ["question"])).toBe("watching");

      await expect(admin.revealFlagger(check.parentId, "why")).rejects.toThrow("Say in a sentence");
      await expect(heavy.revealFlagger(check.parentId, "Checking whether this was meant to harm")).rejects.toThrow(/only an admin/i);
      expect(await admin.revealFlagger(check.parentId, "Checking whether this was meant to harm")).toMatch(/@/);

      await admin.decideFlagger(check.parentId, "not-helpful");
      expect(await admin.flaggerChecks()).toEqual([]);
      expect(await taking(heavy)).toContain(SUB(11));
      expect((await heavy.myFlags()).filter(f => f.state === "dismissed").length).toBe(10);
      // Muted: its next flags hide questions for itself, but don't count.
      await flag(heavy, 20, ["question"]);
      await flag(f2, 20, ["question"]);
      expect(await flag(f3, 20, ["question"])).toBe("watching");
      expect(await flag(f4, 20, ["question"])).toBe("review");
    });

    it("sends every question of a helpful Flagger check to review, with numbers the admin sets", async () => {
      const w = await newWorld();
      const admin = await w.admin();
      const heavy = await consenting(w);
      expect(await admin.flagSettings()).toEqual(DEFAULT_FLAG_SETTINGS);
      await expect(heavy.flagSettings()).rejects.toThrow(/only an admin/i);
      await expect(admin.saveFlagSettings({ ...DEFAULT_FLAG_SETTINGS, burstFlags: 4 })).rejects.toThrow("from 5 to 50");
      await expect(heavy.saveFlagSettings({ ...DEFAULT_FLAG_SETTINGS, burstFlags: 5 })).rejects.toThrow(/only an admin/i);
      await admin.saveFlagSettings({ ...DEFAULT_FLAG_SETTINGS, burstFlags: 5 });
      expect((await admin.flagSettings()).burstFlags).toBe(5);

      for (let n = 21; n < 26; n++) await flag(heavy, n, ["explanation"]);
      const [check] = await admin.flaggerChecks();
      await admin.decideFlagger(check.parentId, "helpful");
      expect(await admin.flaggerChecks()).toEqual([]);
      const queue = (await admin.flagQueue()).filter(q => q.question.id.startsWith(TAKING.topic.id));
      expect(queue.map(q => q.question.id).sort()).toEqual([21, 22, 23, 24, 25].map(SUB).sort());
      expect(queue.every(q => !q.hiddenForAll && q.flaggers[0].trust === 1.1)).toBe(true);
      expect(await taking(await consenting(w))).toContain(SUB(21));
    });

    it("lets a family send a set number of flags a day", async () => {
      const w = await newWorld();
      const admin = await w.admin();
      await admin.saveFlagSettings({ ...DEFAULT_FLAG_SETTINGS, dailyCap: 5, burstFlags: 50 });
      const b = await consenting(w);
      for (let n = 30; n < 35; n++) await flag(b, n, ["level"], { levelDirection: "easy" });
      await expect(flag(b, 35, ["level"], { levelDirection: "easy" })).rejects.toThrow("up to 5 flags a day");
      await w.travel(1.1);
      expect(await flag(b, 35, ["level"], { levelDirection: "easy" })).toBe("watching");
    });

    it("counts what children answer as one more family: here 10 picking the same wrong choice", async () => {
      const w = await newWorld();
      const admin = await w.admin();
      await admin.saveFlagSettings({ ...DEFAULT_FLAG_SETTINGS, minAnswers: 10, reviewFamilies: 2 });
      const b = await consenting(w);
      const riya = await b.createProfile(RIYA);
      const q = TAKING.bank[40];
      const wrong = q.options!.find(o => !q.answers.includes(o))!;
      for (let i = 1; i <= 10; i++) {
        const attemptId = crypto.randomUUID();
        await b.startAttempt(riya.id, { id: attemptId, topicId: TAKING.topic.id, attemptNo: i, practice: true, startedAt: new Date().toISOString() });
        await b.recordResponse({ attemptId, seq: 1, questionId: q.id, level: q.level, subSkill: q.subSkill, firstTryCorrect: false, retryCorrect: true, marksDelta: 0, firstAnswer: wrong });
      }
      expect((await admin.flagQueue()).map(x => x.question.id)).not.toContain(q.id);
      expect(await flag(await consenting(w), 40, ["options"])).toBe("review");
      const entry = (await admin.flagQueue()).find(x => x.question.id === q.id)!;
      expect(entry).toMatchObject({ hiddenForAll: true, boxes: { options: 2, level: 1 }, levelDirections: { easy: 0, hard: 1 } });
      expect(entry.signals).toEqual(expect.arrayContaining([`100% of children picked ${wrong} first.`, expect.stringContaining("0% of children got it right first time")]));
      expect(entry.stats).toMatchObject({ shown: 10, firstTryRight: 0, retries: 10, retryRight: 10 });
    });

    it("keeps a family's flags counting after the family deletes its account", async () => {
      const w = await newWorld();
      const [f1, f2, f3] = [await consenting(w), await consenting(w), await consenting(w)];
      await flag(f1, 45, ["question"]);
      await flag(f2, 45, ["question"]);
      await f1.deleteAccount();
      expect(await flag(f3, 45, ["question"])).toBe("review");
    });
  });
}
