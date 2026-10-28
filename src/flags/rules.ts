import { CLASS_ORDER, type ClassId, type Level } from "../types";
import { checkLiveBand, DEFAULT_BANDS, type CheckReport, type LevelBand } from "../validation";

/**
 * Question flags: anyone can say what is wrong with a question, and Nitya
 * decides when it needs the admin. The rules (cp, 2026-10-26, improved in the
 * "Nitya Question Flags" spec):
 *   * A flag hides the question for the flagging family, and starts a watch.
 *     Another family's flag restarts the watch; a quiet watch lets the
 *     question back for the families who flagged it.
 *   * Families, not flags, are counted, each weighted by its trust. Enough of
 *     them within the memory window send the question to the admin's review.
 *   * "Not right for a child", or a flag on a question whose marked answer
 *     Nitya's answer check disagrees with, sends it to review at once.
 *   * A family that flags many questions in a short time is checked as a
 *     whole ("Flagger check"); its flags hide questions only for itself.
 *   * Live results count as one family's flag ("silent flags").
 * The demo applies these rules with FlagBook below; the database applies the
 * same rules in SQL (supabase/migrations/*_question_flags.sql). The account
 * contract tests hold the two to the same behaviour.
 */

export const FLAG_BOXES = ["question", "options", "level", "explanation", "safety"] as const;
export type FlagBox = (typeof FLAG_BOXES)[number];
export type LevelDirection = "easy" | "hard";

/** The boxes as a family sees them, with the line under each. */
export const FLAG_BOX_TEXT: Record<FlagBox, { label: string; help: string }> = {
  question: { label: "Wrong question", help: "The question is wrong, unclear, or the picture doesn't match" },
  options: { label: "Wrong options", help: "The right answer is marked wrong, two choices are right, or the right one is missing" },
  level: { label: "Wrong level", help: "Too easy or too hard for this level" },
  explanation: { label: "Wrong explanation", help: "The hint or explanation is wrong or doesn't help" },
  safety: { label: "Not right for a child", help: "Unsafe, unkind or not suitable" },
};

/** Boxes that say the question might teach a wrong fact: a question in review with one of these is hidden for everyone. */
const HARMFUL: FlagBox[] = ["question", "options", "safety"];
export const NOTE_MAX = 300;

const DAY = 864e5;
const iso = (t: number) => new Date(t).toISOString();

/** The numbers the admin can change, with their starting values. Only the 7-day watch is cp's; the rest are defaults to tune. */
export interface FlagSettings {
  /** Days a question stays hidden for the families who flagged it, from the latest flag. */
  watchDays: number;
  /** Families (weighted by trust) that send an official question to review. */
  reviewFamilies: number;
  /** The same for a community question, which only Nitya's checker has looked at. */
  communityFamilies: number;
  /** Days a flag still counts after its watch ends. */
  memoryDays: number;
  /** Questions one family flags within burstDays that make a Flagger check. */
  burstFlags: number;
  burstDays: number;
  /** Flags one family can send in a day. */
  dailyCap: number;
  /** Trust below which a family's flags stop counting, once it has muteAfter decided flags. */
  muteBelow: number;
  muteAfter: number;
  /** Days a family's flags don't count after the admin finds its Flagger check not helpful. */
  muteDays: number;
  /** Share of children picking one wrong choice that counts as a silent flag. */
  wrongChoiceShare: number;
  /** Answers a question needs before its live results count. */
  minAnswers: number;
}

export const DEFAULT_FLAG_SETTINGS: FlagSettings = {
  watchDays: 7, reviewFamilies: 3, communityFamilies: 2, memoryDays: 90, burstFlags: 10, burstDays: 7,
  dailyCap: 20, muteBelow: 0.25, muteAfter: 5, muteDays: 30, wrongChoiceShare: 0.4, minAnswers: 30,
};

