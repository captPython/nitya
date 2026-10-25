import type { Expr, Visual, Working } from "../types";

/** A working that cannot be followed, so the answer cannot be recomputed. */
export class WorkingError extends Error {}

export const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

/** What the validation engine learns by following a question's working itself. */
export interface Interpretation {
  /** Whether an answer (or option) is right. */
  accepts: (answer: string) => boolean;
  /** Every number met on the way to the right answer, for the scope check. */
  pathValues: number[];
  /** Thinking steps on the way to the right answer, for the level check. */
  steps: number;
  /** Numbers the working takes from the question, other than 1, which "one more" and "one less" imply. */
  givens: number[];
  /** Words the working takes from the question. */
  words: string[];
  /** True when the right answer is worked out, so wrong options should be near it. */
  computed: boolean;
}

const isWhole = (s: string) => /^\d+$/.test(s.trim());
const asNumber = (s: string) => (isWhole(s) ? Number(s.trim()) : NaN);

/** The number of dots in a picture group that are not crossed out. */
function groupDots(visual: Visual | undefined, index: number): number {
  const g = visual?.groups[index];
  if (!g) throw new WorkingError(`The working counts picture group ${index + 1}, but the picture has no such group.`);
  return g.count - (g.crossed ?? 0);
}

/** The value of an expression, and every value met on the way. */
function evaluate(expr: Expr, visual: Visual | undefined, x?: number): { value: number; seen: number[] } {
  if (typeof expr === "number") return { value: expr, seen: [expr] };
  if (expr === "x") {
    if (x === undefined) throw new WorkingError("The working uses x outside a missing-number question.");
    return { value: x, seen: [] };
  }
  if ("dots" in expr) {
    const value = groupDots(visual, expr.dots);
    return { value, seen: [value] };
  }
  if (expr.args.length < 2) throw new WorkingError(`A "${expr.op}" in the working needs at least two numbers.`);
  const parts = expr.args.map(a => evaluate(a, visual, x));
  const seen = parts.flatMap(p => p.seen);
  let value = parts[0].value;
  for (const p of parts.slice(1)) {
    value = expr.op === "+" ? value + p.value : value - p.value;
    seen.push(value);
  }
  return { value, seen };
}

/** Plus and minus steps, not counting "+ 1" or "− 1", which are counting on or back by one. */
function opSteps(expr: Expr): number {
  if (typeof expr !== "object" || "dots" in expr) return 0;
  const own = expr.args.slice(1).filter(a => a !== 1).length;
  return own + expr.args.reduce<number>((n, a) => n + opSteps(a), 0);
}

function literals(expr: Expr): number[] {
  if (typeof expr === "number") return [expr];
  if (typeof expr !== "object" || "dots" in expr) return [];
  return expr.args.flatMap(literals);
}

const notOne = (ns: number[]) => ns.filter(n => n !== 1);

