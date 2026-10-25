import type { Level, TopicContent } from "../../types";
import { add, arith, buildBank, dots, int, NAMES, numOptions, pick, shuffle, THINGS, type Template } from "../gen";

const ID = "ukg-addition-10";

const countAll: Template = r => {
  const a = int(r, 1, 4), b = int(r, 1, 5 - a);
  return {
    subSkill: "count-all", format: "count",
    prompt: `${a} blue and ${b} orange. How many dots in all?`,
    visual: dots({ count: a, color: "blue" }, { count: b, color: "orange" }),
    options: numOptions(r, a + b, 1, 7),
    answers: [String(a + b)],
    hint: "Touch every dot as you count, both colours.",
    explanation: `Count them all: ${Array.from({ length: a + b }, (_, i) => i + 1).join(", ")}. So ${a} + ${b} = ${a + b}.`,
    reason: `${a} and ${b} more make ${a + b}.`,
    working: { kind: "count-dots" },
  };
};

const sumWithDots: Template = r => {
  const a = int(r, 1, 4), b = int(r, 1, 5 - a);
  return {
    subSkill: "count-all", format: "tap-picture",
    prompt: `${a} + ${b} = ?`,
    visual: dots({ count: a, color: "blue" }, { count: b, color: "orange" }),
    options: numOptions(r, a + b, 1, 7),
    answers: [String(a + b)],
    hint: "Count the blue dots, then keep counting the orange ones.",
    explanation: `${a} blue dots, then count on ${b}: ${Array.from({ length: b }, (_, i) => a + i + 1).join(", ")}. So ${a} + ${b} = ${a + b}.`,
    reason: `${a} + ${b} = ${a + b}.`,
    working: arith(add({ dots: 0 }, { dots: 1 })),
  };
};

const countOn: Template = r => {
  const a = int(r, 3, 8), b = int(r, 1, Math.min(4, 10 - a));
  return {
    subSkill: "count-on", format: "tap-picture",
    prompt: `${a} + ${b} = ?`,
    options: numOptions(r, a + b, 2, 12),
    answers: [String(a + b)],
    hint: `Say ${a}, then count on ${b}.`,
    explanation: `Start at ${a} and count on ${b}: ${Array.from({ length: b }, (_, i) => a + i + 1).join(", ")}. So ${a} + ${b} = ${a + b}.`,
    reason: `${b} more than ${a} is ${a + b}.`,
    working: arith(add(a, b)),
  };
};

const story: Template = r => {
  const name = pick(r, NAMES), thing = pick(r, THINGS);
  const a = int(r, 2, 7), b = int(r, 1, 10 - a);
  return {
    subSkill: "word-problem", format: "audio",
    prompt: `${name} has ${a} ${thing}. ${name} gets ${b} more. How many ${thing} now?`,
    options: numOptions(r, a + b, 2, 12),
    answers: [String(a + b)],
    hint: `Hold up ${a} fingers, then ${b} more.`,
    explanation: `${a} and ${b} more: count on from ${a}: ${Array.from({ length: b }, (_, i) => a + i + 1).join(", ")}. ${name} has ${a + b}.`,
    reason: `${a} + ${b} = ${a + b}.`,
    working: arith(add(a, b)),
  };
};

const frogHops: Template = r => {
  const a = int(r, 2, 7), b = int(r, 2, 10 - a);
  return {
    subSkill: "count-on", format: "number-line",
    prompt: `The frog is on ${a} and hops ${b} steps forward. Where does it land?`,
    options: numOptions(r, a + b, 2, 12),
    answers: [String(a + b)],
    hint: "Count each hop out loud.",
    explanation: `From ${a}, hop ${b} times: ${Array.from({ length: b }, (_, i) => a + i + 1).join(", ")}. It lands on ${a + b}.`,
    reason: `${a} and ${b} hops make ${a + b}.`,
    working: arith(add(a, b)),
  };
};

