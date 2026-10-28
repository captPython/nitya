import type { Review, ReviewEntry } from "../admin/review";
import { bandsOf, defaultClassSettings, type BandCuts, type ClassSettings } from "../admin/settings";
import { ALL_CONTENT } from "../content";
import { checkQuestions, topicInfo } from "../supply/check";
import { MemoryQuestionStore } from "../supply/memory-store";
import { addNewQuestions, seedBank } from "../supply/run";
import {
  answerCheckOf, countAnswer, emptyFlagBook, FlagBook, flaggerCard, flaggerCode, flagSummary, NEW_STATS, queueRank, silentSignals, templateKey, trustOf,
  type FlagBookState, type FlagOutcome, type FlagRequest, type FlagSettings, type FlagTarget, type QuestionStats,
} from "../flags/rules";
import { CLASS_ORDER, type ClassId, type Level, type Question } from "../types";
import { DEFAULT_BANDS, type CheckReport, type LevelBand } from "../validation";
import type { SuppliedQuestion } from "../supply/types";
import type { FlagDecision, FlaggedQuestion, FlaggerCheck, MyFlag, NewQuestionsResult, QuestionRequestLog } from "./backend";
import { DEMO_REVIEW_SAMPLES } from "./demo-samples";
import type { KeyValue } from "./local-backend";

/** What changed the demo's bank, in order, so replaying it rebuilds the same bank. */
type DemoEvent =
  | { kind: "seed"; topicId: string; seed: number }
  | { kind: "review"; questionId: string; review: Review }
  | { kind: "flag"; questionId: string; decision: { kind: "level"; level: Level } | { kind: "fix"; question: SuppliedQuestion; report: CheckReport } | { kind: "remove" } }
  | { kind: "to-review"; questionId: string; report: CheckReport };

interface DemoBankState {
  events: DemoEvent[];
  /** The community bank: every family's shared questions, by family. */
  community?: { owner: string; question: SuppliedQuestion }[];
  /** Questions an admin took out of the community bank. */
  removed?: string[];
  /** Question flags (see src/flags/rules.ts). */
  flags?: FlagBookState;
  /** Live results of every question children can get, from every family. */
  stats?: Record<string, QuestionStats>;
  /** Who flagged, for the flagger card, and each time the admin looked up a family's email. */
  flaggers?: Record<string, DemoFlagger>;
  reveals?: { parentId: string; reason: string; by: string; at: string }[];
  /** The admin's class defaults. (Step 6's first version kept topic settings under `settings`; they are ignored.) */
  classes?: Partial<Record<ClassId, ClassSettings>>;
  cuts: BandCuts | null;
  requests: QuestionRequestLog[];
}

const byId = (topicId: string) => ALL_CONTENT.find(c => c.topic.id === topicId);

/**
 * The demo's stand-in for the server's side of Nitya: the question bank (the
 * built-in questions, a few planted mistakes for the review queue, and every
 * New questions press), the admin's class defaults and the level bands.
 * Only the presses' seeds and the admin's decisions are kept, in this browser;
 * the bank is rebuilt from them when the page opens.
 */
export class DemoBank {
  private store: Promise<MemoryQuestionStore> | null = null;
  /** How many events the built bank has seen. Another tab's changes show up as more. */
  private built = -1;

  constructor(private readonly kv: KeyValue, private readonly key: string, private readonly now: () => Date = () => new Date()) {}

  private read(): DemoBankState {
    try {
      const s = JSON.parse(this.kv.getItem(this.key) ?? "null");
      if (s && typeof s === "object" && Array.isArray(s.events)) return s as DemoBankState;
    } catch { /* start fresh */ }
    return { events: [], classes: {}, cuts: null, requests: [] };
  }

  private write(s: DemoBankState) {
    try { this.kv.setItem(this.key, JSON.stringify(s)); } catch { /* storage full or blocked */ }
  }

  private bank(): Promise<MemoryQuestionStore> {
    const events = this.read().events;
    if (this.store && this.built === events.length) return this.store;
    this.built = events.length;
    return (this.store = (async () => {
      const store = new MemoryQuestionStore(ALL_CONTENT.map(topicInfo));
      await seedBank(store, ALL_CONTENT);
      await store.save(checkQuestions(DEMO_REVIEW_SAMPLES, await store.topics()));
      for (const e of events) {
        if (e.kind === "seed") {
          const content = byId(e.topicId);
          if (content) await addNewQuestions(store, content, { seed: e.seed });
        } else {
          try {
            if (e.kind === "review") store.review(e.questionId, e.review);
            else if (e.kind === "flag") store.flagDecision(e.questionId, e.decision);
            else store.sendToReview(e.questionId, e.report);
          } catch { /* the question is gone */ }
        }
      }
      return store;
    })());
  }

