import type { Review, ReviewEntry } from "../admin/review";
import { bandsOf, defaultClassSettings, type BandCuts, type ClassSettings } from "../admin/settings";
import { ALL_CONTENT } from "../content";
import { checkQuestions, topicInfo } from "../supply/check";
import { MemoryQuestionStore } from "../supply/memory-store";
import { addNewQuestions, seedBank } from "../supply/run";
import { CLASS_ORDER, type ClassId, type Question } from "../types";
import { DEFAULT_BANDS, type LevelBand } from "../validation";
import type { SuppliedQuestion } from "../supply/types";
import type { CommunityReport, NewQuestionsResult, QuestionRequestLog } from "./backend";
import { DEMO_REVIEW_SAMPLES } from "./demo-samples";
import type { KeyValue } from "./local-backend";

/** What changed the demo's bank, in order, so replaying it rebuilds the same bank. */
type DemoEvent =
  | { kind: "seed"; topicId: string; seed: number }
  | { kind: "review"; questionId: string; review: Review };

/** A family's report of a community question, until an admin keeps or removes it. */
interface DemoReport {
  questionId: string;
  /** The reporting parent's user id; null once they delete their account. */
  by: string | null;
  reason: string;
  at: string;
  resolved: boolean;
}

interface DemoBankState {
  events: DemoEvent[];
  /** The community bank: every family's shared questions, by family. */
  community?: { owner: string; question: SuppliedQuestion }[];
  reports?: DemoReport[];
  /** Questions an admin took out of the community bank. */
  removed?: string[];
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

  constructor(private readonly kv: KeyValue, private readonly key: string) {}

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
          try { store.review(e.questionId, e.review); } catch { /* the question is gone */ }
        }
      }
      return store;
    })());
  }

  async questions(topicId: string): Promise<Question[]> {
    const store = await this.bank();
    return [...store.rows.values()].filter(r => r.status === "approved" && r.question.topicId === topicId).map(r => r.question);
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

  /** Other families' shared questions in a topic that nobody has reported. */
  community(topicId: string, except: string): SuppliedQuestion[] {
    const s = this.read();
    const hidden = new Set((s.reports ?? []).filter(r => !r.resolved).map(r => r.questionId));
    return (s.community ?? []).filter(c => c.owner !== except && c.question.topicId === topicId && !hidden.has(c.question.id)).map(c => c.question);
  }

  report(questionId: string, by: string, reason: string) {
    const s = this.read();
    if (!(s.community ?? []).some(c => c.question.id === questionId && c.owner !== by)) throw new Error("That question isn't in the community bank.");
    (s.reports ??= []).push({ questionId, by, reason, at: new Date().toISOString(), resolved: false });
    this.write(s);
  }

  reports(): CommunityReport[] {
    const s = this.read();
    const open = (s.reports ?? []).filter(r => !r.resolved);
    return (s.community ?? []).flatMap(c => {
      const mine = open.filter(r => r.questionId === c.question.id);
      return mine.length ? [{ question: structuredClone(c.question), reasons: mine.map(r => r.reason), firstReportedAt: mine[0].at }] : [];
    }).sort((a, b) => a.firstReportedAt.localeCompare(b.firstReportedAt));
  }

  moderate(questionId: string, decision: "keep" | "remove") {
    const s = this.read();
    if (!(s.community ?? []).some(c => c.question.id === questionId)) throw new Error("That question isn't in the community bank.");
    if (decision === "remove") {
      s.community = s.community!.filter(c => c.question.id !== questionId);
      (s.removed ??= []).push(questionId);
    }
    for (const r of s.reports ?? []) if (r.questionId === questionId) r.resolved = true;
    this.write(s);
  }

  /** A parent who leaves: their shared questions go, and their reports stay without their id. */
  forget(userId: string) {
    const s = this.read();
    s.community = (s.community ?? []).filter(c => c.owner !== userId);
    for (const r of s.reports ?? []) if (r.by === userId) r.by = null;
    this.write(s);
  }
}
