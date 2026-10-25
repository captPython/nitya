import { describe, expect, it } from "vitest";
import {
  answerFirstTry, answerRetry, finishQuiz, isFinished, isQualified, maxMarks, nextQuestion, startQuiz,
  MARKS_BY_LEVEL, PASS_MARKS, QUIZ_LENGTH,
} from "../src/engine";
import { ADDITION } from "../src/content/ukg/addition";
import { mulberry32 } from "../src/content/gen";
import type { ClassId, Level, Question, QuizState } from "../src/types";

const { topic, bank } = ADDITION;
const first = () => 0;

function fresh(classId: ClassId = "UKG", attemptNo = 1, seenBefore: string[] = []): QuizState {
  return startQuiz({ classId, topicId: topic.id, attemptNo, seenBefore });
}

function wrongAnswer(q: Question): string {
  return (q.options ?? ["__"]).find(o => !q.answers.includes(o)) ?? "__";
}

/** Plays one question; `right` decides the first try, the retry is always wrong. */
function play(s: QuizState, right: boolean, rng: () => number = first): { s: QuizState; q: Question } {
  const q = nextQuestion(s, bank, rng);
  const r = answerFirstTry(s, q, right ? q.answers[0] : wrongAnswer(q));
  s = r.state;
  if (r.result.kind === "hint-retry") s = answerRetry(s, q, wrongAnswer(q)).state;
  return { s, q };
}

function playSequence(pattern: boolean[], start: QuizState = fresh(), rng: () => number = first) {
  let s = start;
  const served: { stateLevel: Level; questionLevel: Level }[] = [];
  for (const right of pattern) {
    const stateLevel = s.level;
    const out = play(s, right, rng);
    served.push({ stateLevel, questionLevel: out.q.level });
    s = out.s;
  }
  return { s, served, levels: served.map(x => x.questionLevel) };
}

describe("level rules", () => {
  it("starts at L1", () => {
    expect(fresh().level).toBe(1);
  });

  it("moves up one level after 2 right in a row", () => {
    expect(playSequence([true, true]).s.level).toBe(2);
  });

  it("reaches L3 at question 5 at the fastest", () => {
    expect(playSequence([true, true, true, true, true]).levels).toEqual([1, 1, 2, 2, 3]);
  });

  it("stays on the same level after 1 wrong and offers a hint retry", () => {
    const s = playSequence([true, true]).s;
    const q = nextQuestion(s, bank, first);
    const r = answerFirstTry(s, q, wrongAnswer(q));
    expect(r.result.kind).toBe("hint-retry");
    expect(r.state.level).toBe(2);
    expect(r.state.pendingRetry).toBe(q.id);
  });

  it("moves down one level after 2 wrong in a row", () => {
    expect(playSequence([true, true, false, false]).s.level).toBe(1);
  });

  it("never goes below L1 or above L4", () => {
    expect(playSequence([false, false, false, false]).s.level).toBe(1);
    expect(playSequence(Array(12).fill(true)).s.level).toBe(4);
  });

  it("a wrong answer resets the right streak", () => {
    expect(playSequence([true, false, true]).s.level).toBe(1);
  });
});

describe("question difficulty matches the level shown", () => {
  it("serves real L4 questions after dropping down and climbing back", () => {
    // The pattern from testing: reach L4, slip to L2, climb back to L4.
    const pattern = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1].map(Boolean);
    const { served } = playSequence(pattern);
    for (const x of served) expect(x.questionLevel).toBe(x.stateLevel);
    expect(served.filter(x => x.questionLevel === 4).length).toBeGreaterThan(5);
  });

  it("holds for 2,000 random quizzes, on first and later attempts", () => {
    const r = mulberry32(7);
    let seen: string[] = [];
    for (let run = 0; run < 2000; run++) {
      const pattern = Array.from({ length: QUIZ_LENGTH }, () => r() < 0.7);
      const { s, served } = playSequence(pattern, fresh("UKG", 1 + (run % 3), seen), r);
      for (const x of served) expect(x.questionLevel).toBe(x.stateLevel);
      seen = run % 3 === 2 ? [] : [...seen, ...s.asked];
    }
  });
});

describe("questions with the same maths", () => {
  const q = (id: string, group: string, level: Level = 1): Question => ({
    id, topicId: topic.id, subSkill: "count-on", level, format: "tap-picture", prompt: id, options: ["1", "2"],
    answers: ["1"], hint: "h", explanation: "1", reason: "1", variantGroup: group,
  });

  it("keeps 3 + 4 and 4 + 3 out of one quiz while the level has other maths", () => {
    const twins = [q("3 + 4", "a"), q("4 + 3", "a"), q("2 + 5", "b")];
    const s = { ...fresh(), asked: ["3 + 4"] };
    for (let i = 0; i < 20; i++) expect(nextQuestion(s, twins, () => i / 20).id).toBe("2 + 5");
  });

  it("repeats the maths at the same level rather than jump to a harder one", () => {
    const twins = [q("3 + 4", "a"), q("4 + 3", "a"), q("hard", "c", 2)];
    expect(nextQuestion({ ...fresh(), asked: ["3 + 4"] }, twins).id).toBe("4 + 3");
  });
});

