import { CLASS_ORDER, type ClassId, type TopicContent } from "../types";
import { UKG_TOPICS } from "./ukg";

/** Every topic with built-in content. Each new class adds its topics here. */
export const ALL_CONTENT: TopicContent[] = [...UKG_TOPICS];

/** Classes a child can pick: only those with content, in class order. */
export const CLASSES_WITH_CONTENT: ClassId[] = CLASS_ORDER.filter(c => ALL_CONTENT.some(t => t.topic.classId === c));

export const contentForClass = (classId: ClassId): TopicContent[] =>
  ALL_CONTENT.filter(t => t.topic.classId === classId).sort((a, b) => a.topic.order - b.topic.order);
