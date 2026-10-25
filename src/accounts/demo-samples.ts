import type { SuppliedQuestion } from "../supply/types";

/**
 * Demo only: questions with planted mistakes, so the admin panel's review
 * queue has something in it. Each one fails a different check.
 */
export const DEMO_REVIEW_SAMPLES: SuppliedQuestion[] = [
  {
    // The working says 4 + 3, but the answer given is 6.
    id: "demo-wrong-answer", topicId: "ukg-addition-10", subSkill: "count-on", level: 2, format: "mcq",
    prompt: "What is 4 + 3?", options: ["6", "7", "8"], answers: ["6"],
    hint: "Start at 4 and count on 3 more.", explanation: "4 and 3 more make 7.", reason: "4 + 3 = 7.",
    working: { kind: "arith", expr: { op: "+", args: [4, 3] } },
    source: "template", sourceRef: "demo: planted mistake",
  },
  {
    // Two options are the same.
    id: "demo-duplicate-options", topicId: "ukg-before-after", subSkill: "after", level: 1, format: "tap-picture",
    prompt: "Which number is one more than 5?", options: ["6", "6", "4"], answers: ["6"],
    hint: "Say 5, then count one more.", explanation: "Just after means one more. One more than 5 is 6.", reason: "6 is one more than 5.",
    working: { kind: "arith", expr: { op: "+", args: [5, 1] } },
    source: "template", sourceRef: "demo: planted mistake",
  },
  {
    // 63 is past UKG's numbers, which stop at 50.
    id: "demo-out-of-range", topicId: "ukg-before-after", subSkill: "after", level: 2, format: "tap-picture",
    prompt: "What comes just after 63?", options: ["62", "64", "65"], answers: ["64"],
    hint: "Say 63, then count one more.", explanation: "Just after means one more. One more than 63 is 64.", reason: "64 is one more than 63.",
    working: { kind: "arith", expr: { op: "+", args: [63, 1] } },
    source: "template", sourceRef: "demo: planted mistake",
  },
  {
    // Tagged Olympiad, but it is one of the easiest sums there is.
    id: "demo-wrong-level", topicId: "ukg-addition-10", subSkill: "count-on", level: 4, format: "mcq",
    prompt: "What is 1 + 1?", options: ["1", "2", "3"], answers: ["2"],
    hint: "Start at 1 and count on 1 more.", explanation: "1 and 1 more make 2.", reason: "1 + 1 = 2.",
    working: { kind: "arith", expr: { op: "+", args: [1, 1] } },
    source: "template", sourceRef: "demo: planted mistake",
  },
  {
    // A CSV row with no working, so its answer can't be checked. CSV questions are fixed in Drive.
    id: "demo-csv-no-working", topicId: "ukg-counting-50", subSkill: "count-on", level: 2, format: "mcq",
    prompt: "Count on from 12: 12, 13, 14, … What comes next?", options: ["15", "16", "13"], answers: ["15"],
    hint: "Say the numbers out loud and keep going.", explanation: "After 14 comes 15.", reason: "15 comes after 14.",
    source: "csv", sourceRef: "demo-questions.csv row 2",
  },
];