  /** Nitya's approved questions in a topic, leaving out any hidden for everyone while the admin looks at them. */
  async questions(topicId: string): Promise<Question[]> {
    const store = await this.bank();
    const book = flagBook(this.read());
    return [...store.rows.values()].filter(r => r.status === "approved" && r.question.topicId === topicId && !book.hiddenForAll(r.question.id)).map(r => r.question);
  }

  async newQuestions(topicId: string, profileId?: string): Promise<NewQuestionsResult> {
    const content = byId(topicId);
    if (!content) throw new Error("That topic has no question templates.");
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const summary = await addNewQuestions(await this.bank(), content, { seed, profileId });
    const result = { topicId, added: summary.approved.length, sentToReview: summary.inReview.length, asked: summary.asked };
    const s = this.read();
    if (result.added || result.sentToReview) this.record(s, { kind: "seed", topicId, seed });
    s.requests.unshift({ topicId, requestedAt: new Date().toISOString(), by: profileId ? "child" : "grown-up", added: result.added, sentToReview: result.sentToReview });
    s.requests = s.requests.slice(0, 50);
    this.write(s);
    return result;
  }

  async reviewQueue(): Promise<ReviewEntry[]> {
    const store = await this.bank();
    return [...store.rows.values()].filter(r => r.status === "in_review")
      .map(r => ({ question: r.question, report: r.checks[r.checks.length - 1] ?? null, checkedAt: null }));
  }

  async review(questionId: string, review: Review) {
    (await this.bank()).review(questionId, review);
    const s = this.read();
    this.record(s, { kind: "review", questionId, review });
    this.write(s);
  }

  /** Adds an event the built bank already holds. */
  private record(s: DemoBankState, e: DemoEvent) {
    s.events.push(e);
    if (this.built === s.events.length - 1) this.built = s.events.length;
  }

  classSettings(): ClassSettings[] {
    const saved = this.read().classes ?? {};
    return CLASS_ORDER.map(id => saved[id] ?? defaultClassSettings(id));
  }

  saveClassSettings(settings: ClassSettings) {
    if (!CLASS_ORDER.includes(settings.classId)) throw new Error("That class isn't in Nitya.");
    const s = this.read();
    (s.classes ??= {})[settings.classId] = { ...settings };
    this.write(s);
  }

  levelBands(): LevelBand[] {
    const cuts = this.read().cuts;
    return cuts ? bandsOf(cuts) : DEFAULT_BANDS.map(b => ({ ...b }));
  }

  saveLevelBands(cuts: BandCuts) {
    const s = this.read();
    s.cuts = { ...cuts };
    this.write(s);
  }

  requests(limit: number): QuestionRequestLog[] {
    return this.read().requests.slice(0, limit);
  }

  /** Puts a family's shared questions in the community bank, in place of what they shared before. */
  setCommunity(owner: string, questions: SuppliedQuestion[]) {
    const s = this.read();
    s.community = [...(s.community ?? []).filter(c => c.owner !== owner), ...questions.map(question => ({ owner, question }))];
    this.write(s);
  }

  isRemoved(questionId: string): boolean {
    return (this.read().removed ?? []).includes(questionId);
  }

  /** Other families' shared questions in a topic, leaving out any hidden for everyone while the admin looks at them. */
  community(topicId: string, except: string): SuppliedQuestion[] {
    const s = this.read();
    const book = flagBook(s);
    return (s.community ?? []).filter(c => c.owner !== except && c.question.topicId === topicId && !book.hiddenForAll(c.question.id)).map(c => c.question);
  }

  // Question flags ------------------------------------------------------------

  /** A question children can get: Nitya's own (approved) or a shared one, with what the flag rules need. */
  private async served(questionId: string): Promise<{ question: SuppliedQuestion; community: boolean; owner: string | null; report: CheckReport | null } | null> {
    const row = (await this.bank()).rows.get(questionId);
    if (row) return row.status === "approved" ? { question: row.question, community: false, owner: null, report: row.checks[row.checks.length - 1] ?? null } : null;
    const shared = (this.read().community ?? []).find(c => c.question.id === questionId);
    return shared ? { question: shared.question, community: true, owner: shared.owner, report: null } : null;
  }

  private static targetOf(info: { community: boolean; report: CheckReport | null }): FlagTarget {
    return { community: info.community, answerCheckDisagrees: answerCheckOf(info.report) === "disagrees" };
  }

