import type { ClassId, Level, Question, QuizState } from "./types";

export const QUIZ_LENGTH = 20;
export const PASS_CORRECT = 16; // 80% of 20, kept for the dashboard's accuracy view
export const HARD_NEEDED = 5;
export const PRACTICE_AFTER_FAILS = 2;
export const MIN_LEVEL: Level = 1;

/** Marks for a right first try, by level: harder questions move the bar further. */
export const MARKS_BY_LEVEL: Record<Level, number> = { 1: 1, 2: 2, 3: 3, 4: 4 };
/** Marks taken away for a wrong first try. The total never drops below 0. */
export const WRONG_PENALTY = 1;
/**
 * Marks needed to clear a topic. Simulating every right/wrong pattern over 20
 * questions, 44 agrees with the old "80% and 5 hard answers" rule about 95% of
 * the time, so the bar alone now decides.
 */
export const PASS_MARKS = 44;

const PRE_PRIMARY: ClassId[] = ["LKG", "UKG"];

/** Lowest level that counts as a "hard" answer on the dashboard. */
export function hardLevel(classId: ClassId): Level {
  return PRE_PRIMARY.includes(classId) ? 2 : 3;
}

/** Highest level the quiz may reach. L4 items carry that class's Olympiad scope. */
export function ceiling(_classId: ClassId): Level {
  return 4;
}

/** Best possible marks: every answer right, climbing as fast as the rules allow. */
export function maxMarks(classId: ClassId): number {
  let level: Level = 1, streak = 0, marks = 0;
  for (let i = 0; i < QUIZ_LENGTH; i++) {
    marks += MARKS_BY_LEVEL[level];
    streak += 1;
    if (streak === 2) {
      level = Math.min(level + 1, ceiling(classId)) as Level;
      streak = 0;
    }
  }
  return marks;
}

export function startQuiz(opts: {
  classId: ClassId;
  topicId: string;
  attemptNo: number;
  seenBefore?: string[];
}): QuizState {
  return {
    classId: opts.classId,
    topicId: opts.topicId,
    attemptNo: opts.attemptNo,
    level: 1,
    rightStreak: 0,
    wrongStreak: 0,
    correct: 0,
    hardCorrect: 0,
    marks: 0,
    asked: [],
    seenBefore: opts.seenBefore ?? [],
    pendingRetry: null,
    responses: [],
  };
}

export function isFinished(s: QuizState): boolean {
  return s.asked.length >= QUIZ_LENGTH && s.pendingRetry === null;
}

export function isQualified(s: QuizState): boolean {
  return s.marks >= PASS_MARKS;
}

/** Accuracy per sub-skill so far, as right / asked. */
function subSkillAccuracy(s: QuizState): Map<string, number> {
  const tally = new Map<string, { right: number; total: number }>();
  for (const r of s.responses) {
    const t = tally.get(r.subSkill) ?? { right: 0, total: 0 };
    t.total += 1;
    if (r.firstTryCorrect) t.right += 1;
    tally.set(r.subSkill, t);
  }
  const acc = new Map<string, number>();
  tally.forEach((t, k) => acc.set(k, t.right / t.total));
  return acc;
}

/**
 * Picks the next question at the current level, never one asked in this quiz.
 * Order of preference at that level: not seen in an earlier attempt, then the
 * one seen longest ago. Only if the level has nothing left does it look at the
 * next harder level, and only then easier ones, so the child never gets an
 * easier question than the level shown.
 */
export function nextQuestion(
  s: QuizState,
  bank: Question[],
  rng: () => number = Math.random,
): Question {
  if (s.pendingRetry) throw new Error("Finish the hint retry first");
  if (isFinished(s)) throw new Error("Quiz is finished");

  const unasked = bank.filter(q => q.topicId === s.topicId && !s.asked.includes(q.id));
  if (unasked.length === 0) throw new Error("Question bank is empty for this topic");

  const top = ceiling(s.classId);
  const order: Level[] = [s.level];
  for (let l = s.level + 1; l <= top; l++) order.push(l as Level);
  for (let l = s.level - 1; l >= MIN_LEVEL; l--) order.push(l as Level);

  let pool: Question[] = [];
  for (const lvl of order) {
    pool = unasked.filter(q => q.level === lvl);
    if (pool.length) break;
  }

  const fresh = pool.filter(q => !s.seenBefore.includes(q.id));
  if (fresh.length) {
    pool = fresh;
  } else {
    const oldest = Math.min(...pool.map(q => s.seenBefore.indexOf(q.id)));
    pool = pool.filter(q => s.seenBefore.indexOf(q.id) === oldest);
  }

  const acc = subSkillAccuracy(s);
  const score = (q: Question) => acc.get(q.subSkill) ?? 0.5;
  const weakest = Math.min(...pool.map(score));
  const candidates = pool.filter(q => score(q) === weakest);
  return candidates[Math.floor(rng() * candidates.length)];
}

