import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReviewEntry } from "../admin/review";
import { bandCutsProblem, childSettingsProblem, classSettingsProblems, type ClassSettings } from "../admin/settings";
import { QUESTION_COLUMNS, toQuestion, toRow as questionRow, type QuestionRow } from "../supply/rows";
import type { Look } from "../looks";
import type { ClassId, Level, TopicState } from "../types";
import type { CheckReport } from "../validation";
import type { FamilyQuestionsBody, FamilyQuestionsReply } from "../server/family-questions";
import type { OwnQuestion, UploadResult } from "../supply/family";
import type { OwnVerdict } from "../supply/template";
import {
  answerCheckOf, flaggerCard, flaggerCode, flagSettingsProblems, flagSummary, NEW_STATS, NEW_TRUST, queueRank, templateKey, trustOf,
  type FlagBox, type FlagOutcome, type FlagRow, type FlagSettings, type LevelDirection, type TrustRecord,
} from "../flags/rules";
import type { Account, AccountBackend, FlaggedQuestion, FlaggerCheck, MyFlag, NewQuestionsResult, QuestionUpload } from "./backend";
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

const FLAG_COLUMNS = `id, question_id, kind, parent_id, profile_id, boxes, level_direction, note, weight, answered_wrong,
  seconds_after_answer, flagged_at, hide_until, burst, resolved_at, outcome`;
interface FlagDbRow {
  id: number; question_id: string; kind: "family" | "system"; parent_id: string | null; profile_id: string | null;
  boxes: FlagBox[]; level_direction: LevelDirection | null; note: string | null; weight: number | string;
  answered_wrong: boolean | null; seconds_after_answer: number | null; flagged_at: string; hide_until: string | null;
  burst: boolean; resolved_at: string | null; outcome: "upheld" | "dismissed" | null;
}
const toFlag = (r: FlagDbRow): FlagRow => ({
  id: r.id, questionId: r.question_id, kind: r.kind, parentId: r.parent_id, profileId: r.profile_id, boxes: r.boxes,
  levelDirection: r.level_direction, note: r.note, weight: Number(r.weight), answeredWrong: r.answered_wrong,
  secondsAfterAnswer: r.seconds_after_answer, flaggedAt: r.flagged_at, hideUntil: r.hide_until, burst: r.burst,
  resolvedAt: r.resolved_at, outcome: r.outcome,
});
interface TrustDbRow { parent_id: string; upheld: number; helpful: number; dismissed: number; muted_until: string | null }
const toTrust = (r: TrustDbRow | undefined): TrustRecord => (r ? { upheld: r.upheld, helpful: r.helpful, dismissed: r.dismissed, mutedUntil: r.muted_until } : { ...NEW_TRUST });
/** flag_settings' columns for each number. */
const FLAG_SETTING_COLUMNS: Record<keyof FlagSettings, string> = {
  watchDays: "watch_days", reviewFamilies: "review_families", communityFamilies: "community_families", memoryDays: "memory_days",
  burstFlags: "burst_flags", burstDays: "burst_days", dailyCap: "daily_cap", muteBelow: "mute_below", muteAfter: "mute_after",
  muteDays: "mute_days", wrongChoiceShare: "wrong_choice_share", minAnswers: "min_answers",
};
const SETTING_KEYS = Object.keys(FLAG_SETTING_COLUMNS) as (keyof FlagSettings)[];

const CLASS_SETTINGS = "class_id, pass_percent, wrong_penalty";
interface ClassSettingsRow { class_id: ClassId; pass_percent: number; wrong_penalty: number }
const toClassSettings = (r: ClassSettingsRow): ClassSettings => ({ classId: r.class_id, passPercent: r.pass_percent, wrongPenalty: r.wrong_penalty });

