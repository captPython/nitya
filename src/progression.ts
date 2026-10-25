import { CLASS_ORDER, type ClassId, type Progress, type Topic } from "./types";

function inOrder(topics: Topic[], classId: ClassId): Topic[] {
  return topics.filter(t => t.classId === classId).sort((a, b) => a.order - b.order);
}

/** A fresh class: the first topic is current, the rest are locked. */
export function startClass(classId: ClassId, topics: Topic[]): Progress {
  const list = inOrder(topics, classId);
  const progress: Progress = { classId, topics: {} };
  list.forEach((t, i) => {
    progress.topics[t.id] = { state: i === 0 ? "current" : "locked", attempts: 0, bestScore: 0 };
  });
  return progress;
}

export function nextClass(classId: ClassId): ClassId | null {
  const i = CLASS_ORDER.indexOf(classId);
  return i >= 0 && i < CLASS_ORDER.length - 1 ? CLASS_ORDER[i + 1] : null;
}

export type AttemptEffect =
  | { kind: "retry" }
  | { kind: "next-topic"; topicId: string }
  | { kind: "promoted"; from: ClassId; to: ClassId | null };

/** Records a finished attempt, unlocks the next topic, and promotes when every topic is cleared. */
export function recordAttempt(
  progress: Progress,
  topics: Topic[],
  topicId: string,
  score: number,
  cleared: boolean,
): { progress: Progress; effect: AttemptEffect } {
  const entry = progress.topics[topicId];
  if (!entry || entry.state === "locked") throw new Error(`Topic ${topicId} is locked`);

  const updated: Progress = {
    ...progress,
    topics: {
      ...progress.topics,
      [topicId]: {
        state: cleared ? "cleared" : entry.state,
        attempts: entry.attempts + 1,
        bestScore: Math.max(entry.bestScore, score),
      },
    },
  };
  if (!cleared) return { progress: updated, effect: { kind: "retry" } };

  // Only the topic straight after this one can open, so replaying an earlier
  // cleared topic never skips ahead.
  const list = inOrder(topics, progress.classId);
  const next = list[list.findIndex(t => t.id === topicId) + 1];
  if (next) {
    if (updated.topics[next.id].state === "locked") {
      updated.topics[next.id] = { ...updated.topics[next.id], state: "current" };
    }
    return { progress: updated, effect: { kind: "next-topic", topicId: next.id } };
  }

  const allCleared = list.every(t => updated.topics[t.id].state === "cleared");
  if (allCleared) {
    return {
      progress: updated,
      effect: { kind: "promoted", from: progress.classId, to: nextClass(progress.classId) },
    };
  }
  return { progress: updated, effect: { kind: "retry" } };
}