describe("marks", () => {
  it("gives marks by level and takes 1 away for a wrong first try", () => {
    const { s } = playSequence([true, true, true, false]);
    // L1 + L1 + L2 = 4, then a wrong L2 answer: 4 - 1 = 3
    expect(s.marks).toBe(MARKS_BY_LEVEL[1] * 2 + MARKS_BY_LEVEL[2] - 1);
    expect(s.responses.map(r => r.marksDelta)).toEqual([1, 1, 2, -1]);
  });

  it("never drops below 0", () => {
    const { s } = playSequence([false, false, false]);
    expect(s.marks).toBe(0);
    expect(s.responses.every(r => r.marksDelta === 0)).toBe(true);
  });

  it("does not change on the hint retry", () => {
    let s = playSequence([true, true]).s;
    const q = nextQuestion(s, bank, first);
    s = answerFirstTry(s, q, wrongAnswer(q)).state;
    const marks = s.marks;
    s = answerRetry(s, q, q.answers[0]).state;
    expect(s.marks).toBe(marks);
  });

  it("tops out at 68 for a perfect quiz", () => {
    expect(maxMarks("UKG")).toBe(68);
    expect(playSequence(Array(QUIZ_LENGTH).fill(true)).s.marks).toBe(68);
  });

  it("qualifies once the bar crosses the pass mark and can fall back below", () => {
    let { s } = playSequence(Array(14).fill(true)); // 2 + 4 + 6 + 8 * 4 = 44
    expect(s.marks).toBe(PASS_MARKS);
    expect(isQualified(s)).toBe(true);
    s = playSequence([false], s).s;
    expect(isQualified(s)).toBe(false);
  });
});

describe("hint retry", () => {
  it("does not change the level", () => {
    let s = fresh();
    const q = nextQuestion(s, bank, first);
    s = answerFirstTry(s, q, wrongAnswer(q)).state;
    const level = s.level;
    const r = answerRetry(s, q, q.answers[0]);
    expect(r.retryCorrect).toBe(true);
    expect(r.state.level).toBe(level);
    expect(r.answer).toBe(q.answers[0]);
  });

  it("blocks the next question until the retry is done", () => {
    let s = fresh();
    const q = nextQuestion(s, bank, first);
    s = answerFirstTry(s, q, wrongAnswer(q)).state;
    expect(() => nextQuestion(s, bank, first)).toThrow();
  });
});

describe("question picking", () => {
  it("never repeats a question in one quiz", () => {
    const { s } = playSequence(Array(QUIZ_LENGTH).fill(true));
    expect(new Set(s.asked).size).toBe(QUIZ_LENGTH);
  });

  it("prefers questions not seen in an earlier attempt", () => {
    const seen = bank.filter(q => q.level === 1).slice(0, 5).map(q => q.id);
    const q = nextQuestion(fresh("UKG", 2, seen), bank, first);
    expect(seen).not.toContain(q.id);
    expect(q.level).toBe(1);
  });
});

describe("mastery", () => {
  it("clears a perfect quiz with 3 stars", () => {
    const out = finishQuiz(playSequence(Array(QUIZ_LENGTH).fill(true)).s);
    expect(out).toMatchObject({ cleared: true, marks: 68, passMarks: PASS_MARKS, maxMarks: 68, stars: 3 });
  });

  it("does not clear below the pass mark", () => {
    const pattern = Array(QUIZ_LENGTH).fill(true);
    [2, 5, 8, 11, 14].forEach(i => (pattern[i] = false)); // 15 of 20 right
    const { s } = playSequence(pattern);
    expect(isFinished(s)).toBe(true);
    const out = finishQuiz(s);
    expect(out.marks).toBeLessThan(PASS_MARKS);
    expect(out.cleared).toBe(false);
    expect(out.suggestLesson).toBe(true);
  });

  it("offers practice mode from the 2nd failed attempt", () => {
    const pattern = Array(QUIZ_LENGTH).fill(false);
    expect(finishQuiz(playSequence(pattern, fresh("UKG", 1)).s).offerPractice).toBe(false);
    expect(finishQuiz(playSequence(pattern, fresh("UKG", 2)).s).offerPractice).toBe(true);
  });

  it("lists weak sub-skills", () => {
    const out = finishQuiz(playSequence(Array(QUIZ_LENGTH).fill(false)).s);
    expect(out.weakSubSkills.length).toBeGreaterThan(0);
  });
});
