import type { TopicContent } from "../../types";
import { buildBank, dots, int, numOptions, pick, type Template } from "../gen";

const ID = "ukg-counting-50";
const NUMBER_NAMES = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

const countDots = (lo: number, hi: number): Template => r => {
  const n = int(r, lo, hi);
  const rows = n > 10 ? `${Math.floor(n / 10)} full rows of 10 make ${Math.floor(n / 10) * 10}. ` : "";
  return {
    subSkill: "count-objects", format: "count",
    prompt: "How many dots?", visual: dots({ count: n, color: "blue" }),
    options: numOptions(r, n, Math.max(1, lo - 2), hi + 2),
    answers: [String(n)],
    hint: n > 10 ? "Count the full rows of 10 first, then count on." : "Touch each dot once as you count.",
    explanation: `${rows}Counting every dot gives ${n}.`,
    reason: `There are ${n} dots.`,
  };
};

const whatsNext = (lo: number, hi: number): Template => r => {
  const a = int(r, lo, hi);
  return {
    subSkill: "count-on", format: "fill-blank",
    prompt: `What comes next? ${a}, ${a + 1}, ${a + 2}, __`,
    options: numOptions(r, a + 3, Math.max(1, a), a + 6),
    answers: [String(a + 3)],
    hint: "Say the numbers out loud and keep going.",
    explanation: `${a}, ${a + 1}, ${a + 2}, then ${a + 3}. Each number is one more.`,
    reason: `${a + 3} comes right after ${a + 2}.`,
  };
};

const countBack: Template = r => {
  const a = int(r, 1, 14);
  return {
    subSkill: "count-back", format: "fill-blank",
    prompt: `Count back: ${a + 3}, ${a + 2}, ${a + 1}, __`,
    options: numOptions(r, a, Math.max(0, a - 2), a + 4),
    answers: [String(a)],
    hint: "Each number is one less.",
    explanation: `${a + 3}, ${a + 2}, ${a + 1}, then ${a}. Counting back takes one away each time.`,
    reason: `${a} is one less than ${a + 1}.`,
  };
};

const numberName: Template = r => {
  const n = int(r, 1, 10);
  return {
    subSkill: "number-names", format: "tap-picture",
    prompt: `Tap the number ${NUMBER_NAMES[n - 1]}.`,
    options: numOptions(r, n, 1, 10, 3),
    answers: [String(n)],
    hint: "Count on your fingers to that word.",
    explanation: `"${NUMBER_NAMES[n - 1]}" is written ${n}.`,
    reason: `${n} is ${NUMBER_NAMES[n - 1]}.`,
  };
};

const fillGap: Template = r => {
  const a = int(r, 18, 46);
  return {
    subSkill: "count-on", format: "fill-blank",
    prompt: `Fill the gap: ${a}, ${a + 1}, __, ${a + 3}`,
    options: numOptions(r, a + 2, a - 1, a + 5),
    answers: [String(a + 2)],
    hint: `Count on from ${a + 1}.`,
    explanation: `After ${a + 1} comes ${a + 2}, and then ${a + 3}.`,
    reason: `${a + 2} sits between ${a + 1} and ${a + 3}.`,
  };
};

const skipCount: Template = r => {
  const step = pick(r, [2, 2, 5, 10] as const);
  const start = step === 10 ? pick(r, [5, 10, 20]) : step === 5 ? 5 * int(r, 1, 6) : int(r, 1, 42);
  const a = start, b = a + step, c = b + step, d = c + step;
  if (d > 50) return skipCount(r);
  const seq = `${a}, ${b}, ${c}, __`;
  return {
    subSkill: "skip-count", format: "pattern",
    prompt: `What comes next? ${seq}`,
    options: numOptions(r, d, Math.max(1, c), Math.min(50, d + step), step > 2 ? step : 2).map(String),
    answers: [String(d)],
    hint: `How much bigger is each number than the one before?`,
    explanation: `Each number goes up by ${step}. ${c} and ${step} more is ${d}.`,
    reason: `Counting by ${step}s: ${c}, then ${d}.`,
  };
};

export const COUNTING: TopicContent = {
  topic: { id: ID, classId: "UKG", order: 1, title: "Counting 1 to 50" },
  lesson: [
    { title: "One touch, one number", text: "Touch each thing once and say one number. The last number you say tells you how many.", visual: dots({ count: 5, color: "blue" }) },
    { title: "Counting every day", text: "Count the steps as you climb the stairs. Count your toys when you tidy up. Counting is everywhere!" },
    { title: "Rows of 10", text: "When there are lots, make rows of 10. One full row is 10. One row and 3 more: say 10, then 11, 12, 13.", visual: dots({ count: 13, color: "orange" }) },
    { title: "Jumping in 2s, 5s and 10s", text: "10, 20, 30, 40, 50 is counting in tens. 2, 4, 6, 8 is counting in twos. Big jumps help you count faster." },
  ],
  tryIt: { prompt: "How many dots?", visual: dots({ count: 7, color: "blue" }), options: ["6", "7", "8"], answer: "7",
    praise: "You counted all 7 dots!", help: "Touch each dot once: 1, 2, 3, 4, 5, 6, 7." },
  bank: buildBank(ID, 101, {
    1: [countDots(1, 10), whatsNext(1, 8), numberName],
    2: [countDots(11, 20), whatsNext(9, 18), countBack],
    3: [fillGap, countDots(21, 30)],
    4: [skipCount],
  }),
  subSkillNames: {
    "count-objects": "Counting things", "count-on": "Counting on", "count-back": "Counting back",
    "number-names": "Number words", "skip-count": "Counting in 2s, 5s and 10s",
  },
};
