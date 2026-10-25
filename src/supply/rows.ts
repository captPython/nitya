import type { Level, QuestionFormat } from "../types";
import type { QuestionSource, SuppliedQuestion } from "./types";

/** The question table's content columns, as both stores read and write them. */
export const QUESTION_COLUMNS = `id, topic_id, sub_skill, level, format, prompt, visual, options, answers, hint, explanation, reason,
  working, variant_group, source, source_ref, generator_version`;

export interface QuestionRow {
  id: string; topic_id: string; sub_skill: string; level: number; format: string; prompt: string;
  visual: SuppliedQuestion["visual"] | null; options: string[] | null; answers: string[];
  hint: string; explanation: string; reason: string; working: SuppliedQuestion["working"] | null;
  variant_group: string | null; source: string; source_ref: string | null; generator_version: string | null;
}

/** A database row as a question, leaving out empty fields so it matches the question that was saved. */
export function toQuestion(r: QuestionRow): SuppliedQuestion {
  return {
    id: r.id, topicId: r.topic_id, subSkill: r.sub_skill, level: r.level as Level, format: r.format as QuestionFormat,
    prompt: r.prompt,
    ...(r.visual ? { visual: r.visual } : {}),
    ...(r.options ? { options: r.options } : {}),
    answers: r.answers, hint: r.hint, explanation: r.explanation, reason: r.reason,
    ...(r.working ? { working: r.working } : {}),
    ...(r.variant_group ? { variantGroup: r.variant_group } : {}),
    source: r.source as QuestionSource,
    ...(r.source_ref ? { sourceRef: r.source_ref } : {}),
    ...(r.generator_version ? { generatorVersion: r.generator_version } : {}),
  };
}

/** A question as a row, for the Supabase API, which takes JSON as it is. */
export function toRow(q: SuppliedQuestion): QuestionRow {
  return {
    id: q.id, topic_id: q.topicId, sub_skill: q.subSkill, level: q.level, format: q.format, prompt: q.prompt,
    visual: q.visual ?? null, options: q.options ?? null, answers: q.answers, hint: q.hint, explanation: q.explanation,
    reason: q.reason, working: q.working ?? null, variant_group: q.variantGroup ?? null, source: q.source,
    source_ref: q.sourceRef ?? null, generator_version: q.generatorVersion ?? null,
  };
}
