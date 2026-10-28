import { describe, expect, it } from "vitest";
import {
  answerCheckOf, childFlagsDirectly, cleanFlag, countAnswer, DEFAULT_FLAG_SETTINGS, emptyFlagBook, FlagBook, flaggerCode,
  flagSettingsProblems, flagWeight, NEW_STATS, NEW_TRUST, queueRank, silentSignals, templateKey, trustOf, type FlagTarget,
} from "../src/flags/rules";
import type { CheckReport } from "../src/validation";

const NOW = new Date("2026-10-28T10:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 864e5);
const OFFICIAL: FlagTarget = { community: false, answerCheckDisagrees: false };

describe("a family's flag, cleaned up", () => {
  it("needs a box, a direction with Wrong level, and a short note", () => {
    expect(cleanFlag({ questionId: "q", boxes: [] })).toBe("Tick at least one box.");
    expect(cleanFlag({ questionId: "q", boxes: ["level"] })).toBe("Say whether it is too easy or too hard.");
    expect(cleanFlag({ questionId: "q", boxes: ["question"], note: "x".repeat(301) })).toBe("Keep the note to 300 characters.");
    expect(cleanFlag({ questionId: "q", boxes: ["level", "nonsense" as never, "question"], levelDirection: "hard", note: "  " }))
      .toEqual({ boxes: ["question", "level"], levelDirection: "hard", note: null });
    // A direction without Wrong level is dropped.
    expect(cleanFlag({ questionId: "q", boxes: ["options"], levelDirection: "easy", note: " Two fit " }))
      .toEqual({ boxes: ["options"], levelDirection: null, note: "Two fit" });
  });

  it("lets children from Class 6 tick the boxes themselves", () => {
    expect(childFlagsDirectly("UKG")).toBe(false);
    expect(childFlagsDirectly("C5")).toBe(false);
    expect(childFlagsDirectly("C6")).toBe(true);
    expect(childFlagsDirectly("C12")).toBe(true);
  });

  it("gives each family the same code every time, which says nothing about it", () => {
    const code = flaggerCode("4b1c9a3e-0000-4000-8000-000000000001");
    expect(code).toMatch(/^F-[A-Z2-9]{4}$/);
    expect(flaggerCode("4b1c9a3e-0000-4000-8000-000000000001")).toBe(code);
    expect(flaggerCode("4b1c9a3e-0000-4000-8000-000000000002")).not.toBe(code);
  });
});

describe("trust", () => {
  it("starts at 1, gains 0.1 per upheld flag or helpful check, loses 0.25 per dismissed flag, and stays within 0 to 2", () => {
    expect(trustOf(NEW_TRUST)).toBe(1);
    expect(trustOf({ ...NEW_TRUST, upheld: 2, helpful: 1 })).toBe(1.3);
    expect(trustOf({ ...NEW_TRUST, upheld: 1, dismissed: 2 })).toBe(0.6);
    expect(trustOf({ ...NEW_TRUST, upheld: 40 })).toBe(2);
    expect(trustOf({ ...NEW_TRUST, dismissed: 9 })).toBe(0);
  });

  it("stops a family's flags counting while it is muted, or once it is mostly wrong over enough flags", () => {
    const s = DEFAULT_FLAG_SETTINGS;
    expect(flagWeight({ ...NEW_TRUST, mutedUntil: days(1).toISOString() }, s, NOW)).toBe(0);
    expect(flagWeight({ ...NEW_TRUST, mutedUntil: days(-1).toISOString() }, s, NOW)).toBe(1);
    expect(flagWeight({ ...NEW_TRUST, upheld: 2, dismissed: 4 }, s, NOW)).toBe(0);
    expect(flagWeight({ ...NEW_TRUST, upheld: 3, dismissed: 3 }, s, NOW)).toBe(0.55);
    // Below the line, but too few decided flags to judge yet.
    expect(flagWeight({ ...NEW_TRUST, dismissed: 2 }, { ...s, muteBelow: 0.6 }, NOW)).toBe(0.5);
  });
});

describe("the admin's numbers", () => {
  it("keeps each in its range", () => {
    expect(flagSettingsProblems(DEFAULT_FLAG_SETTINGS)).toEqual([]);
    expect(flagSettingsProblems({ ...DEFAULT_FLAG_SETTINGS, watchDays: 0, muteBelow: 1.5, burstFlags: 7.5 })).toEqual([
      "Watch period after a flag, in days: use a whole number from 1 to 30.",
      "Questions that make a Flagger check: use a whole number from 5 to 50.",
      "Trust below which flags stop counting: use from 0 to 1.",
    ]);
  });
});

describe("template siblings", () => {
  const q = { topicId: "ukg-subtraction-10", subSkill: "take-away-objects", level: 1 as const };
  it("joins generated questions by template, and the built-in bank by skill and level too", () => {
    expect(templateKey({ ...q, source: "template", sourceRef: "ukg-subtraction-10 L1 template 3, seed 42" }))
      .toBe(templateKey({ ...q, source: "template", sourceRef: "ukg-subtraction-10 L1 template 3, seed 7" }));
    expect(templateKey({ ...q, source: "template", sourceRef: "ukg-subtraction-10 built-in bank, seed 1" }))
      .toBe("ukg-subtraction-10|ukg-subtraction-10 built-in bank|take-away-objects|1");
    expect(templateKey({ ...q, source: "upload", sourceRef: "mine.xlsx row 2" })).toBeNull();
    expect(templateKey({ ...q, source: "csv", sourceRef: "bank.csv" })).toBeNull();
  });
});

describe("silent flags from children's answers", () => {
  const q = { level: 1 as const, answers: ["3"] };
  const s = { ...DEFAULT_FLAG_SETTINGS, minAnswers: 10 };
  const answers = (n: number, a: { firstTryCorrect: boolean; retryCorrect: boolean | null; firstAnswer?: string }) =>
    Array.from({ length: n }).reduce<typeof NEW_STATS>(st => countAnswer(st, a), NEW_STATS);

  it("counts first tries, retries after the hint and each choice picked", () => {
    let st = countAnswer(NEW_STATS, { firstTryCorrect: true, retryCorrect: null, firstAnswer: "3" });
    st = countAnswer(st, { firstTryCorrect: false, retryCorrect: true, firstAnswer: "4" });
    st = countAnswer(st, { firstTryCorrect: false, retryCorrect: false, firstAnswer: "4" });
    expect(st).toEqual({ shown: 3, firstTryRight: 1, retries: 2, retryRight: 1, picks: { "3": 1, "4": 2 } });
  });

  it("says nothing before enough answers", () => {
    expect(silentSignals(q, answers(9, { firstTryCorrect: false, retryCorrect: true, firstAnswer: "4" }), s)).toEqual([]);
  });

  it("flags a level that the first tries don't fit, one wrong choice most children pick, and a hint that doesn't help", () => {
    const st = answers(10, { firstTryCorrect: false, retryCorrect: false, firstAnswer: "4" });
    expect(silentSignals(q, st, s)).toEqual([
      { box: "level", levelDirection: "hard", note: "0% of children got it right first time, which fits level 4." },
      { box: "options", levelDirection: null, note: "100% of children picked 4 first." },
      { box: "explanation", levelDirection: null, note: "Only 0% of children got it right after the hint." },
    ]);
    // Too easy for level 3.
    const easy = answers(10, { firstTryCorrect: true, retryCorrect: null, firstAnswer: "3" });
    expect(silentSignals({ level: 3, answers: ["3"] }, easy, s)).toEqual([
      { box: "level", levelDirection: "easy", note: "100% of children got it right first time, which fits level 1." },
    ]);
  });
});

describe("the flag book", () => {
  const book = () => new FlagBook(emptyFlagBook());

  it("sends a question flagged as wrong to review at once when Nitya's answer check also disagrees with it", () => {
    const b = book();
    expect(b.flag("p1", { questionId: "q", boxes: ["level"], levelDirection: "hard" }, { ...OFFICIAL, answerCheckDisagrees: true }, NOW)).toBe("watching");
    expect(b.flag("p2", { questionId: "q", boxes: ["options"] }, { ...OFFICIAL, answerCheckDisagrees: true }, NOW)).toBe("review");
    expect(b.hiddenForAll("q")).toBe(true);
  });

  it("forgets flags older than the memory window", () => {
    const b = book();
    b.flag("p1", { questionId: "q", boxes: ["question"] }, OFFICIAL, NOW);
    b.flag("p2", { questionId: "q", boxes: ["question"] }, OFFICIAL, days(2));
    expect(b.flag("p3", { questionId: "q", boxes: ["question"] }, OFFICIAL, days(91))).toBe("watching");
    expect(b.families("q", days(91))).toBe(2);
  });

  it("weighs each family by its trust", () => {
    const b = book();
    b.state.trust.p1 = { ...NEW_TRUST, upheld: 10 };
    b.flag("p1", { questionId: "q", boxes: ["explanation"] }, OFFICIAL, NOW);
    expect(b.families("q", NOW)).toBe(2);
    expect(b.flag("p2", { questionId: "q", boxes: ["explanation"] }, OFFICIAL, NOW)).toBe("review");
    expect(b.hiddenForAll("q")).toBe(false);
  });

  it("sends each question of a Flagger check to review when the admin wants to look at each", () => {
    const b = book();
    b.state.settings.burstFlags = 5;
    for (let i = 0; i < 5; i++) b.flag("p1", { questionId: `q${i}`, boxes: ["question"] }, OFFICIAL, NOW);
    expect(b.state.flags.every(f => f.burst)).toBe(true);
    expect(b.state.review).toEqual({});
    b.decideFlagger("p1", "each", () => OFFICIAL, NOW);
    expect(Object.keys(b.state.review).sort()).toEqual(["q0", "q1", "q2", "q3", "q4"]);
    expect(b.trust("p1")).toEqual(NEW_TRUST);
    expect(() => b.decideFlagger("p1", "each", () => OFFICIAL, NOW)).toThrow("no Flagger check waiting");
  });

  it("forgets a family that leaves, but its flag still counts as a family", () => {
    const b = book();
    b.flag("p1", { questionId: "q", boxes: ["question"] }, OFFICIAL, NOW);
    b.suggest("p1", "kid", "q2", true, NOW);
    b.forget("p1");
    expect(b.state.flags[0].parentId).toBeNull();
    expect(b.state.suggestions).toEqual([]);
    expect(b.families("q", NOW)).toBe(1);
  });
});

describe("the admin's queue", () => {
  it("puts child safety first, then a possibly wrong answer, then more families", () => {
    const order = [{ level: 3 }, { options: 1 }, { safety: 1 }, { options: 3 }, { explanation: 2 }]
      .sort((a, b) => queueRank(a) - queueRank(b));
    expect(order).toEqual([{ safety: 1 }, { options: 3 }, { options: 1 }, { explanation: 2 }, { level: 3 }]);
  });

  it("reads Nitya's answer check from the last report", () => {
    const report = (answer: CheckReport["answer"]) => ({ answer }) as CheckReport;
    expect(answerCheckOf(null)).toBe("agrees");
    expect(answerCheckOf(report({ passed: true, problems: [] }))).toBe("agrees");
    expect(answerCheckOf(report({ passed: false, problems: ["x"], wrongKeys: ["7"] }))).toBe("disagrees");
    expect(answerCheckOf(report({ passed: true, problems: [], unchecked: true }))).toBe("unchecked");
  });
});