/** What the admin may set each number to. The database checks the same ranges. */
export const FLAG_SETTING_LIMITS: Record<keyof FlagSettings, { min: number; max: number; label: string; whole: boolean }> = {
  watchDays: { min: 1, max: 30, label: "Watch period after a flag, in days", whole: true },
  reviewFamilies: { min: 2, max: 10, label: "Families needed to send a question to review", whole: true },
  communityFamilies: { min: 1, max: 10, label: "Families needed for a community question", whole: true },
  memoryDays: { min: 30, max: 365, label: "Days a released flag still counts", whole: true },
  burstFlags: { min: 5, max: 50, label: "Questions that make a Flagger check", whole: true },
  burstDays: { min: 1, max: 30, label: "…within this many days", whole: true },
  dailyCap: { min: 5, max: 100, label: "Flags a family can send in a day", whole: true },
  muteBelow: { min: 0, max: 1, label: "Trust below which flags stop counting", whole: false },
  muteAfter: { min: 1, max: 50, label: "…once a family has this many decided flags", whole: true },
  muteDays: { min: 7, max: 365, label: "Days a not-helpful family's flags don't count", whole: true },
  wrongChoiceShare: { min: 0.2, max: 0.8, label: "Share picking one wrong choice that counts as a flag", whole: false },
  minAnswers: { min: 10, max: 500, label: "Answers before live results count", whole: true },
};

export function flagSettingsProblems(s: FlagSettings): string[] {
  return (Object.keys(FLAG_SETTING_LIMITS) as (keyof FlagSettings)[]).flatMap(k => {
    const { min, max, label, whole } = FLAG_SETTING_LIMITS[k];
    const v = s[k];
    if (typeof v !== "number" || !Number.isFinite(v) || (whole && !Number.isInteger(v)) || v < min || v > max) {
      return [`${label.replace(/^…/, "")}: use ${whole ? "a whole number " : ""}from ${min} to ${max}.`];
    }
    return [];
  });
}

/** What a family sends when it flags a question. */
export interface FlagRequest {
  questionId: string;
  /** The child who got the question, when the flag is about a child's quiz. */
  profileId?: string | null;
  boxes: FlagBox[];
  /** With "level": too easy or too hard. */
  levelDirection?: LevelDirection | null;
  note?: string | null;
  /** For the admin's flagger card: whether the child's first try was wrong, and how long after answering the flag came. */
  answeredWrong?: boolean | null;
  secondsAfterAnswer?: number | null;
}

/** The flag cleaned up, or a plain sentence saying what is missing. */
export function cleanFlag(r: FlagRequest): { boxes: FlagBox[]; levelDirection: LevelDirection | null; note: string | null } | string {
  const boxes = FLAG_BOXES.filter(b => Array.isArray(r.boxes) && r.boxes.includes(b));
  if (!boxes.length) return "Tick at least one box.";
  const levelDirection = boxes.includes("level") ? r.levelDirection ?? null : null;
  if (boxes.includes("level") && levelDirection !== "easy" && levelDirection !== "hard") return "Say whether it is too easy or too hard.";
  const note = typeof r.note === "string" ? r.note.trim() : "";
  if (note.length > NOTE_MAX) return `Keep the note to ${NOTE_MAX} characters.`;
  return { boxes, levelDirection, note: note || null };
}

/** Children from Class 6 tick the boxes themselves; younger children tap "Something's wrong?" and a parent ticks them. */
export const childFlagsDirectly = (classId: ClassId) => CLASS_ORDER.indexOf(classId) >= CLASS_ORDER.indexOf("C6");

/** The code the admin sees for a family: the same each time, and nothing that names them. */
export function flaggerCode(parentId: string): string {
  let h = 2166136261;
  for (const ch of parentId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) { code += abc[h % 32]; h = Math.floor(h / 32); }
  return `F-${code}`;
}

/** A family's flagging record. */
export interface TrustRecord {
  upheld: number;
  /** Flagger checks the admin found helpful. */
  helpful: number;
  dismissed: number;
  mutedUntil: string | null;
}
export const NEW_TRUST: TrustRecord = { upheld: 0, helpful: 0, dismissed: 0, mutedUntil: null };

/** From 0 to 2, starting at 1: an upheld flag adds 0.1, a dismissed one takes 0.25 away. */
export function trustOf(t: TrustRecord): number {
  const v = 1 + 0.1 * (t.upheld + t.helpful) - 0.25 * t.dismissed;
  return Math.round(Math.min(2, Math.max(0, v)) * 1000) / 1000;
}

