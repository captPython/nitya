import { startClass } from "../progression";
import type { ClassId, Level, Progress, Topic, TopicState } from "../types";

/** One play of a topic: a quiz, or a practice round on one skill. */
export interface AttemptRow {
  id: string;
  topicId: string;
  /** Counts every play of the topic, quizzes and practice, from 1. */
  attemptNo: number;
  practice: boolean;
  startedAt: string;
  finishedAt: string | null;
  marks: number | null;
  cleared: boolean | null;
  stars: number | null;
}

/** One question answered in a play. */
export interface ResponseRow {
  attemptId: string;
  seq: number;
  questionId: string;
  level: Level;
  subSkill: string;
  firstTryCorrect: boolean;
  retryCorrect: boolean | null;
  marksDelta: number;
}

export interface TopicProgressRow {
  topicId: string;
  state: TopicState;
  attempts: number;
  bestMarks: number;
}

/** Everything saved for one child. This is also what a parent downloads. */
export interface ProfileData {
  attempts: AttemptRow[];
  responses: ResponseRow[];
  topics: TopicProgressRow[];
}

export const emptyProfileData = (): ProfileData => ({ attempts: [], responses: [], topics: [] });

type Tally = { right: number; total: number };

/** What the dashboard and the quiz need, worked out from a child's saved plays. */
export interface ProgressSummary {
  progress: Progress;
  /** Questions asked in each topic, each once, the most recent last: the quiz avoids these first. */
  seen: Record<string, string[]>;
  /** Best stars in each cleared topic. */
  stars: Record<string, number>;
  /** First-try results by "topicId|subSkill". */
  skills: Record<string, Tally>;
  /** First-try results by level. */
  levels: Partial<Record<Level, Tally>>;
  /** Every topic in the class is cleared. */
  promoted: boolean;
  /** Plays of each topic so far, so the next play's number is one more. */
  plays: Record<string, number>;
}

export function summarize(classId: ClassId, topics: Topic[], data: ProfileData): ProgressSummary {
  const progress = startClass(classId, topics);
  for (const row of data.topics) {
    if (progress.topics[row.topicId]) progress.topics[row.topicId] = { state: row.state, attempts: row.attempts, bestScore: row.bestMarks };
  }
  const attempts = [...data.attempts].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.attemptNo - b.attemptNo);
  const byAttempt = new Map(attempts.map(a => [a.id, a]));
  const order = new Map(attempts.map((a, i) => [a.id, i]));
  const responses = data.responses
    .filter(r => byAttempt.has(r.attemptId))
    .sort((a, b) => order.get(a.attemptId)! - order.get(b.attemptId)! || a.seq - b.seq);

  const summary: ProgressSummary = { progress, seen: {}, stars: {}, skills: {}, levels: {}, promoted: false, plays: {} };
  for (const a of attempts) {
    summary.plays[a.topicId] = Math.max(summary.plays[a.topicId] ?? 0, a.attemptNo);
    if (a.cleared && a.stars) summary.stars[a.topicId] = Math.max(summary.stars[a.topicId] ?? 0, a.stars);
  }
  for (const r of responses) {
    const topicId = byAttempt.get(r.attemptId)!.topicId;
    const list = (summary.seen[topicId] ??= []);
    const at = list.indexOf(r.questionId);
    if (at >= 0) list.splice(at, 1);
    list.push(r.questionId);
    const skill = (summary.skills[`${topicId}|${r.subSkill}`] ??= { right: 0, total: 0 });
    const level = (summary.levels[r.level] ??= { right: 0, total: 0 });
    skill.total++; level.total++;
    if (r.firstTryCorrect) { skill.right++; level.right++; }
  }
  const states = Object.values(progress.topics);
  summary.promoted = states.length > 0 && states.every(t => t.state === "cleared");
  return summary;
}