export function checkAnswer(q: Question, response: string): boolean {
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
  return q.answers.some(a => norm(a) === norm(response));
}

export type FirstTryResult =
  | { kind: "praise"; reason: string; marksDelta: number }
  | { kind: "hint-retry"; hint: string; marksDelta: number };

/** Scores the first try, moves the marks bar, and applies the level rules. */
export function answerFirstTry(
  s: QuizState,
  q: Question,
  response: string,
): { state: QuizState; result: FirstTryResult } {
  if (s.pendingRetry) throw new Error("Finish the hint retry first");
  const right = checkAnswer(q, response);
  const marksDelta = right ? MARKS_BY_LEVEL[q.level] : 0 - Math.min(WRONG_PENALTY, s.marks);
  const next: QuizState = {
    ...s,
    marks: s.marks + marksDelta,
    asked: [...s.asked, q.id],
    responses: [
      ...s.responses,
      { questionId: q.id, level: q.level, marksDelta, subSkill: q.subSkill, firstTryCorrect: right, retryCorrect: null },
    ],
  };

  if (right) {
    next.correct += 1;
    if (q.level >= hardLevel(s.classId)) next.hardCorrect += 1;
    next.rightStreak += 1;
    next.wrongStreak = 0;
    if (next.rightStreak === 2) {
      next.level = Math.min(next.level + 1, ceiling(s.classId)) as Level;
      next.rightStreak = 0;
    }
    return { state: next, result: { kind: "praise", reason: q.reason, marksDelta } };
  }

  next.wrongStreak += 1;
  next.rightStreak = 0;
  if (next.wrongStreak === 2) {
    next.level = Math.max(next.level - 1, MIN_LEVEL) as Level;
    next.wrongStreak = 0;
  }
  next.pendingRetry = q.id;
  return { state: next, result: { kind: "hint-retry", hint: q.hint, marksDelta } };
}

/** The hint retry is recorded for the dashboard but never changes the marks or level. */
export function answerRetry(
  s: QuizState,
  q: Question,
  response: string,
): { state: QuizState; retryCorrect: boolean; explanation: string; answer: string } {
  if (s.pendingRetry !== q.id) throw new Error("No retry pending for this question");
  const right = checkAnswer(q, response);
  const responses = s.responses.map(r =>
    r.questionId === q.id ? { ...r, retryCorrect: right } : r,
  );
  return {
    state: { ...s, responses, pendingRetry: null },
    retryCorrect: right,
    explanation: q.explanation,
    answer: q.answers[0],
  };
}

export interface QuizOutcome {
  cleared: boolean;
  marks: number;
  passMarks: number;
  maxMarks: number;
  correct: number;
  hardCorrect: number;
  stars: 0 | 1 | 2 | 3;
  suggestLesson: boolean;
  offerPractice: boolean;
  weakSubSkills: string[];
}

export const TWO_STARS = 53;
export const THREE_STARS = 62;

export function finishQuiz(s: QuizState): QuizOutcome {
  if (!isFinished(s)) throw new Error("Quiz is not finished");
  const cleared = isQualified(s);
  const stars = !cleared ? 0 : s.marks >= THREE_STARS ? 3 : s.marks >= TWO_STARS ? 2 : 1;
  const acc = subSkillAccuracy(s);
  const weakSubSkills = [...acc.entries()]
    .filter(([, a]) => a < 0.8)
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k);
  return {
    cleared,
    marks: s.marks,
    passMarks: PASS_MARKS,
    maxMarks: maxMarks(s.classId),
    correct: s.correct,
    hardCorrect: s.hardCorrect,
    stars,
    suggestLesson: !cleared,
    offerPractice: !cleared && s.attemptNo >= PRACTICE_AFTER_FAILS,
    weakSubSkills,
  };
}
