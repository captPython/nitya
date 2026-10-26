import { contentKey, variantGroup } from "../content/gen";
import { QUESTION_FORMATS, type Level, type TopicContent, type Visual, type Working } from "../types";
import { judgeOwnQuestion, familyQuestionId, MAX_UPLOAD_ROWS, safetyLink, templateTopic, type OwnVerdict, type UploadRow } from "./template";
import type { SuppliedQuestion } from "./types";

/**
 * Saving a family's own questions, shared by the demo and the
 * family-questions server function, so both decide the same way. Every
 * question is rebuilt from its fields and checked again here: the server
 * never trusts the app's own verdict.
 */

/** One of a family's own questions as it is kept. */
export interface OwnQuestion {
  question: SuppliedQuestion;
  uploadId: string;
  /** "ready": the family's children get it. "review": it waits for the family. */
  status: "ready" | "review";
  /** What the checks found, in words for a parent. */
  problems: string[];
  /** In the community bank: it passed every check, the answer included, and its upload isn't private. */
  shared: boolean;
}

/** What saving an upload did. */
export interface UploadResult {
  /** Null when nothing in the file was new. */
  uploadId: string | null;
  ready: number;
  inReview: number;
  /** Of those added, how many went into the community bank. */
  shared: number;
  /** Repeats of a question the family already has, or of an earlier row in the file. */
  alreadyAdded: number;
  /** Repeats of one of Nitya's official questions. */
  inNitya: number;
  /** Rows refused here, such as a row with a link. The app refuses these before upload, so this is normally empty. */
  refused: number;
}

/** Whether a checked question goes into the community bank. (cp's choice of what other families may see decides this rule.) */
export const isShareable = (verdict: Pick<OwnVerdict, "status" | "passedAll">, privateUpload: boolean) =>
  !privateUpload && verdict.status === "ready" && verdict.passedAll;

const isText = (v: unknown, max = 600): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;
const textList = (v: unknown, max: number) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(x => isText(x, 120));

/**
 * The question from untrusted JSON, rebuilt from the fields a family may set,
 * or null when a field is missing or the wrong shape. The source, id and
 * family flag are always set here.
 */
export function sanitizeOwnQuestion(input: unknown, contents: TopicContent[], fileName: string, row: number): SuppliedQuestion | null {
  if (!input || typeof input !== "object") return null;
  const q = input as Record<string, unknown>;
  const content = contents.find(c => c.topic.id === q.topicId);
  if (!content) return null;
  if (![1, 2, 3, 4].includes(q.level as number)) return null;
  if (!isText(q.prompt) || !isText(q.hint) || !isText(q.explanation) || !isText(q.reason)) return null;
  if (!textList(q.options, 4) || (q.options as string[]).length < 2 || !textList(q.answers, 4)) return null;
  if (!(q.answers as string[]).every(a => (q.options as string[]).includes(a))) return null;
  if (typeof q.subSkill !== "string" || !(q.subSkill === "own" || q.subSkill in content.subSkillNames)) return null;
  if (typeof q.format !== "string" || !(QUESTION_FORMATS as readonly string[]).includes(q.format)) return null;
  const visual = q.visual === undefined || q.visual === null ? undefined : q.visual as Visual;
  if (visual && (visual.kind !== "dots" || !Array.isArray(visual.groups) || visual.groups.length > 4
    || !visual.groups.every(g => g && Number.isInteger(g.count) && g.count >= 0 && g.count <= 100 && (g.color === "blue" || g.color === "orange")))) return null;
  const working = q.working === undefined || q.working === null ? undefined : q.working as Working;
  if (working && (typeof working !== "object" || typeof (working as { kind?: unknown }).kind !== "string" || JSON.stringify(working).length > 2000)) return null;
  return {
    id: "", topicId: content.topic.id, subSkill: q.subSkill, level: q.level as Level, format: q.format as SuppliedQuestion["format"],
    prompt: (q.prompt as string).trim(),
    ...(visual ? { visual } : {}),
    options: (q.options as string[]).map(o => o.trim()), answers: (q.answers as string[]).map(a => a.trim()),
    hint: (q.hint as string).trim(), explanation: (q.explanation as string).trim(), reason: (q.reason as string).trim(),
    ...(working ? { working, variantGroup: variantGroup(content.topic.id, working, visual) } : {}),
    source: "upload", sourceRef: `${fileName.slice(0, 200)} row ${row}`,
  };
}

