import type { Review, ReviewEntry } from "../admin/review";
import type { BandCuts, ChildSettings, ClassSettings } from "../admin/settings";
import type { Question } from "../types";
import type { LevelBand } from "../validation";
import type { Profile, ProfileDetails } from "./options";
import type { AttemptRow, ProfileData, ResponseRow, TopicProgressRow } from "./progress";

/** The signed-in parent. */
export interface Account {
  userId: string;
  email: string | null;
  /** The consent version the parent agreed to, or null before consent. */
  consentVersion: string | null;
  /** The parent PIN's hash, or null before one is set. */
  pinHash: string | null;
  /** Admins also see the admin panel. */
  isAdmin: boolean;
}

/** A play as it starts. The app makes its id, so answers can be saved without waiting for the server. */
export type NewAttempt = Omit<AttemptRow, "finishedAt" | "marks" | "cleared" | "stars">;
export type AttemptResult = Pick<AttemptRow, "marks" | "cleared" | "stars"> & { passMarks: number; maxMarks: number; correct: number };

/** What one press of New questions did. */
export interface NewQuestionsResult {
  topicId: string;
  /** Approved and ready for the next quiz. */
  added: number;
  /** Held for the admin, because a check failed. */
  sentToReview: number;
  /** How many were asked for. Fewer are added when the templates have no new ones left. */
  asked: number;
}

/** One press of New questions, for the admin's log. */
export interface QuestionRequestLog {
  topicId: string;
  requestedAt: string;
  /** "child" when a child pressed it on a profile, else "grown-up" (a parent or an admin). */
  by: "child" | "grown-up";
  added: number;
  sentToReview: number;
}

/**
 * Where a family's account lives. The app uses the Supabase backend when it
 * is built with a Supabase project, and the demo backend (this browser only,
 * pretend sign-in) otherwise, as in the preview.
 */
export interface AccountBackend {
  readonly mode: "demo" | "supabase";
  account(): Promise<Account | null>;
  signInWithGoogle(): Promise<void>;
  /** Sends a one-time sign-in link. The demo sends nothing; see `openDemoLink`. */
  sendEmailLink(email: string): Promise<void>;
  /** Demo only: acts as if the parent opened the emailed link. */
  openDemoLink?(): Promise<void>;
  signOut(): Promise<void>;

  /** Records consent. Nothing about a child can be saved before it. */
  giveConsent(version: string): Promise<void>;
  setPinHash(hash: string): Promise<void>;

  profiles(): Promise<Profile[]>;
  createProfile(details: ProfileDetails): Promise<Profile>;
  updateProfile(id: string, details: ProfileDetails): Promise<Profile>;
  /** Deletes the profile and everything saved for it. */
  deleteProfile(id: string): Promise<void>;

  profileData(profileId: string): Promise<ProfileData>;
  startAttempt(profileId: string, attempt: NewAttempt): Promise<void>;
  recordResponse(response: ResponseRow): Promise<void>;
  finishAttempt(attemptId: string, result: AttemptResult): Promise<void>;
  saveTopicProgress(profileId: string, rows: TopicProgressRow[]): Promise<void>;

  /** The approved questions a quiz on this topic can use. */
  questions(topicId: string): Promise<Question[]>;
  /** Makes new questions from the topic's templates. A child pressing it passes their profile. */
  newQuestions(topicId: string, profileId?: string): Promise<NewQuestionsResult>;
  /** The admin's defaults for every class. */
  classSettings(): Promise<ClassSettings[]>;
  /** A parent's choices for one child, for all of that child's topics: pass mark, marks off and look. */
  childSettings(profileId: string): Promise<ChildSettings>;
  /** Saves a parent's choices for one child; nulls go back to the class default. */
  saveChildSettings(profileId: string, settings: ChildSettings): Promise<void>;

  // The admin panel. Each of these refuses anyone who isn't an admin (levelBands is for everyone).
  reviewQueue(): Promise<ReviewEntry[]>;
  reviewQuestion(questionId: string, review: Review): Promise<void>;
  saveClassSettings(settings: ClassSettings): Promise<void>;
  levelBands(): Promise<LevelBand[]>;
  saveLevelBands(cuts: BandCuts): Promise<void>;
  questionRequests(limit?: number): Promise<QuestionRequestLog[]>;
  /** Demo only: makes the signed-in account an admin, or not, to try the admin panel. */
  setDemoAdmin?(on: boolean): Promise<void>;
}

export class NotSignedIn extends Error {
  constructor() { super("Sign in first."); }
}

export class NotAdmin extends Error {
  constructor() { super("Only an admin can do that."); }
}

export class NoConsent extends Error {
  constructor() { super("A parent must give consent before a child's profile is saved."); }
}
