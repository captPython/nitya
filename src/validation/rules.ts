import type { ClassId, Level } from "../types";

/**
 * Syllabus limits for a class. Only classes with content have limits so far:
 * a question for any other class fails the scope check and goes to manual
 * review until its class's limits are added here.
 */
export interface ClassScope {
  minNumber: number;
  maxNumber: number;
  /** Longest question a child of this class is asked to read, in words. */
  maxPromptWords: number;
}

export const CLASS_SCOPES: Partial<Record<ClassId, ClassScope>> = {
  UKG: { minNumber: 0, maxNumber: 50, maxPromptWords: 25 },
};

/** Extra limits for one topic, such as "sums up to 10". */
export interface TopicScope {
  /** Biggest result a child works out on the way to the answer. */
  maxResult: number;
}

export const TOPIC_SCOPES: Record<string, TopicScope> = {
  "ukg-addition-10": { maxResult: 10 },
  "ukg-subtraction-10": { maxResult: 10 },
};

/** Options a tap question may show. */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

/**
 * Words that must never reach a child. A short, cautious list: the admin's
 * manual review is the real safety net, and this only catches the obvious.
 */
export const UNSAFE_WORDS = [
  "blood", "bloody", "bomb", "dead", "death", "die", "died", "dies", "drown", "drowned", "dumb", "fat", "gun", "guns",
  "hate", "hit", "hits", "idiot", "kill", "killed", "kills", "knife", "loser", "murder", "scary", "shoot", "shot",
  "stupid", "ugly", "weapon", "beer", "wine", "cigarette", "drugs",
];

/** First-try success rate a level should have. A band covers minRate <= rate < maxRate; L1 also includes 100%. */
export interface LevelBand {
  level: Level;
  minRate: number;
  maxRate: number;
}

/** The starting bands, the same as the database's level_bands table. */
export const DEFAULT_BANDS: LevelBand[] = [
  { level: 1, minRate: 0.85, maxRate: 1 },
  { level: 2, minRate: 0.65, maxRate: 0.85 },
  { level: 3, minRate: 0.5, maxRate: 0.65 },
  { level: 4, minRate: 0, maxRate: 0.5 },
];

/** Plays a question needs before its success rate says anything about its level. */
export const MIN_PLAYS_FOR_BAND_CHECK = 30;
