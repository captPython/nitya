import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReviewEntry } from "../admin/review";
import { bandCutsProblem, childSettingsProblem, classSettingsProblems, type ClassSettings } from "../admin/settings";
import { QUESTION_COLUMNS, toQuestion, toRow as questionRow, type QuestionRow } from "../supply/rows";
import type { Look } from "../looks";
import type { ClassId, Level, TopicState } from "../types";
import type { CheckReport } from "../validation";
import type { Account, AccountBackend, NewQuestionsResult } from "./backend";
import { NotAdmin, NotSignedIn } from "./backend";
import type { Profile, ProfileDetails } from "./options";
import type { ProfileData } from "./progress";

/** Sign-in, kept apart from the data calls so the data calls can be tested against a real PostgREST. */
export interface AuthPort {
  user(): Promise<{ id: string; email: string | null } | null>;
  signInWithGoogle(): Promise<void>;
  sendEmailLink(email: string): Promise<void>;
  signOut(): Promise<void>;
}

/** Supabase Auth: Google sign-in and one-time email links, both returning to `redirectTo`. */
export function supabaseAuth(client: SupabaseClient, redirectTo: string): AuthPort {
  const ok = ({ error }: { error: Error | null }) => { if (error) throw error; };
  return {
    async user() {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      const u = data.session?.user;
      return u ? { id: u.id, email: u.email ?? null } : null;
    },
    async signInWithGoogle() { ok(await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo } })); },
    async sendEmailLink(email) { ok(await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } })); },
    async signOut() { ok(await client.auth.signOut()); },
  };
}

interface ProfileRow { id: string; nickname: string; avatar: string; class_id: ClassId; board: string; language: string }
const PROFILE_COLUMNS = "id, nickname, avatar, class_id, board, language";
const toProfile = (r: ProfileRow): Profile => ({ id: r.id, nickname: r.nickname, avatar: r.avatar, classId: r.class_id, board: r.board, language: r.language });
const toRow = (d: ProfileDetails) => ({ nickname: d.nickname.trim(), avatar: d.avatar, class_id: d.classId, board: d.board, language: d.language });

/** The result of a Supabase call, or its error as a thrown Error. */
function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) {
    // The one database rule a fix can break, said plainly.
    if (/content_key/.test(res.error.message)) throw new Error("The bank already has this question.");
    throw new Error(res.error.message);
  }
  return res.data as T;
}

const CLASS_SETTINGS = "class_id, pass_percent, wrong_penalty";
interface ClassSettingsRow { class_id: ClassId; pass_percent: number; wrong_penalty: number }
const toClassSettings = (r: ClassSettingsRow): ClassSettings => ({ classId: r.class_id, passPercent: r.pass_percent, wrongPenalty: r.wrong_penalty });

/** Calls the New questions server function (see src/server). */
export type NewQuestionsCall = (body: { topicId: string; profileId?: string }) => Promise<NewQuestionsResult>;

/** Supabase Edge Functions: the function named `new-questions`, with the parent's sign-in. */
export function edgeFunction(client: SupabaseClient): NewQuestionsCall {
  return async body => {
    const { data, error } = await client.functions.invoke("new-questions", { body });
    if (error) {
      // The function's own message, like the daily limit, is in the response.
      const ctx = (error as { context?: Response }).context;
      const message = ctx && typeof ctx.json === "function" ? await ctx.json().then(j => j?.error, () => null) : null;
      throw new Error(message || error.message);
    }
    return data as NewQuestionsResult;
  };
}

/**
 * The family's account in Nitya's Supabase database. Row-level security
 * decides what each parent can see and change; this only shapes the calls.
 */
