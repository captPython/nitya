import { contentKey } from "../content/gen";
import { fingerprint } from "./generate";
import type { CheckedQuestion, SaveResult, SuppliedQuestion } from "./types";

/** What saving a batch does to each question. Both stores follow this plan. */
export interface SavePlan {
  insert: CheckedQuestion[];
  update: CheckedQuestion[];
  /** Same id and nothing a child sees has changed. */
  unchanged: CheckedQuestion[];
  /** The bank already has the same words and picture under another id. */
  duplicates: CheckedQuestion[];
}

/**
 * Decides, for a batch of checked questions, which are new, which change an
 * existing question, which are unchanged and which repeat another question.
 * `existing` is every question already in the batch's topics.
 */
export function planSave(existing: SuppliedQuestion[], incoming: CheckedQuestion[]): SavePlan {
  const byId = new Map(existing.map(q => [q.id, q]));
  // Same words and picture in one topic is the same question, whatever its level.
  const owner = new Map(existing.map(q => [`${q.topicId}|${contentKey(q)}`, q.id]));
  const plan: SavePlan = { insert: [], update: [], unchanged: [], duplicates: [] };
  for (const c of incoming) {
    const q = c.question;
    const key = `${q.topicId}|${contentKey(q)}`;
    const old = byId.get(q.id);
    const taken = owner.get(key);
    if (old && fingerprint(old) === fingerprint(q)) plan.unchanged.push(c);
    else if (taken !== undefined && taken !== q.id) plan.duplicates.push(c);
    else {
      (old ? plan.update : plan.insert).push(c);
      if (old) owner.delete(`${old.topicId}|${contentKey(old)}`);
      owner.set(key, q.id);
      byId.set(q.id, q);
    }
  }
  return plan;
}

export const resultOf = (plan: SavePlan): SaveResult => ({
  added: plan.insert.map(c => c.question.id),
  updated: plan.update.map(c => c.question.id),
  unchanged: plan.unchanged.map(c => c.question.id),
  duplicates: plan.duplicates.map(c => c.question.id),
});
