import { MARKS_BY_LEVEL, PASS_MARKS, WRONG_PENALTY } from "../engine";
import type { Level } from "../types";
import { DEFAULT_BANDS, type LevelBand } from "../validation";

/** The admin's settings for one topic: the defaults, and how far a parent may change them for one child. */
export interface TopicSettings {
  topicId: string;
  passMarks: number;
  passMarksMin: number;
  passMarksMax: number;
  wrongPenalty: number;
  wrongPenaltyMin: number;
  wrongPenaltyMax: number;
}

/** A parent's choice for one child on one topic. Null means the admin's default. */
export interface ChildSettings {
  topicId: string;
  passMarks: number | null;
  wrongPenalty: number | null;
}

/** What a quiz uses. */
export interface QuizSettings {
  passMarks: number;
  wrongPenalty: number;
}

/**
 * The starting settings, the same as the database's: pass mark 44 of 68 and 1
 * mark off for a wrong first try. Parents may only make a topic harder: a pass
 * mark from 44 to 60, and a penalty of 1 or 2 (cp's choice, 2026-10-25).
 */
export function defaultTopicSettings(topicId: string): TopicSettings {
  return {
    topicId, passMarks: PASS_MARKS, passMarksMin: PASS_MARKS, passMarksMax: 60,
    wrongPenalty: WRONG_PENALTY, wrongPenaltyMin: WRONG_PENALTY, wrongPenaltyMax: 2,
  };
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/**
 * The parent's value if set, else the admin's default, always kept inside the
 * admin's current limits (as the database's effective_topic_settings does), so
 * narrowing the limits later never leaves a child outside them.
 */
export function effectiveSettings(t: TopicSettings, child?: ChildSettings | null): QuizSettings {
  return {
    passMarks: clamp(child?.passMarks ?? t.passMarks, t.passMarksMin, t.passMarksMax),
    wrongPenalty: clamp(child?.wrongPenalty ?? t.wrongPenalty, t.wrongPenaltyMin, t.wrongPenaltyMax),
  };
}

const whole = (v: number) => Number.isInteger(v);

/** What is wrong with an admin's topic settings, in plain sentences. */
export function topicSettingsProblems(t: TopicSettings, maxMarks: number): string[] {
  const out: string[] = [];
  const numbers = [t.passMarks, t.passMarksMin, t.passMarksMax, t.wrongPenalty, t.wrongPenaltyMin, t.wrongPenaltyMax];
  if (!numbers.every(whole)) return ["Use whole numbers."];
  if (t.passMarksMin < 1) out.push("The lowest pass mark must be at least 1.");
  if (t.passMarksMax > maxMarks) out.push(`The highest pass mark can't be more than ${maxMarks}, the most marks a quiz can give.`);
  if (t.passMarksMin > t.passMarksMax) out.push("The lowest pass mark is above the highest.");
  else if (t.passMarks < t.passMarksMin || t.passMarks > t.passMarksMax) out.push("The default pass mark must be inside the parents' range.");
  // A wrong try never costs more than the hardest right answer is worth.
  const most = MARKS_BY_LEVEL[4 as Level];
  if (t.wrongPenaltyMin < 0) out.push("The smallest penalty can't be below 0.");
  if (t.wrongPenaltyMax > most) out.push(`The biggest penalty can't be more than ${most}.`);
  if (t.wrongPenaltyMin > t.wrongPenaltyMax) out.push("The smallest penalty is above the biggest.");
  else if (t.wrongPenalty < t.wrongPenaltyMin || t.wrongPenalty > t.wrongPenaltyMax) out.push("The default penalty must be inside the parents' range.");
  return out;
}

/** What is wrong with a parent's choice for one child, or null if it's fine. */
export function childSettingsProblem(t: TopicSettings, c: ChildSettings): string | null {
  if (c.passMarks !== null && (!whole(c.passMarks) || c.passMarks < t.passMarksMin || c.passMarks > t.passMarksMax)) {
    return `The pass mark can be ${t.passMarksMin} to ${t.passMarksMax}.`;
  }
  if (c.wrongPenalty !== null && (!whole(c.wrongPenalty) || c.wrongPenalty < t.wrongPenaltyMin || c.wrongPenalty > t.wrongPenaltyMax)) {
    return `The penalty can be ${t.wrongPenaltyMin} to ${t.wrongPenaltyMax}.`;
  }
  return null;
}

/**
 * Level bands as three cut points, in percent of first tries right: L1 is
 * `l1` and up, L2 from `l2` to `l1`, L3 from `l3` to `l2`, and L4 under `l3`.
 * Three numbers can't leave a gap or an overlap.
 */
export interface BandCuts { l1: number; l2: number; l3: number }

export const cutsOf = (bands: LevelBand[]): BandCuts => {
  const min = (l: Level) => Math.round((bands.find(b => b.level === l)?.minRate ?? 0) * 100);
  return { l1: min(1), l2: min(2), l3: min(3) };
};

export const bandsOf = (c: BandCuts): LevelBand[] => [
  { level: 1, minRate: c.l1 / 100, maxRate: 1 },
  { level: 2, minRate: c.l2 / 100, maxRate: c.l1 / 100 },
  { level: 3, minRate: c.l3 / 100, maxRate: c.l2 / 100 },
  { level: 4, minRate: 0, maxRate: c.l3 / 100 },
];

export function bandCutsProblem(c: BandCuts): string | null {
  if (![c.l1, c.l2, c.l3].every(whole)) return "Use whole percentages.";
  if (!(c.l1 < 100 && c.l1 > c.l2 && c.l2 > c.l3 && c.l3 > 0)) return "Each level must start lower than the one before: 100 > L1 > L2 > L3 > 0.";
  return null;
}

export { DEFAULT_BANDS };
