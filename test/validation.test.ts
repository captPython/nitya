import { describe, expect, it } from "vitest";
import { UKG_TOPICS } from "../src/content/ukg";
import { add, arith, dots } from "../src/content/gen";
import type { Question } from "../src/types";
import { checkLiveBand, validateQuestion, type CheckReport, type LevelBand } from "../src/validation";

const ctxFor = (topicId: string) => {
  const content = UKG_TOPICS.find(t => t.topic.id === topicId)!;
  return { classId: content.topic.classId, subSkills: Object.keys(content.subSkillNames) };
};

const failed = (r: CheckReport) =>
  (["answer", "options", "scope", "level", "wording"] as const).filter(k => !r[k].passed);

const check = (q: Question) => validateQuestion(q, ctxFor(q.topicId));

/** A sound L2 addition question. Each planted fault below changes one thing about it. */
const good = (over: Partial<Question> = {}): Question => ({
  id: "planted", topicId: "ukg-addition-10", subSkill: "count-on", level: 2, format: "tap-picture",
  prompt: "4 + 3 = ?", options: ["6", "7", "8"], answers: ["7"],
  hint: "Say 4, then count on 3.", explanation: "Start at 4 and count on 3: 5, 6, 7. So 4 + 3 = 7.",
  reason: "3 more than 4 is 7.", working: arith(add(4, 3)),
  ...over,
});

describe("the UKG question banks", () => {
  it.each(UKG_TOPICS.map(t => [t.topic.title, t] as const))("%s: every question passes every check", (_title, t) => {
    const ctx = { classId: t.topic.classId, subSkills: Object.keys(t.subSkillNames) };
    for (const q of t.bank) {
      const report = validateQuestion(q, ctx);
      expect({ id: q.id, failed: failed(report) }).toEqual({ id: q.id, failed: [] });
    }
  });

  it("catches a wrong answer planted in any question", () => {
    for (const t of UKG_TOPICS) {
      for (const q of t.bank) {
        const wrong = q.options!.find(o => !q.answers.includes(o))!;
        expect({ id: q.id, passed: check({ ...q, answers: [wrong] }).answer.passed }).toEqual({ id: q.id, passed: false });
      }
    }
  });

  it("estimates the tagged level, or one next to it, for every question", () => {
    let exact = 0, total = 0;
    for (const t of UKG_TOPICS) {
      for (const q of t.bank) {
        const estimate = check(q).level.estimate!;
        expect(Math.abs(estimate - q.level)).toBeLessThanOrEqual(1);
        if (estimate === q.level) exact++;
        total++;
      }
    }
    expect(exact / total).toBeGreaterThan(0.7);
  });
});

