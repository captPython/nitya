import type { ClassId, Level, Question } from "../types";
import {
  CLASS_SCOPES, DEFAULT_BANDS, MAX_OPTIONS, MIN_OPTIONS, MIN_PLAYS_FOR_BAND_CHECK, TOPIC_SCOPES, UNSAFE_WORDS,
  type LevelBand,
} from "./rules";
import { interpret, WorkingError, type Interpretation } from "./working";

/** Bumped whenever a check changes, so old reports can be told apart. */
export const VALIDATOR_VERSION = "1";

export interface CheckResult {
  passed: boolean;
  /** Plain sentences for the admin's review queue. Empty when the check passed. */
  problems: string[];
  /** The answer check only: the stored answers that recomputing shows are wrong. */
  wrongKeys?: string[];
  /** The answer check only: the answer couldn't be recomputed, so it is unchecked rather than wrong. */
  unchecked?: boolean;
}

/** One run of every check on one question. Stored as question_checks.report. */
export interface CheckReport {
  version: string;
  passed: boolean;
  answer: CheckResult;
  options: CheckResult;
  scope: CheckResult;
  level: CheckResult & { estimate: Level | null };
  wording: CheckResult;
}

export interface ValidationContext {
  classId: ClassId;
  /** The topic's sub-skill ids. A question must use one of them. */
  subSkills: string[];
}

