import { mulberry32 } from "../content/gen";
import { CLASS_ORDER, type ClassId, type Level, type Question, type TopicContent } from "../types";
import { CLASS_NAMES } from "./options";

/** About 5 minutes for a young child: 10 questions at roughly 30 seconds each. */
export const PLACEMENT_LENGTH = 10;
/** At or above this share right, the next class may suit the child better. */
export const MOVE_UP_AT = 0.9;
/** Below this share right, the class before may be a gentler start. */
export const MOVE_DOWN_BELOW = 0.4;

/**
 * Questions for the placement check: from the class the parent picked, one
 * per topic at L2, then L3, then L4, easiest first, never two with the same maths.
 */
export function placementQuestions(classId: ClassId, contents: TopicContent[], seed: number): Question[] {
  const r = mulberry32(seed);
  const topics = contents.filter(t => t.topic.classId === classId).sort((a, b) => a.topic.order - b.topic.order);
  const picked: Question[] = [];
  for (const level of [2, 3, 4] as Level[]) {
    for (const t of topics) {
      if (picked.length >= PLACEMENT_LENGTH) return picked;
      const pool = t.bank.filter(q => q.level === level && !picked.some(p => p.variantGroup && p.variantGroup === q.variantGroup));
      if (pool.length) picked.push(pool[Math.floor(r() * pool.length)]);
    }
  }
  return picked;
}

export interface PlacementSuggestion {
  suggested: ClassId;
  /** One line for the parent, using only the child's nickname. */
  message: string;
}

/** Suggests a starting class from the placement answers. The parent confirms it. */
export function placementSuggestion(
  classId: ClassId, nickname: string, results: boolean[], classes: ClassId[],
): PlacementSuggestion {
  const rate = results.length ? results.filter(Boolean).length / results.length : 0;
  const i = CLASS_ORDER.indexOf(classId);
  const up = CLASS_ORDER[i + 1], down = CLASS_ORDER[i - 1];
  const name = CLASS_NAMES[classId];
  if (rate >= MOVE_UP_AT) {
    return up && classes.includes(up)
      ? { suggested: up, message: `${nickname} got almost everything right. ${CLASS_NAMES[up]} may suit ${nickname} better.` }
      : { suggested: classId, message: `${nickname} got almost everything right. ${name} is the highest class Nitya has so far, so start there.` };
  }
  if (rate < MOVE_DOWN_BELOW) {
    return down && classes.includes(down)
      ? { suggested: down, message: `${nickname} found these hard. ${CLASS_NAMES[down]} may be a gentler start.` }
      : { suggested: classId, message: `${nickname} found these hard. ${name} quizzes start with easy questions, so this is a good place to begin.` };
  }
  return { suggested: classId, message: `${name} looks right for ${nickname}.` };
}
