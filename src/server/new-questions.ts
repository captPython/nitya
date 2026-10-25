import { addNewQuestions } from "../supply/run";
import type { QuestionStore } from "../supply/types";
import type { TopicContent } from "../types";

/** How often a family can press New questions in a day. Admins have no limit. */
export const NEW_QUESTIONS_PER_DAY = 10;

/** What the New questions server function needs from the database. */
export interface NewQuestionsDeps {
  /** The user a request's sign-in token belongs to, or null if it isn't valid. */
  userFor(token: string): Promise<string | null>;
  isAdmin(userId: string): Promise<boolean>;
  ownsProfile(userId: string, profileId: string): Promise<boolean>;
  /** How many times this user has pressed New questions since `since`. */
  requestsSince(userId: string, since: Date): Promise<number>;
  store: QuestionStore;
  /** Topics with templates. */
  contents: TopicContent[];
  now?: () => Date;
  seed?: () => number;
}

export interface NewQuestionsReply {
  topicId: string;
  added: number;
  sentToReview: number;
  asked: number;
}

// The app is served from another address than the function, so the browser asks first.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const refuse = (status: number, error: string) => reply(status, { error });

/**
 * The New questions server function. A signed-in admin, parent or child (on
 * their parent's account) asks for a topic; it makes questions from the
 * topic's templates, checks each one, saves them (approved, or held for the
 * admin's review) and logs the request. Families can press it
 * NEW_QUESTIONS_PER_DAY times a day.
 */
export function newQuestionsHandler(deps: NewQuestionsDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const seed = deps.seed ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]);
  return async req => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "POST") return refuse(405, "Use POST.");
    try {
      const token = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "")?.[1];
      const userId = token ? await deps.userFor(token) : null;
      if (!userId) return refuse(401, "Sign in first.");

      let body: { topicId?: unknown; profileId?: unknown };
      try { body = await req.json(); } catch { return refuse(400, "Send the topic as JSON."); }
      const content = deps.contents.find(c => c.topic.id === body.topicId);
      if (!content) return refuse(404, "That topic has no question templates.");
      const profileId = typeof body.profileId === "string" ? body.profileId : undefined;
      if (profileId && !(await deps.ownsProfile(userId, profileId))) return refuse(403, "That profile isn't in this account.");

      if (!(await deps.isAdmin(userId))) {
        const dayAgo = new Date(now().getTime() - 24 * 60 * 60 * 1000);
        if ((await deps.requestsSince(userId, dayAgo)) >= NEW_QUESTIONS_PER_DAY) {
          return refuse(429, `New questions can be asked for ${NEW_QUESTIONS_PER_DAY} times a day. Try again tomorrow.`);
        }
      }

      const summary = await addNewQuestions(deps.store, content, { seed: seed(), requestedBy: userId, profileId });
      const out: NewQuestionsReply = {
        topicId: summary.topicId, added: summary.approved.length, sentToReview: summary.inReview.length, asked: summary.asked,
      };
      return reply(200, out);
    } catch (err) {
      return refuse(500, (err as Error).message || "Something went wrong.");
    }
  };
}
