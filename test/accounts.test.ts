import { describe, expect, it } from "vitest";
import { CONSENT_VERSION } from "../src/accounts/consent";
import { DEMO_GOOGLE_EMAIL, localBackend, type KeyValue } from "../src/accounts/local-backend";
import { nicknameProblem, profileProblems } from "../src/accounts/options";
import { hashPin, pinProblem, verifyPin } from "../src/accounts/pin";
import { PLACEMENT_LENGTH, placementQuestions, placementSuggestion } from "../src/accounts/placement";
import { summarize, type ProfileData } from "../src/accounts/progress";
import { CLASSES_WITH_CONTENT } from "../src/content";
import { UKG_TOPICS } from "../src/content/ukg";
import { accountContract } from "./accounts-contract";

const memory = (): KeyValue & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
};

let n = 0;
// One browser's storage holds a world: each parent gets their own key, and they share the bank.
accountContract("the demo backend", async () => {
  const store = memory();
  const signIn = async () => {
    const b = localBackend(store, `family-${++n}`, "world-bank");
    await b.sendEmailLink(`parent${n}@example.com`);
    await b.openDemoLink!();
    return b;
  };
  return {
    family: signIn,
    async admin() {
      const b = await signIn();
      await b.setDemoAdmin!(true);
      return b;
    },
  };
});

describe("the demo backend", () => {
  it("signs in with pretend Google, or with an emailed link once the parent opens it", async () => {
    const store = memory();
    const b = localBackend(store);
    expect(await b.account()).toBeNull();
    await b.signInWithGoogle();
    expect(await b.account()).toMatchObject({ email: DEMO_GOOGLE_EMAIL });
    await b.signOut();
    await b.sendEmailLink(" Asha@Example.com ");
    expect(await b.account()).toBeNull();
    await b.openDemoLink!();
    expect(await b.account()).toMatchObject({ email: "asha@example.com" });
  });

  it("shows each parent on a shared device only their own children, and keeps them after signing out", async () => {
    const store = memory();
    const b = localBackend(store);
    await b.signInWithGoogle();
    await b.giveConsent(CONSENT_VERSION);
    await b.createProfile({ nickname: "Riya", avatar: "owl", classId: "UKG", board: "CBSE", language: "en" });
    await b.signOut();
    await b.sendEmailLink("other@example.com");
    await b.openDemoLink!();
    expect(await b.profiles()).toEqual([]);
    await b.signOut();
    await b.signInWithGoogle();
    expect((await localBackend(store).profiles()).map(p => p.nickname)).toEqual(["Riya"]);
  });

  it("starts fresh if what's stored can't be read", async () => {
    const store = memory();
    store.setItem("nitya-demo-v1", "{not json");
    expect(await localBackend(store).account()).toBeNull();
  });
});

describe("onboarding choices", () => {
  it("accepts a nickname in any script, and nothing that looks like a full name, email or number", () => {
    expect(nicknameProblem("Riya")).toBeNull();
    expect(nicknameProblem("चिंटू")).toBeNull();
    expect(nicknameProblem("Anu-Mol")).toBeNull();
    expect(nicknameProblem("  ")).toBe("Type a nickname.");
    expect(nicknameProblem("riya@example.com")).toBe("Use letters only, like Riya or Chintu.");
    expect(nicknameProblem("Riya 98765")).toBe("Use letters only, like Riya or Chintu.");
    expect(nicknameProblem("Abcdefghijklmnopqrstu")).toBe("Keep the nickname to 20 letters or fewer.");
  });

  it("offers only classes that have content, which today is UKG", () => {
    expect(CLASSES_WITH_CONTENT).toEqual(["UKG"]);
    expect(profileProblems({ nickname: "Riya", avatar: "owl", classId: "C1", board: "CBSE", language: "en" }, CLASSES_WITH_CONTENT))
      .toEqual(["Pick a class: UKG."]);
    expect(profileProblems({ nickname: "Riya", avatar: "cat", classId: "UKG", board: "IB", language: "fr" }, CLASSES_WITH_CONTENT))
      .toEqual(["Pick an avatar.", "Pick a board.", "Pick a language."]);
  });
});

describe("the parent PIN", () => {
  it("is 4 digits that aren't all the same or in a row", () => {
    expect(pinProblem("4827")).toBeNull();
    expect(pinProblem("482")).toBe("The PIN is 4 digits.");
    expect(pinProblem("7777")).toBe("Pick digits that aren't all the same.");
    expect(pinProblem("1234")).toBe("Pick digits that aren't in a row.");
    expect(pinProblem("6543")).toBe("Pick digits that aren't in a row.");
  });

  it("is kept only as a salted hash that checks the right PIN", async () => {
    const a = await hashPin("4827"), b = await hashPin("4827");
    expect(a).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toContain("4827");
    expect(a).not.toBe(b);
    expect(await verifyPin("4827", a)).toBe(true);
    expect(await verifyPin("4828", a)).toBe(false);
    expect(await verifyPin("4827", "plain-4827")).toBe(false);
  });
});