/** How many families one flag of this family counts as: its trust, or 0 while it is muted. */
export function flagWeight(t: TrustRecord, s: FlagSettings, now: Date): number {
  if (t.mutedUntil && Date.parse(t.mutedUntil) > now.getTime()) return 0;
  const trust = trustOf(t);
  if (trust < s.muteBelow && t.upheld + t.dismissed >= s.muteAfter) return 0;
  return trust;
}

/**
 * Questions from one template, which share its mistakes. Generated questions
 * name their template and seed; the built-in bank shares one generator, so
 * its siblings are also those with the same skill and level.
 */
export function templateKey(q: { topicId: string; source?: string; sourceRef?: string; subSkill: string; level: Level }): string | null {
  if (q.source !== "template" || !q.sourceRef) return null;
  const base = q.sourceRef.replace(/, seed \d+$/, "");
  return base.endsWith("built-in bank") ? `${q.topicId}|${base}|${q.subSkill}|${q.level}` : `${q.topicId}|${base}`;
}

// ---------------------------------------------------------------------------
// Silent flags from live results

/** Answers after the hint a question needs before its hint is judged, and the share right after it below which the hint counts as unhelpful. */
export const MIN_RETRIES = 10;
export const HINT_SHARE = 0.25;

export interface QuestionStats {
  shown: number;
  firstTryRight: number;
  /** First tries that were wrong, so the child got the hint. */
  retries: number;
  retryRight: number;
  /** Each choice's first-try picks. */
  picks: Record<string, number>;
}
export const NEW_STATS: QuestionStats = { shown: 0, firstTryRight: 0, retries: 0, retryRight: 0, picks: {} };

