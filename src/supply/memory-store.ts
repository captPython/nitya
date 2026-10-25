import type { CheckReport } from "../validation";
import { planSave, resultOf } from "./plan";
import type { CheckedQuestion, QuestionRequest, QuestionStore, SaveResult, SuppliedQuestion, TopicInfo } from "./types";

export interface MemoryRow {
  question: SuppliedQuestion;
  status: CheckedQuestion["status"];
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
}
