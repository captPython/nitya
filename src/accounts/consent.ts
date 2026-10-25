/**
 * The consent a parent gives before any child data is saved (COPPA, India's
 * DPDP Act). The version is stored with the consent, so a change to the
 * wording needs a new version, and parents are asked again.
 */
export const CONSENT_VERSION = "2026-10-25";

export const CONSENT_POINTS = [
  "Nitya keeps only what you enter for each child: a nickname, an avatar, their class, board and language, and their quiz answers and progress.",
  "It is stored in Nitya's database in Mumbai, India, so it comes back when you sign in on another device.",
  "Nitya has no ads, no chat, no trackers and no links out of the app, and never sells or shares your child's data.",
  "You can download or delete a child's data at any time from Grown-ups.",
];

export const CONSENT_AGREEMENT = "I am the parent or legal guardian of the children I add, and I agree to Nitya keeping their data as described above.";