describe("the placement check", () => {
  it("asks 10 questions from the picked class, easiest first, never the same maths twice", () => {
    const qs = placementQuestions("UKG", UKG_TOPICS, 1);
    expect(qs).toHaveLength(PLACEMENT_LENGTH);
    expect(qs.map(q => q.level)).toEqual([2, 2, 2, 2, 2, 3, 3, 3, 3, 3]);
    expect(new Set(qs.map(q => q.topicId)).size).toBe(5);
    expect(new Set(qs.map(q => q.variantGroup)).size).toBe(10);
    expect(placementQuestions("UKG", UKG_TOPICS, 1)).toEqual(qs);
  });

  it("suggests the next class, the one before, or the same, and only a class Nitya has", () => {
    const right = (n: number) => Array.from({ length: 10 }, (_, i) => i < n);
    expect(placementSuggestion("UKG", "Riya", right(6), ["UKG"])).toEqual({ suggested: "UKG", message: "UKG looks right for Riya." });
    expect(placementSuggestion("UKG", "Riya", right(10), ["UKG", "C1"]))
      .toEqual({ suggested: "C1", message: "Riya got almost everything right. Class 1 may suit Riya better." });
    expect(placementSuggestion("UKG", "Riya", right(10), ["UKG"]).suggested).toBe("UKG");
    expect(placementSuggestion("UKG", "Riya", right(2), ["LKG", "UKG"]))
      .toEqual({ suggested: "LKG", message: "Riya found these hard. LKG may be a gentler start." });
    expect(placementSuggestion("UKG", "Riya", right(2), ["UKG"]))
      .toEqual({ suggested: "UKG", message: "Riya found these hard. UKG quizzes start with easy questions, so this is a good place to begin." });
  });
});

describe("a child's progress", () => {
  const topics = UKG_TOPICS.map(t => t.topic);
  const [c1, c2, c3] = UKG_TOPICS[0].bank;

  it("starts a new class with the first topic open", () => {
    const s = summarize("UKG", topics, { attempts: [], responses: [], topics: [] });
    expect(Object.values(s.progress.topics).map(t => t.state)).toEqual(["current", "locked", "locked", "locked", "locked"]);
    expect(s).toMatchObject({ seen: {}, stars: {}, skills: {}, recentSkills: {}, levels: {}, promoted: false, plays: {} });
  });

  it("works out seen questions, stars, skills and plays from the saved plays", () => {
    const data: ProfileData = {
      attempts: [
        { id: "b", topicId: c1.topicId, attemptNo: 2, practice: false, startedAt: "2026-10-25T11:00:00Z", finishedAt: "x", marks: 60, cleared: true, stars: 2 },
        { id: "a", topicId: c1.topicId, attemptNo: 1, practice: false, startedAt: "2026-10-25T10:00:00Z", finishedAt: "x", marks: 30, cleared: false, stars: 0 },
      ],
      responses: [
        { attemptId: "b", seq: 1, questionId: c3.id, level: 1, subSkill: c3.subSkill, firstTryCorrect: true, retryCorrect: null, marksDelta: 1 },
        { attemptId: "a", seq: 2, questionId: c2.id, level: 1, subSkill: c2.subSkill, firstTryCorrect: true, retryCorrect: null, marksDelta: 1 },
        { attemptId: "a", seq: 1, questionId: c1.id, level: 1, subSkill: c1.subSkill, firstTryCorrect: false, retryCorrect: true, marksDelta: 0 },
        { attemptId: "b", seq: 2, questionId: c1.id, level: 1, subSkill: c1.subSkill, firstTryCorrect: true, retryCorrect: null, marksDelta: 1 },
        { attemptId: "gone", seq: 1, questionId: "x", level: 1, subSkill: "x", firstTryCorrect: true, retryCorrect: null, marksDelta: 1 },
      ],
      topics: [{ topicId: c1.topicId, state: "cleared", attempts: 2, bestMarks: 60 }, { topicId: UKG_TOPICS[1].topic.id, state: "current", attempts: 0, bestMarks: 0 }],
    };
    const s = summarize("UKG", topics, data);
    expect(s.seen[c1.topicId]).toEqual([c2.id, c3.id, c1.id]);
    expect(s.stars).toEqual({ [c1.topicId]: 2 });
    expect(s.plays).toEqual({ [c1.topicId]: 2 });
    expect(s.levels[1]).toEqual({ right: 3, total: 4 });
    expect(s.progress.topics[c1.topicId]).toEqual({ state: "cleared", attempts: 2, bestScore: 60 });
    expect(s.progress.topics[UKG_TOPICS[1].topic.id].state).toBe("current");
    expect(s.promoted).toBe(false);
  });

  it("judges improvement areas on recent plays, so a skill learned since stops showing", () => {
    const play = (id: string, hour: number, right: boolean[]) => ({
      attempt: { id, topicId: c1.topicId, attemptNo: hour, practice: false, startedAt: `2026-10-25T1${hour}:00:00Z`, finishedAt: "x", marks: 0, cleared: false, stars: 0 },
      responses: right.map((ok, i) => ({ attemptId: id, seq: i + 1, questionId: c1.id, level: 1 as const, subSkill: c1.subSkill, firstTryCorrect: ok, retryCorrect: null, marksDelta: 0 })),
    });
    const plays = [play("a", 1, [false, false, false]), play("b", 2, [false, true]), play("c", 3, [true, true, true])];
    const data = (state: "current" | "cleared"): ProfileData => ({
      attempts: plays.map(p => p.attempt), responses: plays.flatMap(p => p.responses),
      topics: [{ topicId: c1.topicId, state, attempts: 3, bestMarks: 50 }],
    });
    const key = `${c1.topicId}|${c1.subSkill}`;
    // Every answer still counts towards the all-time tally.
    expect(summarize("UKG", topics, data("current")).skills[key]).toEqual({ right: 4, total: 8 });
    // Not cleared yet: the last two plays.
    expect(summarize("UKG", topics, data("current")).recentSkills[key]).toEqual({ right: 4, total: 5 });
    // Cleared: only the last play.
    expect(summarize("UKG", topics, data("cleared")).recentSkills[key]).toEqual({ right: 3, total: 3 });
  });

  it("says the class is complete when every topic is cleared", () => {
    const s = summarize("UKG", topics, { attempts: [], responses: [], topics: topics.map(t => ({ topicId: t.id, state: "cleared" as const, attempts: 1, bestMarks: 50 })) });
    expect(s.promoted).toBe(true);
  });
});
