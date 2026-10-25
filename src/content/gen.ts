import type { Level, Question, QuestionFormat, Visual } from "../types";

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
}

export type Template = (r: Rng) => Draft;

export const PER_LEVEL = 20;

/**
 * Builds a fixed bank from templates: PER_LEVEL unique questions for each
 * level, taking templates in turn so every level mixes its question types.
 */
export function buildBank(
  topicId: string,
  seed: number,
  templates: Record<Level, Template[]>,
  perLevel = PER_LEVEL,
): Question[] {
  const r = mulberry32(seed);
  const bank: Question[] = [];
  for (const level of [1, 2, 3, 4] as Level[]) {
    const seen = new Set<string>();
    const list = templates[level];
    let n = 0;
    for (let tries = 0; n < perLevel && tries < perLevel * 200; tries++) {
      const d = list[tries % list.length](r);
      const key = d.prompt + "|" + JSON.stringify(d.visual ?? null);
      if (seen.has(key)) continue;
      seen.add(key);
      n += 1;
      bank.push({ ...d, id: `${topicId}-L${level}-${String(n).padStart(2, "0")}`, topicId, level });
    }
    if (n < perLevel) throw new Error(`${topicId} L${level}: only ${n} unique questions`);
  }
  return bank;
}

export const NAMES = ["Riya", "Arjun", "Meera", "Kabir", "Zara", "Dev", "Anaya", "Ishaan"] as const;
export const THINGS = ["balloons", "apples", "stars", "marbles", "flowers", "sweets", "shells", "pencils"] as const;