const threeAddends: Template = r => {
  const thing = pick(r, THINGS);
  const a = int(r, 1, 4), b = int(r, 1, 4), c = int(r, 1, Math.max(1, 10 - a - b));
  // Two 1s make it a counting-on question, too easy for L3.
  if (a + b + c > 10 || [a, b, c].filter(n => n === 1).length > 1) return threeAddends(r);
  return {
    subSkill: "add-three", format: "audio",
    prompt: `${a} ${thing}, then ${b} more, then ${c} more. How many ${thing}?`,
    options: numOptions(r, a + b + c, 3, 12),
    answers: [String(a + b + c)],
    hint: "Add the first two, then add the last one.",
    explanation: `${a} + ${b} = ${a + b}. Then ${a + b} + ${c} = ${a + b + c}.`,
    reason: `${a}, ${b} and ${c} make ${a + b + c}.`,
    working: arith(add(a, b, c)),
  };
};

const hiddenDots: Template = r => {
  const total = int(r, 5, 10), shown = int(r, 2, total - 1), hidden = total - shown;
  return {
    subSkill: "missing-addend", format: "count",
    prompt: `Some dots hide in the box. ${shown} dots are outside. Together there are ${total}. How many are hiding?`,
    visual: dots({ count: shown, color: "blue" }),
    options: numOptions(r, hidden, 1, 9),
    answers: [String(hidden)],
    hint: `Count on from ${shown} until you reach ${total}.`,
    explanation: `From ${shown}, count on to ${total}: ${Array.from({ length: hidden }, (_, i) => shown + i + 1).join(", ")}. That is ${hidden} more, so ${hidden} are hiding.`,
    reason: `${shown} and ${hidden} make ${total}.`,
    working: { kind: "missing", lhs: add({ dots: 0 }, "x"), rhs: total },
  };
};

const compareSums: Template = r => {
  const a = int(r, 1, 6), b = int(r, 1, 9 - a), c = int(r, 1, 6), d = int(r, 1, 9 - c);
  if (a + b === c + d) return compareSums(r);
  const left = `${a} + ${b}`, right = `${c} + ${d}`;
  const ans = a + b > c + d ? left : right;
  return {
    subSkill: "compare-sums", format: "tap-picture",
    prompt: `Which makes more: ${left} or ${right}?`,
    options: [left, right],
    answers: [ans],
    hint: "Work out each one, then compare.",
    explanation: `${left} = ${a + b} and ${right} = ${c + d}. ${Math.max(a + b, c + d)} is more.`,
    reason: `${ans} makes ${Math.max(a + b, c + d)}.`,
    working: { kind: "extreme", of: "max", items: [{ label: left, expr: add(a, b) }, { label: right, expr: add(c, d) }] },
  };
};

const makeTen: Template = r => {
  const x = int(r, 2, 8), y = int(r, 2, 7), z = int(r, 3, 8);
  const good = `${x} + ${10 - x}`;
  const near = `${y} + ${9 - y}`;
  const over = `${z} + ${11 - z}`;
  if (near === good || over === good) return makeTen(r);
  return {
    subSkill: "make-ten", format: "tap-picture",
    prompt: "Which pair makes 10?",
    options: shuffle(r, [good, near, over]),
    answers: [good],
    hint: "Use all 10 fingers. Fold down the first number.",
    explanation: `${good} = 10, ${near} = 9, ${over} = 11. Only ${good} makes 10.`,
    reason: `${x} and ${10 - x} make 10.`,
    working: {
      kind: "equals", target: 10,
      items: [{ label: good, expr: add(x, 10 - x) }, { label: near, expr: add(y, 9 - y) }, { label: over, expr: add(z, 11 - z) }],
    },
  };
};

const whoAmI: Template = r => {
  // b starts at 2: "add 1 to me" is just the number before, too easy for L4.
  const b = int(r, 2, 4), t = int(r, b + 2, 10), n = t - b;
  return {
    subSkill: "missing-addend", format: "audio",
    prompt: `I am a number. Add ${b} to me and you get ${t}. Who am I?`,
    options: numOptions(r, n, 1, 10),
    answers: [String(n)],
    hint: `Count back ${b} from ${t}.`,
    explanation: `Count back ${b} from ${t}: ${Array.from({ length: b }, (_, i) => t - i - 1).join(", ")}. So I am ${n}, and ${n} + ${b} = ${t}.`,
    reason: `${n} + ${b} = ${t}.`,
    working: { kind: "missing", lhs: add("x", b), rhs: t },
  };
};

