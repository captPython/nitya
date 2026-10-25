export type ClassId =
  | "LKG" | "UKG"
  | "C1" | "C2" | "C3" | "C4" | "C5" | "C6"
  | "C7" | "C8" | "C9" | "C10" | "C11" | "C12";

export const CLASS_ORDER: ClassId[] = [
  "LKG", "UKG", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11", "C12",
];

export type Level = 1 | 2 | 3 | 4;

export type QuestionFormat =
  | "tap-picture" | "match" | "drag-drop" | "count" | "audio" | "pattern" | "balance"
  | "number-line" | "mcq" | "fill-blank" | "true-false" | "numeric" | "multi-step";

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
  bank: Question[];
  /** Friendly names for sub-skills, shown in improvement areas. */
  subSkillNames: Record<string, string>;
}
