import type { TopicContent } from "../types";
import { validateQuestion } from "../validation";
import type { CheckedQuestion, SuppliedQuestion, TopicInfo } from "./types";

/** What the checks need to know about a topic with built-in content. */
export const topicInfo = (c: TopicContent): TopicInfo => ({
  id: c.topic.id, classId: c.topic.classId, subSkills: Object.keys(c.subSkillNames),
});

/**
 * Runs every check on each question. One that passes is approved; one that
 * fails goes to the admin's review queue with its report.
 */
export function checkQuestions(questions: SuppliedQuestion[], topics: TopicInfo[]): CheckedQuestion[] {
  const byId = new Map(topics.map(t => [t.id, t]));
  return questions.map(question => {
    const topic = byId.get(question.topicId);
    if (!topic) throw new Error(`Unknown topic ${question.topicId}`);
    const report = validateQuestion(question, { classId: topic.classId, subSkills: topic.subSkills });
    return { question, status: report.passed ? "approved" : "in_review", report };
  });
}
