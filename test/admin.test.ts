import { describe, expect, it } from "vitest";
import { applyEdits, canFixHere, editsOf, recheck } from "../src/admin/review";
import {
  bandCutsProblem, bandsOf, childSettingsProblem, cutsOf, defaultTopicSettings, effectiveSettings, topicSettingsProblems,
} from "../src/admin/settings";
import { DEMO_REVIEW_SAMPLES } from "../src/accounts/demo-samples";
import { ALL_CONTENT } from "../src/content";
import { parseWorking, topicInfo, workingText } from "../src/supply";
import type { Working } from "../src/types";
import { DEFAULT_BANDS } from "../src/validation";

const T = defaultTopicSettings("ukg-counting-50");
const topics = ALL_CONTENT.map(topicInfo);

describe("topic settings", () => {
  it("start at 44 of 68 and 1 mark off, and parents can only make a topic harder", () => {
    expect(T).toEqual({ topicId: "ukg-counting-50", passMarks: 44, passMarksMin: 44, passMarksMax: 60, wrongPenalty: 1, wrongPenaltyMin: 1, wrongPenaltyMax: 2 });
    expect(topicSettingsProblems(T, 68)).toEqual([]);
  });

  it("use the parent's choice for that child, kept inside the admin's limits", () => {
    expect(effectiveSettings(T)).toEqual({ passMarks: 44, wrongPenalty: 1 });
    expect(effectiveSettings(T, { topicId: T.topicId, passMarks: 52, wrongPenalty: null })).toEqual({ passMarks: 52, wrongPenalty: 1 });
    // The admin narrowed the range after the parent chose 58.
    expect(effectiveSettings({ ...T, passMarksMax: 50 }, { topicId: T.topicId, passMarks: 58, wrongPenalty: 2 })).toEqual({ passMarks: 50, wrongPenalty: 2 });
  });

  it("refuse a parent's choice outside the limits", () => {
    expect(childSettingsProblem(T, { topicId: T.topicId, passMarks: 60, wrongPenalty: 2 })).toBeNull();
    expect(childSettingsProblem(T, { topicId: T.topicId, passMarks: 40, wrongPenalty: null })).toBe("The pass mark can be 44 to 60.");
    expect(childSettingsProblem(T, { topicId: T.topicId, passMarks: 50.5, wrongPenalty: null })).toBe("The pass mark can be 44 to 60.");
    expect(childSettingsProblem(T, { topicId: T.topicId, passMarks: null, wrongPenalty: 0 })).toBe("The penalty can be 1 to 2.");
  });

  it("catch an admin's settings that don't make sense", () => {
    expect(topicSettingsProblems({ ...T, passMarksMax: 70 }, 68)).toEqual(["The highest pass mark can't be more than 68, the most marks a quiz can give."]);
    expect(topicSettingsProblems({ ...T, passMarks: 62 }, 68)).toEqual(["The default pass mark must be inside the parents' range."]);
    expect(topicSettingsProblems({ ...T, passMarksMin: 61 }, 68)).toEqual(["The lowest pass mark is above the highest."]);
    expect(topicSettingsProblems({ ...T, wrongPenaltyMax: 5 }, 68)).toEqual(["The biggest penalty can't be more than 4."]);
    expect(topicSettingsProblems({ ...T, wrongPenalty: 3 }, 68)).toEqual(["The default penalty must be inside the parents' range."]);
    expect(topicSettingsProblems({ ...T, passMarks: 44.5 }, 68)).toEqual(["Use whole numbers."]);
  });
});

describe("level bands", () => {
  it("are three cut points, so they can't leave a gap or overlap", () => {
    expect(cutsOf(DEFAULT_BANDS)).toEqual({ l1: 85, l2: 65, l3: 50 });
    expect(bandsOf({ l1: 85, l2: 65, l3: 50 })).toEqual(DEFAULT_BANDS);
    expect(bandCutsProblem({ l1: 85, l2: 65, l3: 50 })).toBeNull();
    expect(bandCutsProblem({ l1: 65, l2: 85, l3: 50 })).toMatch("lower than the one before");
    expect(bandCutsProblem({ l1: 100, l2: 65, l3: 50 })).toMatch("lower than the one before");
    expect(bandCutsProblem({ l1: 85, l2: 65, l3: 0 })).toMatch("lower than the one before");
  });
});

describe("the review queue's fix form", () => {
  it("reads back every built-in question unchanged", () => {
    for (const q of ALL_CONTENT.flatMap(c => c.bank)) {
      expect(applyEdits({ ...q, source: "template" }, editsOf({ ...q, source: "template" }))).toEqual({ ...q, source: "template" });
    }
  });

  it("writes a plain sum's working as the sum, and anything else as JSON", () => {
    expect(workingText({ kind: "arith", expr: { op: "-", args: [9, 2, 3] } })).toBe("9 - 2 - 3");
    expect(workingText({ kind: "count-dots" })).toBe("count dots");
    const missing: Working = { kind: "missing", lhs: { op: "+", args: [3, "x"] }, rhs: 7 };
    expect(parseWorking(workingText(missing))).toEqual(missing);
  });

  it("fixes a planted mistake so it passes every check", () => {
    const q = DEMO_REVIEW_SAMPLES.find(s => s.id === "demo-duplicate-options")!;
    expect(recheck(q, topics).passed).toBe(false);
    const fixed = applyEdits(q, { ...editsOf(q), options: "6 | 4 | 7" });
    expect(fixed).toMatchObject({ id: q.id, topicId: q.topicId, options: ["6", "4", "7"] });
    expect(recheck(fixed, topics).passed).toBe(true);
  });

  it("says plainly when a field can't be read", () => {
    const q = DEMO_REVIEW_SAMPLES[0];
    expect(() => applyEdits(q, { ...editsOf(q), level: "5" })).toThrow("The level must be 1, 2, 3 or 4.");
    expect(() => applyEdits(q, { ...editsOf(q), answers: " | " })).toThrow("Give the right answer.");
    expect(() => applyEdits(q, { ...editsOf(q), picture: "three dots" })).toThrow("Can't read the picture");
    expect(() => applyEdits(q, { ...editsOf(q), working: "4 plus 3" })).toThrow("Can't read the working");
  });

  it("sends CSV questions back to their Drive file to be fixed", () => {
    expect(DEMO_REVIEW_SAMPLES.filter(q => !canFixHere(q)).map(q => q.id)).toEqual(["demo-csv-no-working"]);
  });
});

describe("the demo's planted mistakes", () => {
  it("each fail a check, so the review queue always has them", () => {
    for (const q of DEMO_REVIEW_SAMPLES) expect(recheck(q, topics).passed, q.id).toBe(false);
  });

  it("aren't the same as any built-in question", () => {
    const prompts = new Set(ALL_CONTENT.flatMap(c => c.bank).map(q => `${q.topicId}|${q.prompt}`));
    for (const q of DEMO_REVIEW_SAMPLES) expect(prompts.has(`${q.topicId}|${q.prompt}`), q.id).toBe(false);
  });
});
