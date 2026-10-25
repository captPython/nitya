import { describe, expect, it } from "vitest";
import { applyEdits, canFixHere, editsOf, recheck } from "../src/admin/review";
import {
  bandCutsProblem, bandsOf, childSettingsProblem, classSettingsProblems, cutsOf, defaultClassSettings, effectiveSettings, passMarksFor, QUIZ_LIMITS,
  type ChildSettings,
} from "../src/admin/settings";
import { classLook, lookFor, type Look } from "../src/looks";
import { CLASS_ORDER } from "../src/types";
import { DEMO_REVIEW_SAMPLES } from "../src/accounts/demo-samples";
import { ALL_CONTENT } from "../src/content";
import { parseWorking, topicInfo, workingText } from "../src/supply";
import type { Working } from "../src/types";
import { DEFAULT_BANDS } from "../src/validation";

const UKG = defaultClassSettings("UKG");
const topics = ALL_CONTENT.map(topicInfo);
const none = { passPercent: null, wrongPenalty: null };

describe("class settings", () => {
  it("start at 65% (44 of 68 marks) and 1 mark off for every class", () => {
    expect(UKG).toEqual({ classId: "UKG", passPercent: 65, wrongPenalty: 1 });
    expect(classSettingsProblems(UKG)).toEqual([]);
    expect(effectiveSettings(UKG)).toEqual({ passMarks: 44, wrongPenalty: 1 });
  });

  it("turn a percentage into the nearest mark", () => {
    expect([1, 50, 65, 80, 90, 100].map(p => passMarksFor("UKG", p))).toEqual([1, 34, 44, 54, 61, 68]);
  });

  it("use the parent's choice for that child on every topic, higher or lower than the default", () => {
    expect(effectiveSettings(UKG, none)).toEqual({ passMarks: 44, wrongPenalty: 1 });
    expect(effectiveSettings(UKG, { passPercent: 80, wrongPenalty: null })).toEqual({ passMarks: 54, wrongPenalty: 1 });
    expect(effectiveSettings(UKG, { passPercent: 50, wrongPenalty: 0 })).toEqual({ passMarks: 34, wrongPenalty: 0 });
    // A child without a choice follows the admin's new default; one with a choice keeps it.
    expect(effectiveSettings({ ...UKG, passPercent: 75 }, none)).toEqual({ passMarks: 51, wrongPenalty: 1 });
    expect(effectiveSettings({ ...UKG, passPercent: 75 }, { passPercent: 60, wrongPenalty: null })).toEqual({ passMarks: 41, wrongPenalty: 1 });
  });

  it("keep any choice inside what a quiz allows: 1% to 100%, and 0 to 4 marks off", () => {
    expect(QUIZ_LIMITS).toEqual({ passPercent: { min: 1, max: 100 }, wrongPenalty: { min: 0, max: 4 } });
    const child = (c: Partial<ChildSettings>): ChildSettings => ({ ...none, look: null, voice: null, ...c });
    for (const ok of [child({}), child({ passPercent: 1, wrongPenalty: 0 }), child({ passPercent: 100, wrongPenalty: 4 })]) expect(childSettingsProblem(ok)).toBeNull();
    expect(childSettingsProblem(child({ passPercent: 0 }))).toBe("The pass mark can be 1% to 100%.");
    expect(childSettingsProblem(child({ passPercent: 101 }))).toBe("The pass mark can be 1% to 100%.");
    expect(childSettingsProblem(child({ passPercent: 70.5 }))).toBe("The pass mark can be 1% to 100%.");
    expect(childSettingsProblem(child({ wrongPenalty: 5 }))).toBe("Marks off can be 0 to 4.");
    expect(childSettingsProblem(child({ look: "focus" }))).toBeNull();
    expect(childSettingsProblem(child({ look: "dark" as Look }))).toBe("The look can be playful or clean.");
    expect(childSettingsProblem(child({ voice: false }))).toBeNull();
    expect(childSettingsProblem(child({ voice: "yes" as unknown as boolean }))).toBe("The voice can be on or off.");
    expect(classSettingsProblems({ ...UKG, passPercent: 101, wrongPenalty: -1 })).toEqual(["The pass mark can be 1% to 100%.", "Marks off can be 0 to 4."]);
  });
});

describe("looks", () => {
  it("are playful up to Class 5 and clean from Class 6", () => {
    expect(CLASS_ORDER.map(classLook)).toEqual([
      "play", "play", "play", "play", "play", "play", "play", "focus", "focus", "focus", "focus", "focus", "focus", "focus",
    ]);
    expect(classLook("C5")).toBe("play");
    expect(classLook("C6")).toBe("focus");
  });

  it("follow the parent's choice for a child, either way", () => {
    expect(lookFor("UKG", null)).toBe("play");
    expect(lookFor("UKG", "focus")).toBe("focus");
    expect(lookFor("C8", "play")).toBe("play");
    expect(lookFor("C8")).toBe("focus");
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
