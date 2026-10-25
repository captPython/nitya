import { describe, expect, it } from "vitest";
import { nextClass, recordAttempt, startClass } from "../src/progression";
import type { Topic } from "../src/types";

const topics: Topic[] = [
  { id: "t1", classId: "LKG", order: 1, title: "Sorting" },
  { id: "t2", classId: "LKG", order: 2, title: "Counting 1 to 10" },
  { id: "t3", classId: "LKG", order: 3, title: "Shapes" },
];

describe("progression", () => {
  it("opens only the first topic", () => {
    const p = startClass("LKG", topics);
    expect(p.topics.t1.state).toBe("current");
    expect(p.topics.t2.state).toBe("locked");
    expect(p.topics.t3.state).toBe("locked");
  });

  it("refuses a locked topic", () => {
    const p = startClass("LKG", topics);
    expect(() => recordAttempt(p, topics, "t2", 20, true)).toThrow();
  });

  it("keeps the topic current after a failed attempt", () => {
    const { progress, effect } = recordAttempt(startClass("LKG", topics), topics, "t1", 12, false);
    expect(effect.kind).toBe("retry");
    expect(progress.topics.t1).toEqual({ state: "current", attempts: 1, bestScore: 12 });
  });

  it("unlocks the next topic in order when one is cleared", () => {
    const { progress, effect } = recordAttempt(startClass("LKG", topics), topics, "t1", 18, true);
    expect(effect).toEqual({ kind: "next-topic", topicId: "t2" });
    expect(progress.topics.t2.state).toBe("current");
    expect(progress.topics.t3.state).toBe("locked");
  });

  it("promotes only when every topic is cleared", () => {
    let p = startClass("LKG", topics);
    p = recordAttempt(p, topics, "t1", 18, true).progress;
    p = recordAttempt(p, topics, "t2", 17, true).progress;
    const last = recordAttempt(p, topics, "t3", 16, true);
    expect(last.effect).toEqual({ kind: "promoted", from: "LKG", to: "UKG" });
  });

  it("replaying an earlier cleared topic does not skip ahead", () => {
    let p = startClass("LKG", topics);
    p = recordAttempt(p, topics, "t1", 50, true).progress; // t2 now current
    const replay = recordAttempt(p, topics, "t1", 60, true);
    expect(replay.effect).toEqual({ kind: "next-topic", topicId: "t2" });
    expect(replay.progress.topics.t2.state).toBe("current");
    expect(replay.progress.topics.t3.state).toBe("locked");
    expect(replay.progress.topics.t1.bestScore).toBe(60);
  });

  it("keeps a cleared topic cleared after a weaker replay", () => {
    let p = startClass("LKG", topics);
    p = recordAttempt(p, topics, "t1", 50, true).progress;
    const replay = recordAttempt(p, topics, "t1", 10, false);
    expect(replay.progress.topics.t1).toEqual({ state: "cleared", attempts: 2, bestScore: 50 });
  });

  it("runs LKG to Class 12 and stops after Class 12", () => {
    expect(nextClass("LKG")).toBe("UKG");
    expect(nextClass("UKG")).toBe("C1");
    expect(nextClass("C11")).toBe("C12");
    expect(nextClass("C12")).toBeNull();
  });
});
