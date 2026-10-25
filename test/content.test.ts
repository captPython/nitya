import { describe, expect, it } from "vitest";
import { UKG_TOPICS } from "../src/content/ukg";
import { contentKey } from "../src/content/gen";

describe.each(UKG_TOPICS.map(t => [t.topic.title, t] as const))("%s", (_title, content) => {
  const { bank, topic, tryIt, subSkillNames } = content;

  it("has 20 questions at every level (80 in all), none repeated anywhere in the topic", () => {
    expect(bank).toHaveLength(80);
    expect(new Set(bank.map(q => q.id)).size).toBe(80);
    // The database allows one copy of a question per topic, whatever its level.
    expect(new Set(bank.map(contentKey)).size).toBe(80);
    for (const l of [1, 2, 3, 4]) expect(bank.filter(q => q.level === l)).toHaveLength(20);
  });

  it("every question has distinct options that include each right answer", () => {
    for (const q of bank) {
      expect(q.topicId).toBe(topic.id);
      expect(q.options!.length).toBeGreaterThanOrEqual(2);
      expect(new Set(q.options).size).toBe(q.options!.length);
      for (const a of q.answers) expect(q.options).toContain(a);
      expect(q.options!.filter(o => q.answers.includes(o))).toHaveLength(1);
    }
  });

  it("keeps numbers inside the UKG range (0 to 50)", () => {
    for (const q of bank) {
      for (const n of (q.prompt + " " + q.options!.join(" ")).match(/\d+/g) ?? []) {
        expect(Number(n)).toBeGreaterThanOrEqual(0);
        expect(Number(n)).toBeLessThanOrEqual(50);
      }
    }
  });

  it("names every sub-skill it uses", () => {
    for (const q of bank) expect(subSkillNames[q.subSkill]).toBeTruthy();
  });

  it("has a Try it check whose answer is an option", () => {
    expect(tryIt.options).toContain(tryIt.answer);
  });
});

describe("arithmetic answers are correct", () => {
  const evalExpr = (e: string) => {
    const m = e.match(/^(\d+) ([+−]) (\d+)$/);
    return m ? (m[2] === "+" ? Number(m[1]) + Number(m[3]) : Number(m[1]) - Number(m[3])) : null;
  };

  it("checks every 'a + b = ?' and 'a − b = ?' question", () => {
    let checked = 0;
    for (const { bank } of UKG_TOPICS) {
      for (const q of bank) {
        const m = q.prompt.match(/^(\d+ [+−] \d+) = \?$/);
        if (!m) continue;
        expect(String(evalExpr(m[1]))).toBe(q.answers[0]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("sums stay at 10 or less and take-aways never go below 0", () => {
    for (const { bank, topic } of UKG_TOPICS) {
      if (!/Adding|Taking/.test(topic.title)) continue;
      for (const q of bank) {
        for (const o of q.options!) {
          const v = evalExpr(o);
          if (v !== null) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(11); // 11 appears only as a "make 10" distractor
          }
        }
        expect(Number.isNaN(Number(q.answers[0])) || Number(q.answers[0]) <= 10).toBe(true);
      }
    }
  });
});
