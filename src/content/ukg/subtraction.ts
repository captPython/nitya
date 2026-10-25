import type { TopicContent } from "../../types";
import { buildBank, dots, int, NAMES, numOptions, pick, shuffle, THINGS, type Template } from "../gen";

const ID = "ukg-subtraction-10";

const flyAway: Template = r => {
  const a = int(r, 2, 5), b = int(r, 1, a - 1);
  return {
    subSkill: "take-away-objects", format: "count",
    prompt: `${a} balloons. ${b} ${b === 1 ? "flies" : "fly"} away. How many are left?`,
    visual: dots({ count: a, color: "blue", crossed: b }),
    options: numOptions(r, a - b, 0, 6),
    answers: [String(a - b)],
    hint: "Count only the dots that are not crossed out.",
    explanation: `${b} of the ${a} are crossed out. Count the rest: ${a - b}. So ${a} − ${b} = ${a - b}.`,
    reason: `${a} take away ${b} leaves ${a - b}.`,
  };
};

const minusWithDots: Template = r => {
  const a = int(r, 2, 5), b = int(r, 1, a - 1);
  return {
    subSkill: "take-away-objects", format: "tap-picture",
    prompt: `${a} − ${b} = ?`,
    visual: dots({ count: a, color: "orange", crossed: b }),
    options: numOptions(r, a - b, 0, 6),
    answers: [String(a - b)],
    hint: "Cover the crossed-out dots and count what is left.",
    explanation: `Start with ${a}. Take away ${b}. ${a - b} are left.`,
    reason: `${a} − ${b} = ${a - b}.`,
  };
};

const countBack: Template = r => {
  const a = int(r, 6, 10), b = int(r, 1, 4);
  return {
    subSkill: "count-back", format: "tap-picture",
    prompt: `${a} − ${b} = ?`,
    options: numOptions(r, a - b, 0, 10),
    answers: [String(a - b)],
    hint: `Start at ${a} and count back ${b}.`,
    explanation: `From ${a}, count back ${b}: ${Array.from({ length: b }, (_, i) => a - i - 1).join(", ")}. So ${a} − ${b} = ${a - b}.`,
    reason: `${b} less than ${a} is ${a - b}.`,
  };
};

const eatStory: Template = r => {
  const name = pick(r, NAMES), thing = pick(r, THINGS);
  const a = int(r, 5, 10), b = int(r, 1, a - 1);
  return {
    subSkill: "word-problem", format: "audio",
    prompt: `${name} has ${a} ${thing} and gives away ${b}. How many ${thing} are left?`,
    options: numOptions(r, a - b, 0, 10),
    answers: [String(a - b)],
    hint: `Hold up ${a} fingers and fold down ${b}.`,
    explanation: `${a} take away ${b}: count back from ${a}: ${Array.from({ length: b }, (_, i) => a - i - 1).join(", ")}. ${a - b} are left.`,
    reason: `${a} − ${b} = ${a - b}.`,
  };
};

const hopBack: Template = r => {
  const a = int(r, 6, 10), b = int(r, 2, 4);
  return {
    subSkill: "count-back", format: "number-line",
    prompt: `The frog is on ${a} and hops ${b} steps back. Where does it land?`,
    options: numOptions(r, a - b, 0, 10),
    answers: [String(a - b)],
    hint: "Count each hop back out loud.",
    explanation: `From ${a}, hop back ${b}: ${Array.from({ length: b }, (_, i) => a - i - 1).join(", ")}. It lands on ${a - b}.`,
    reason: `${a} back ${b} is ${a - b}.`,
  };
};

const howManyGone: Template = r => {
  const a = int(r, 5, 10), left = int(r, 1, a - 1), gone = a - left;
  return {
    subSkill: "how-many-taken", format: "audio",
    prompt: `There were ${a} birds. Some flew away. Now there are ${left}. How many flew away?`,
    options: numOptions(r, gone, 1, 9),
    answers: [String(gone)],
    hint: `Count on from ${left} up to ${a}.`,
    explanation: `From ${left}, count on to ${a}: ${Array.from({ length: gone }, (_, i) => left + i + 1).join(", ")}. That is ${gone}, so ${gone} flew away.`,
    reason: `${a} − ${gone} = ${left}.`,
  };
};

const twoStep: Template = r => {
  const name = pick(r, NAMES);
  const a = int(r, 6, 10), b = int(r, 1, 3), c = int(r, 1, Math.min(3, a - b - 1));
  return {
    subSkill: "two-step", format: "audio",
    prompt: `${name} has ${a} sweets. ${name} eats ${b}, then ${c} more. How many are left?`,
    options: numOptions(r, a - b - c, 0, 10),
    answers: [String(a - b - c)],
    hint: "Take away the first number, then the second.",
    explanation: `${a} − ${b} = ${a - b}. Then ${a - b} − ${c} = ${a - b - c}.`,
    reason: `${a} take away ${b} and ${c} leaves ${a - b - c}.`,
  };
};