  private async targets(questionIds: string[]): Promise<Map<string, FlagTarget>> {
    const out = new Map<string, FlagTarget>();
    for (const id of questionIds) {
      const info = await this.served(id);
      out.set(id, info ? DemoBank.targetOf(info) : { community: false, answerCheckDisagrees: false });
    }
    return out;
  }

  async isServed(questionId: string): Promise<boolean> {
    return !!(await this.served(questionId));
  }

  hidden(parentId: string, profileId: string | null): Set<string> {
    return flagBook(this.read()).hiddenFor(parentId, profileId, this.now());
  }

  async flag(parentId: string, who: DemoFlagger, request: FlagRequest): Promise<FlagOutcome> {
    const info = await this.served(request.questionId);
    if (!info || info.owner === parentId) throw new Error("That question isn't in Nitya's quizzes.");
    const s = this.read();
    (s.flaggers ??= {})[parentId] = who;
    const out = flagBook(s).flag(parentId, request, DemoBank.targetOf(info), this.now());
    this.write(s);
    return out;
  }

  suggest(parentId: string, profileId: string, questionId: string, answeredWrong: boolean | null) {
    const s = this.read();
    flagBook(s).suggest(parentId, profileId, questionId, answeredWrong, this.now());
    this.write(s);
  }

  suggestions(parentId: string) {
    return flagBook(this.read()).state.suggestions.filter(x => x.parentId === parentId);
  }

  dismissSuggestion(parentId: string, profileId: string, questionId: string) {
    const s = this.read();
    flagBook(s).dismissSuggestion(parentId, profileId, questionId);
    this.write(s);
  }

  /** A child's answer, counted into the question's live results; what they say may add a silent flag. */
  async recordAnswer(questionId: string, r: { firstTryCorrect: boolean; retryCorrect: boolean | null; firstAnswer?: string | null }) {
    const info = await this.served(questionId);
    if (!info) return;
    const s = this.read();
    const stats = countAnswer((s.stats ??= {})[questionId] ?? NEW_STATS, r);
    s.stats[questionId] = stats;
    const book = flagBook(s);
    const bands = s.cuts ? bandsOf(s.cuts) : DEFAULT_BANDS;
    for (const signal of silentSignals(info.question, stats, book.settings, bands)) book.systemFlag(questionId, signal, DemoBank.targetOf(info), this.now());
    this.write(s);
  }

  async myFlags(parentId: string): Promise<MyFlag[]> {
    const s = this.read();
    const book = flagBook(s);
    const now = this.now().getTime();
    const out: MyFlag[] = [];
    for (const f of book.state.flags.filter(x => x.kind === "family" && x.parentId === parentId)) {
      if (f.resolvedAt && Date.parse(f.resolvedAt) < now - 30 * 864e5) continue;
      const question = await this.question(f.questionId);
      if (!question) continue;
      const watching = !!f.hideUntil && Date.parse(f.hideUntil) > now;
      const state = f.outcome ?? (book.state.review[f.questionId] ? "review" : watching || f.burst ? "watching" : "back");
      out.push({ question, boxes: f.boxes, flaggedAt: f.flaggedAt, state, until: state === "watching" && !f.burst ? f.hideUntil : null });
    }
    return out.sort((a, b) => b.flaggedAt.localeCompare(a.flaggedAt));
  }

  /** A question whatever its state, for a family's record of what it flagged or a child tapped. */
  async question(questionId: string): Promise<SuppliedQuestion | null> {
    const row = (await this.bank()).rows.get(questionId);
    const q = row?.question ?? (this.read().community ?? []).find(c => c.question.id === questionId)?.question;
    return q ? structuredClone(q) : null;
  }

  async queue(): Promise<FlaggedQuestion[]> {
    const s = this.read();
    const book = flagBook(s);
    const out: FlaggedQuestion[] = [];
    for (const [questionId, review] of Object.entries(book.state.review)) {
      const info = await this.served(questionId);
      if (!info) continue;
      const flags = book.state.flags.filter(f => f.questionId === questionId && !f.resolvedAt && !f.burst);
      out.push({
        question: structuredClone(info.question), community: info.community, hiddenForAll: review.hideAll, reviewSince: review.since,
        ...flagSummary(flags), flaggers: [...new Set(flags.filter(f => f.kind === "family" && f.parentId).map(f => f.parentId!))]
          .map(id => ({ code: flaggerCode(id), trust: trustOf(book.trust(id)) })),
        stats: structuredClone(s.stats?.[questionId] ?? NEW_STATS), answerCheck: answerCheckOf(info.report),
      });
    }
    return out.sort((a, b) => queueRank(a.boxes) - queueRank(b.boxes) || a.reviewSince.localeCompare(b.reviewSince));
  }

