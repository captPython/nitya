import { bandCutsProblem, childSettingsProblem, classSettingsProblems, type ChildSettings } from "../admin/settings";
import { ALL_CONTENT } from "../content";
import { planFix, planUpload, type OwnQuestion } from "../supply/family";
import { sameQuestionKey } from "../supply/template";
import type { Account, AccountBackend, AttemptResult, NewAttempt, QuestionUpload } from "./backend";
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
  /** A parent's choice per child, for all of that child's topics. (Step 6's first version kept per-topic choices under `settings`; they are ignored.) */
  quiz?: Record<string, ChildSettings>;
  /** The family's uploads of the question template, each with its questions. */
  uploads?: DemoUpload[];
}

interface DemoUpload {
  id: string;
  fileName: string;
  uploadedAt: string;
  private: boolean;
  questions: OwnQuestion[];
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
  /** Keeps the community bank in step with what this family shares. */
  const publish = (p: DemoParent) => bank.setCommunity(p.account.userId,
    (p.uploads ?? []).flatMap(u => u.questions.filter(q => q.shared && q.status === "ready" && !bank.isRemoved(q.question.id)).map(q => q.question)));
  const findOwn = (parent: DemoParent, questionId: string) => {
    for (const upload of parent.uploads ?? []) {
      const q = upload.questions.find(x => x.question.id === questionId);
      if (q) return { upload, q };
    }
    throw new Error("That question isn't in this account.");
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
    async deleteAccount() {
      const s = read();
      if (!s.signedIn || !s.parents[s.signedIn]) throw new NotSignedIn();
      bank.forget(s.parents[s.signedIn].account.userId);
      delete s.parents[s.signedIn];
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
        if (p.quiz) delete p.quiz[id];
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

    async questions(topicId, pool = {}) {
      const official = await bank.questions(topicId);
      const s = read();
      const me = s.signedIn ? s.parents[s.signedIn] : undefined;
      if (!me) return official;
      const mine = (me.uploads ?? []).flatMap(u => u.questions).filter(q => q.status === "ready" && q.question.topicId === topicId);
      return [
        ...official,
        ...mine.map(q => ({ ...q.question, family: true })),
        ...(pool.community ? bank.community(topicId, me.account.userId).map(q => ({ ...q, community: true })) : []),
      ];
    },
    async saveUpload(upload) {
      const parent = signedIn();
      if (!parent.account.consentVersion) throw new NoConsent();
      const topicIds = [...new Set(ALL_CONTENT.map(c => c.topic.id))];
      const officialKeys = new Set((await Promise.all(topicIds.map(id => bank.questions(id)))).flat().map(sameQuestionKey));
      return change((_, p) => {
        const ownKeys = new Set((p.uploads ?? []).flatMap(u => u.questions.map(q => sameQuestionKey(q.question))));
        const plan = planUpload({ owner: p.account.userId, fileName: upload.fileName, private: upload.private, rows: upload.rows, contents: ALL_CONTENT, officialKeys, ownKeys });
        if (!plan.add.length) return { uploadId: null, ...plan.result };
        const id = randomId();
        (p.uploads ??= []).unshift({
          id, fileName: upload.fileName.slice(0, 200), uploadedAt: new Date().toISOString(), private: upload.private,
          questions: plan.add.map(a => ({ question: a.question, uploadId: id, status: a.verdict.status, problems: a.verdict.problems, shared: a.shared })),
        });
        publish(p);
        return { uploadId: id, ...plan.result };
      });
    },
    async questionUploads() {
      return (signedIn().uploads ?? []).map((u): QuestionUpload => ({
        id: u.id, fileName: u.fileName, uploadedAt: u.uploadedAt, private: u.private,
        ready: u.questions.filter(q => q.status === "ready").length,
        inReview: u.questions.filter(q => q.status === "review").length,
        shared: u.questions.filter(q => q.shared && !bank.isRemoved(q.question.id)).length,
      }));
    },
    async ownQuestions() {
      return (signedIn().uploads ?? []).flatMap(u => u.questions.map(q => ({ ...structuredClone(q), shared: q.shared && !bank.isRemoved(q.question.id) })));
    },
    async reviewOwnQuestion(questionId, review) {
      return change((_, p) => {
        const { upload, q } = findOwn(p, questionId);
        if (review.decision === "delete") {
          upload.questions = upload.questions.filter(x => x !== q);
          if (!upload.questions.length) p.uploads = p.uploads!.filter(u => u !== upload);
          publish(p);
          return null;
        }
        if (q.status !== "review") throw new Error("This question was already reviewed.");
        if (review.decision !== "fix") {
          // Approved with its issues: for the family's own children only.
          Object.assign(q, { status: "ready", shared: false });
          return null;
        }
        const fix = planFix(q.question, review.question, ALL_CONTENT, upload.private);
        const key = sameQuestionKey(fix.question);
        if ((p.uploads ?? []).some(u => u.questions.some(x => x !== q && sameQuestionKey(x.question) === key))) {
          throw new Error("You already have this question.");
        }
        Object.assign(q, { question: fix.question, status: fix.verdict.status, problems: fix.verdict.problems, shared: fix.shared });
        publish(p);
        return fix.verdict;
      });
    },
    async removeUpload(uploadId) {
      change((_, p) => {
        if (!(p.uploads ?? []).some(u => u.id === uploadId)) throw new Error("That upload isn't in this account.");
        p.uploads = p.uploads!.filter(u => u.id !== uploadId);
        publish(p);
      });
    },
    async reportQuestion(questionId, reason) {
      const text = reason.trim();
      if (!text || text.length > 300) throw new Error("Say in a few words what is wrong with it.");
      bank.report(questionId, signedIn().account.userId, text);
    },
    async communityReports() { admin(); return bank.reports(); },
    async moderateQuestion(questionId, decision) { admin(); bank.moderate(questionId, decision); },
    async newQuestions(topicId, profileId) {
      const parent = signedIn();
      if (profileId) own(parent, profileId);
      return bank.newQuestions(topicId, profileId);
    },
    async classSettings() { signedIn(); return bank.classSettings(); },
    async childSettings(profileId) {
      return change((_, p) => { own(p, profileId); return { passPercent: null, wrongPenalty: null, look: null, voice: null, community: null, ...p.quiz?.[profileId] }; });
    },
    async saveChildSettings(profileId, c) {
      change((_, p) => {
        own(p, profileId);
        const problem = childSettingsProblem(c);
        if (problem) throw new Error(problem);
        (p.quiz ??= {})[profileId] = { passPercent: c.passPercent, wrongPenalty: c.wrongPenalty, look: c.look, voice: c.voice, community: c.community ?? null };
      });
    },

    async reviewQueue() { admin(); return bank.reviewQueue(); },
    async reviewQuestion(questionId, review) { admin(); await bank.review(questionId, review); },
    async saveClassSettings(c) {
      admin();
      const problems = classSettingsProblems(c);
      if (problems.length) throw new Error(problems.join(" "));
      bank.saveClassSettings(c);
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
