import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClassId } from "../types";
import { planSave, resultOf } from "./plan";
import { QUESTION_COLUMNS, toQuestion, toRow, type QuestionRow } from "./rows";
import type { CheckedQuestion, QuestionRequest, QuestionStore, SaveResult, SuppliedQuestion, TopicInfo } from "./types";

function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

/**
 * The question bank through the Supabase API, for the New questions server
 * function. It must be given a service-role client: only the server writes
 * the bank, and that key never reaches the app.
 *
 * Unlike the Postgres store it can't hold a lock across calls, so two saves
 * at the same moment could plan the same new question; the insert skips a
 * question that is already there, and one with the same words under another
 * id fails the save, to be pressed again.
 */
export class SupabaseQuestionStore implements QuestionStore {
  constructor(private readonly client: SupabaseClient) {}

  async topics(): Promise<TopicInfo[]> {
    const rows = must(await this.client.from("topics").select("id, class_id, sub_skills").order("class_id").order("position")) as
      { id: string; class_id: ClassId; sub_skills: Record<string, string> }[];
    return rows.map(r => ({ id: r.id, classId: r.class_id, subSkills: Object.keys(r.sub_skills) }));
  }

  async existing(topicId: string): Promise<SuppliedQuestion[]> {
    const rows = must(await this.client.from("questions").select(QUESTION_COLUMNS).eq("topic_id", topicId).order("id")) as unknown as QuestionRow[];
    return rows.map(toQuestion);
  }

  async save(questions: CheckedQuestion[]): Promise<SaveResult> {
    if (questions.length === 0) return { added: [], updated: [], unchanged: [], duplicates: [] };
    const topicIds = [...new Set(questions.map(c => c.question.topicId))];
    const existing = (await Promise.all(topicIds.map(id => this.existing(id)))).flat();
    const plan = planSave(existing, questions);

    let added: string[] = [];
    if (plan.insert.length) {
      const inserted = must(await this.client.from("questions")
        .upsert(plan.insert.map(c => ({ ...toRow(c.question), status: c.status })), { onConflict: "id", ignoreDuplicates: true })
        .select("id")) as { id: string }[];
      added = inserted.map(r => r.id);
      const reports = new Map(plan.insert.map(c => [c.question.id, c.report]));
      if (added.length) {
        must(await this.client.from("question_checks").insert(added.map(id => ({
          question_id: id, reason: "release", passed: reports.get(id)!.passed, report: reports.get(id),
        }))));
      }
    }
    for (const c of plan.update) {
      // The question changed, so its old live results no longer apply.
      must(await this.client.from("questions")
        .update({ ...toRow(c.question), status: c.status, times_shown: 0, first_try_correct: 0 }).eq("id", c.question.id));
      must(await this.client.from("question_checks").insert({ question_id: c.question.id, reason: "release", passed: c.report.passed, report: c.report }));
    }
    // A row that moved within its file keeps its question; only the reference follows it.
    const before = new Map(existing.map(q => [q.id, q]));
    for (const c of plan.unchanged.filter(c => before.get(c.question.id)?.sourceRef !== c.question.sourceRef)) {
      must(await this.client.from("questions").update({ source_ref: c.question.sourceRef ?? null }).eq("id", c.question.id));
    }
    const result = resultOf(plan);
    // A question another save added a moment ago is there already, so it isn't counted as added here.
    return { ...result, added: result.added.filter(id => added.includes(id)) };
  }

  async logRequest(r: QuestionRequest): Promise<void> {
    must(await this.client.from("question_requests").insert({
      topic_id: r.topicId, requested_by: r.requestedBy ?? null, profile_id: r.profileId ?? null,
      added: r.added, sent_to_review: r.sentToReview,
    }));
  }
}
