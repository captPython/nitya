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
}

/** A play as it starts. The app makes its id, so answers can be saved without waiting for the server. */
export type NewAttempt = Omit<AttemptRow, "finishedAt" | "marks" | "cleared" | "stars">;
export type AttemptResult = Pick<AttemptRow, "marks" | "cleared" | "stars"> & { passMarks: number; maxMarks: number; correct: number };

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
}

export class NotSignedIn extends Error {
  constructor() { super("Sign in first."); }
}

export class NoConsent extends Error {
  constructor() { super("A parent must give consent before a child's profile is saved."); }
}