/** Follows a working on its own to find which answers are right. Throws WorkingError if it can't. */
export function interpret(working: Working, visual: Visual | undefined): Interpretation {
  switch (working.kind) {
    case "arith": {
      const { value, seen } = evaluate(working.expr, visual);
      return {
        accepts: s => asNumber(s) === value, pathValues: [...seen, value], steps: opSteps(working.expr),
        givens: notOne(literals(working.expr)), words: [], computed: true,
      };
    }
    case "count-dots": {
      if (!visual || visual.groups.length === 0) throw new WorkingError("The working counts dots, but the question has no picture.");
      const value = visual.groups.reduce((n, g) => n + g.count - (g.crossed ?? 0), 0);
      const crossed = visual.groups.some(g => (g.crossed ?? 0) > 0);
      return {
        accepts: s => asNumber(s) === value, pathValues: [...visual.groups.map(g => g.count), value],
        steps: crossed ? 1 : 0, givens: [], words: [], computed: true,
      };
    }
    case "missing": {
      const solutions: number[] = [];
      for (let x = -1000; x <= 1000 && solutions.length < 2; x++) {
        if (evaluate(working.lhs, visual, x).value === evaluate(working.rhs, visual, x).value) solutions.push(x);
      }
      if (solutions.length !== 1) throw new WorkingError("The missing-number working does not have exactly one answer.");
      const x = solutions[0];
      const lhs = evaluate(working.lhs, visual, x), rhs = evaluate(working.rhs, visual, x);
      return {
        accepts: s => asNumber(s) === x, pathValues: [x, ...lhs.seen, ...rhs.seen],
        steps: opSteps(working.lhs) + opSteps(working.rhs) + 1,
        givens: notOne([...literals(working.lhs), ...literals(working.rhs)]), words: [], computed: true,
      };
    }
    case "sequence": {
      const { terms } = working;
      const gap = terms.indexOf(null);
      if (gap < 0 || terms.indexOf(null, gap + 1) >= 0) throw new WorkingError("A sequence needs exactly one blank.");
      const known = terms.flatMap((t, i) => (t === null ? [] : [{ i, t }]));
      if (known.length < 2) throw new WorkingError("A sequence needs at least two numbers to find its step.");
      const steps = new Set<number>();
      for (const a of known) for (const b of known) if (b.i > a.i) steps.add((b.t - a.t) / (b.i - a.i));
      const step = [...steps][0];
      if (steps.size !== 1 || !Number.isInteger(step)) {
        throw new WorkingError("The sequence does not go up or down by one fixed step.");
      }
      if (step === 0) throw new WorkingError("The sequence does not change.");
      const value = known[0].t + step * (gap - known[0].i);
      const knownTerms = known.map(k => k.t);
      return {
        accepts: s => asNumber(s) === value, pathValues: [...knownTerms, value], steps: Math.abs(step) === 1 ? 0 : 2,
        givens: knownTerms, words: [], computed: true,
      };
    }
    case "between": {
      const { above, below } = working;
      if (below - above < 2) throw new WorkingError(`No whole number is bigger than ${above} and smaller than ${below}.`);
      return {
        accepts: s => isWhole(s) && asNumber(s) > above && asNumber(s) < below, pathValues: [above, below],
        steps: below - above > 2 ? 1 : 0, givens: notOne([above, below]), words: [], computed: false,
      };
    }
    case "extreme": {
      const values = working.items.map(i => evaluate(i.expr, visual));
      const best = working.of === "max" ? Math.max(...values.map(v => v.value)) : Math.min(...values.map(v => v.value));
      const winners = working.items.filter((_, i) => values[i].value === best);
      let label: string;
      if (winners.length === 1) label = winners[0].label;
      else if (working.tieLabel && winners.length === working.items.length) label = working.tieLabel;
      else throw new WorkingError(`Two or more choices tie for the ${working.of === "max" ? "biggest" : "smallest"}.`);
      const exprSteps = Math.max(...working.items.map(i => opSteps(i.expr)));
      const worksSomethingOut = working.items.some(i => typeof i.expr !== "number");
      return {
        accepts: s => s === label, pathValues: values.flatMap(v => v.seen),
        steps: exprSteps + (working.items.length >= 3 ? 1 : 0) + (worksSomethingOut ? 1 : 0),
        givens: notOne(working.items.flatMap(i => literals(i.expr))), words: [], computed: false,
      };
    }
    case "equals": {
      const values = working.items.map(i => evaluate(i.expr, visual));
      const matches = working.items.filter((_, i) => values[i].value === working.target);
      if (matches.length !== 1) throw new WorkingError(`Exactly one choice should make ${working.target}, but ${matches.length} do.`);
      const match = values[working.items.indexOf(matches[0])];
      return {
        accepts: s => s === matches[0].label, pathValues: [working.target, ...match.seen],
        steps: 1 + Math.max(...working.items.map(i => opSteps(i.expr))),
        givens: notOne([working.target, ...working.items.flatMap(i => literals(i.expr))]), words: [], computed: false,
      };
    }
    case "order": {
      const sorted = [...working.values].sort((a, b) => (working.direction === "asc" ? a - b : b - a));
      const answer = sorted.join(", ");
      return {
        accepts: s => s.replace(/\s+/g, " ").trim() === answer, pathValues: working.values,
        steps: working.values.length >= 3 ? 2 : 1, givens: notOne(working.values), words: [], computed: false,
      };
    }
    case "number-word": {
      const value = NUMBER_WORDS.indexOf(working.word.toLowerCase());
      if (value < 0) throw new WorkingError(`"${working.word}" is not a number word the checks know.`);
      return {
        accepts: s => asNumber(s) === value, pathValues: [value], steps: 0, givens: [], words: [working.word], computed: true,
      };
    }
  }
}
