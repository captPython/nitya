import { planFix, planUpload, type UploadPlan, type UploadResult } from "../supply/family";
import type { OwnVerdict } from "../supply/template";
import type { SuppliedQuestion } from "../supply/types";
import type { TopicContent } from "../types";

/** What the family-questions server function needs from the database. */
export interface FamilyQuestionsDeps {
  /** The user a request's sign-in token belongs to, or null if it isn't valid. */
  userFor(token: string): Promise<string | null>;
  hasConsent(userId: string): Promise<boolean>;
  /** Topic and content keys (see sameQuestionKey) of the official questions in these topics. */
  officialKeys(topicIds: string[]): Promise<Set<string>>;
  /** Topic and content keys of the family's own questions that are still in use. */
  ownKeys(userId: string): Promise<Set<string>>;
  /** Saves an upload and its questions together, returning the upload's id. */
  saveUpload(userId: string, upload: { fileName: string; private: boolean }, add: UploadPlan["add"]): Promise<string>;
  /** One of the family's questions under review, with whether its upload is private; null if it isn't theirs or isn't under review. */
  questionToFix(userId: string, questionId: string): Promise<{ question: SuppliedQuestion; private: boolean } | null>;
  saveFix(userId: string, fix: { question: SuppliedQuestion; verdict: OwnVerdict; shared: boolean }): Promise<void>;
  contents: TopicContent[];
}

export type FamilyQuestionsBody =
  | { action: "upload"; fileName: string; private: boolean; rows: unknown[] }
  | { action: "fix"; questionId: string; question: unknown };

export type FamilyQuestionsReply = UploadResult | { verdict: OwnVerdict };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const refuse = (status: number, error: string) => reply(status, { error });

/** A plain sentence for the parent, as opposed to a fault in the function. */
class Refused extends Error {}

/**
 * The family-questions server function. A signed-in parent sends the
 * questions read from their upload, or a fix of one under review. Every
 * question is rebuilt and checked again here, so what reaches the family's
 * children, and above all what goes into the community bank, never rests on
 * the app's own checks.
 */
export function familyQuestionsHandler(deps: FamilyQuestionsDeps): (req: Request) => Promise<Response> {
  return async req => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "POST") return refuse(405, "Use POST.");
    try {
      const token = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "")?.[1];
      const userId = token ? await deps.userFor(token) : null;
      if (!userId) return refuse(401, "Sign in first.");
      if (!(await deps.hasConsent(userId))) return refuse(403, "A parent must give consent first.");

      let body: Partial<Record<string, unknown>>;
      try { body = await req.json(); } catch { return refuse(400, "Send the questions as JSON."); }

      if (body.action === "upload") {
        const fileName = typeof body.fileName === "string" && body.fileName.trim() ? body.fileName.trim().slice(0, 200) : "upload";
        const rows = Array.isArray(body.rows) ? body.rows : null;
        if (!rows) return refuse(400, "Send the questions as a list.");
        const topicIds = [...new Set(deps.contents.map(c => c.topic.id))];
        let plan: UploadPlan;
        try {
          plan = planUpload({
            owner: userId, fileName, private: body.private === true, rows, contents: deps.contents,
            officialKeys: await deps.officialKeys(topicIds), ownKeys: await deps.ownKeys(userId),
          });
        } catch (err) { throw new Refused((err as Error).message); }
        const uploadId = plan.add.length ? await deps.saveUpload(userId, { fileName, private: body.private === true }, plan.add) : null;
        const out: UploadResult = { uploadId, ...plan.result };
        return reply(200, out);
      }

      if (body.action === "fix") {
        if (typeof body.questionId !== "string") return refuse(400, "Say which question to fix.");
        const before = await deps.questionToFix(userId, body.questionId);
        if (!before) return refuse(404, "That question isn't waiting for review in this account.");
        let fix: ReturnType<typeof planFix>;
        try { fix = planFix(before.question, body.question, deps.contents, before.private); } catch (err) { throw new Refused((err as Error).message); }
        await deps.saveFix(userId, fix);
        return reply(200, { verdict: fix.verdict });
      }
      return refuse(400, "The action must be upload or fix.");
    } catch (err) {
      if (err instanceof Refused) return refuse(400, err.message);
      // The one database rule a parent's fix can break, said plainly.
      if (/content_key/.test((err as Error).message)) return refuse(409, "You already have this question.");
      return refuse(500, (err as Error).message || "Something went wrong.");
    }
  };
}
