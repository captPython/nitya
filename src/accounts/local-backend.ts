import { bandCutsProblem, childSettingsProblem, topicSettingsProblems, type ChildSettings } from "../admin/settings";
import { ALL_CONTENT } from "../content";
import { maxMarks } from "../engine";
import type { Account, AccountBackend, AttemptResult, NewAttempt } from "./backend";
import { NoConsent, NotAdmin, NotSignedIn } from "./backend";
import { DemoBank } from "./demo-bank";
import type { Profile, ProfileDetails } from "./options";
import { emptyProfileData, type ProfileData, type ResponseRow, type TopicProgressRow } from "./progress";

/** Anything that keeps a string by key, like localStorage. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface DemoParent {
  account: Account;
  consentAt: string | null;
  profiles: Profile[];
  data: Record<string, ProfileData>;
  /** A parent's choices per child, for the topics they changed. */
  settings?: Record<string, ChildSettings[]>;
}

interface DemoState {
  signedIn: string | null;
  pendingEmail: string | null;
  parents: Record<string, DemoParent>;
}

export const DEMO_KEY = "nitya-demo-v1";
/** The demo's question bank and admin settings, kept apart from the families. */
export const demoBankKey = (key: string) => `${key}-bank`;
export const DEMO_GOOGLE_EMAIL = "parent@demo.nitya";

const randomId = () => crypto.randomUUID();

/**
 * The demo backend: a pretend sign-in, with everything kept in this browser.
 * It follows the database's rules (no child data before consent, one family
 * sees only its own profiles), so the screens behave as they will for real.
 */