const balance: Template = r => {
  const a = int(r, 2, 5), b = int(r, 1, 10 - a - 1), total = a + b, c = int(r, 1, total - 1), bag = total - c;
  return {
    subSkill: "missing-addend", format: "balance",
    prompt: `Left pan: ${a} + ${b} apples. Right pan: ${c} apples and a bag. How many apples go in the bag to balance?`,
    options: numOptions(r, bag, 1, 9),
    answers: [String(bag)],
    hint: "Count the left pan first.",
    explanation: `Left: ${a} + ${b} = ${total}. Right has ${c}, and ${c} + ${bag} = ${total}. So the bag holds ${bag}.`,
    reason: `${c} and ${bag} make ${total}, the same as the left pan.`,
    working: { kind: "missing", lhs: add(c, "x"), rhs: add(a, b) },
  };
};

const pickBags: Template = r => {
  const t = int(r, 6, 10);
  const x = int(r, 1, t - 1), y = t - x;
  let z = int(r, 1, 9);
  if (x === y || z === x || z === y || x + z === t || y + z === t || z + x === t) return pickBags(r);
  const bags = shuffle(r, [x, y, z]);
  const pairs = [[bags[0], bags[1]], [bags[0], bags[2]], [bags[1], bags[2]]].map(p => p.sort((m, n) => m - n));
  const fmt = (p: number[]) => `${p[0]} and ${p[1]}`;
  const ans = fmt([x, y].sort((m, n) => m - n));
  return {
    subSkill: "make-a-number", format: "tap-picture",
    prompt: `Bags show ${bags.join(", ")}. Pick two bags that make ${t}.`,
    options: pairs.map(fmt),
    answers: [ans],
    hint: "Try the biggest bag first. What goes with it?",
    explanation: pairs.map(p => `${p[0]} + ${p[1]} = ${p[0] + p[1]}`).join(", ") + `. So ${ans} make ${t}.`,
    reason: `${ans} make ${t}.`,
    working: { kind: "equals", target: t, items: pairs.map(p => ({ label: fmt(p), expr: add(p[0], p[1]) })) },
  };
};

const SEED = 404;
const TEMPLATES: Record<Level, Template[]> = {
  1: [countAll, sumWithDots],
  2: [countOn, story, frogHops],
  3: [threeAddends, hiddenDots, compareSums],
  4: [makeTen, whoAmI, balance, pickBags],
};

export const ADDITION: TopicContent = {
  topic: { id: ID, classId: "UKG", order: 4, title: "Adding with objects up to 10" },
  lesson: [
    { title: "Putting together", text: "2 mangoes and 1 more. Count them all: 1, 2, 3!", visual: dots({ count: 2, color: "blue" }, { count: 1, color: "orange" }) },
    { title: "In real life", text: "+ means \"and more\". = means \"makes\". 3 + 2 = 5." },
    { title: "Count on", text: "For 4 + 2, say 4, then count on: 5, 6.", visual: dots({ count: 4, color: "blue" }, { count: 2, color: "orange" }) },
    { title: "Finger trick", text: "Start at the bigger number. 5 + 3: say 5… 6, 7, 8." },
  ],
  tryIt: { prompt: "3 ducks and 2 more ducks. How many ducks?", visual: dots({ count: 3, color: "blue" }, { count: 2, color: "orange" }),
    options: ["4", "5", "6"], answer: "5", praise: "You got it! 3 ducks and 2 more make 5.", help: "Say 3, then count on: 4, 5." },
  generator: { seed: SEED, templates: TEMPLATES },
  bank: buildBank(ID, SEED, TEMPLATES),
  subSkillNames: {
    "count-all": "Counting all", "count-on": "Counting on", "word-problem": "Story sums", "add-three": "Adding three numbers",
    "missing-addend": "Finding the missing number", "compare-sums": "Comparing sums", "make-ten": "Making 10", "make-a-number": "Making a number",
  },
};