  async flaggerChecks(): Promise<FlaggerCheck[]> {
    const s = this.read();
    const book = flagBook(s);
    const families = [...new Set(book.state.flags.filter(f => f.kind === "family" && f.parentId && f.burst && !f.resolvedAt).map(f => f.parentId!))];
    const out: FlaggerCheck[] = [];
    for (const parentId of families) {
      const all = book.state.flags.filter(f => f.kind === "family" && f.parentId === parentId);
      const questions: SuppliedQuestion[] = [];
      for (const f of all.filter(x => x.burst && !x.resolvedAt)) { const q = await this.question(f.questionId); if (q) questions.push(q); }
      const who = s.flaggers?.[parentId];
      out.push({ ...flaggerCard(parentId, all, book.trust(parentId), { createdAt: who?.createdAt ?? null, classes: who?.classes ?? [] }, book.settings, this.now()), questions });
    }
    return out;
  }

  async decide(questionId: string, decision: FlagDecision) {
    const info = await this.served(questionId);
    if (!info) throw new Error("That question isn't waiting for review.");
    const s = this.read();
    const book = flagBook(s);
    if (!book.state.review[questionId]) throw new Error("That question isn't waiting for review.");
    if (info.community && (decision.kind === "fix" || decision.kind === "level")) {
      throw new Error("A family's question can only be kept or taken out of the community bank.");
    }
    if (decision.kind !== "keep") {
      if (info.community) {
        s.community = (s.community ?? []).filter(c => c.question.id !== questionId);
        (s.removed ??= []).push(questionId);
      } else {
        (await this.bank()).flagDecision(questionId, decision);
        this.record(s, { kind: "flag", questionId, decision });
        if (decision.kind !== "remove") delete s.stats?.[questionId];
      }
    }
    book.decide(questionId, decision.kind === "keep" ? "dismissed" : "upheld", this.now());
    this.write(s);
  }

  async decideFlagger(parentId: string, decision: "helpful" | "not-helpful" | "each") {
    const s = this.read();
    const book = flagBook(s);
    const ids = [...new Set(book.state.flags.filter(f => f.parentId === parentId && f.burst && !f.resolvedAt).map(f => f.questionId))];
    const targets = await this.targets(ids);
    book.decideFlagger(parentId, decision, id => targets.get(id)!, this.now());
    this.write(s);
  }

  flagSettings(): FlagSettings {
    return { ...flagBook(this.read()).settings };
  }

  saveFlagSettings(settings: FlagSettings) {
    const s = this.read();
    flagBook(s).state.settings = { ...settings };
    this.write(s);
  }

  reveal(parentId: string, reason: string, by: string): string | null {
    const s = this.read();
    (s.reveals ??= []).push({ parentId, reason, by, at: this.now().toISOString() });
    this.write(s);
    return s.flaggers?.[parentId]?.email ?? null;
  }

  async siblings(questionId: string): Promise<SuppliedQuestion[]> {
    const rows = [...(await this.bank()).rows.values()];
    const q = rows.find(r => r.question.id === questionId)?.question;
    const key = q && templateKey(q);
    if (!key) return [];
    return rows.filter(r => r.status === "approved" && r.question.id !== questionId && templateKey(r.question) === key).map(r => structuredClone(r.question));
  }

  async sendToReview(entries: { questionId: string; report: CheckReport }[]) {
    const store = await this.bank();
    const s = this.read();
    for (const e of entries) {
      store.sendToReview(e.questionId, e.report);
      this.record(s, { kind: "to-review", questionId: e.questionId, report: e.report });
    }
    this.write(s);
  }

  /** A parent who leaves: their shared questions go, and their flags stay without them. */
  forget(userId: string) {
    const s = this.read();
    s.community = (s.community ?? []).filter(c => c.owner !== userId);
    flagBook(s).forget(userId);
    if (s.flaggers) delete s.flaggers[userId];
    this.write(s);
  }

  forgetProfile(profileId: string) {
    const s = this.read();
    flagBook(s).forgetProfile(profileId);
    this.write(s);
  }
}

/** Who flagged, for the admin's flagger card: kept only while the family has flags. */
export interface DemoFlagger {
  createdAt: string | null;
  classes: ClassId[];
  email: string | null;
}

const flagBook = (s: DemoBankState) => new FlagBook((s.flags ??= emptyFlagBook()));
