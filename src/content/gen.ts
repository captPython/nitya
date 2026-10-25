import type { Expr, Level, Question, QuestionFormat, Visual, Working } from "../types";

export type Rng = () => number;

/** Small seeded generator, so every build of a bank is identical. */
export function mulberry32(seed: number): Rng {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

export function shuffle<T>(r: Rng, xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Three number options: the answer plus two near misses inside [lo, hi]. */
export function numOptions(r: Rng, answer: number, lo: number, hi: number, spread = 2): string[] {
  const opts = new Set<number>([answer]);
  let guard = 0;
  while (opts.size < 3 && guard++ < 100) {
    const d = int(r, 1, spread) * (r() < 0.5 ? -1 : 1);
    const v = answer + d;
    if (v >= lo && v <= hi) opts.add(v);
  }
  for (let v = lo; opts.size < 3 && v <= hi; v++) opts.add(v);
  return shuffle(r, [...opts].map(String));
}

export const dots = (...groups: Visual["groups"]): Visual => ({ kind: "dots", groups });

/** Working helpers: add(3, 4) is 3 + 4, sub(9, 2, 3) is 9 − 2 − 3. */
export const add = (...args: Expr[]): Expr => ({ op: "+", args });
export const sub = (...args: Expr[]): Expr => ({ op: "-", args });
export const arith = (expr: Expr): Working => ({ kind: "arith", expr });

/** What a template returns; the bank builder adds id, topic and level. */
export interface Draft {
  subSkill: string;
  format: QuestionFormat;
  prompt: string;
  visual?: Visual;
  options: string[];
  answers: string[];
  hint: string;
  explanation: string;
  reason: string;
  working: Working;
}

export type Template = (r: Rng) => Draft;

export const PER_LEVEL = 20;

/** Bumped whenever a template changes how it builds questions. */
export const GENERATOR_VERSION = "1";

/** JSON with keys in a fixed order, so the same picture always gives the same text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A short, stable hash of some text, as 16 hex digits (two 32-bit FNV-1a variants). */
export function shortHash(text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ text.charCodeAt(i), 2246822519);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** Two questions with the same key are the same question: same words, same picture. */
export const contentKey = (q: { prompt: string; visual?: Visual }) => `${q.prompt}|${stableJson(q.visual ?? null)}`;

/** Writes the maths of an expression with sums in a fixed order, so 3 + 4 and 4 + 3 read the same. */
function canonical(expr: Expr, visual: Visual | undefined): string {
  if (typeof expr === "number" || expr === "x") return String(expr);
  if ("dots" in expr) {
    const g = visual?.groups[expr.dots];
    return g ? String(g.count - (g.crossed ?? 0)) : "?";
  }
  const args = expr.args.map(a => canonical(a, visual));
  return expr.op === "+" ? `(${[...args].sort().join("+")})` : `(${args.join("-")})`;
}

/**
 * The variant group for a question: questions with the same maths share it,
 * so the engine never puts them in the same quiz.
 */
export function variantGroup(topicId: string, working: Working, visual?: Visual): string {
  const items = (xs: { label: string; expr: Expr }[]) => xs.map(i => canonical(i.expr, visual)).sort().join(",");
  let maths: string;
  switch (working.kind) {
    case "arith": maths = canonical(working.expr, visual); break;
    case "count-dots": maths = (visual?.groups ?? []).map(g => `${g.count}-${g.crossed ?? 0}`).sort().join(","); break;
    case "missing": maths = [canonical(working.lhs, visual), canonical(working.rhs, visual)].sort().join("="); break;
    case "sequence": maths = working.terms.map(t => t ?? "_").join(","); break;
    case "between": maths = `${working.above}<x<${working.below}`; break;
    case "extreme": maths = `${working.of}:${items(working.items)}`; break;
    case "equals": maths = `${working.target}:${items(working.items)}`; break;
    case "order": maths = `${working.direction}:${[...working.values].sort((a, b) => a - b).join(",")}`; break;
    case "number-word": maths = working.word.toLowerCase(); break;
  }
  return `${topicId}:${working.kind}:${maths}`;
}

/**
 * Builds a fixed bank from templates: PER_LEVEL questions for each level, none
 * repeated anywhere in the topic, taking templates in turn so every level
 * mixes its question types.
 */
export function buildBank(
  topicId: string,
  seed: number,
  templates: Record<Level, Template[]>,
  perLevel = PER_LEVEL,
): Question[] {
  const r = mulberry32(seed);
  const bank: Question[] = [];
  // One set for the whole topic: the same question can't sit at two levels.
  const seen = new Set<string>();
  for (const level of [1, 2, 3, 4] as Level[]) {
    const list = templates[level];
    let n = 0;
    for (let tries = 0; n < perLevel && tries < perLevel * 200; tries++) {
      const d = list[tries % list.length](r);
      const key = contentKey(d);
      if (seen.has(key)) continue;
      seen.add(key);
      n += 1;
      bank.push({
        ...d, id: `${topicId}-L${level}-${String(n).padStart(2, "0")}`, topicId, level,
        variantGroup: variantGroup(topicId, d.working, d.visual),
      });
    }
    if (n < perLevel) throw new Error(`${topicId} L${level}: only ${n} unique questions`);
  }
  return bank;
}

export const NAMES = ["Riya", "Arjun", "Meera", "Kabir", "Zara", "Dev", "Anaya", "Ishaan"] as const;
export const THINGS = ["balloons", "apples", "stars", "marbles", "flowers", "sweets", "shells", "pencils"] as const;
