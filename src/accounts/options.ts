import type { ClassId } from "../types";

/** What a profile holds: only what onboarding asks for. */
export interface ProfileDetails {
  nickname: string;
  avatar: string;
  classId: ClassId;
  board: string;
  language: string;
}

export interface Profile extends ProfileDetails {
  id: string;
}

export const AVATARS = [
  { id: "owl", emoji: "🦉", name: "Owl" },
  { id: "tiger", emoji: "🐯", name: "Tiger" },
  { id: "elephant", emoji: "🐘", name: "Elephant" },
  { id: "peacock", emoji: "🦚", name: "Peacock" },
  { id: "rabbit", emoji: "🐰", name: "Rabbit" },
  { id: "turtle", emoji: "🐢", name: "Turtle" },
  { id: "lion", emoji: "🦁", name: "Lion" },
  { id: "panda", emoji: "🐼", name: "Panda" },
] as const;

export const BOARDS = [
  { id: "CBSE", name: "CBSE" },
  { id: "ICSE", name: "ICSE" },
  { id: "State", name: "State board" },
  { id: "Other", name: "Other" },
] as const;

/** The app's questions are in English for now; the choice is kept for when other languages arrive. */
export const LANGUAGES = [
  { id: "en", name: "English" },
  { id: "hi", name: "हिन्दी (Hindi)" },
] as const;

export const CLASS_NAMES: Record<ClassId, string> = {
  LKG: "LKG", UKG: "UKG", C1: "Class 1", C2: "Class 2", C3: "Class 3", C4: "Class 4", C5: "Class 5",
  C6: "Class 6", C7: "Class 7", C8: "Class 8", C9: "Class 9", C10: "Class 10", C11: "Class 11", C12: "Class 12",
};

/**
 * Checks a nickname. It should be what the child is called at home, not a
 * full name, so it takes letters only (any script), up to 20 of them.
 */
export function nicknameProblem(nickname: string): string | null {
  const n = nickname.trim();
  if (!n) return "Type a nickname.";
  if ([...n].length > 20) return "Keep the nickname to 20 letters or fewer.";
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(n)) return "Use letters only, like Riya or Chintu.";
  return null;
}

/** Every problem with a profile's details, or an empty list when it can be saved. */
export function profileProblems(p: ProfileDetails, classes: ClassId[]): string[] {
  const problems: string[] = [];
  const nick = nicknameProblem(p.nickname);
  if (nick) problems.push(nick);
  if (!AVATARS.some(a => a.id === p.avatar)) problems.push("Pick an avatar.");
  if (!classes.includes(p.classId)) problems.push(`Pick a class: ${classes.map(c => CLASS_NAMES[c]).join(" or ")}.`);
  if (!BOARDS.some(b => b.id === p.board)) problems.push("Pick a board.");
  if (!LANGUAGES.some(l => l.id === p.language)) problems.push("Pick a language.");
  return problems;
}

export const avatarEmoji = (id: string) => AVATARS.find(a => a.id === id)?.emoji ?? "🙂";
