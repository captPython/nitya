import type { Level, TopicContent } from "../../types";
import { add, arith, buildBank, int, numOptions, sub, type Template } from "../gen";

const ID = "ukg-before-after";

const after = (lo: number, hi: number): Template => r => {
  const n = int(r, lo, hi);
  return {
    subSkill: "after", format: "tap-picture",
    prompt: `What comes just after ${n}?`,
    options: numOptions(r, n + 1, Math.max(0, n - 1), n + 3),
    answers: [String(n + 1)],
    hint: `Say ${n}, then count one more.`,
    explanation: `Just after means one more. One more than ${n} is ${n + 1}.`,
    reason: `${n + 1} is one more than ${n}.`,
    working: arith(add(n, 1)),
  };
};

const before = (lo: number, hi: number): Template => r => {
  const n = int(r, lo, hi);
  return {
    subSkill: "before", format: "tap-picture",
    prompt: `What comes just before ${n}?`,
    options: numOptions(r, n - 1, Math.max(0, n - 3), n + 1),
    answers: [String(n - 1)],
    hint: `Count back one step from ${n}.`,
    explanation: `Just before means one less. One less than ${n} is ${n - 1}.`,
    reason: `${n - 1} is one less than ${n}.`,
    working: arith(sub(n, 1)),
  };
};

const between = (lo: number, hi: number): Template => r => {
  const a = int(r, lo, hi);
  return {
    subSkill: "between", format: "tap-picture",
    prompt: `What comes between ${a} and ${a + 2}?`,
    options: numOptions(r, a + 1, Math.max(0, a - 1), a + 3),
    answers: [String(a + 1)],
    hint: `Count from ${a}: which number do you say next?`,
    explanation: `${a}, ${a + 1}, ${a + 2}. The number in the middle is ${a + 1}.`,
    reason: `${a + 1} sits between ${a} and ${a + 2}.`,
    working: { kind: "between", above: a, below: a + 2 },
  };
};

const twoSteps: Template = r => {
  const n = int(r, 10, 45);
  const k = int(r, 2, 3);
  const forward = r() < 0.5;
  const ans = forward ? n + k : n - k;
  return {
    subSkill: "two-steps", format: "number-line",
    prompt: `Start at ${n} and take ${k} steps ${forward ? "forward" : "back"}. Where are you?`,
    options: numOptions(r, ans, n - 5, n + 5),
    answers: [String(ans)],
    hint: forward ? `Count on ${k} times from ${n}.` : `Count back ${k} times from ${n}.`,
    explanation: forward
      ? `From ${n}, count on ${k}: ${Array.from({ length: k }, (_, i) => n + i + 1).join(", ")}. You land on ${ans}.`
      : `From ${n}, count back ${k}: ${Array.from({ length: k }, (_, i) => n - i - 1).join(", ")}. You land on ${ans}.`,
    reason: `${k} steps ${forward ? "forward" : "back"} from ${n} is ${ans}.`,
    working: arith(forward ? add(n, k) : sub(n, k)),
  };
};

const riddle: Template = r => {
  // Past 20, so the riddle stays harder than L2's "between" questions.
  const a = int(r, 20, 47);
  return {
    subSkill: "two-steps", format: "audio",
    prompt: `I come just after ${a} and just before ${a + 2}. Who am I?`,
    options: numOptions(r, a + 1, a - 1, a + 3),
    answers: [String(a + 1)],
    hint: "Both clues point to the same number.",
    explanation: `Just after ${a} is ${a + 1}. Just before ${a + 2} is also ${a + 1}.`,
    reason: `${a + 1} fits both clues.`,
    working: { kind: "between", above: a, below: a + 2 },
  };
};

const SEED = 202;
const TEMPLATES: Record<Level, Template[]> = {
  1: [after(1, 10), before(2, 10), between(1, 8)],
  2: [after(10, 19), before(11, 20), between(9, 18)],
  3: [after(20, 49), before(21, 50), between(19, 47)],
  4: [twoSteps, riddle],
};

export const BEFORE_AFTER: TopicContent = {
  topic: { id: ID, classId: "UKG", order: 2, title: "Before, after and between" },
  lesson: [
    { title: "After means one more", text: "The number just after 6 is 7. Count on one step." },
    { title: "Before means one less", text: "The number just before 6 is 5. Count back one step." },
    { title: "Between is in the middle", text: "Between 6 and 8 is 7. It sits in the middle, like you between two friends." },
    { title: "In real life", text: "In a lift, the floors go 3, 4, 5. The floor after 4 is 5. The floor before 4 is 3." },
  ],
  tryIt: { prompt: "What comes just after 9?", options: ["8", "10", "11"], answer: "10",
    praise: "Yes! One more than 9 is 10.", help: "Say 9, then count one more: 10." },
  generator: { seed: SEED, templates: TEMPLATES },
  bank: buildBank(ID, SEED, TEMPLATES),
  subSkillNames: { after: "Number after", before: "Number before", between: "Number between", "two-steps": "Steps on the number line" },
};
