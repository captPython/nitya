import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseQuestionStore } from "../supply/supabase-store";
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
