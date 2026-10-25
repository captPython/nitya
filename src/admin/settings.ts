import { MARKS_BY_LEVEL, WRONG_PENALTY, maxMarks } from "../engine";
import { isLook, type Look } from "../looks";
import type { ClassId, Level } from "../types";
import { DEFAULT_BANDS, type LevelBand } from "../validation";

/**
 * The admin's defaults for one class. Every topic in the class uses them. The
 * pass mark is a percentage of the most marks a quiz gives, because marks
 * confuse most parents (cp, 2026-10-25).
 */
export interface ClassSettings {
  classId: ClassId;
  passPercent: number;
  wrongPenalty: number;
}

/** A parent's choices for one child, for all of that child's topics. Null means the class default. */
export interface ChildSettings {
  passPercent: number | null;
  wrongPenalty: number | null;
  /** Null means the class decides: playful up to Class 5, clean from Class 6. */
  look: Look | null;
  /** Reading aloud, with a sound for right and wrong. Null means on for the playful look and off for the clean one. */
  voice: boolean | null;
}

/** What a quiz uses. */
export interface QuizSettings {
  passMarks: number;
  wrongPenalty: number;
}

/** 65% is 44 of 68 marks, the pass mark before it became a percentage. */
export const PASS_PERCENT = 65;

/** The starting defaults for every class, the same as the database's: 65% to pass, and 1 mark off. */
export const defaultClassSettings = (classId: ClassId): ClassSettings => ({ classId, passPercent: PASS_PERCENT, wrongPenalty: WRONG_PENALTY });

/** A pass percentage as marks, to the nearest mark: 65% of 68 is 44, and 80% is 54. */
export const passMarksFor = (classId: ClassId, percent: number) => Math.max(1, Math.round((percent * maxMarks(classId)) / 100));

/**
 * What a quiz allows: a pass mark from 1% to 100%, and up to 4 marks off, what
 * the hardest right answer gives. Parents choose freely inside these, higher
 * or lower than the class default, to fit their child (cp, 2026-10-25).
 */
export const QUIZ_LIMITS = {
  passPercent: { min: 1, max: 100 },
  wrongPenalty: { min: 0, max: MARKS_BY_LEVEL[4 as Level] },
};

/** The parent's choice if set, else the class default, as the database's effective_quiz_settings does. */
export function effectiveSettings(c: ClassSettings, child?: Pick<ChildSettings, "passPercent" | "wrongPenalty"> | null): QuizSettings {
  return { passMarks: passMarksFor(c.classId, child?.passPercent ?? c.passPercent), wrongPenalty: child?.wrongPenalty ?? c.wrongPenalty };
}

const whole = (v: number) => Number.isInteger(v);
type Range = { min: number; max: number };
const outside = (v: number, r: Range) => !whole(v) || v < r.min || v > r.max;

function problems(s: Omit<ChildSettings, "look" | "voice"> & { look?: unknown; voice?: unknown }): string[] {
  const r = QUIZ_LIMITS;
  const out: string[] = [];
  if (s.passPercent !== null && outside(s.passPercent, r.passPercent)) out.push(`The pass mark can be ${r.passPercent.min}% to ${r.passPercent.max}%.`);
  if (s.wrongPenalty !== null && outside(s.wrongPenalty, r.wrongPenalty)) out.push(`Marks off can be ${r.wrongPenalty.min} to ${r.wrongPenalty.max}.`);
  if (s.look != null && !isLook(s.look)) out.push("The look can be playful or clean.");
  if (s.voice != null && typeof s.voice !== "boolean") out.push("The voice can be on or off.");
  return out;
}

/** What is wrong with an admin's class defaults, in plain sentences. */
export const classSettingsProblems = (c: ClassSettings): string[] => problems(c);

/** What is wrong with a parent's choice for a child, or null if it's fine. */
export const childSettingsProblem = (child: ChildSettings): string | null => problems(child)[0] ?? null;

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