describe("planted faulty questions", () => {
  it("passes the sound question they are made from", () => {
    expect(failed(check(good()))).toEqual([]);
  });

  it("catches a wrong answer", () => {
    const r = check(good({ answers: ["8"] }));
    expect(failed(r)).toEqual(["answer"]);
    expect(r.answer.problems).toContain("Recomputing gives a different answer: 8 is wrong.");
  });

  it("catches duplicate options", () => {
    const r = check(good({ options: ["7", "8", "8"] }));
    expect(failed(r)).toEqual(["options"]);
    expect(r.options.problems).toContain('"8" appears twice.');
  });

  it("catches a number outside the class's range", () => {
    const r = check(good({
      topicId: "ukg-counting-50", subSkill: "count-on", level: 3, format: "fill-blank",
      prompt: "Fill the gap: 49, 50, __, 52", options: ["50", "51", "52"], answers: ["51"],
      hint: "Count on from 50.", explanation: "After 50 comes 51, and then 52.", reason: "51 sits between 50 and 52.",
      working: { kind: "sequence", terms: [49, 50, null, 52] },
    }));
    expect(failed(r)).toEqual(["scope"]);
    expect(r.scope.problems).toContain("51 and 52 are outside UKG's range of 0 to 50.");
  });

  it("catches a wrong level tag", () => {
    const r = check(good({
      topicId: "ukg-counting-50", subSkill: "count-objects", level: 4, format: "count",
      prompt: "How many dots?", visual: dots({ count: 4, color: "blue" }), options: ["3", "4", "5"], answers: ["4"],
      hint: "Touch each dot once as you count.", explanation: "Counting every dot gives 4.", reason: "There are 4 dots.",
      working: { kind: "count-dots" },
    }));
    expect(failed(r)).toEqual(["level"]);
    expect(r.level.problems).toEqual(["It is tagged L4, but it looks like L1."]);
  });

  it("sends a question with no working to manual review", () => {
    const r = check(good({ working: undefined }));
    expect(r.passed).toBe(false);
    expect(failed(r)).toEqual(["answer", "level"]);
  });

  it("catches working that doesn't match the question", () => {
    const r = check(good({ prompt: "4 + 2 = ?" }));
    expect(failed(r)).toEqual(["answer"]);
    expect(r.answer.problems).toEqual([
      "The working uses 3, which the question never shows.",
      "The question shows 2, which the working never uses.",
    ]);
  });

  it("catches a picture that doesn't match the answer", () => {
    const r = check(good({
      topicId: "ukg-counting-50", subSkill: "count-objects", level: 1, format: "count",
      prompt: "How many dots?", visual: dots({ count: 5, color: "blue" }), options: ["5", "6", "7"], answers: ["6"],
      hint: "Touch each dot once as you count.", explanation: "Counting every dot gives 6.", reason: "There are 6 dots.",
      working: { kind: "count-dots" },
    }));
    expect(failed(r)).toEqual(["answer"]);
  });

  it("catches two right options", () => {
    const r = check(good({
      topicId: "ukg-comparing", subSkill: "in-between", level: 4,
      prompt: "Which number is bigger than 23 but smaller than 26?", options: ["24", "25", "22"], answers: ["24"],
      hint: "List the numbers after 23, stopping before 26.", explanation: "24 or 25 fit.", reason: "24 is between 23 and 26.",
      working: { kind: "between", above: 23, below: 26 },
    }));
    expect(failed(r)).toEqual(["answer"]);
    expect(r.answer.problems).toContain("More than one option is right: 24 and 25.");
  });

  it("catches a tie with no 'same' option", () => {
    const r = check(good({
      topicId: "ukg-comparing", subSkill: "compare-groups", level: 1,
      prompt: "Which has more dots, blue or orange?", visual: dots({ count: 4, color: "blue" }, { count: 4, color: "orange" }),
      options: ["Blue", "Orange"], answers: ["Blue"], hint: "Count each colour.",
      explanation: "Blue has 4 and orange has 4.", reason: "Blue has 4.",
      working: { kind: "extreme", of: "max", items: [{ label: "Blue", expr: { dots: 0 } }, { label: "Orange", expr: { dots: 1 } }] },
    }));
    expect(failed(r)).toEqual(["answer", "level"]);
    expect(r.answer.problems).toEqual(["Two or more choices tie for the biggest."]);
  });

  it("catches an explanation that never reaches the answer", () => {
    const r = check(good({ explanation: "Start at 4 and count on: 5, 6.", reason: "That makes 17 in all." }));
    expect(failed(r)).toEqual(["answer"]);
    expect(r.answer.problems).toEqual(["The explanation and reason never state the answer."]);
  });

  it("catches a wrong option that looks different from the answer", () => {
    const r = check(good({ options: ["6", "7", "seven"] }));
    expect(failed(r)).toEqual(["options"]);
  });

  it("catches a wrong option too far away to be a believable mistake", () => {
    const r = check(good({ options: ["7", "8", "30"] }));
    expect(failed(r)).toEqual(["options"]);
    expect(r.options.problems).toEqual(["30 is too far from the answer 7 to be a believable mistake."]);
  });

  it("catches a sum past this topic's limit of 10", () => {
    const r = check(good({
      prompt: "7 + 6 = ?", options: ["12", "13", "14"], answers: ["13"], hint: "Say 7, then count on 6.",
      explanation: "Start at 7 and count on 6. So 7 + 6 = 13.", reason: "6 more than 7 is 13.", working: arith(add(7, 6)),
    }));
    expect(failed(r)).toEqual(["scope"]);
    expect(r.scope.problems).toEqual(["Working it out reaches 13, past this topic's limit of 10."]);
  });

  it("catches a skill from another topic", () => {
    const r = check(good({ subSkill: "skip-count" }));
    expect(failed(r)).toEqual(["scope"]);
  });

  it("catches a word that is not right for a child", () => {
    const r = check(good({ hint: "Don't be stupid, count on 3." }));
    expect(failed(r)).toEqual(["wording"]);
  });

  it("catches a link", () => {
    const r = check(good({ explanation: "See www.example.com. So 4 + 3 = 7." }));
    expect(failed(r)).toEqual(["wording"]);
  });

  it("catches a question too long for the class to read", () => {
    const long = "Riya and Arjun walk to the big park near the school with their friends, and they see 4 red birds and then 3 more birds. How many?";
    const r = check(good({ prompt: long, format: "audio", subSkill: "word-problem" }));
    expect(failed(r)).toEqual(["wording"]);
  });

  it("writes reports that can be stored as JSON", () => {
    const r = check(good({ answers: ["8"] }));
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe("live results against the level bands", () => {
  it("waits for 30 plays before judging", () => {
    expect(checkLiveBand({ level: 4, timesShown: 29, firstTryCorrect: 29 })).toEqual({ status: "too-few-plays", plays: 29 });
  });

  it("accepts a question inside its band, including 100% at L1", () => {
    expect(checkLiveBand({ level: 1, timesShown: 40, firstTryCorrect: 40 })).toEqual({ status: "in-band", rate: 1 });
    expect(checkLiveBand({ level: 2, timesShown: 100, firstTryCorrect: 65 })).toEqual({ status: "in-band", rate: 0.65 });
    expect(checkLiveBand({ level: 4, timesShown: 50, firstTryCorrect: 20 })).toEqual({ status: "in-band", rate: 0.4 });
  });

  it("flags an Olympiad question most children get right, and says which level it looks like", () => {
    expect(checkLiveBand({ level: 4, timesShown: 50, firstTryCorrect: 40 })).toEqual({ status: "outside-band", rate: 0.8, looksLike: 2 });
  });

  it("puts a rate on a boundary in the band above it", () => {
    expect(checkLiveBand({ level: 2, timesShown: 100, firstTryCorrect: 85 })).toEqual({ status: "outside-band", rate: 0.85, looksLike: 1 });
  });

  it("uses the admin's bands when given", () => {
    const bands: LevelBand[] = [
      { level: 1, minRate: 0.9, maxRate: 1 }, { level: 2, minRate: 0.7, maxRate: 0.9 },
      { level: 3, minRate: 0.45, maxRate: 0.7 }, { level: 4, minRate: 0, maxRate: 0.45 },
    ];
    expect(checkLiveBand({ level: 1, timesShown: 100, firstTryCorrect: 87 }, bands).status).toBe("outside-band");
  });
});