const result = (problems: string[]): CheckResult => ({ passed: problems.length === 0, problems });
const numbersIn = (text: string) => (text.match(/\d+/g) ?? []).map(Number);
const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** "4", "4 and 7", "4, 7 and 9". */
function listOf(items: (string | number)[]): string {
  const xs = items.map(String);
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
const isAre = (items: unknown[]) => (items.length === 1 ? "is" : "are");
const sorted = (ns: number[]) => [...new Set(ns)].sort((a, b) => a - b);

/** Whether `text` says `phrase` as a whole, so "4" is not found inside "14". */
function mentions(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])${escaped}($|[^\\w])`).test(text);
}

function visualNumbers(q: Question): number[] {
  return q.visual?.groups.flatMap(g => [g.count, ...(g.crossed ? [g.crossed] : [])]) ?? [];
}

/** What shape an option has, so a wrong option can't give itself away by looking different. */
function shapeOf(option: string): string {
  const s = option.trim();
  if (/^\d+$/.test(s)) return "number";
  if (/^\d+ [+−-] \d+$/.test(s)) return "sum";
  if (/^\d+(, \d+)+$/.test(s)) return "list";
  if (/^\d+ and \d+$/.test(s)) return "pair";
  return "word";
}

function checkAnswer(q: Question, follow: Interpretation | null, workingProblem: string | null): CheckResult {
  if (!follow) return { ...result([workingProblem ?? "The question has no working, so its answer can't be recomputed. Check it by hand."]), unchecked: true };
  const problems: string[] = [];

  const shown = new Set([...numbersIn(q.prompt), ...(q.options ?? []).flatMap(numbersIn), ...visualNumbers(q)]);
  const missing = sorted(follow.givens.filter(n => !shown.has(n)));
  if (missing.length) problems.push(`The working uses ${listOf(missing)}, which the question never shows.`);
  const used = new Set([...follow.givens, ...follow.pathValues, ...visualNumbers(q)]);
  const unused = sorted(numbersIn(q.prompt).filter(n => !used.has(n) && n !== 1));
  if (unused.length) problems.push(`The question shows ${listOf(unused)}, which the working never uses.`);
  for (const w of follow.words) {
    if (!new RegExp(`\\b${w}\\b`, "i").test(q.prompt)) problems.push(`The working uses the word "${w}", which the question never says.`);
  }

  const wrongAnswers = q.answers.filter(a => !follow.accepts(a));
  if (wrongAnswers.length) {
    problems.push(`Recomputing gives a different answer: ${listOf(wrongAnswers)} ${isAre(wrongAnswers)} wrong.`);
  }
  if (q.options) {
    const right = q.options.filter(o => follow.accepts(o));
    const unlisted = right.filter(o => !q.answers.includes(o));
    if (right.length === 0) problems.push("None of the options is right.");
    else if (q.answers.length === 1 && right.length > 1) problems.push(`More than one option is right: ${listOf(right)}.`);
    else if (unlisted.length) problems.push(`${listOf(unlisted)} ${isAre(unlisted)} right but not listed as an answer.`);
  }

  const told = normalise(`${q.explanation} ${q.reason}`);
  if (!q.answers.some(a => mentions(told, normalise(a)))) problems.push("The explanation and reason never state the answer.");
  return { ...result(problems), ...(wrongAnswers.length ? { wrongKeys: wrongAnswers } : {}) };
}

function checkOptions(q: Question, follow: Interpretation | null): CheckResult {
  const problems: string[] = [];
  const options = q.options;
  if (!options) {
    if (q.format !== "numeric") problems.push(`A ${q.format} question needs options to tap.`);
    return result(problems);
  }
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    problems.push(`It has ${options.length} options; it should have ${MIN_OPTIONS} to ${MAX_OPTIONS}.`);
  }
  const seen = new Set<string>();
  for (const o of options) {
    if (seen.has(normalise(o))) problems.push(`"${o}" appears twice.`);
    seen.add(normalise(o));
  }
  for (const a of q.answers) if (!options.includes(a)) problems.push(`The answer "${a}" is not one of the options.`);

  const shape = shapeOf(q.answers[0] ?? "");
  const odd = options.filter(o => shapeOf(o) !== shape);
  if (odd.length) {
    problems.push(`${listOf(odd.map(o => `"${o}"`))} ${odd.length === 1 ? "looks" : "look"} different from the answer, which gives it away.`);
  }

  if (follow?.computed && shape === "number") {
    const answer = Number(q.answers[0]);
    const reach = Math.max(3, Math.ceil(answer / 2));
    const far = options.filter(o => !q.answers.includes(o) && Math.abs(Number(o) - answer) > reach);
    if (far.length) {
      problems.push(`${listOf(far)} ${isAre(far)} too far from the answer ${answer} to be a believable mistake.`);
    }
  }
  return result(problems);
}

function checkScope(q: Question, ctx: ValidationContext, follow: Interpretation | null): CheckResult {
  const problems: string[] = [];
  const scope = CLASS_SCOPES[ctx.classId];
  if (!scope) return result([`No syllabus limits are set for ${ctx.classId} yet, so the question can't be checked against them.`]);

  const numbers = [
    ...numbersIn(q.prompt), ...(q.options ?? []).flatMap(numbersIn), ...q.answers.flatMap(numbersIn),
    ...visualNumbers(q), ...(follow?.pathValues ?? []),
  ];
  const outside = sorted(numbers.filter(n => n < scope.minNumber || n > scope.maxNumber));
  if (outside.length) {
    problems.push(
      `${listOf(outside)} ${isAre(outside)} outside ${ctx.classId}'s range of ${scope.minNumber} to ${scope.maxNumber}.`,
    );
  }
  const topic = TOPIC_SCOPES[q.topicId];
  if (topic && follow) {
    const big = sorted(follow.pathValues.filter(n => n > topic.maxResult));
    if (big.length) problems.push(`Working it out reaches ${listOf(big)}, past this topic's limit of ${topic.maxResult}.`);
  }
  if (!ctx.subSkills.includes(q.subSkill)) problems.push(`"${q.subSkill}" is not a skill in this topic.`);
  return result(problems);
}

/**
 * A rough difficulty estimate from the size of the numbers, the thinking
 * steps and whether a picture helps. It only flags a tag that is 2 or more
 * levels away; live results catch the closer calls.
 */