const leavesMore: Template = r => {
  const a = int(r, 5, 10), b = int(r, 1, a - 1), c = int(r, 5, 10), d = int(r, 1, c - 1);
  if (a - b === c - d) return leavesMore(r);
  const left = `${a} − ${b}`, right = `${c} − ${d}`;
  const ans = a - b > c - d ? left : right;
  return {
    subSkill: "compare-differences", format: "tap-picture",
    prompt: `Which leaves more: ${left} or ${right}?`,
    options: [left, right],
    answers: [ans],
    hint: "Work out each one, then compare.",
    explanation: `${left} = ${a - b} and ${right} = ${c - d}. ${Math.max(a - b, c - d)} is more.`,
    reason: `${ans} leaves ${Math.max(a - b, c - d)}.`,
  };
};

const whoAmI: Template = r => {
  const b = int(r, 1, 5), c = int(r, 1, 10 - b), n = b + c;
  return {
    subSkill: "missing-start", format: "audio",
    prompt: `I am a number. Take away ${b} from me and you get ${c}. Who am I?`,
    options: numOptions(r, n, 2, 10),
    answers: [String(n)],
    hint: `Count on ${b} from ${c}.`,
    explanation: `Put the ${b} back: ${c} + ${b} = ${n}. Check: ${n} − ${b} = ${c}.`,
    reason: `${n} − ${b} = ${c}.`,
  };
};

const whichGives: Template = r => {
  const t = int(r, 1, 5), sub = int(r, 2, 5);
  if (t + sub + 1 > 10) return whichGives(r);
  const good = `${t + sub} − ${sub}`, low = `${t + sub - 1} − ${sub}`, high = `${t + sub + 1} − ${sub}`;
  return {
    subSkill: "compare-differences", format: "tap-picture",
    prompt: `Which one leaves exactly ${t}?`,
    options: shuffle(r, [good, low, high]),
    answers: [good],
    hint: "Work out each one. Which gives the number asked for?",
    explanation: `${good} = ${t}, ${low} = ${t - 1}, ${high} = ${t + 1}. Only ${good} leaves ${t}.`,
    reason: `${good} = ${t}.`,
  };
};

const marbles: Template = r => {
  const name = pick(r, NAMES), gave = int(r, 1, 5), left = int(r, 1, 10 - gave);
  return {
    subSkill: "missing-start", format: "audio",
    prompt: `${name} gave away ${gave} marbles and has ${left} left. How many did ${name} have at the start?`,
    options: numOptions(r, gave + left, 2, 10),
    answers: [String(gave + left)],
    hint: "Put the marbles that were given away back.",
    explanation: `${left} left and ${gave} given away: ${left} + ${gave} = ${gave + left}.`,
    reason: `${gave + left} − ${gave} = ${left}.`,
  };
};

export const SUBTRACTION: TopicContent = {
  topic: { id: ID, classId: "UKG", order: 5, title: "Taking away with objects up to 10" },
  lesson: [
    { title: "Taking away", text: "Max has 5 balloons. 2 fly away. Count the ones left: 3. 5 − 2 = 3.", visual: dots({ count: 5, color: "blue", crossed: 2 }) },
    { title: "In real life", text: "You have 6 biscuits and eat 1. Now 5 are left on the plate." },
    { title: "Count back", text: "For 8 − 3, start at 8 and count back 3: 7, 6, 5. So 8 − 3 = 5." },
    { title: "The take-away sign", text: "− means take away. = means is left. 7 − 2 = 5 says: 7, take away 2, leaves 5." },
  ],
  tryIt: { prompt: "4 apples. 1 is eaten. How many are left?", visual: dots({ count: 4, color: "orange", crossed: 1 }),
    options: ["2", "3", "4"], answer: "3", praise: "Yes! 4 take away 1 leaves 3.", help: "Count the dots that are not crossed out: 1, 2, 3." },
  bank: buildBank(ID, 505, {
    1: [flyAway, minusWithDots],
    2: [countBack, eatStory, hopBack],
    3: [howManyGone, twoStep, leavesMore],
    4: [whoAmI, whichGives, marbles],
  }),
  subSkillNames: {
    "take-away-objects": "Taking away objects", "count-back": "Counting back", "word-problem": "Story take-aways",
    "how-many-taken": "Finding how many went", "two-step": "Two take-aways", "compare-differences": "Comparing take-aways",
    "missing-start": "Finding the start number",
  },
};
