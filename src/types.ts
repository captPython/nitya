import type { Template } from "./content/gen";

export type ClassId =
  | "LKG" | "UKG"
  | "C1" | "C2" | "C3" | "C4" | "C5" | "C6"
  | "C7" | "C8" | "C9" | "C10" | "C11" | "C12";

export const CLASS_ORDER: ClassId[] = [
  "LKG", "UKG", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11", "C12",
];

export type Level = 1 | 2 | 3 | 4;

export const QUESTION_FORMATS = [
  "tap-picture", "match", "drag-drop", "count", "audio", "pattern", "balance",
  "number-line", "mcq", "fill-blank", "true-false", "numeric", "multi-step",
] as const;

export type QuestionFormat = (typeof QUESTION_FORMATS)[number];

/** Dots drawn above the question. `crossed` dots are shown taken away. */
export interface DotGroup {
  count: number;
  color: "blue" | "orange";
  crossed?: number;
}

export interface Visual {
  kind: "dots";
  groups: DotGroup[];
}

/**
 * A number in a question's working: a literal, the unknown `x`, the dots in
 * one picture group (`dots` is the group's index), or a sum or difference.
 */
export type Expr = number | "x" | { dots: number } | { op: "+" | "-"; args: Expr[] };

/**
 * How a question's answer is worked out, written so the validation engine can
 * recompute it on its own instead of trusting the generator.
 */
export type Working =
  /** The answer is the value of `expr`. */
  | { kind: "arith"; expr: Expr }
  /** The answer is the number of dots in the picture that are not crossed out. */
  | { kind: "count-dots" }
  /** The answer is the `x` that makes `lhs` equal `rhs`. */
  | { kind: "missing"; lhs: Expr; rhs: Expr }
  /** The answer is the blank (null) in a sequence that goes up or down by a fixed step. */
  | { kind: "sequence"; terms: (number | null)[] }
  /** The answer is a number bigger than `above` and smaller than `below`. */
  | { kind: "between"; above: number; below: number }
  /** The answer is the label whose value is biggest (or smallest), or `tieLabel` when they are equal. */
  | { kind: "extreme"; of: "max" | "min"; items: { label: string; expr: Expr }[]; tieLabel?: string }
  /** The answer is the label whose value equals `target`. */
  | { kind: "equals"; target: number; items: { label: string; expr: Expr }[] }
  /** The answer is `values` sorted, written "a, b, c". */
  | { kind: "order"; values: number[]; direction: "asc" | "desc" }
  /** The answer is the number that `word` names, like "seven". */
  | { kind: "number-word"; word: string };

export interface Question {
  id: string;
  topicId: string;
  subSkill: string;
  level: Level;
  format: QuestionFormat;
  prompt: string;
  visual?: Visual;
  options?: string[];
  /** Every accepted answer. A question with several right answers lists each one. */
  answers: string[];
  hint: string;
  /** Step-by-step working shown after a wrong answer. */
  explanation: string;
  /** One-line reason shown with the praise after a right answer. */
  reason: string;
  /** How the answer is worked out. Imported questions may not have one. */
  working?: Working;
  /** Questions with the same maths (like "3 + 4" and "4 + 3") share a group and never meet in one quiz. */
  variantGroup?: string;
}

export interface Topic {
  id: string;
  classId: ClassId;
  order: number;
  title: string;
}

export interface ResponseRecord {
  questionId: string;
  level: Level;
  marksDelta: number;
  subSkill: string;
  firstTryCorrect: boolean;
  retryCorrect: boolean | null;
}

export interface QuizState {
  classId: ClassId;
  topicId: string;
  attemptNo: number;
  level: Level;
  rightStreak: number;
  wrongStreak: number;
  correct: number;
  hardCorrect: number;
  /** Level-weighted marks; wrong first tries take marks away. */
  marks: number;
  /** Marks needed to clear the topic: the admin's default, or the parent's choice for this child. */
  passMarks: number;
  /** Marks a wrong first try takes away. */
  wrongPenalty: number;
  asked: string[];
  seenBefore: string[];
  /** Set while the child is on the hint retry for a question they got wrong. */
  pendingRetry: string | null;
  responses: ResponseRecord[];
}

export type TopicState = "locked" | "current" | "cleared";

export interface Progress {
  classId: ClassId;
  /** bestScore holds the best marks from any attempt. */
  topics: Record<string, { state: TopicState; attempts: number; bestScore: number }>;
}

export interface LessonScreen {
  title: string;
  text: string;
  visual?: Visual;
}

export interface TryIt {
  prompt: string;
  visual?: Visual;
  options: string[];
  answer: string;
  praise: string;
  help: string;
}

/** Everything one topic ships with: the lesson, its Try it check and the question bank. */
export interface TopicContent {
  topic: Topic;
  lesson: LessonScreen[];
  tryIt: TryIt;
  /** The templates behind the bank. A new seed makes new questions from them. */
  generator: { seed: number; templates: Record<Level, Template[]> };
  bank: Question[];
  /** Friendly names for sub-skills, shown in improvement areas. */
  subSkillNames: Record<string, string>;
}