export function estimateLevel(q: Question, follow: Interpretation): Level {
  const biggest = Math.max(0, ...follow.pathValues);
  const size = biggest <= 10 ? 0 : biggest <= 20 ? 1 : 2;
  const picture = q.visual && follow.steps > 0 ? 1 : 0;
  return Math.min(4, Math.max(1, 1 + size + follow.steps - picture)) as Level;
}

function checkLevel(q: Question, follow: Interpretation | null): CheckResult & { estimate: Level | null } {
  if (!follow) return { ...result(["The level can't be estimated without the working."]), estimate: null };
  const estimate = estimateLevel(q, follow);
  const problems = Math.abs(estimate - q.level) >= 2
    ? [`It is tagged L${q.level}, but it looks like L${estimate}.`]
    : [];
  return { ...result(problems), estimate };
}

function checkWording(q: Question, ctx: ValidationContext): CheckResult {
  const problems: string[] = [];
  const scope = CLASS_SCOPES[ctx.classId];
  const words = q.prompt.split(/\s+/).filter(Boolean).length;
  if (scope && words > scope.maxPromptWords) {
    problems.push(`The question is ${words} words long; ${ctx.classId} questions should be ${scope.maxPromptWords} or fewer.`);
  }
  const texts = [q.prompt, q.hint, q.explanation, q.reason, ...(q.options ?? [])];
  for (const field of ["hint", "explanation", "reason"] as const) {
    if (!q[field].trim()) problems.push(`The ${field} is empty.`);
  }
  const all = texts.join(" ");
  const unsafe = UNSAFE_WORDS.filter(w => new RegExp(`\\b${w}\\b`, "i").test(all));
  if (unsafe.length) problems.push(`It uses ${listOf(unsafe.map(w => `"${w}"`))}, which ${unsafe.length === 1 ? "is" : "are"} not right for a child.`);
  if (/https?:\/\/|www\.|\.com\b/i.test(all)) problems.push("It contains a link, and children must never see links.");
  return result(problems);
}

/** Runs every check on one question. A question that fails any check goes to the admin's review queue. */
export function validateQuestion(q: Question, ctx: ValidationContext): CheckReport {
  let follow: Interpretation | null = null;
  let workingProblem: string | null = null;
  if (q.working) {
    try {
      follow = interpret(q.working, q.visual);
    } catch (err) {
      if (!(err instanceof WorkingError)) throw err;
      workingProblem = err.message;
    }
  }
  const report = {
    version: VALIDATOR_VERSION,
    answer: checkAnswer(q, follow, workingProblem),
    options: checkOptions(q, follow),
    scope: checkScope(q, ctx, follow),
    level: checkLevel(q, follow),
    wording: checkWording(q, ctx),
  };
  const passed = [report.answer, report.options, report.scope, report.level, report.wording].every(c => c.passed);
  return { ...report, passed };
}

export type BandCheck =
  | { status: "too-few-plays"; plays: number }
  | { status: "in-band"; rate: number }
  | { status: "outside-band"; rate: number; looksLike: Level };

/**
 * After release: does a question's first-try success rate fit its level's
 * band? A question outside its band goes back through the checks.
 */
export function checkLiveBand(
  q: { level: Level; timesShown: number; firstTryCorrect: number },
  bands: LevelBand[] = DEFAULT_BANDS,
  minPlays = MIN_PLAYS_FOR_BAND_CHECK,
): BandCheck {
  if (q.timesShown < minPlays) return { status: "too-few-plays", plays: q.timesShown };
  const rate = q.firstTryCorrect / q.timesShown;
  const inBand = (b: LevelBand) => rate >= b.minRate && (rate < b.maxRate || (b.maxRate === 1 && rate === 1));
  const own = bands.find(b => b.level === q.level);
  if (own && inBand(own)) return { status: "in-band", rate };
  const looksLike = bands.find(inBand)?.level ?? q.level;
  return { status: "outside-band", rate, looksLike };
}
