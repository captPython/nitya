import { CLASS_ORDER, type ClassId } from "./types";

/**
 * How the app looks for a child. "play" is bright and game-like, for young
 * children; "focus" is clean and calm, for older ones. Both share one layout,
 * so moving up a class changes the look, not where things are.
 */
export type Look = "play" | "focus";
export const LOOKS: Look[] = ["play", "focus"];

/** Playful up to Class 5, clean from Class 6 (cp, 2026-10-25). */
export const LAST_PLAY_CLASS: ClassId = "C5";

/** The look a class gets when the parent hasn't chosen one. */
export const classLook = (classId: ClassId): Look =>
  CLASS_ORDER.indexOf(classId) <= CLASS_ORDER.indexOf(LAST_PLAY_CLASS) ? "play" : "focus";

/** The parent's choice for the child if there is one, else the class's look. */
export const lookFor = (classId: ClassId, choice?: Look | null): Look => choice ?? classLook(classId);

export const isLook = (v: unknown): v is Look => LOOKS.includes(v as Look);
