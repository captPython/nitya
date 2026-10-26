import type { SupabaseClient } from "@supabase/supabase-js";
import { QUESTION_COLUMNS, toQuestion, toRow, type QuestionRow } from "../supply/rows";
import { SupabaseQuestionStore } from "../supply/supabase-store";
import { sameQuestionKey, type OwnVerdict } from "../supply/template";
import type { SuppliedQuestion } from "../supply/types";
import type { Visual } from "../types";
import type { FamilyQuestionsDeps } from "./family-questions";
import type { NewQuestionsDeps } from "./new-questions";

/**
 * The New questions function's database calls, through a service-role client.
 * The service role skips row-level security, so every family check is made
 * here by hand. `userFor` is Supabase Auth's check of the caller's token.
 */
export function supabaseDeps(admin: SupabaseClient): Omit<NewQuestionsDeps, "contents"> {
  const count = async (q: PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
    const { count: n, error } = await q;
    if (error) throw new Error(error.message);
    return n ?? 0;
  };
  return {
    async userFor(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error ? null : data.user?.id ?? null;
    },
    isAdmin: async userId => (await count(admin.from("admins").select("user_id", { count: "exact", head: true }).eq("user_id", userId))) > 0,
    ownsProfile: async (userId, profileId) =>
      (await count(admin.from("profiles").select("id", { count: "exact", head: true }).eq("id", profileId).eq("parent_id", userId))) > 0,
    requestsSince: (userId, since) =>
      count(admin.from("question_requests").select("id", { count: "exact", head: true }).eq("requested_by", userId).gte("requested_at", since.toISOString())),
    store: new SupabaseQuestionStore(admin),
  };
}

/**
 * The family-questions function's database calls, through a service-role
 * client. The service role skips row-level security, so every call is
 * limited to the caller's own rows by hand.
 */
export function familyDeps(admin: SupabaseClient): Omit<FamilyQuestionsDeps, "contents"> {
  const must = <T>(res: { data: T | null; error: { message: string } | null }): T => {
    if (res.error) throw new Error(res.error.message);
    return res.data as T;
  };
  const keysOf = (rows: { topic_id: string; prompt: string; visual: Visual | null }[]) =>
    new Set(rows.map(r => sameQuestionKey({ topicId: r.topic_id, prompt: r.prompt, ...(r.visual ? { visual: r.visual } : {}) })));
  const familyRow = (userId: string, c: { question: SuppliedQuestion; verdict: OwnVerdict; shared: boolean }) => ({
    ...toRow(c.question), owner: userId, status: c.verdict.status === "ready" ? "approved" : "in_review",
    problems: c.verdict.problems, shared: c.shared,
  });
  return {
    async userFor(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error ? null : data.user?.id ?? null;
    },
    hasConsent: async userId => (must(await admin.from("consents").select("id").eq("parent_id", userId).limit(1)) as unknown[]).length > 0,
    officialKeys: async topicIds =>
      keysOf(must(await admin.from("questions").select("topic_id, prompt, visual").in("topic_id", topicIds).neq("source", "upload")) as
        { topic_id: string; prompt: string; visual: Visual | null }[]),
    ownKeys: async userId =>
      keysOf(must(await admin.from("questions").select("topic_id, prompt, visual").eq("owner", userId).neq("status", "rejected")) as
        { topic_id: string; prompt: string; visual: Visual | null }[]),
    async saveUpload(userId, upload, add) {
      const { id } = must(await admin.from("question_uploads")
        .insert({ parent_id: userId, file_name: upload.fileName, private: upload.private }).select("id").single()) as { id: string };
      const { error } = await admin.from("questions").insert(add.map(a => ({ ...familyRow(userId, a), upload_id: id })));
      if (error) {
        // Nothing half-saved: the upload goes with its questions.
        await admin.from("question_uploads").delete().eq("id", id);
        throw new Error(error.message);
      }
      return id;
    },
    async questionToFix(userId, questionId) {
      const r = must(await admin.from("questions").select(`${QUESTION_COLUMNS}, question_uploads(private)`)
        .eq("id", questionId).eq("owner", userId).eq("status", "in_review").maybeSingle()) as
        (QuestionRow & { question_uploads: { private: boolean } | null }) | null;
      return r ? { question: toQuestion(r), private: r.question_uploads?.private ?? true } : null;
    },
    async saveFix(userId, fix) {
      const { id: _id, ...row } = familyRow(userId, fix);
      must(await admin.from("questions").update({ ...row, times_shown: 0, first_try_correct: 0 })
        .eq("id", fix.question.id).eq("owner", userId).eq("status", "in_review").select("id"));
    },
  };
}
