import { checkQuestions } from "../supply/check";
import { parsePicture, parseWorking, pictureText, workingText } from "../supply/csv";
import type { SuppliedQuestion, TopicInfo } from "../supply/types";
import type { Level } from "../types";
import type { CheckReport } from "../validation";

/** A question waiting in the admin's review queue, with the check run that sent it there. */
export interface ReviewEntry {
  question: SuppliedQuestion;
  /** The latest check run, or null if it has none. */
  report: CheckReport | null;
  checkedAt: string | null;
}

/**
 * The admin's decision on a question in the queue. A fix changes the question
 * and approves it, with the checks run again on the new version.
 */
export type Review =
  | { decision: "approved" | "rejected"; note?: string }
  | { decision: "fixed"; question: SuppliedQuestion; report: CheckReport; note?: string };

/**
 * CSV questions are fixed in the Drive file: the next sync would put the
 * file's version back over a fix made here.
 */
export const canFixHere = (q: SuppliedQuestion) => q.source !== "csv";

/** The fields of the fix form, as text. */
export interface QuestionEdits {
  prompt: string;
  /** Separated by "|", as in the CSV. */
  options: string;
  answers: string;
  level: string;
  subSkill: string;
  hint: string;
  explanation: string;
  reason: string;
  /** Like "3 blue, 2 orange", or empty for no picture. */
  picture: string;
  /** Like "4 + 3", "count dots" or JSON, or empty. */
  working: string;
}

const list = (text: string) => text.split("|").map(s => s.trim()).filter(Boolean);

export function editsOf(q: SuppliedQuestion): QuestionEdits {
  return {
    prompt: q.prompt, options: (q.options ?? []).join(" | "), answers: q.answers.join(" | "), level: String(q.level),
    subSkill: q.subSkill, hint: q.hint, explanation: q.explanation, reason: q.reason,
    picture: pictureText(q.visual), working: workingText(q.working),
  };
}

/**
 * The question with the admin's edits. It keeps its id, topic, format and
 * source. Throws a plain sentence when a field can't be read.
 */
export function applyEdits(q: SuppliedQuestion, e: QuestionEdits): SuppliedQuestion {
  const level = Number(e.level);
  if (![1, 2, 3, 4].includes(level)) throw new Error("The level must be 1, 2, 3 or 4.");
  const answers = list(e.answers);
  if (!answers.length) throw new Error("Give the right answer.");
  if (!e.prompt.trim()) throw new Error("The question can't be empty.");
  const options = list(e.options);
  const { visual: _v, working: _w, options: _o, ...rest } = q;
  return {
    ...rest,
    prompt: e.prompt.trim(), answers, level: level as Level, subSkill: e.subSkill.trim(),
    hint: e.hint.trim(), explanation: e.explanation.trim(), reason: e.reason.trim(),
    ...(options.length ? { options } : {}),
    ...(e.picture.trim() ? { visual: parsePicture(e.picture) } : {}),
    ...(e.working.trim() ? { working: parseWorking(e.working) } : {}),
  };
}

/** Runs every check on the edited question, as on the way into the bank. */
export function recheck(q: SuppliedQuestion, topics: TopicInfo[]): CheckReport {
  return checkQuestions([q], topics)[0].report;
}
