import type { Review } from "../admin/review";
import { contentKey } from "../content/gen";
import type { Level } from "../types";
import type { CheckReport } from "../validation";
import { planSave, resultOf } from "./plan";
import type { CheckedQuestion, QuestionRequest, QuestionStore, SaveResult, SuppliedQuestion, TopicInfo } from "./types";

export interface MemoryRow {
  question: SuppliedQuestion;
  status: CheckedQuestion["status"] | "rejected";
  /** Every check record, newest last. */
  checks: CheckReport[];
  timesShown: number;
  firstTryCorrect: number;
}

/** A question store held in memory, for the preview and the unit tests. It follows the same plan as the Postgres store. */
export class MemoryQuestionStore implements QuestionStore {
  readonly rows = new Map<string, MemoryRow>();
  readonly requests: QuestionRequest[] = [];

  constructor(private readonly topicList: TopicInfo[]) {}

  async topics() { return this.topicList; }

  async existing(topicId: string) {
    return [...this.rows.values()].filter(r => r.question.topicId === topicId).map(r => r.question);
  }

  async save(questions: CheckedQuestion[]): Promise<SaveResult> {
    const plan = planSave([...this.rows.values()].map(r => r.question), questions);
    for (const c of plan.insert) {
      this.rows.set(c.question.id, { question: c.question, status: c.status, checks: [c.report], timesShown: 0, firstTryCorrect: 0 });
    }
    for (const c of plan.update) {
      const row = this.rows.get(c.question.id)!;
      Object.assign(row, { question: c.question, status: c.status, timesShown: 0, firstTryCorrect: 0 });
      row.checks.push(c.report);
    }
    return resultOf(plan);
  }

  async logRequest(request: QuestionRequest) { this.requests.push(request); }

  /** The admin's decision on a question in the review queue, with the database's rules. */
  review(questionId: string, review: Review) {
    const row = this.rows.get(questionId);
    if (!row) throw new Error(`There is no question ${questionId}.`);
    if (row.status !== "in_review") throw new Error("This question was already reviewed.");
    if (review.decision === "fixed") {
      if (row.question.source === "csv") throw new Error("Fix CSV questions in the Drive file, so the next sync keeps the fix.");
      const q = review.question;
      const key = `${q.topicId}|${contentKey(q)}`;
      for (const other of this.rows.values()) {
        if (other !== row && `${other.question.topicId}|${contentKey(other.question)}` === key) {
          throw new Error(`The bank already has this question (${other.question.id}).`);
        }
      }
      Object.assign(row, { question: { ...q, id: row.question.id, topicId: row.question.topicId }, status: "approved", timesShown: 0, firstTryCorrect: 0 });
      row.checks.push(review.report);
    } else {
      row.status = review.decision;
    }
  }

  /** The admin's decision on a flagged question, which stays approved unless it is removed. */
  flagDecision(questionId: string, d: { kind: "level"; level: Level } | { kind: "fix"; question: SuppliedQuestion; report: CheckReport } | { kind: "remove" }) {
    const row = this.rows.get(questionId);
    if (!row || row.status !== "approved") throw new Error(`There is no question ${questionId}.`);
    if (d.kind === "remove") { row.status = "rejected"; return; }
    if (d.kind === "level") { Object.assign(row, { question: { ...row.question, level: d.level }, timesShown: 0, firstTryCorrect: 0 }); return; }
    if (row.question.source === "csv") throw new Error("Fix CSV questions in the Drive file, so the next sync keeps the fix.");
    const key = `${row.question.topicId}|${contentKey(d.question)}`;
    for (const other of this.rows.values()) {
      if (other !== row && `${other.question.topicId}|${contentKey(other.question)}` === key) {
        throw new Error(`The bank already has this question (${other.question.id}).`);
      }
    }
    Object.assign(row, { question: { ...d.question, id: row.question.id, topicId: row.question.topicId }, timesShown: 0, firstTryCorrect: 0 });
    row.checks.push(d.report);
  }

  /** Puts an approved question back in the review queue, with the check run that sent it. */
  sendToReview(questionId: string, report: CheckReport) {
    const row = this.rows.get(questionId);
    if (!row || row.status !== "approved") throw new Error(`Question ${questionId} isn't an approved question.`);
    row.status = "in_review";
    row.checks.push(report);
  }
}