/** One answer, counted into a question's live results. */
export function countAnswer(s: QuestionStats, r: { firstTryCorrect: boolean; retryCorrect: boolean | null; firstAnswer?: string | null }): QuestionStats {
  const picks = { ...s.picks };
  if (r.firstAnswer) picks[r.firstAnswer] = (picks[r.firstAnswer] ?? 0) + 1;
  return {
    shown: s.shown + 1,
    firstTryRight: s.firstTryRight + (r.firstTryCorrect ? 1 : 0),
    retries: s.retries + (r.firstTryCorrect ? 0 : 1),
    retryRight: s.retryRight + (!r.firstTryCorrect && r.retryCorrect ? 1 : 0),
    picks,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** What a question's live results say is wrong with it, as system flags: one box each, with a sentence for the admin. */
export function silentSignals(
  q: { level: Level; answers: string[] }, s: QuestionStats, settings: FlagSettings, bands: LevelBand[] = DEFAULT_BANDS,
): { box: FlagBox; levelDirection: LevelDirection | null; note: string }[] {
  const out: { box: FlagBox; levelDirection: LevelDirection | null; note: string }[] = [];
  const band = checkLiveBand({ level: q.level, timesShown: s.shown, firstTryCorrect: s.firstTryRight }, bands, settings.minAnswers);
  if (band.status === "outside-band") {
    out.push({
      box: "level", levelDirection: band.looksLike < q.level ? "easy" : "hard",
      note: `${pct(band.rate)} of children got it right first time, which fits level ${band.looksLike}.`,
    });
  }
  if (s.shown >= settings.minAnswers) {
    const wrong = Object.entries(s.picks).filter(([choice]) => !q.answers.includes(choice)).sort((a, b) => b[1] - a[1])[0];
    if (wrong && wrong[1] / s.shown >= settings.wrongChoiceShare) {
      out.push({ box: "options", levelDirection: null, note: `${pct(wrong[1] / s.shown)} of children picked ${wrong[0]} first.` });
    }
  }
  if (s.retries >= MIN_RETRIES && s.retryRight / s.retries < HINT_SHARE) {
    out.push({ box: "explanation", levelDirection: null, note: `Only ${pct(s.retryRight / s.retries)} of children got it right after the hint.` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The flag book: the rules over plain data, for the demo

export interface FlagRow {
  id: number;
  questionId: string;
  /** "system": a silent flag from live results. */
  kind: "family" | "system";
  /** Null for a system flag, or once the family has deleted its account. */
  parentId: string | null;
  profileId: string | null;
  boxes: FlagBox[];
  levelDirection: LevelDirection | null;
  note: string | null;
  /** How many families this flag counts as, from the family's trust when it flagged. */
  weight: number;
  answeredWrong: boolean | null;
  secondsAfterAnswer: number | null;
  /** The latest flag; a family flagging the same question again moves it. */
  flaggedAt: string;
  /** The family stops seeing the question until then (or until the admin decides, while it is in review). */
  hideUntil: string | null;
  /** Part of a Flagger check: hidden for this family until the admin decides, and not counted meanwhile. */
  burst: boolean;
  resolvedAt: string | null;
  outcome: "upheld" | "dismissed" | null;
}

/** A child's "Something's wrong?" tap, waiting for a parent. */
export interface FlagSuggestion {
  parentId: string;
  profileId: string;
  questionId: string;
  answeredWrong: boolean | null;
  suggestedAt: string;
}

export interface FlagBookState {
  flags: FlagRow[];
  nextId: number;
  trust: Record<string, TrustRecord>;
  /** Questions in review: since when, and whether they are hidden for everyone meanwhile. */
  review: Record<string, { since: string; hideAll: boolean }>;
  suggestions: FlagSuggestion[];
  settings: FlagSettings;
}

export const emptyFlagBook = (): FlagBookState => ({ flags: [], nextId: 1, trust: {}, review: {}, suggestions: [], settings: { ...DEFAULT_FLAG_SETTINGS } });

/** What the rules need to know about a flagged question. */
export interface FlagTarget {
  /** Another family's shared question, which fewer families send to review. */
  community: boolean;
  /** Nitya's answer check says the marked answer is wrong. */
  answerCheckDisagrees: boolean;
}

// ---------------------------------------------------------------------------
// What the admin sees, worked out the same way by both backends

/** What Nitya's answer check said when the question was last checked. Community questions passed every check. */
export function answerCheckOf(report: CheckReport | null): "agrees" | "disagrees" | "unchecked" {
  if (!report) return "agrees";
  if (report.answer.unchecked) return "unchecked";
  return !report.answer.passed && (report.answer.wrongKeys?.length ?? 0) > 0 ? "disagrees" : "agrees";
}

export interface FlagSummary {
  /** Families that ticked each box; the silent flags count as one. */
  boxes: Partial<Record<FlagBox, number>>;
  levelDirections: { easy: number; hard: number };
  /** What families wrote. */
  notes: string[];
  /** What the live results say, from the silent flags. */
  signals: string[];
}

/** A question's open flags, summed up for the admin. */
export function flagSummary(flags: FlagRow[]): FlagSummary {
  const boxes: Partial<Record<FlagBox, number>> = {};
  for (const box of FLAG_BOXES) {
    const who = new Set(flags.filter(f => f.boxes.includes(box)).map(f => (f.kind === "system" ? "system" : f.parentId ?? `gone-${f.id}`)));
    if (who.size) boxes[box] = who.size;
  }
  return {
    boxes,
    levelDirections: { easy: flags.filter(f => f.levelDirection === "easy").length, hard: flags.filter(f => f.levelDirection === "hard").length },
    notes: flags.filter(f => f.kind === "family").flatMap(f => (f.note ? [f.note] : [])),
    signals: flags.filter(f => f.kind === "system").map(f => f.note ?? ""),
  };
}

/** The admin's queue order: child safety first, then a possibly wrong answer, the question, the explanation, the level; more families first. */
export function queueRank(boxes: Partial<Record<FlagBox, number>>): number {
  const order: FlagBox[] = ["safety", "options", "question", "explanation", "level"];
  const i = order.findIndex(b => boxes[b]);
  return (i < 0 ? order.length : i) * 100 - Math.max(0, ...Object.values(boxes).map(n => n ?? 0));
}

/** The admin's card for a family waiting on a Flagger check: what it did, never who it is. */
export interface FlaggerCard {
  /** Acted on, never shown: the admin sees the code. */
  parentId: string;
  code: string;
  accountAgeDays: number | null;
  classes: ClassId[];
  flagsThisWeek: number;
  flagsTotal: number;
  upheld: number;
  dismissed: number;
  /** Flags made right after the child got the question wrong, out of those made after an answer. */
  answeredWrong: number;
  answered: number;
  averageSeconds: number | null;
  /** Flags with each box. */
  boxes: Partial<Record<FlagBox, number>>;
  notes: string[];
}

/** The card, from every flag of the family's (`all`) and what Nitya knows of it. */
export function flaggerCard(
  parentId: string, all: FlagRow[], trust: TrustRecord, who: { createdAt: string | null; classes: ClassId[] }, settings: FlagSettings, now: Date,
): FlaggerCard {
  const t = now.getTime();
  const open = all.filter(f => f.burst && !f.resolvedAt);
  const timed = open.filter(f => f.secondsAfterAnswer !== null);
  return {
    parentId, code: flaggerCode(parentId),
    accountAgeDays: who.createdAt ? Math.floor((t - Date.parse(who.createdAt)) / DAY) : null,
    classes: who.classes,
    flagsThisWeek: all.filter(f => Date.parse(f.flaggedAt) > t - settings.burstDays * DAY).length,
    flagsTotal: all.length, upheld: trust.upheld, dismissed: trust.dismissed,
    answeredWrong: open.filter(f => f.answeredWrong === true).length, answered: open.filter(f => f.answeredWrong !== null).length,
    averageSeconds: timed.length ? Math.round(timed.reduce((a, f) => a + f.secondsAfterAnswer!, 0) / timed.length) : null,
    boxes: Object.fromEntries(FLAG_BOXES.map(b => [b, open.filter(f => f.boxes.includes(b)).length]).filter(([, n]) => n)),
    notes: open.flatMap(f => (f.note ? [f.note] : [])),
  };
}

/** What a flag did, for the family's thank-you. */
export type FlagOutcome = "watching" | "review" | "own-review";

export class FlagBook {
  constructor(readonly state: FlagBookState) {}

  get settings() { return this.state.settings; }

  trust(parentId: string): TrustRecord {
    return this.state.trust[parentId] ?? { ...NEW_TRUST };
  }

  private open(questionId?: string) {
    return this.state.flags.filter(f => !f.resolvedAt && (questionId === undefined || f.questionId === questionId));
  }

  /** The flags that count toward review: open, within the memory window, not waiting on a Flagger check. */
  private counted(questionId: string, now: Date) {
    const from = now.getTime() - this.settings.memoryDays * DAY;
    return this.open(questionId).filter(f => !f.burst && Date.parse(f.flaggedAt) > from);
  }

  /** Families flagging a question, each counted once at its highest weight; all silent flags together count as one family. */
  families(questionId: string, now: Date): number {
    const by = new Map<string, number>();
    for (const f of this.counted(questionId, now)) {
      const key = f.kind === "system" ? "system" : f.parentId ?? `gone-${f.id}`;
      by.set(key, Math.max(by.get(key) ?? 0, f.kind === "system" ? 1 : f.weight));
    }
    return Math.round([...by.values()].reduce((a, b) => a + b, 0) * 1000) / 1000;
  }

  /** Sends the question to review when the rules say so, and decides whether it is hidden for everyone meanwhile. */
  evaluate(questionId: string, target: FlagTarget, now: Date) {
    const live = this.counted(questionId, now).filter(f => f.kind === "system" || f.weight > 0);
    const urgent = live.some(f => f.boxes.includes("safety"))
      || (target.answerCheckDisagrees && live.some(f => f.boxes.includes("options") || f.boxes.includes("question")));
    const enough = this.families(questionId, now) >= (target.community ? this.settings.communityFamilies : this.settings.reviewFamilies);
    const current = this.state.review[questionId];
    if (!current && !urgent && !enough) return;
    this.state.review[questionId] = {
      since: current?.since ?? iso(now.getTime()),
      hideAll: urgent || live.some(f => f.boxes.some(b => HARMFUL.includes(b))),
    };
  }

  /** A family's flag. Throws a plain sentence when the flag isn't allowed. */
  flag(parentId: string, request: FlagRequest, target: FlagTarget, now: Date): FlagOutcome {
    const clean = cleanFlag(request);
    if (typeof clean === "string") throw new Error(clean);
    const s = this.settings;
    const t = now.getTime();
    const mine = this.state.flags.filter(f => f.kind === "family" && f.parentId === parentId);
    if (mine.filter(f => Date.parse(f.flaggedAt) > t - DAY).length >= s.dailyCap) {
      throw new Error(`You can send up to ${s.dailyCap} flags a day. Please try again tomorrow.`);
    }
    if (mine.some(f => f.questionId === request.questionId && f.outcome === "dismissed" && !this.changedSince(request.questionId, f.resolvedAt!))) {
      throw new Error("You flagged this question before, and Nitya's team kept it as it is.");
    }
    const weight = flagWeight(this.trust(parentId), s, now);
    const inBurst = mine.some(f => !f.resolvedAt && f.burst);
    let row = mine.find(f => !f.resolvedAt && f.questionId === request.questionId);
    const fields = {
      profileId: request.profileId ?? null, answeredWrong: request.answeredWrong ?? null,
      secondsAfterAnswer: request.secondsAfterAnswer ?? null, weight, flaggedAt: iso(t), hideUntil: iso(t + s.watchDays * DAY),
    };
    if (row) {
      // The same family again: it hides the question for them again, but is still one family.
      Object.assign(row, fields, {
        boxes: FLAG_BOXES.filter(b => row!.boxes.includes(b) || clean.boxes.includes(b)),
        levelDirection: clean.levelDirection ?? row.levelDirection, note: clean.note ?? row.note,
      });
    } else {
      row = { id: this.state.nextId++, questionId: request.questionId, kind: "family", parentId, ...clean, ...fields, burst: inBurst, resolvedAt: null, outcome: null };
      this.state.flags.push(row);
    }
    // A child's tap on this question is answered by this flag.
    this.state.suggestions = this.state.suggestions.filter(x => !(x.parentId === parentId && x.questionId === request.questionId));

    // Another flag restarts the watch for every family still waiting on it.
    for (const f of this.open(request.questionId)) {
      if (f.kind === "family" && f.hideUntil && Date.parse(f.hideUntil) > t) f.hideUntil = row.hideUntil;
    }

    // Many questions in a short time: the family's open flags become one Flagger check.
    const since = t - s.burstDays * DAY;
    const recent = new Set(mine.concat(mine.includes(row) ? [] : [row]).filter(f => Date.parse(f.flaggedAt) > since).map(f => f.questionId));
    if (weight > 0 && recent.size >= s.burstFlags) {
      for (const f of this.state.flags) if (f.kind === "family" && f.parentId === parentId && !f.resolvedAt) f.burst = true;
    }
    if (row.burst) return this.state.review[request.questionId] ? "review" : "watching";
    this.evaluate(request.questionId, target, now);
    return this.state.review[request.questionId] ? "review" : "watching";
  }

  /** Whether the admin changed the question (upheld flags on it) after `time`, making it a new version. */
  private changedSince(questionId: string, time: string) {
    return this.state.flags.some(f => f.questionId === questionId && f.outcome === "upheld" && f.resolvedAt! > time);
  }

  /** A silent flag from live results, once per box while it is open. */
  systemFlag(questionId: string, signal: { box: FlagBox; levelDirection: LevelDirection | null; note: string }, target: FlagTarget, now: Date) {
    if (this.open(questionId).some(f => f.kind === "system" && f.boxes[0] === signal.box)) return;
    this.state.flags.push({
      id: this.state.nextId++, questionId, kind: "system", parentId: null, profileId: null, boxes: [signal.box],
      levelDirection: signal.levelDirection, note: signal.note, weight: 1, answeredWrong: null, secondsAfterAnswer: null,
      flaggedAt: iso(now.getTime()), hideUntil: null, burst: false, resolvedAt: null, outcome: null,
    });
    this.evaluate(questionId, target, now);
  }

  suggest(parentId: string, profileId: string, questionId: string, answeredWrong: boolean | null, now: Date) {
    if (this.state.suggestions.some(x => x.profileId === profileId && x.questionId === questionId)) return;
    this.state.suggestions.push({ parentId, profileId, questionId, answeredWrong, suggestedAt: iso(now.getTime()) });
  }

  dismissSuggestion(parentId: string, profileId: string, questionId: string) {
    this.state.suggestions = this.state.suggestions.filter(x => !(x.parentId === parentId && x.profileId === profileId && x.questionId === questionId));
  }

  /** Questions a family's children don't get now; with a profile, also those that child tapped "Something's wrong?" on. */
  hiddenFor(parentId: string, profileId: string | null, now: Date): Set<string> {
    const t = now.getTime();
    const out = new Set<string>();
    for (const f of this.open()) {
      if (f.kind !== "family" || f.parentId !== parentId) continue;
      if (f.burst || this.state.review[f.questionId] || (f.hideUntil && Date.parse(f.hideUntil) > t)) out.add(f.questionId);
    }
    for (const x of this.state.suggestions) if (x.parentId === parentId && (!profileId || x.profileId === profileId)) out.add(x.questionId);
    return out;
  }

  hiddenForAll(questionId: string): boolean {
    return !!this.state.review[questionId]?.hideAll;
  }

  /** The admin's decision on a question in review: the flags were right (upheld) or not (dismissed). */
  decide(questionId: string, outcome: "upheld" | "dismissed", now: Date) {
    if (!this.state.review[questionId]) throw new Error("That question isn't waiting for review.");
    this.resolve(this.open(questionId), outcome, now);
    delete this.state.review[questionId];
  }

  private resolve(flags: FlagRow[], outcome: "upheld" | "dismissed", now: Date) {
    const families = new Map<string, number>();
    for (const f of flags) {
      f.resolvedAt = iso(now.getTime());
      f.outcome = outcome;
      f.burst = false;
      if (f.kind === "family" && f.parentId) families.set(f.parentId, (families.get(f.parentId) ?? 0) + 1);
    }
    for (const [parentId, n] of families) {
      const t = (this.state.trust[parentId] ??= { ...NEW_TRUST });
      if (outcome === "upheld") t.upheld += n; else t.dismissed += n;
    }
  }

  /** The admin's call on a Flagger check. */
  decideFlagger(parentId: string, decision: "helpful" | "not-helpful" | "each", targetOf: (questionId: string) => FlagTarget, now: Date) {
    const flags = this.open().filter(f => f.kind === "family" && f.parentId === parentId && f.burst);
    if (!flags.length) throw new Error("That family has no Flagger check waiting.");
    if (decision === "not-helpful") {
      this.resolve(flags, "dismissed", now);
      (this.state.trust[parentId] ??= { ...NEW_TRUST }).mutedUntil = iso(now.getTime() + this.settings.muteDays * DAY);
      return;
    }
    if (decision === "helpful") (this.state.trust[parentId] ??= { ...NEW_TRUST }).helpful += 1;
    for (const f of flags) {
      f.burst = false;
      // Each question goes to review, whatever the count.
      this.state.review[f.questionId] ??= { since: iso(now.getTime()), hideAll: false };
      this.evaluate(f.questionId, targetOf(f.questionId), now);
    }
  }

  /** Forgets a family that deleted its account: its flags stay without it, so the counts stay true. */
  forget(parentId: string) {
    for (const f of this.state.flags) if (f.parentId === parentId) { f.parentId = null; f.profileId = null; }
    this.state.suggestions = this.state.suggestions.filter(x => x.parentId !== parentId);
    delete this.state.trust[parentId];
  }

  /** A child's profile was deleted: its taps go, its flags stay without it. */
  forgetProfile(profileId: string) {
    for (const f of this.state.flags) if (f.profileId === profileId) f.profileId = null;
    this.state.suggestions = this.state.suggestions.filter(x => x.profileId !== profileId);
  }

  /** Flags on a question that no longer exists. */
  drop(questionId: string) {
    this.state.flags = this.state.flags.filter(f => f.questionId !== questionId);
    this.state.suggestions = this.state.suggestions.filter(x => x.questionId !== questionId);
    delete this.state.review[questionId];
  }
}
