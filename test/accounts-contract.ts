import { describe, expect, it } from "vitest";
import { UKG_TOPICS } from "../src/content/ukg";
import type { AccountBackend } from "../src/accounts/backend";
import type { ProfileDetails } from "../src/accounts/options";

const RIYA: ProfileDetails = { nickname: "Riya", avatar: "owl", classId: "UKG", board: "CBSE", language: "en" };
const KABIR: ProfileDetails = { nickname: "Kabir", avatar: "tiger", classId: "UKG", board: "ICSE", language: "hi" };
const COUNTING = UKG_TOPICS[0];
const [Q1, Q2] = COUNTING.bank;
const HASH = "pbkdf2-sha256$100000$c2FsdA==$aGFzaA==";

/**
 * What every account backend must do, run against the demo backend and the
 * Supabase one alike. `newFamily` signs in a parent nobody has seen before.
 */
export function accountContract(name: string, newFamily: () => Promise<AccountBackend>) {
  describe(`${name}: an account`, () => {
    it("starts with no consent, no PIN and no profiles", async () => {
      const b = await newFamily();
      expect(await b.account()).toMatchObject({ consentVersion: null, pinHash: null });
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
}