export function supabaseBackend(client: SupabaseClient, auth: AuthPort, newQuestions: NewQuestionsCall = edgeFunction(client)): AccountBackend {
  const userId = async () => {
    const u = await auth.user();
    if (!u) throw new NotSignedIn();
    return u.id;
  };
  // Row-level security would only hide rows from anyone else; this says so instead.
  const requireAdmin = async () => {
    const id = await userId();
    if ((must(await client.from("admins").select("user_id").eq("user_id", id)) as unknown[]).length === 0) throw new NotAdmin();
  };
  // The parent row is made on first sign-in; afterwards this does nothing.
  const ensureParent = async (id: string) => {
    must(await client.from("parents").upsert({ id }, { onConflict: "id", ignoreDuplicates: true }));
  };

  return {
    mode: "supabase",
    async account(): Promise<Account | null> {
      const u = await auth.user();
      if (!u) return null;
      await ensureParent(u.id);
      const parent = must(await client.from("parents").select("pin_hash").eq("id", u.id).single()) as { pin_hash: string | null };
      const consents = must(await client.from("consents").select("consent_version").order("given_at", { ascending: false }).limit(1)) as { consent_version: string }[];
      // An admin can read their own row in admins; anyone else reads nothing.
      const admins = must(await client.from("admins").select("user_id").eq("user_id", u.id)) as unknown[];
      return { userId: u.id, email: u.email, consentVersion: consents[0]?.consent_version ?? null, pinHash: parent.pin_hash, isAdmin: admins.length > 0 };
    },
    signInWithGoogle: () => auth.signInWithGoogle(),
    sendEmailLink: email => auth.sendEmailLink(email.trim().toLowerCase()),
    signOut: () => auth.signOut(),

    async giveConsent(version) {
      const id = await userId();
      await ensureParent(id);
      must(await client.from("consents").insert({ parent_id: id, consent_version: version }));
    },
    async setPinHash(hash) {
      must(await client.from("parents").update({ pin_hash: hash }).eq("id", await userId()));
    },

    async profiles() {
      const rows = must(await client.from("profiles").select(PROFILE_COLUMNS).order("created_at")) as ProfileRow[];
      return rows.map(toProfile);
    },
    async createProfile(details) {
      const row = must(await client.from("profiles").insert({ parent_id: await userId(), ...toRow(details) }).select(PROFILE_COLUMNS).single());
      return toProfile(row as unknown as ProfileRow);
    },
    async updateProfile(id, details) {
      const row = must(await client.from("profiles").update(toRow(details)).eq("id", id).select(PROFILE_COLUMNS).single());
      return toProfile(row as unknown as ProfileRow);
    },
    async deleteProfile(id) {
      const rows = must(await client.from("profiles").delete().eq("id", id).select("id")) as unknown[];
      if (rows.length !== 1) throw new Error("That profile isn't in this account.");
    },

    async profileData(profileId): Promise<ProfileData> {
      const [profile, attempts, responses, topics] = await Promise.all([
        client.from("profiles").select("id").eq("id", profileId),
        client.from("quiz_attempts").select("id, topic_id, attempt_no, practice, started_at, finished_at, marks, cleared, stars")
          .eq("profile_id", profileId),
        client.from("quiz_responses")
          .select("attempt_id, seq, question_id, level, first_try_correct, retry_correct, marks_delta, questions(sub_skill), quiz_attempts!inner(profile_id)")
          .eq("quiz_attempts.profile_id", profileId),
        client.from("topic_progress").select("topic_id, state, attempts, best_marks").eq("profile_id", profileId),
      ]);
      type A = { id: string; topic_id: string; attempt_no: number; practice: boolean; started_at: string; finished_at: string | null; marks: number | null; cleared: boolean | null; stars: number | null };
      type R = { attempt_id: string; seq: number; question_id: string; level: Level; first_try_correct: boolean; retry_correct: boolean | null; marks_delta: number; questions: { sub_skill: string } | null };
      type T = { topic_id: string; state: TopicState; attempts: number; best_marks: number };
      if ((must(profile) as unknown[]).length !== 1) throw new Error("That profile isn't in this account.");
      return {
        attempts: (must(attempts) as A[]).map(a => ({
          id: a.id, topicId: a.topic_id, attemptNo: a.attempt_no, practice: a.practice, startedAt: a.started_at,
          finishedAt: a.finished_at, marks: a.marks, cleared: a.cleared, stars: a.stars,
        })),
        responses: (must(responses) as unknown as R[]).map(r => ({
          attemptId: r.attempt_id, seq: r.seq, questionId: r.question_id, level: r.level,
          // A question the admin has since rejected is hidden, so its skill is unknown.
          subSkill: r.questions?.sub_skill ?? "unknown",
          firstTryCorrect: r.first_try_correct, retryCorrect: r.retry_correct, marksDelta: r.marks_delta,
        })),
        topics: (must(topics) as T[]).map(t => ({ topicId: t.topic_id, state: t.state, attempts: t.attempts, bestMarks: t.best_marks })),
      };
    },
    async startAttempt(profileId, a) {
      must(await client.from("quiz_attempts").insert({
        id: a.id, profile_id: profileId, topic_id: a.topicId, attempt_no: a.attemptNo, practice: a.practice, started_at: a.startedAt,
      }));
    },
    async recordResponse(r) {
      must(await client.from("quiz_responses").insert({
        attempt_id: r.attemptId, seq: r.seq, question_id: r.questionId, level: r.level,
        first_try_correct: r.firstTryCorrect, retry_correct: r.retryCorrect, marks_delta: r.marksDelta,
      }));
    },
    async finishAttempt(attemptId, r) {
      must(await client.from("quiz_attempts").update({
        finished_at: new Date().toISOString(), marks: r.marks, pass_marks: r.passMarks, max_marks: r.maxMarks,
        correct: r.correct, cleared: r.cleared, stars: r.stars,
      }).eq("id", attemptId));
    },
    async saveTopicProgress(profileId, rows) {
      if (!rows.length) return;
      must(await client.from("topic_progress").upsert(
        rows.map(t => ({ profile_id: profileId, topic_id: t.topicId, state: t.state, attempts: t.attempts, best_marks: t.bestMarks })),
        { onConflict: "profile_id,topic_id" },
      ));
    },

    async questions(topicId) {
      const rows = must(await client.from("questions").select(QUESTION_COLUMNS).eq("topic_id", topicId).eq("status", "approved").order("id")) as unknown as QuestionRow[];
      return rows.map(toQuestion);
    },
    newQuestions: (topicId, profileId) => newQuestions(profileId ? { topicId, profileId } : { topicId }),
    async classSettings() {
      return (must(await client.from("class_settings").select(CLASS_SETTINGS).order("class_id")) as ClassSettingsRow[]).map(toClassSettings);
    },
    async childSettings(profileId) {
      const r = must(await client.from("profiles").select("pass_percent, wrong_penalty, look").eq("id", profileId).maybeSingle()) as
        { pass_percent: number | null; wrong_penalty: number | null; look: Look | null } | null;
      if (!r) throw new Error("That profile isn't in this account.");
      return { passPercent: r.pass_percent, wrongPenalty: r.wrong_penalty, look: r.look };
    },
    async saveChildSettings(profileId, c) {
      // The database checks this too; checking first gives the parent a plain message.
      const problem = childSettingsProblem(c);
      if (problem) throw new Error(problem);
      const rows = must(await client.from("profiles").update({ pass_percent: c.passPercent, wrong_penalty: c.wrongPenalty, look: c.look })
        .eq("id", profileId).select("id")) as unknown[];
      // Row-level security hides other families' children, so nothing changes.
      if (rows.length !== 1) throw new Error("That profile isn't in this account.");
    },

    async reviewQueue() {
      await requireAdmin();
      const rows = must(await client.from("questions")
        .select(`${QUESTION_COLUMNS}, question_checks(report, checked_at)`)
        .eq("status", "in_review").order("id")
        .order("checked_at", { referencedTable: "question_checks", ascending: false })
        .limit(1, { referencedTable: "question_checks" })) as unknown as (QuestionRow & { question_checks: { report: CheckReport; checked_at: string }[] })[];
      return rows.map((r): ReviewEntry => ({
        question: toQuestion(r), report: r.question_checks[0]?.report ?? null, checkedAt: r.question_checks[0]?.checked_at ?? null,
      }));
    },
    async reviewQuestion(questionId, review) {
      const fixed = review.decision === "fixed" ? questionRow(review.question) : null;
      must(await client.rpc("review_question", {
        p_question_id: questionId, p_decision: review.decision, p_note: review.note ?? null,
        p_fixed: fixed, p_report: review.decision === "fixed" ? review.report : null,
      }));
    },
    async saveClassSettings(c) {
      const problems = classSettingsProblems(c);
      if (problems.length) throw new Error(problems.join(" "));
      const rows = must(await client.from("class_settings").update({ pass_percent: c.passPercent, wrong_penalty: c.wrongPenalty })
        .eq("class_id", c.classId).select("class_id")) as unknown[];
      // Row-level security hides the row from anyone but an admin, so nothing changes.
      if (rows.length !== 1) throw new NotAdmin();
    },
    async levelBands() {
      const rows = must(await client.from("level_bands").select("level, min_rate, max_rate").order("level")) as { level: Level; min_rate: number | string; max_rate: number | string }[];
      return rows.map(r => ({ level: r.level, minRate: Number(r.min_rate), maxRate: Number(r.max_rate) }));
    },
    async saveLevelBands(cuts) {
      const problem = bandCutsProblem(cuts);
      if (problem) throw new Error(problem);
      must(await client.rpc("set_level_bands", { p_l1: cuts.l1 / 100, p_l2: cuts.l2 / 100, p_l3: cuts.l3 / 100 }));
    },
    async questionRequests(limit = 20) {
      await requireAdmin();
      const rows = must(await client.from("question_requests").select("topic_id, requested_at, profile_id, added, sent_to_review")
        .order("requested_at", { ascending: false }).limit(limit)) as
        { topic_id: string; requested_at: string; profile_id: string | null; added: number; sent_to_review: number }[];
      return rows.map(r => ({
        topicId: r.topic_id, requestedAt: r.requested_at, by: r.profile_id ? "child" as const : "grown-up" as const,
        added: r.added, sentToReview: r.sent_to_review,
      }));
    },
  };
}