export function localBackend(store: KeyValue, key = DEMO_KEY, bankKey = demoBankKey(key)): AccountBackend {
  const bank = new DemoBank(store, bankKey);
  const read = (): DemoState => {
    try {
      const s = JSON.parse(store.getItem(key) ?? "null");
      if (s && typeof s === "object" && s.parents) return s as DemoState;
    } catch { /* start fresh */ }
    return { signedIn: null, pendingEmail: null, parents: {} };
  };
  const write = (s: DemoState) => { try { store.setItem(key, JSON.stringify(s)); } catch { /* storage full or blocked */ } };
  const change = <T>(fn: (s: DemoState, parent: DemoParent) => T): T => {
    const s = read();
    const parent = s.signedIn ? s.parents[s.signedIn] : undefined;
    if (!parent) throw new NotSignedIn();
    const out = fn(s, parent);
    write(s);
    return out;
  };
  const signIn = (email: string) => {
    const s = read();
    s.parents[email] ??= { account: { userId: randomId(), email, consentVersion: null, pinHash: null, isAdmin: false }, consentAt: null, profiles: [], data: {} };
    s.signedIn = email;
    s.pendingEmail = null;
    write(s);
  };
  const own = (parent: DemoParent, profileId: string) => {
    if (!parent.profiles.some(p => p.id === profileId)) throw new Error("That profile isn't in this account.");
    return (parent.data[profileId] ??= emptyProfileData());
  };
  const signedIn = () => {
    const s = read();
    const parent = s.signedIn ? s.parents[s.signedIn] : undefined;
    if (!parent) throw new NotSignedIn();
    return parent;
  };
  const admin = () => {
    if (!signedIn().account.isAdmin) throw new NotAdmin();
  };
  const settingsFor = (topicId: string) => {
    const t = bank.topicSettings().find(x => x.topicId === topicId);
    if (!t) throw new Error("That topic isn't in Nitya.");
    return t;
  };
  const findAttempt = (parent: DemoParent, attemptId: string) => {
    for (const data of Object.values(parent.data)) {
      const a = data.attempts.find(x => x.id === attemptId);
      if (a) return { data, attempt: a };
    }
    throw new Error("That play isn't in this account.");
  };

  return {
    mode: "demo",
    async account() {
      const s = read();
      const account = s.signedIn ? s.parents[s.signedIn]?.account : undefined;
      return account ? { ...account, isAdmin: account.isAdmin ?? false } : null;
    },
    async signInWithGoogle() { signIn(DEMO_GOOGLE_EMAIL); },
    async sendEmailLink(email) {
      const s = read();
      s.pendingEmail = email.trim().toLowerCase();
      write(s);
    },
    async openDemoLink() {
      const email = read().pendingEmail;
      if (!email) throw new Error("Ask for a sign-in link first.");
      signIn(email);
    },
    async signOut() {
      const s = read();
      s.signedIn = null;
      write(s);
    },
    async giveConsent(version) {
      change((_, p) => { p.account.consentVersion = version; p.consentAt = new Date().toISOString(); });
    },
    async setPinHash(hash) { change((_, p) => { p.account.pinHash = hash; }); },
    async profiles() {
      const s = read();
      return s.signedIn ? [...(s.parents[s.signedIn]?.profiles ?? [])] : [];
    },
    async createProfile(details) {
      return change((_, p) => {
        if (!p.account.consentVersion) throw new NoConsent();
        const profile: Profile = { id: randomId(), ...details, nickname: details.nickname.trim() };
        p.profiles.push(profile);
        p.data[profile.id] = emptyProfileData();
        return profile;
      });
    },
    async updateProfile(id, details) {
      return change((_, p) => {
        const profile = p.profiles.find(x => x.id === id);
        if (!profile) throw new Error("That profile isn't in this account.");
        Object.assign(profile, details, { nickname: details.nickname.trim() });
        return { ...profile };
      });
    },
    async deleteProfile(id) {
      change((_, p) => {
        if (!p.profiles.some(x => x.id === id)) throw new Error("That profile isn't in this account.");
        p.profiles = p.profiles.filter(x => x.id !== id);
        delete p.data[id];
        if (p.settings) delete p.settings[id];
      });
    },
    async profileData(profileId) {
      return change((_, p) => structuredClone(own(p, profileId)));
    },
    async startAttempt(profileId, attempt: NewAttempt) {
      return change((_, p) => {
        const data = own(p, profileId);
        if (data.attempts.some(a => a.topicId === attempt.topicId && a.attemptNo === attempt.attemptNo)) {
          throw new Error(`Play ${attempt.attemptNo} of ${attempt.topicId} is already saved.`);
        }
        data.attempts.push({ ...attempt, finishedAt: null, marks: null, cleared: null, stars: null });
      });
    },
    async recordResponse(response: ResponseRow) {
      change((_, p) => {
        const { data } = findAttempt(p, response.attemptId);
        if (data.responses.some(r => r.attemptId === response.attemptId && (r.seq === response.seq || r.questionId === response.questionId))) {
          throw new Error("That answer is already saved.");
        }
        data.responses.push({ ...response });
      });
    },
    async finishAttempt(attemptId, result: AttemptResult) {
      change((_, p) => {
        const { attempt } = findAttempt(p, attemptId);
        Object.assign(attempt, { finishedAt: new Date().toISOString(), marks: result.marks, cleared: result.cleared, stars: result.stars });
      });
    },
    async saveTopicProgress(profileId, rows: TopicProgressRow[]) {
      change((_, p) => {
        const data = own(p, profileId);
        for (const row of rows) {
          const i = data.topics.findIndex(t => t.topicId === row.topicId);
          if (i >= 0) data.topics[i] = { ...row }; else data.topics.push({ ...row });
        }
      });
    },

    async questions(topicId) { return bank.questions(topicId); },
    async newQuestions(topicId, profileId) {
      const parent = signedIn();
      if (profileId) own(parent, profileId);
      return bank.newQuestions(topicId, profileId);
    },
    async topicSettings() { signedIn(); return bank.topicSettings(); },
    async childSettings(profileId) {
      return change((_, p) => { own(p, profileId); return structuredClone(p.settings?.[profileId] ?? []); });
    },
    async saveChildSettings(profileId, c) {
      const problem = childSettingsProblem(settingsFor(c.topicId), c);
      if (problem) throw new Error(problem);
      change((_, p) => {
        own(p, profileId);
        const list = ((p.settings ??= {})[profileId] ??= []).filter(x => x.topicId !== c.topicId);
        if (c.passMarks !== null || c.wrongPenalty !== null) list.push({ ...c });
        p.settings[profileId] = list;
      });
    },

    async reviewQueue() { admin(); return bank.reviewQueue(); },
    async reviewQuestion(questionId, review) { admin(); await bank.review(questionId, review); },
    async saveTopicSettings(t) {
      admin();
      const content = ALL_CONTENT.find(c => c.topic.id === t.topicId);
      const problems = topicSettingsProblems(t, maxMarks(content?.topic.classId ?? "UKG"));
      if (problems.length) throw new Error(problems.join(" "));
      bank.saveTopicSettings(t);
    },
    async levelBands() { signedIn(); return bank.levelBands(); },
    async saveLevelBands(cuts) {
      admin();
      const problem = bandCutsProblem(cuts);
      if (problem) throw new Error(problem);
      bank.saveLevelBands(cuts);
    },
    async questionRequests(limit = 20) { admin(); return bank.requests(limit); },
    async setDemoAdmin(on) { change((_, p) => { p.account.isAdmin = on; }); },
  };
}