/** Calls the New questions server function (see src/server). */
export type NewQuestionsCall = (body: { topicId: string; profileId?: string }) => Promise<NewQuestionsResult>;
/** Calls the family-questions server function (see src/server). */
export type FamilyQuestionsCall = (body: FamilyQuestionsBody) => Promise<FamilyQuestionsReply>;

/** A Supabase Edge Function, `new-questions` unless named, called with the parent's sign-in. */
export function edgeFunction<T = NewQuestionsResult>(client: SupabaseClient, name = "new-questions"): (body: object) => Promise<T> {
  return async body => {
    const { data, error } = await client.functions.invoke(name, { body });
    if (error) {
      // The function's own message, like the daily limit, is in the response.
      const ctx = (error as { context?: Response }).context;
      const message = ctx && typeof ctx.json === "function" ? await ctx.json().then(j => j?.error, () => null) : null;
      throw new Error(message || error.message);
    }
    return data as T;
  };
}

/**
 * The family's account in Nitya's Supabase database. Row-level security
 * decides what each parent can see and change; this only shapes the calls.
 */
export function supabaseBackend(
  client: SupabaseClient,
  auth: AuthPort,
  newQuestions: NewQuestionsCall = edgeFunction(client),
  familyQuestions: FamilyQuestionsCall = edgeFunction<FamilyQuestionsReply>(client, "family-questions"),
): AccountBackend {
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
  // Only an admin can read them.
  const flagSettings = async (): Promise<FlagSettings> => {
    const row = must(await client.from("flag_settings").select(SETTING_KEYS.map(k => FLAG_SETTING_COLUMNS[k]).join(", ")).single()) as unknown as Record<string, number | string>;
    return Object.fromEntries(SETTING_KEYS.map(k => [k, Number(row[FLAG_SETTING_COLUMNS[k]])])) as unknown as FlagSettings;
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
    async deleteAccount() {
      await userId();
      // Deleting the sign-in deletes the parent row, and with it everything of theirs (see the migration).
      must(await client.rpc("delete_my_account"));
      await auth.signOut();
    },

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
        first_try_correct: r.firstTryCorrect, retry_correct: r.retryCorrect, marks_delta: r.marksDelta, first_answer: r.firstAnswer ?? null,
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

    async questions(topicId, pool = {}) {
      const me = (await auth.user())?.id;
      const base = client.from("questions").select(`${QUESTION_COLUMNS}, owner, shared`).eq("topic_id", topicId).eq("status", "approved");
      // Official questions, the family's own, and with the community bank on, every shared one nobody has reported.
      // Official questions, the family's own, and with the community bank on, every shared one. Row-level security
      // leaves out those in flag review that may teach something wrong; the family's own flags leave out more.
      const query = !me ? base.neq("source", "upload") : base.or(`source.neq.upload,owner.eq.${me}${pool.community ? ",shared.is.true" : ""}`);
      const [res, hidden] = await Promise.all([query.order("id"), me ? client.rpc("my_hidden_questions", { p_profile_id: pool.profileId ?? null }) : null]);
      const skip = new Set(hidden ? must(hidden) as string[] : []);
      const rows = (must(res) as unknown as (QuestionRow & { owner: string | null; shared: boolean })[]).filter(r => r.owner === me || !skip.has(r.id));
      return rows.map(r => (me && r.owner === me ? { ...toQuestion(r), family: true } : r.shared ? { ...toQuestion(r), community: true } : toQuestion(r)));
    },
    async saveUpload(upload) {
      return await familyQuestions({ action: "upload", fileName: upload.fileName, private: upload.private, rows: upload.rows }) as UploadResult;
    },
    async questionUploads() {
      const rows = must(await client.from("question_uploads").select("id, file_name, private, uploaded_at, questions(status, shared)")
        .is("removed_at", null).order("uploaded_at", { ascending: false })) as
        { id: string; file_name: string; private: boolean; uploaded_at: string; questions: { status: string; shared: boolean }[] }[];
      return rows.map((r): QuestionUpload => ({
        id: r.id, fileName: r.file_name, uploadedAt: r.uploaded_at, private: r.private,
        ready: r.questions.filter(q => q.status === "approved").length,
        inReview: r.questions.filter(q => q.status === "in_review").length,
        shared: r.questions.filter(q => q.shared).length,
      }));
    },
    async ownQuestions() {
      const rows = must(await client.from("questions")
        .select(`${QUESTION_COLUMNS}, upload_id, status, problems, shared, question_uploads(uploaded_at)`)
        .eq("owner", await userId()).in("status", ["approved", "in_review"])) as unknown as
        (QuestionRow & { upload_id: string; status: string; problems: string[]; shared: boolean; question_uploads: { uploaded_at: string } | null })[];
      const rowNo = (r: QuestionRow) => Number(r.source_ref?.match(/row (\d+)$/)?.[1] ?? 0);
      rows.sort((a, b) => (b.question_uploads?.uploaded_at ?? "").localeCompare(a.question_uploads?.uploaded_at ?? "") || rowNo(a) - rowNo(b));
      return rows.map((r): OwnQuestion => ({
        question: toQuestion(r), uploadId: r.upload_id, status: r.status === "approved" ? "ready" : "review", problems: r.problems, shared: r.shared,
      }));
    },
    async reviewOwnQuestion(questionId, review) {
      if (review.decision === "fix") {
        const out = await familyQuestions({ action: "fix", questionId, question: review.question }) as { verdict: OwnVerdict };
        return out.verdict;
      }
      must(await client.rpc("review_own_question", { p_question_id: questionId, p_decision: review.decision }));
      return null;
    },
    async removeUpload(uploadId) {
      must(await client.rpc("remove_question_upload", { p_upload_id: uploadId }));
    },

    async flagQuestion(r) {
      await ensureParent(await userId());
      return must(await client.rpc("flag_question", {
        p_question_id: r.questionId, p_boxes: r.boxes, p_level_direction: r.levelDirection ?? null, p_note: r.note ?? null,
        p_profile_id: r.profileId ?? null, p_answered_wrong: r.answeredWrong ?? null,
        p_seconds_after_answer: r.secondsAfterAnswer == null ? null : Math.round(r.secondsAfterAnswer),
      })) as FlagOutcome;
    },
    async suggestFlag(profileId, questionId, answeredWrong) {
      must(await client.rpc("suggest_flag", { p_profile_id: profileId, p_question_id: questionId, p_answered_wrong: answeredWrong }));
    },
    async flagChecks() {
      const rows = must(await client.from("flag_suggestions").select(`profile_id, answered_wrong, suggested_at, questions(${QUESTION_COLUMNS})`)
        .order("suggested_at", { ascending: false })) as unknown as
        { profile_id: string; answered_wrong: boolean | null; suggested_at: string; questions: QuestionRow | null }[];
      // A question hidden for everyone meanwhile can't be read, and needs no check.
      return rows.flatMap(r => (r.questions ? [{ profileId: r.profile_id, question: toQuestion(r.questions), answeredWrong: r.answered_wrong, suggestedAt: r.suggested_at }] : []));
    },
    async dismissFlagCheck(profileId, questionId) {
      must(await client.from("flag_suggestions").delete().eq("profile_id", profileId).eq("question_id", questionId));
    },
    async myFlags() {
      const rows = must(await client.rpc("my_flags")) as
        { question: QuestionRow; boxes: FlagBox[]; flagged_at: string; state: MyFlag["state"]; until: string | null }[];
      return rows.map((r): MyFlag => ({ question: toQuestion(r.question), boxes: r.boxes, flaggedAt: r.flagged_at, state: r.state, until: r.until }));
    },

    async flagQueue() {
      await requireAdmin();
      type Q = QuestionRow & { shared: boolean; flag_review_at: string; flag_hide_all: boolean; times_shown: number; first_try_correct: number; retries: number; retry_right: number };
      const qs = must(await client.from("questions")
        .select(`${QUESTION_COLUMNS}, shared, flag_review_at, flag_hide_all, times_shown, first_try_correct, retries, retry_right`)
        .not("flag_review_at", "is", null).eq("status", "approved")) as unknown as Q[];
      if (!qs.length) return [];
      const ids = qs.map(q => q.id);
      const [flagRes, pickRes, checkRes] = await Promise.all([
        client.from("question_flags").select(FLAG_COLUMNS).in("question_id", ids).is("resolved_at", null).eq("burst", false),
        client.from("question_choice_picks").select("question_id, choice, picks").in("question_id", ids),
        client.from("question_checks").select("question_id, report").in("question_id", ids)
          .order("checked_at", { ascending: false }).order("id", { ascending: false }),
      ]);
      const flags = (must(flagRes) as FlagDbRow[]).map(toFlag);
      const picks = must(pickRes) as { question_id: string; choice: string; picks: number }[];
      const checks = must(checkRes) as { question_id: string; report: CheckReport }[];
      const families = [...new Set(flags.flatMap(f => (f.kind === "family" && f.parentId ? [f.parentId] : [])))];
      const trust = families.length ? must(await client.from("family_trust").select("parent_id, upheld, helpful, dismissed, muted_until").in("parent_id", families)) as TrustDbRow[] : [];
      return qs.map((q): FlaggedQuestion => {
        const mine = flags.filter(f => f.questionId === q.id);
        return {
          question: toQuestion(q), community: q.shared, hiddenForAll: q.flag_hide_all, reviewSince: q.flag_review_at, ...flagSummary(mine),
          flaggers: [...new Set(mine.flatMap(f => (f.kind === "family" && f.parentId ? [f.parentId] : [])))]
            .map(id => ({ code: flaggerCode(id), trust: trustOf(toTrust(trust.find(t => t.parent_id === id))) })),
          stats: {
            ...NEW_STATS, shown: q.times_shown, firstTryRight: q.first_try_correct, retries: q.retries, retryRight: q.retry_right,
            picks: Object.fromEntries(picks.filter(p => p.question_id === q.id).map(p => [p.choice, p.picks])),
          },
          answerCheck: answerCheckOf(checks.find(c => c.question_id === q.id)?.report ?? null),
        };
      }).sort((a, b) => queueRank(a.boxes) - queueRank(b.boxes) || a.reviewSince.localeCompare(b.reviewSince));
    },
    async flaggerChecks() {
      await requireAdmin();
      const cards = must(await client.rpc("flagger_cards")) as { parent_id: string; created_at: string; classes: ClassId[] }[];
      if (!cards.length) return [];
      const ids = cards.map(c => c.parent_id);
      const [flagRes, trustRes, settings] = await Promise.all([
        client.from("question_flags").select(FLAG_COLUMNS).in("parent_id", ids).eq("kind", "family"),
        client.from("family_trust").select("parent_id, upheld, helpful, dismissed, muted_until").in("parent_id", ids),
        flagSettings(),
      ]);
      const flags = (must(flagRes) as FlagDbRow[]).map(toFlag);
      const trust = must(trustRes) as TrustDbRow[];
      const waiting = [...new Set(flags.filter(f => f.burst && !f.resolvedAt).map(f => f.questionId))];
      const questions = waiting.length ? (must(await client.from("questions").select(QUESTION_COLUMNS).in("id", waiting)) as unknown as QuestionRow[]).map(toQuestion) : [];
      return cards.map((c): FlaggerCheck => {
        const all = flags.filter(f => f.parentId === c.parent_id);
        const open = new Set(all.filter(f => f.burst && !f.resolvedAt).map(f => f.questionId));
        return {
          ...flaggerCard(c.parent_id, all, toTrust(trust.find(t => t.parent_id === c.parent_id)), { createdAt: c.created_at, classes: c.classes }, settings, new Date()),
          questions: questions.filter(q => open.has(q.id)),
        };
      });
    },
    async decideFlags(questionId, d) {
      must(await client.rpc("decide_flags", {
        p_question_id: questionId, p_decision: d.kind, p_level: d.kind === "level" ? d.level : null,
        p_fixed: d.kind === "fix" ? questionRow(d.question) : null, p_report: d.kind === "fix" ? d.report : null,
      }));
    },
    async decideFlagger(parentId, decision) {
      must(await client.rpc("decide_flagger", { p_parent_id: parentId, p_decision: decision }));
    },
    async flagSettings() {
      await requireAdmin();
      return flagSettings();
    },
    async saveFlagSettings(settings) {
      const problems = flagSettingsProblems(settings);
      if (problems.length) throw new Error(problems.join(" "));
      const rows = must(await client.from("flag_settings")
        .update({ ...Object.fromEntries(SETTING_KEYS.map(k => [FLAG_SETTING_COLUMNS[k], settings[k]])), updated_at: new Date().toISOString() })
        .eq("id", true).select("id")) as unknown[];
      // Row-level security hides the row from anyone but an admin, so nothing changes.
      if (rows.length !== 1) throw new NotAdmin();
    },
    async revealFlagger(parentId, reason) {
      return must(await client.rpc("reveal_flagger", { p_parent_id: parentId, p_reason: reason })) as string | null;
    },
    async templateSiblings(questionId) {
      await requireAdmin();
      const row = must(await client.from("questions").select(QUESTION_COLUMNS).eq("id", questionId).maybeSingle()) as unknown as QuestionRow | null;
      const key = row && templateKey(toQuestion(row));
      if (!row || !key) return [];
      const rows = must(await client.from("questions").select(QUESTION_COLUMNS).eq("topic_id", row.topic_id).eq("source", "template")
        .eq("status", "approved").neq("id", questionId).order("id")) as unknown as QuestionRow[];
      return rows.map(toQuestion).filter(q => templateKey(q) === key);
    },
    async sendToReview(entries) {
      must(await client.rpc("send_to_review", { p_entries: entries }));
    },
    newQuestions: (topicId, profileId) => newQuestions(profileId ? { topicId, profileId } : { topicId }),
    async classSettings() {
      return (must(await client.from("class_settings").select(CLASS_SETTINGS).order("class_id")) as ClassSettingsRow[]).map(toClassSettings);
    },
    async childSettings(profileId) {
      const r = must(await client.from("profiles").select("pass_percent, wrong_penalty, look, voice, community").eq("id", profileId).maybeSingle()) as
        { pass_percent: number | null; wrong_penalty: number | null; look: Look | null; voice: boolean | null; community: boolean } | null;
      if (!r) throw new Error("That profile isn't in this account.");
      // Off is kept as false, and means the same as never chosen.
      return { passPercent: r.pass_percent, wrongPenalty: r.wrong_penalty, look: r.look, voice: r.voice, community: r.community || null };
    },
    async saveChildSettings(profileId, c) {
      // The database checks this too; checking first gives the parent a plain message.
      const problem = childSettingsProblem(c);
      if (problem) throw new Error(problem);
      const rows = must(await client.from("profiles").update({ pass_percent: c.passPercent, wrong_penalty: c.wrongPenalty, look: c.look, voice: c.voice, community: c.community === true })
        .eq("id", profileId).select("id")) as unknown[];
      // Row-level security hides other families' children, so nothing changes.
      if (rows.length !== 1) throw new Error("That profile isn't in this account.");
    },

    async reviewQueue() {
      await requireAdmin();
      const rows = must(await client.from("questions")
        .select(`${QUESTION_COLUMNS}, question_checks(report, checked_at)`)
        .eq("status", "in_review").neq("source", "upload").order("id")
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
