import type pg from "pg";
import type { ClassId } from "../types";
import { planSave, resultOf } from "./plan";
import { QUESTION_COLUMNS as COLUMNS, toQuestion, type QuestionRow } from "./rows";
import type { CheckedQuestion, QuestionRequest, QuestionStore, SaveResult, SuppliedQuestion, TopicInfo } from "./types";

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/** The values for every content column, in COLUMNS order, plus the status. */
function values(c: CheckedQuestion) {
  const q = c.question;
  return [
    q.id, q.topicId, q.subSkill, q.level, q.format, q.prompt, json(q.visual), q.options ?? null, q.answers, q.hint,
    q.explanation, q.reason, json(q.working), q.variantGroup ?? null, q.source, q.sourceRef ?? null,
    q.generatorVersion ?? null, c.status,
  ];
}

/**
 * The question bank in Nitya's Supabase database. It connects as the database
 * owner (the scripts use the project's connection string), so row-level
 * security doesn't apply: only the server and the scripts use it.
 */
export class PgQuestionStore implements QuestionStore {
  constructor(private readonly db: pg.ClientBase) {}

  async topics(): Promise<TopicInfo[]> {
    const { rows } = await this.db.query<{ id: string; class_id: ClassId; sub_skills: Record<string, string> }>(
      "select id, class_id, sub_skills from public.topics order by class_id, position",
    );
    return rows.map(r => ({ id: r.id, classId: r.class_id, subSkills: Object.keys(r.sub_skills) }));
  }

  async existing(topicId: string): Promise<SuppliedQuestion[]> {
    const { rows } = await this.db.query<QuestionRow>(`select ${COLUMNS} from public.questions where topic_id = $1 order by id`, [topicId]);
    return rows.map(toQuestion);
  }

  async save(questions: CheckedQuestion[]): Promise<SaveResult> {
    if (questions.length === 0) return { added: [], updated: [], unchanged: [], duplicates: [] };
    const topicIds = [...new Set(questions.map(c => c.question.topicId))];
    const ids = questions.map(c => c.question.id);
    await this.db.query("begin");
    try {
      // One save at a time, so two imports running at once can't plan against the same old rows.
      await this.db.query("select pg_advisory_xact_lock(hashtext('nitya.questions.save'))");
      const { rows } = await this.db.query<QuestionRow>(
        `select ${COLUMNS} from public.questions where topic_id = any($1) or id = any($2)`, [topicIds, ids],
      );
      const plan = planSave(rows.map(toQuestion), questions);
      for (const c of plan.insert) {
        await this.db.query(
          `insert into public.questions (${COLUMNS}, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          values(c),
        );
        await this.recordCheck(c);
      }
      for (const c of plan.update) {
        // The question changed, so its old live results no longer apply.
        await this.db.query(
          `update public.questions set
             topic_id = $2, sub_skill = $3, level = $4, format = $5, prompt = $6, visual = $7, options = $8, answers = $9,
             hint = $10, explanation = $11, reason = $12, working = $13, variant_group = $14, source = $15,
             source_ref = $16, generator_version = $17, status = $18, times_shown = 0, first_try_correct = 0
           where id = $1`,
          values(c),
        );
        await this.recordCheck(c);
      }
      // A row that moved within its file keeps its question; only the reference follows it.
      for (const c of plan.unchanged) {
        await this.db.query(
          "update public.questions set source_ref = $2 where id = $1 and source_ref is distinct from $2",
          [c.question.id, c.question.sourceRef ?? null],
        );
      }
      await this.db.query("commit");
      return resultOf(plan);
    } catch (err) {
      await this.db.query("rollback");
      throw err;
    }
  }

  async logRequest(r: QuestionRequest): Promise<void> {
    await this.db.query(
      `insert into public.question_requests (topic_id, requested_by, profile_id, added, sent_to_review)
       values ($1, $2, $3, $4, $5)`,
      [r.topicId, r.requestedBy ?? null, r.profileId ?? null, r.added, r.sentToReview],
    );
  }

  private async recordCheck(c: CheckedQuestion) {
    await this.db.query(
      "insert into public.question_checks (question_id, reason, passed, report) values ($1, 'release', $2, $3)",
      [c.question.id, c.report.passed, JSON.stringify(c.report)],
    );
  }
}
