import { describe, expect, it } from "vitest";
import { ALL_CONTENT } from "../src/content";
import { NEW_QUESTIONS_PER_DAY, newQuestionsHandler, type NewQuestionsDeps } from "../src/server/new-questions";
import { MemoryQuestionStore, seedBank, topicInfo } from "../src/supply";

const PARENT = "parent-1", ADMIN = "admin-1";

async function setup(opts: { pressedToday?: number } = {}) {
  const store = new MemoryQuestionStore(ALL_CONTENT.map(topicInfo));
  await seedBank(store, ALL_CONTENT);
  const deps: NewQuestionsDeps = {
    userFor: async token => ({ "parent-token": PARENT, "admin-token": ADMIN } as Record<string, string>)[token] ?? null,
    isAdmin: async id => id === ADMIN,
    ownsProfile: async (id, profileId) => id === PARENT && profileId === "riya",
    requestsSince: async () => opts.pressedToday ?? 0,
    store, contents: ALL_CONTENT, seed: () => 7,
  };
  const handler = newQuestionsHandler(deps);
  const post = (token: string | null, body: unknown) => handler(new Request("http://functions.test/new-questions", {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  return { store, handler, post };
}

describe("the New questions server function", () => {
  it("adds checked questions for a parent's child and logs who asked", async () => {
    const { store, post } = await setup();
    const res = await post("parent-token", { topicId: "ukg-comparing", profileId: "riya" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await res.json();
    expect(body).toMatchObject({ topicId: "ukg-comparing", asked: 80 });
    expect(body.added).toBeGreaterThan(0);
    expect(store.requests).toEqual([{ topicId: "ukg-comparing", requestedBy: PARENT, profileId: "riya", added: body.added, sentToReview: body.sentToReview }]);
  });

  it("answers the browser's check before a call from another address", async () => {
    const { handler } = await setup();
    const res = await handler(new Request("http://functions.test/new-questions", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("authorization");
  });

  it("refuses anyone not signed in, a bad request, a topic without templates and another family's child", async () => {
    const { post, handler } = await setup();
    expect((await post(null, { topicId: "ukg-comparing" })).status).toBe(401);
    expect((await post("stolen-token", { topicId: "ukg-comparing" })).status).toBe(401);
    expect((await post("parent-token", "not json")).status).toBe(400);
    expect((await post("parent-token", { topicId: "c12-calculus" })).status).toBe(404);
    const other = await post("admin-token", { topicId: "ukg-comparing", profileId: "riya" });
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: "That profile isn't in this account." });
    expect((await handler(new Request("http://functions.test/new-questions"))).status).toBe(405);
  });

  it(`lets a family ask ${NEW_QUESTIONS_PER_DAY} times a day, and an admin any number of times`, async () => {
    const { post, store } = await setup({ pressedToday: NEW_QUESTIONS_PER_DAY });
    const res = await post("parent-token", { topicId: "ukg-comparing", profileId: "riya" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch("Try again tomorrow");
    expect(store.requests).toEqual([]);
    expect((await post("admin-token", { topicId: "ukg-comparing" })).status).toBe(200);
  });
});
