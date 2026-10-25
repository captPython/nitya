import { contentKey, PER_LEVEL } from "../content/gen";
import type { Level, TopicContent } from "../types";
import type { CheckReport } from "../validation";
import { checkQuestions } from "./check";
import { parseQuestionCsv } from "./csv";
import { bankQuestions, generateQuestions } from "./generate";
import type { CheckedQuestion, CsvFolder, QuestionStore, SaveResult, SuppliedQuestion } from "./types";

/** A question that failed a check, with the reasons the admin will see. */
export interface ReviewItem {
  id: string;
  problems: string[];
}

/** Every failed check's reasons, in the order the checks run. */
export const reportProblems = (report: CheckReport) =>
  (["answer", "options", "scope", "level", "wording"] as const).flatMap(k => report[k].problems);
const problemsOf = (c: CheckedQuestion) => reportProblems(c.report);

/** Questions that were saved (added or changed) but failed a check, so they wait for the admin. */
function sentToReview(checked: CheckedQuestion[], saved: SaveResult): ReviewItem[] {
  const ids = new Set([...saved.added, ...saved.updated]);
  return checked.filter(c => c.status === "in_review" && ids.has(c.question.id)).map(c => ({ id: c.question.id, problems: problemsOf(c) }));
}

export interface NewQuestionsSummary {
  topicId: string;
  /** Added and approved: children can get them in their next quiz. */
  approved: string[];
  /** Added but held for the admin, because a check failed. */
  inReview: ReviewItem[];
  /** How many were asked for. Fewer are added when the templates have no new questions left. */
  asked: number;
}

/**
 * What happens when an admin, parent or child presses New questions: make new
 * questions from the topic's templates, check each one, save them (approved,
 * or held for review), and log the request.
 */
export async function addNewQuestions(
  store: QuestionStore,
  content: TopicContent,
  opts: { seed: number; perLevel?: number; levels?: Level[]; requestedBy?: string; profileId?: string },
): Promise<NewQuestionsSummary> {
  const topicId = content.topic.id;
  const [topics, existing] = await Promise.all([store.topics(), store.existing(topicId)]);
  const perLevel = opts.perLevel ?? PER_LEVEL;
  const made = generateQuestions(content, { seed: opts.seed, perLevel, levels: opts.levels, known: existing.map(contentKey) });
  const checked = checkQuestions(made, topics);
  const saved = await store.save(checked);
  const inReview = sentToReview(checked, saved);
  const approved = saved.added.filter(id => !inReview.some(r => r.id === id));
  await store.logRequest({
    topicId, requestedBy: opts.requestedBy, profileId: opts.profileId, added: approved.length, sentToReview: inReview.length,
  });
  return { topicId, approved, inReview, asked: perLevel * (opts.levels ?? [1, 2, 3, 4]).length };
}

/** Loads the built-in question banks. Running it again changes nothing. */
export async function seedBank(store: QuestionStore, contents: TopicContent[]): Promise<SaveResult & { inReview: ReviewItem[] }> {
  const topics = await store.topics();
  const checked = checkQuestions(contents.flatMap(bankQuestions), topics);
  const saved = await store.save(checked);
  return { ...saved, inReview: sentToReview(checked, saved) };
}

export interface ImportSummary extends SaveResult {
  inReview: ReviewItem[];
  /** Rows that couldn't be read, by file. Nothing from those rows was saved. */
  errors: { file: string; row: number; message: string }[];
}

/** Imports one question CSV: rows that can be read are checked and saved; the rest come back as errors. */
export async function importCsvText(store: QuestionStore, text: string, fileName: string): Promise<ImportSummary> {
  const topics = await store.topics();
  const { questions, errors } = parseQuestionCsv(text, { fileName, topics });
  const checked = checkQuestions(questions, topics);
  const saved = await store.save(checked);
  return { ...saved, inReview: sentToReview(checked, saved), errors: errors.map(e => ({ file: fileName, ...e })) };
}

export interface SyncSummary extends ImportSummary {
  files: string[];
  /**
   * CSV questions in the bank that no file has any more. They are kept; the
   * admin decides. A row that couldn't be read can show up here too.
   */
  missing: string[];
}

/**
 * Brings a folder of CSVs (the admin's Drive folder) into the bank, one way
 * and all at once: new rows are added, edited rows are updated and checked
 * again, and questions whose row is gone are reported, never deleted.
 */
export async function syncCsvFolder(store: QuestionStore, folder: CsvFolder): Promise<SyncSummary> {
  const topics = await store.topics();
  const files = await folder.files();
  const questions: SuppliedQuestion[] = [];
  const errors: ImportSummary["errors"] = [];
  const fileOf = new Map<string, string>();
  for (const file of files) {
    const parsed = parseQuestionCsv(await file.text(), { fileName: file.name, topics });
    errors.push(...parsed.errors.map(e => ({ file: file.name, ...e })));
    for (const q of parsed.questions) {
      const first = fileOf.get(q.id);
      if (first) {
        const row = Number(/row (\d+)$/.exec(q.sourceRef ?? "")?.[1] ?? 0);
        errors.push({ file: file.name, row, message: `The id "${q.id}" is also used in ${first}.` });
        continue;
      }
      fileOf.set(q.id, file.name);
      questions.push(q);
    }
  }
  const checked = checkQuestions(questions, topics);
  const saved = await store.save(checked);
  const missing: string[] = [];
  for (const topic of topics) {
    for (const q of await store.existing(topic.id)) if (q.source === "csv" && !fileOf.has(q.id)) missing.push(q.id);
  }
  return { ...saved, inReview: sentToReview(checked, saved), errors, files: files.map(f => f.name), missing: missing.sort() };
}
