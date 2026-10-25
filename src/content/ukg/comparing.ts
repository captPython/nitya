import type { Level, TopicContent } from "../../types";
import { buildBank, dots, int, pick, shuffle, type Template } from "../gen";

const ID = "ukg-comparing";

const moreGroups = (maxN: number, minGap: number, allowSame: boolean): Template => r => {
  const a = int(r, 1, maxN);
  let b = int(r, 1, maxN);
  if (!allowSame && Math.abs(a - b) < minGap) return moreGroups(maxN, minGap, allowSame)(r);
  if (allowSame && Math.abs(a - b) > 1 && r() < 0.7) b = Math.min(maxN, Math.max(1, a + pick(r, [-1, 0, 1])));
  const fewer = r() < 0.4 && a !== b;
  const answer = a === b ? "Same" : (a > b) !== fewer ? "Blue" : "Orange";
  const word = fewer ? "fewer" : "more";
  return {
    subSkill: "compare-groups", format: "tap-picture",
    prompt: allowSame ? `Which has ${word} dots: blue, orange, or are they the same?` : `Which has ${word} dots, blue or orange?`,
    visual: dots({ count: a, color: "blue" }, { count: b, color: "orange" }),
    options: allowSame ? ["Blue", "Orange", "Same"] : ["Blue", "Orange"],
    answers: [answer],
    hint: "Count each colour, then compare the two numbers.",
    explanation: a === b
      ? `Blue has ${a} and orange has ${b}. They are the same.`
      : `Blue has ${a} and orange has ${b}. ${Math.max(a, b)} is more than ${Math.min(a, b)}, so ${answer.toLowerCase()} has ${word}.`,
    reason: a === b ? `Both have ${a}.` : `${answer} has ${fewer ? Math.min(a, b) : Math.max(a, b)}.`,
    working: {
      kind: "extreme", of: fewer ? "min" : "max",
      items: [{ label: "Blue", expr: { dots: 0 } }, { label: "Orange", expr: { dots: 1 } }],
      ...(allowSame ? { tieLabel: "Same" } : {}),
    },
  };
};

const biggerOfTwo: Template = r => {
  const a = int(r, 1, 20);
  let b = int(r, 1, 20);
  if (a === b) b = a === 20 ? 19 : a + 1;
  const smaller = r() < 0.4;
  const ans = smaller ? Math.min(a, b) : Math.max(a, b);
  return {
    subSkill: "compare-numbers", format: "tap-picture",
    prompt: `Which number is ${smaller ? "smaller" : "bigger"}: ${a} or ${b}?`,
    options: [String(a), String(b)],
    answers: [String(ans)],
    hint: "When you count, bigger numbers come later.",
    explanation: `Counting up, ${Math.min(a, b)} comes before ${Math.max(a, b)}. So ${ans} is ${smaller ? "smaller" : "bigger"}.`,
    reason: `${ans} is ${smaller ? "smaller" : "bigger"}.`,
    working: { kind: "extreme", of: smaller ? "min" : "max", items: [a, b].map(v => ({ label: String(v), expr: v })) },
  };
};

function threeNumbers(r: () => number): number[] {
  const tens = int(r, 1, 4);
  const set = new Set<number>();
  while (set.size < 3) {
    const t = r() < 0.6 ? tens : int(r, 1, 4);
    set.add(Math.min(50, t * 10 + int(r, 0, 9)));
  }
  return [...set];
}

const biggestOfThree: Template = r => {
  const nums = threeNumbers(r);
  const smallest = r() < 0.5;
  const ans = smallest ? Math.min(...nums) : Math.max(...nums);
  return {
    subSkill: "biggest-smallest", format: "tap-picture",
    prompt: `Which is the ${smallest ? "smallest" : "biggest"}: ${nums.join(", ")}?`,
    options: nums.map(String),
    answers: [String(ans)],
    hint: "Look at the tens first. If they match, look at the ones.",
    explanation: `In counting order they go ${[...nums].sort((x, y) => x - y).join(", ")}. The ${smallest ? "smallest" : "biggest"} is ${ans}.`,
    reason: `${ans} is the ${smallest ? "smallest" : "biggest"}.`,
    working: { kind: "extreme", of: smallest ? "min" : "max", items: nums.map(v => ({ label: String(v), expr: v })) },
  };
};

const inRange: Template = r => {
  const a = int(r, 10, 45);
  const valid = a + int(r, 1, 2);
  return {
    subSkill: "in-between", format: "tap-picture",
    prompt: `Which number is bigger than ${a} but smaller than ${a + 3}?`,
    options: shuffle(r, [String(valid), String(a + 3), String(a - 1)]),
    answers: [String(valid)],
    hint: `List the numbers after ${a}, stopping before ${a + 3}.`,
    explanation: `Bigger than ${a} and smaller than ${a + 3} means ${a + 1} or ${a + 2}. ${a + 3} is not smaller than itself.`,
    reason: `${valid} is between ${a} and ${a + 3}.`,
    working: { kind: "between", above: a, below: a + 3 },
  };
};

const order: Template = r => {
  const nums = threeNumbers(r);
  const asc = [...nums].sort((x, y) => x - y);
  const wrong1 = [asc[1], asc[0], asc[2]];
  const wrong2 = [asc[0], asc[2], asc[1]];
  const fmt = (xs: number[]) => xs.join(", ");
  return {
    subSkill: "ordering", format: "tap-picture",
    prompt: `Put ${nums.join(", ")} in order, smallest first.`,
    options: shuffle(r, [fmt(asc), fmt(wrong1), fmt(wrong2)]),
    answers: [fmt(asc)],
    hint: "Find the smallest one first, then the next.",
    explanation: `${asc[0]} is the smallest, then ${asc[1]}, then ${asc[2]}.`,
    reason: `${fmt(asc)} goes from smallest to biggest.`,
    working: { kind: "order", values: nums, direction: "asc" },
  };
};

const SEED = 303;
const TEMPLATES: Record<Level, Template[]> = {
  1: [moreGroups(8, 2, false)],
  2: [biggerOfTwo, moreGroups(10, 0, true)],
  3: [biggestOfThree],
  4: [inRange, order],
};

export const COMPARING: TopicContent = {
  topic: { id: ID, classId: "UKG", order: 3, title: "Comparing numbers" },
  lesson: [
    { title: "More and fewer", text: "Count each group. The group with the bigger number has more. The other has fewer.", visual: dots({ count: 6, color: "blue" }, { count: 3, color: "orange" }) },
    { title: "In real life", text: "Who has more grapes, you or your friend? Line them up in pairs. The one with grapes left over has more." },
    { title: "Bigger numbers come later", text: "When you count, 15 comes after 12. So 15 is bigger than 12." },
    { title: "Tens first", text: "27 and 32: look at the tens. 3 tens is more than 2 tens, so 32 is bigger." },
  ],
  tryIt: { prompt: "Which is bigger: 14 or 41?", options: ["14", "41"], answer: "41",
    praise: "Yes! 41 has 4 tens. 14 has only 1 ten.", help: "Look at the tens: 41 has 4 tens, 14 has 1 ten." },
  generator: { seed: SEED, templates: TEMPLATES },
  bank: buildBank(ID, SEED, TEMPLATES),
  subSkillNames: {
    "compare-groups": "More and fewer", "compare-numbers": "Bigger and smaller", "biggest-smallest": "Biggest and smallest",
    "in-between": "Numbers in between", ordering: "Putting numbers in order",
  },
};
