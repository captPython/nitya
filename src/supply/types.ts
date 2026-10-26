import type { ClassId, Question } from "../types";
import type { CheckReport } from "../validation";

/** "upload" is a family's own question from the question template. */
export type QuestionSource = "template" | "csv" | "website" | "upload";

/** A question on its way into the bank, with where it came from. */
export interface SuppliedQuestion extends Question {
  source: QuestionSource;
  /** Template, CSV file and row, or the page link. */
  sourceRef?: string;
  generatorVersion?: string;
}

/** What the checks need to know about a topic. */
export interface TopicInfo {
  id: string;
  classId: ClassId;
  subSkills: string[];
}

/** A question after the checks: approved if it passed, otherwise sent to the admin's review queue. */
export interface CheckedQuestion {
  question: SuppliedQuestion;
  status: "approved" | "in_review";
  report: CheckReport;
}

export interface SaveResult {
  added: string[];
  updated: string[];
  unchanged: string[];
  /** Skipped because the bank already has the same question under another id. */
  duplicates: string[];
}

/** One press of New questions: who asked, and what it added. */
export interface QuestionRequest {
  topicId: string;
  /** The signed-in user (admin or parent). */
  requestedBy?: string;
  /** The child, when a child pressed it. */
  profileId?: string;
  added: number;
  sentToReview: number;
}

/**
 * Where questions are kept. The scripts use the Postgres store; the preview
 * and the unit tests use the in-memory one.
 */
export interface QuestionStore {
  topics(): Promise<TopicInfo[]>;
  /** Every question in a topic, whatever its status. */
  existing(topicId: string): Promise<SuppliedQuestion[]>;
  /**
   * Adds new questions and updates changed ones, all or nothing. A changed
   * question starts its live results again and gets a new check record.
   */
  save(questions: CheckedQuestion[]): Promise<SaveResult>;
  logRequest(request: QuestionRequest): Promise<void>;
}

/** A CSV in the admin's Drive folder (or any folder of CSVs). */
export interface CsvFile {
  id: string;
  name: string;
  text(): Promise<string>;
}

export interface CsvFolder {
  files(): Promise<CsvFile[]>;
}