/** Checks one question again, where the family can't change the outcome. */
export function verdictFor(question: SuppliedQuestion, contents: TopicContent[]): OwnVerdict | null {
  const content = contents.find(c => c.topic.id === question.topicId);
  if (!content || safetyLink(question)) return null;
  return judgeOwnQuestion(question, templateTopic(content));
}

/** What an upload adds: each new question with its verdict, and the counts for the parent. */
export interface UploadPlan {
  add: { question: SuppliedQuestion; verdict: OwnVerdict; shared: boolean }[];
  result: Omit<UploadResult, "uploadId">;
}

/**
 * Plans an upload for one family: rebuilds and checks every row, and leaves
 * out repeats of Nitya's official questions and of the family's own.
 * `officialKeys` and `ownKeys` hold the topic and content key
 * (see sameQuestionKey) of what is there already.
 */
export function planUpload(opts: {
  owner: string;
  fileName: string;
  private: boolean;
  rows: unknown;
  contents: TopicContent[];
  officialKeys: Set<string>;
  ownKeys: Set<string>;
}): UploadPlan {
  if (!Array.isArray(opts.rows)) throw new Error("Send the questions as a list.");
  if (opts.rows.length > MAX_UPLOAD_ROWS) throw new Error(`Upload at most ${MAX_UPLOAD_ROWS} questions at a time.`);
  const seen = new Set(opts.ownKeys);
  const result = { ready: 0, inReview: 0, shared: 0, alreadyAdded: 0, inNitya: 0, refused: 0 };
  const add: UploadPlan["add"] = [];
  for (const r of opts.rows as Partial<UploadRow>[]) {
    const question = sanitizeOwnQuestion(r?.question, opts.contents, opts.fileName, typeof r?.row === "number" ? r.row : 0);
    const verdict = question && verdictFor(question, opts.contents);
    if (!question || !verdict) { result.refused++; continue; }
    const key = `${question.topicId}|${contentKey(question)}`;
    if (opts.officialKeys.has(key)) { result.inNitya++; continue; }
    if (seen.has(key)) { result.alreadyAdded++; continue; }
    seen.add(key);
    const shared = isShareable(verdict, opts.private);
    add.push({ question: { ...question, id: familyQuestionId(opts.owner, question) }, verdict, shared });
    if (verdict.status === "ready") result.ready++; else result.inReview++;
    if (shared) result.shared++;
  }
  return { add, result };
}

/** A family's fix of one of its questions, checked again. Keeps the question's id, topic and source. */
export function planFix(before: SuppliedQuestion, edited: unknown, contents: TopicContent[], privateUpload: boolean) {
  const row = Number(before.sourceRef?.match(/row (\d+)$/)?.[1] ?? 0);
  const fileName = before.sourceRef?.replace(/ row \d+$/, "") ?? "";
  const rebuilt = sanitizeOwnQuestion({ ...(edited as object), topicId: before.topicId }, contents, fileName, row);
  if (!rebuilt) throw new Error("Nitya can't read that fix. Check that every field is filled in.");
  const verdict = verdictFor(rebuilt, contents);
  if (!verdict) throw new Error("It has a link. Children must never see links, so Nitya can't keep it.");
  const question = { ...rebuilt, id: before.id };
  return { question, verdict, shared: isShareable(verdict, privateUpload) };
}
