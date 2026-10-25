const M = Nitya;
const backend = M.createBackend();
const DEMO = backend.mode === "demo";
const LEVEL_NAMES = { 1: "Easy", 2: "Medium", 3: "Hard", 4: "Olympiad" };
const PRACTICE_LENGTH = 8;
const CURRENT_KEY = "nitya-current-profile";
// Where step 4's preview kept its New questions seeds; reset clears it.
const OLD_BANK_KEY = "nitya-ukg-bank-v1";
const storage = M.browserStorage();
const screen = document.getElementById("screen");
const side = document.getElementById("side");
const stage = document.getElementById("stage");
const tag = document.getElementById("tag");

/* ---------- light and dark colours: light unless this device's switch says dark ---------- */
const MODE_KEY = "nitya-mode";
const modeBtn = document.getElementById("mode");
const MOON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>`;
const SUN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>`;
let colourMode = "light";
try { if (storage.getItem(MODE_KEY) === "dark") colourMode = "dark"; } catch (e) {}
function showMode() {
  const dark = colourMode === "dark";
  document.documentElement.dataset.mode = colourMode;
  modeBtn.innerHTML = dark ? `${SUN}<span class="mode-lbl">Light</span>` : `${MOON}<span class="mode-lbl">Dark</span>`;
  modeBtn.setAttribute("aria-label", dark ? "Switch to light colours" : "Switch to dark colours");
}
modeBtn.onclick = () => {
  colourMode = colourMode === "dark" ? "light" : "dark";
  try { storage.setItem(MODE_KEY, colourMode); } catch (e) {}
  showMode();
};
showMode();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pick = a => a[Math.floor(Math.random() * a.length)];
const byId = id => M.ALL_CONTENT.find(t => t.topic.id === id);

/** The owl: ear tufts, wings and a belly, so it reads as an owl. Its eyes show how it feels: "happy" after a right
 * answer or a cleared topic, "think" with a hint, and a plain look otherwise. */
function owl(mood = "") {
  const eyes = mood === "happy"
    ? `<path d="M18 30 Q24 24 30 30 M34 30 Q40 24 46 30" fill="none" stroke="#13234b" stroke-width="3.2" stroke-linecap="round"/>`
    : `<circle cx="24" cy="29" r="8" fill="#ffffff"/><circle cx="40" cy="29" r="8" fill="#ffffff"/>
       <circle cx="${mood === "think" ? 26 : 25}" cy="${mood === "think" ? 26 : 30}" r="4" fill="#13234b"/><circle cx="${mood === "think" ? 42 : 41}" cy="${mood === "think" ? 26 : 30}" r="4" fill="#13234b"/>`;
  const brows = mood === "think" ? `<path d="M34 17 Q40 13 47 17" fill="none" stroke="#13234b" stroke-width="2.6" stroke-linecap="round"/>` : "";
  return `<svg class="owl" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
  <path d="M12 12 L22 20 L24 12 Z M52 12 L42 20 L40 12 Z" fill="var(--owl-dark)"/>
  <path d="M8 34 Q4 48 17 54 Q14 44 16 34 Z M56 34 Q60 48 47 54 Q50 44 48 34 Z" fill="var(--owl-dark)"/>
  <ellipse cx="32" cy="36" rx="20" ry="22" fill="var(--owl)"/>
  <ellipse cx="32" cy="45" rx="11" ry="11" fill="var(--owl-belly)"/>
  ${eyes}${brows}
  <path d="M29 36 L32 41 L35 36 Z" fill="#e85a36"/>
  <path d="M25 58 l2.5-3 2.5 3 M34 58 l2.5-3 2.5 3" fill="none" stroke="#d9661a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
const MASCOT = owl();

/* ---------- the family and the child playing now ---------- */
let account = null;   // the signed-in parent
let profiles = [];
let child = null;     // the profile playing now
let data = null;      // everything saved for the child
let sum = null;       // what the dashboard and quiz need, worked out from `data`
let saveError = null;
let saving = Promise.resolve();
let app = { mode: "loading" };
let banks = {};       // topic id -> the approved questions its quizzes use
let settings = { classes: [], child: null };   // the admin's class defaults, and the parent's choice for this child
let newqBusy = null;  // the topic New questions is working on

const classTopics = () => M.contentForClass(child.classId);
const topicList = () => classTopics().map(t => t.topic);
const maxMarks = () => M.maxMarks(child.classId);
const className = id => M.CLASS_NAMES[id];
function refresh() { sum = M.summarize(child.classId, topicList(), data); }
const classDefaults = (classes, classId) => classes.find(c => c.classId === classId) ?? M.defaultClassSettings(classId);
/** The pass mark and penalty this child's quizzes use, on every topic. */
function quizSettings() { return M.effectiveSettings(classDefaults(settings.classes, child.classId), settings.child); }
const passPercent = () => settings.child?.passPercent ?? classDefaults(settings.classes, child.classId).passPercent;

/** Saves in order without making the child wait. A failure shows a banner, and the next save tries again. */
function persist(fn) {
  saving = saving.then(fn).then(
    () => { if (saveError) { saveError = null; render(); } },
    e => { saveError = `Progress couldn't be saved (${e.message}). Check the connection.`; render(); },
  );
}

/** Runs a step that talks to the account, showing any error instead of failing silently. */
async function step(fn) {
  try { await fn(); } catch (e) { app.error = e.message || String(e); render(); }
}

function show(next) { app = next; render(); }

async function route(preferId) {
  if (!account) return show({ mode: "signin" });
  if (account.consentVersion !== M.CONSENT_VERSION) return show({ mode: "consent" });
  if (!account.pinHash) return show({ mode: "set-pin", first: null, then: "route" });
  profiles = await backend.profiles();
  if (!profiles.length) return startOnboarding();
  let id = preferId;
  try { id = id ?? storage.getItem(CURRENT_KEY); } catch (e) {}
  const p = profiles.find(x => x.id === id);
  if (p) return openProfile(p);
  show({ mode: "profiles" });
}

async function openProfile(p) {
  child = p;
  try { storage.setItem(CURRENT_KEY, p.id); } catch (e) {}
  const ids = M.contentForClass(p.classId).map(c => c.topic.id);
  const [d, classes, mine, ...served] = await Promise.all([
    backend.profileData(p.id), backend.classSettings(), backend.childSettings(p.id), ...ids.map(id => backend.questions(id)),
  ]);
  data = d;
  settings = { classes, child: mine };
  // A bank that hasn't been loaded into the database yet falls back to the built-in questions.
  ids.forEach((id, i) => { banks[id] = served[i].length ? served[i] : byId(id).bank; });
  refresh();
  goDash();
}

async function boot() {
  render();
  await step(async () => { account = await backend.account(); await route(); });
}

/* ---------- New questions ---------- */
/** Asks for new questions on a topic, for the child playing (or for the admin), and tells the grown-up what happened. */
async function askNewQuestions(topicId, profileId) {
  if (newqBusy) return;
  newqBusy = topicId;
  app.newqNote = null;
  render();
  const title = byId(topicId).topic.title;
  try {
    const r = await backend.newQuestions(topicId, profileId);
    const held = r.sentToReview ? ` ${r.sentToReview} more ${r.sentToReview === 1 ? "waits" : "wait"} for the admin's check.` : "";
    app.newqNote = r.added
      ? `${r.added} new questions added to ${title}.${held}`
      : `${title} has no new questions left to make right now.${held}`;
    const fresh = await backend.questions(topicId);
    if (fresh.length) banks[topicId] = fresh;
  } catch (e) {
    app.newqNote = `Couldn't make new questions: ${e.message}`;
  }
  newqBusy = null;
  render();
}

/* ---------- voice and sounds ---------- */
// The playful look reads each lesson page, question, hint and praise aloud, and plays a short sound for right and
// wrong, so a child who can't read yet can still play. A parent can turn this off for each child in Settings; the
// choice is kept on this device. The clean look stays quiet unless the parent turns it on.
const VOICE_KEY = id => `nitya-voice-${id}`;
function voiceChoice(p) { try { const v = storage.getItem(VOICE_KEY(p.id)); return v === "on" || v === "off" ? v : null; } catch (e) { return null; } }
function voiceOn(p, lookShown) { const v = voiceChoice(p); return v ? v === "on" : lookShown === "play"; }
const childVoice = () => !!child && PLAYING.includes(app.mode) && voiceOn(child, look());
function speak(text) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.9;
    u.lang = child?.language === "hi" ? "hi-IN" : "en-IN";
    speechSynthesis.speak(u);
  } catch (e) {}
}
// Browsers only speak after the first tap, so nothing is said on a page that was just opened.
let lastSaid = "";
function autoSay(key, text) {
  if (key === lastSaid || !childVoice()) return;
  lastSaid = key;
  try { if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; } catch (e) {}
  speak(text);
}
let audio = null;
function chime(kind) {
  if (!childVoice()) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === "good" ? [523, 659, 784] : [392, 330];
    notes.forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * 0.11;
      o.type = kind === "good" ? "triangle" : "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(kind === "good" ? 0.16 : 0.08, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g).connect(audio.destination);
      o.start(t); o.stop(t + 0.3);
    });
  } catch (e) {}
}
const SPEAKER = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>`;
/** The speaker button on a speech bubble: round and big when playful, a small square when clean. */
const sayBtn = text => `<button class="say" type="button" data-say="${esc(text)}" aria-label="Listen">${SPEAKER}</button>`;
screen.addEventListener("click", e => { const b = e.target.closest("[data-say]"); if (b) speak(b.dataset.say); });

/* ---------- screen reader messages ---------- */
// The screen is rebuilt on each step, so it isn't a live region (that would read it all again). Feedback is
// announced here instead, and focus moves to the new heading or question.
const announcer = document.getElementById("announce");
function announce(text) {
  if (!announcer) return;
  announcer.textContent = "";
  setTimeout(() => { announcer.textContent = text; }, 60);
}
const plain = html => { const d = document.createElement("div"); d.innerHTML = html; return d.textContent.replace(/\s+/g, " ").trim(); };

/* ---------- words that change with the look ---------- */
const WORDS = {
  play: { map: "Class map", again: "Play this one again", retry: "Try again" },
  focus: { map: "All topics", again: "Retake", retry: "Retake" },
};
const word = k => WORDS[look()][k];
/** A question's text, with number runs like "1, 2, 3, __" kept on one line. */
const promptHtml = text => esc(text).replace(/(?:\d+|_+)(?:, (?:\d+|_+)){2,}/g, m => `<span class="seq">${m}</span>`);

/* ---------- dots ---------- */
function dotsSvg(visual) {
  if (!visual) return "";
  const R = 14, G = 7, STEP = 2 * R + G, GROUP_GAP = 34;
  let x = 0, h = 0;
  const parts = [];
  visual.groups.forEach((g, gi) => {
    const cols = Math.min(10, g.count), rows = Math.ceil(g.count / 10);
    const fill = g.color === "blue" ? "var(--dot-blue)" : "var(--dot-orange)";
    for (let i = 0; i < g.count; i++) {
      const cx = x + R + (i % 10) * STEP, cy = R + Math.floor(i / 10) * STEP;
      const crossed = g.crossed && i >= g.count - g.crossed;
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="${fill}" ${crossed ? 'fill-opacity="0.3"' : ""}/>`);
      if (crossed) parts.push(`<path d="M${cx - 8} ${cy - 8}L${cx + 8} ${cy + 8}M${cx + 8} ${cy - 8}L${cx - 8} ${cy + 8}" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/>`);
    }
    x += cols * STEP - G + (gi < visual.groups.length - 1 ? GROUP_GAP : 0);
    h = Math.max(h, rows * STEP - G);
  });
  const label = visual.groups.map(g => `${g.count} ${g.color}${g.crossed ? `, ${g.crossed} crossed out` : ""}`).join(" and ");
  return `<div class="visual"><svg width="${x}" height="${h}" viewBox="0 0 ${x} ${h}" role="img" aria-label="${label} dots">${parts.join("")}</svg></div>`;
}

const errorLine = () => (app.error ? `<p class="error" role="alert">${esc(app.error)}</p>` : "");

/* ---------- answer options and feedback, shared by the lesson, the quiz and the placement check ---------- */
const KEYS = "ABCD";
/**
 * The answer buttons. The clean look shows each one's key (A, B, C) and lets a keyboard press it. `tried` are the
 * child's wrong picks, which stay marked; `right` is set once the question is over, to mark the right answer.
 */
function optionButtons(options, attr, { disabled = false, tried = [], right = null } = {}) {
  return `<div class="opts" style="--n:${options.length}">${options.map((o, i) => {
    const isRight = !!right && right.includes(o), isTried = tried.includes(o);
    const note = isRight ? `<span class="opt-note ok">✓ Right</span>` : isTried ? `<span class="opt-note no">✗ ${look() === "play" ? "tried" : "Your try"}</span>` : "";
    return `<button class="btn ${String(o).length > 3 ? "long" : ""} ${isRight ? "right" : isTried ? "tried" : ""}" type="button" ${attr}="${esc(o)}" ${disabled || isTried ? "disabled" : ""}>
    <span class="key" aria-hidden="true">${KEYS[i] ?? ""}</span><span class="opt-val">${esc(o)}</span>${note}</button>`;
  }).join("")}</div>`;
}
const keyHint = n => `<p class="keyhint small muted">Tap an answer, or press ${[...KEYS.slice(0, n)].join(", ").replace(/, ([^,]*)$/, " or $1")}.</p>`;

const ICON_GOOD = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--leaf)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>`;
const ICON_HINT = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--hint-ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/></svg>`;
/**
 * A feedback card: "good" after a right answer, "gentle" with a hint or the worked answer, on a warm yellow card
 * rather than an error colour. The playful look shows the owl's face instead of the icon. `note` is a small line under it.
 */
const feedbackCard = (kind, title, body, note = "") =>
  `<div class="feedback ${kind}" id="fbcard" tabindex="-1"><span class="fb-icon">${kind === "good" ? ICON_GOOD : ICON_HINT}</span><span class="fb-owl">${owl(kind === "good" ? "happy" : "think")}</span><div><b class="fb-title">${title}</b>${body}${note ? `<p class="fb-note">${note}</p>` : ""}</div></div>`;

/* ---------- sign-in ---------- */
function renderSignin() {
  screen.innerHTML = `<div class="narrow">
    <div class="hero">${MASCOT}<h1>Welcome to Nitya</h1><p>Maths practice that grows with your child, one topic at a time.</p></div>
    <p class="muted">Grown-ups sign in here. Children play inside your account, each with their own profile.</p>
    <button class="gbtn" type="button" id="google">${GOOGLE_G}Continue with Google</button>
    <div class="or">or</div>
    <form id="emailform" novalidate>
      <label for="email">Your email</label>
      <input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" value="${esc(app.email ?? "")}">
      <button class="ghost tonal" type="submit">Email me a sign-in link</button>
    </form>
    ${errorLine()}
    <p class="small muted">Before anything about a child is saved, Nitya shows you what it keeps and asks for your OK. <button class="linkbtn" type="button" id="notice">How Nitya uses data</button></p>
    ${DEMO ? `<p class="note">Demo: nobody is really signed in, no email is sent, and everything stays in this browser.</p>` : ""}
  </div>`;
  document.getElementById("google").onclick = () => step(async () => {
    await backend.signInWithGoogle();
    // The real sign-in leaves for Google and comes back to this page; the demo is signed in at once.
    if (DEMO) { account = await backend.account(); await route(); }
  });
  document.getElementById("emailform").onsubmit = e => {
    e.preventDefault();
    const email = document.getElementById("email").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { app.email = email; app.error = "Type your email, like you@example.com."; render(); return; }
    step(async () => { await backend.sendEmailLink(email); show({ mode: "email-sent", email }); });
  };
  document.getElementById("notice").onclick = () => show({ mode: "notice", back: app });
}

function renderEmailSent() {
  screen.innerHTML = `<div class="narrow">
    <div class="hero">${MASCOT}<h1>Check your email</h1><p>We sent a sign-in link to <b>${esc(app.email)}</b>. Open it on this device to come back signed in${app.resetPin ? ", then set a new PIN" : ""}.</p></div>
    ${DEMO ? `<p class="note">Demo: no email was sent. Tap below to carry on as if you opened the link.</p>
      <button class="btn primary wide" type="button" id="open">Open the link</button>` : ""}
    ${errorLine()}
    <button class="ghost" type="button" id="back">${app.resetPin ? "Back" : "Use a different email"}</button>
  </div>`;
  const open = document.getElementById("open");
  if (open) open.onclick = () => step(async () => {
    await backend.openDemoLink();
    account = await backend.account();
    if (app.resetPin) show({ mode: "set-pin", first: null, then: "route", reset: true });
    else await route();
  });
  document.getElementById("back").onclick = () => app.resetPin ? show({ mode: "forgot-pin" }) : show({ mode: "signin", email: app.email });
}

async function signOut() {
  await backend.signOut();
  account = null; child = null; data = null; sum = null; profiles = [];
  show({ mode: "signin" });
}

/* ---------- consent ---------- */
function renderConsent() {
  screen.innerHTML = `<div class="narrow">
    <span class="label">Before we start</span>
    <h1>A grown-up's OK</h1>
    <p>Nitya is for children, so the law (India's DPDP Act, and COPPA) asks a parent to agree before anything about a child is saved.</p>
    <ul class="points">${M.CONSENT_POINTS.map(p => `<li>${esc(p)}</li>`).join("")}</ul>
    <p class="small"><button class="linkbtn" type="button" id="notice">Read the full notice</button></p>
    <label class="check"><input type="checkbox" id="agree" ${app.agreed ? "checked" : ""} aria-describedby="agreeerr"> <span>${esc(M.CONSENT_AGREEMENT)}</span></label>
    <p class="error" id="agreeerr" role="alert">${app.needTick ? "Tick the box to continue." : ""}</p>
    ${errorLine()}
    <div class="row"><button class="btn primary" type="button" id="ok">I agree</button>
      <button class="ghost" type="button" id="signout">Sign out</button></div>
    <p class="small muted">Consent version ${esc(M.CONSENT_VERSION)}. The date you agree is kept with it.</p>
  </div>`;
  const agree = document.getElementById("agree");
  agree.onchange = () => { app.agreed = agree.checked; if (agree.checked && app.needTick) { app.needTick = false; document.getElementById("agreeerr").textContent = ""; } };
  document.getElementById("ok").onclick = () => {
    if (!agree.checked) { app.needTick = true; render(); document.getElementById("agree").focus(); return; }
    step(async () => {
      await backend.giveConsent(M.CONSENT_VERSION);
      account = await backend.account();
      await route();
    });
  };
  document.getElementById("signout").onclick = () => step(signOut);
  document.getElementById("notice").onclick = () => show({ mode: "notice", back: app });
}

function renderNotice() {
  screen.innerHTML = `<div class="narrow">
    <span class="label">Privacy notice</span><h1>How Nitya uses data</h1>
    ${NOTICE.map(([h, text]) => `<section class="notice"><h3>${esc(h)}</h3><p>${esc(text)}</p></section>`).join("")}
    <p class="small muted">Notice version ${esc(M.CONSENT_VERSION)}.</p>
    <div class="row"><button class="btn primary" type="button" id="back">Back</button></div>
  </div>`;
  document.getElementById("back").onclick = () => show(app.back ?? { mode: "signin" });
}

/* ---------- parent PIN ---------- */
let pinLockedUntil = 0, pinWrong = 0, pinTimer = null;

function pinPad(title, text, extra = "") {
  const n = (app.pin || "").length;
  return `<div class="narrow" style="justify-items:center;text-align:center">
    ${gbar()}<h1>${esc(title)}</h1><p>${esc(text)}</p>
    <div class="pin-dots" role="img" aria-label="${n} of 4 digits">${[0, 1, 2, 3].map(i => `<span class="${i < n ? "on" : ""}"></span>`).join("")}</div>
    ${errorLine()}
    <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => `<button class="btn" type="button" data-digit="${d}">${d}</button>`).join("")}
      ${app.cancel ? `<button class="ghost pinside" type="button" id="pincancel">Cancel</button>` : "<span></span>"}
      <button class="btn" type="button" data-digit="0">0</button>
      <button class="btn" type="button" id="pinback" aria-label="Delete a digit">⌫</button></div>
    ${extra}
  </div>`;
}

function wirePinPad(done) {
  const press = d => {
    if ((app.pin || "").length >= 4) return;
    app.pin = (app.pin || "") + d;
    app.error = null;
    if (app.pin.length === 4) { const pin = app.pin; app.pin = ""; done(pin); } else render();
  };
  screen.querySelectorAll("[data-digit]").forEach(b => b.onclick = () => press(b.dataset.digit));
  document.getElementById("pinback").onclick = () => { app.pin = (app.pin || "").slice(0, -1); render(); };
  const cancel = document.getElementById("pincancel");
  if (cancel) cancel.onclick = app.cancel;
  document.onkeydown = e => {
    if (!["pin", "set-pin"].includes(app.mode)) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === "Backspace") { app.pin = (app.pin || "").slice(0, -1); render(); }
  };
}

function renderSetPin() {
  const confirming = app.first !== null;
  screen.innerHTML = pinPad(confirming ? "Type the PIN again" : app.reset ? "Set a new PIN" : "Set a parent PIN",
    confirming ? "Just to be sure." : "4 digits that only grown-ups know. Nitya asks for it before switching children, editing a profile or opening settings.",
    confirming ? `<button class="ghost quiet" type="button" id="again">Start again</button>` : `<p class="small muted">Don't use a birthday or a year.</p>`);
  const again = document.getElementById("again");
  if (again) again.onclick = () => { app.first = null; app.pin = ""; app.error = null; render(); };
  wirePinPad(pin => {
    if (!confirming) {
      const problem = M.pinProblem(pin);
      if (problem) { app.error = problem; render(); return; }
      app.first = pin; render();
    } else if (pin !== app.first) {
      app.first = null; app.error = "Those didn't match. Start again."; render();
    } else {
      step(async () => {
        await backend.setPinHash(await M.hashPin(pin));
        account = await backend.account();
        pinWrong = 0; pinLockedUntil = 0;
        if (app.then === "grownups") show({ mode: "grownups", note: "PIN changed." });
        else await route();
      });
    }
  });
}

/** Asks for the PIN, then runs `then`. */
function askPin(purpose, then) {
  const back = app;
  show({ mode: "pin", purpose, then, cancel: () => show(back) });
}

function renderPin() {
  const wait = Math.ceil((pinLockedUntil - Date.now()) / 1000);
  if (wait > 0) {
    app.error = `Too many tries. Wait ${wait} seconds, or set a new PIN below.`;
    clearTimeout(pinTimer);
    pinTimer = setTimeout(() => { if (app.mode === "pin") { app.error = null; render(); } }, wait * 1000);
  }
  screen.innerHTML = pinPad("Parent PIN", app.purpose, `<button class="linkbtn" type="button" id="forgot">Forgot the PIN?</button>`);
  document.getElementById("forgot").onclick = () => show({ mode: "forgot-pin", back: app });
  wirePinPad(pin => step(async () => {
    if (Date.now() < pinLockedUntil) { render(); return; }
    if (await M.verifyPin(pin, account.pinHash)) { pinWrong = 0; app.then(); return; }
    pinWrong++;
    if (pinWrong >= M.PIN_TRIES) { pinWrong = 0; pinLockedUntil = Date.now() + M.PIN_WAIT_SECONDS * 1000; }
    app.error = "That isn't the PIN. Try again.";
    render();
  }));
}

function renderForgotPin() {
  const email = account?.email ?? "";
  const masked = email.replace(/^(.)[^@]*(@.*)$/, "$1•••$2");
  screen.innerHTML = `<div class="narrow">
    ${gbar()}<h1>Forgot the PIN?</h1>
    <p>Sign in again to show it's you, then set a new PIN. Your children's progress stays as it is.</p>
    <button class="gbtn" type="button" id="google">${GOOGLE_G}Continue with Google</button>
    ${email ? `<button class="ghost tonal" type="button" id="emailme">Email a link to ${esc(masked)}</button>` : ""}
    ${errorLine()}
    <div class="row account"><button class="ghost quiet" type="button" id="cancel">Back</button>
      <button class="ghost quiet" type="button" id="signout">${ICONS.out}Sign out</button></div>
  </div>`;
  document.getElementById("google").onclick = () => step(async () => {
    await backend.signInWithGoogle();
    if (DEMO) show({ mode: "set-pin", first: null, then: "route", reset: true });
  });
  const em = document.getElementById("emailme");
  if (em) em.onclick = () => step(async () => { await backend.sendEmailLink(email); show({ mode: "email-sent", email, resetPin: true }); });
  document.getElementById("cancel").onclick = () => show(app.back && app.back.mode !== "forgot-pin" ? { ...app.back, error: null } : { mode: "signin" });
  document.getElementById("signout").onclick = () => step(signOut);
}

/* ---------- choosing a child ---------- */
function renderProfiles() {
  screen.innerHTML = `<div class="narrow" style="max-width:720px">
    ${gbar()}<h1>Who's learning now?</h1>
    <div class="kids">${profiles.map(p => `<button class="btn kid-btn" type="button" data-kid="${p.id}">
      <span class="emoji" aria-hidden="true">${M.avatarEmoji(p.avatar)}</span>${esc(p.nickname)}<small class="muted small">${esc(className(p.classId))}</small></button>`).join("")}</div>
    ${errorLine()}
    <div class="row"><button class="ghost addkid" type="button" id="add">${ICONS.plus}Add a child</button></div>
    <div class="row account"><button class="ghost quiet" type="button" id="grownups">${ICONS.settings}Grown-ups</button>
      ${app.confirmOut
        ? `<span class="row"><span class="small">Sign out?</span><button class="ghost quiet danger sure" type="button" id="signout">Sign out</button><button class="ghost quiet" type="button" id="nosignout">Cancel</button></span>`
        : `<button class="ghost quiet" type="button" id="signout">${ICONS.out}Sign out</button>`}</div>
  </div>`;
  screen.querySelectorAll("[data-kid]").forEach(b => b.onclick = () => step(() => openProfile(profiles.find(p => p.id === b.dataset.kid))));
  document.getElementById("add").onclick = () => askPin("To add a child.", startOnboarding);
  document.getElementById("grownups").onclick = () => askPin("To open the grown-ups' page.", () => show({ mode: "grownups" }));
  document.getElementById("signout").onclick = () => app.confirmOut ? step(signOut) : (app.confirmOut = true, render());
  const no = document.getElementById("nosignout");
  if (no) no.onclick = () => { app.confirmOut = false; render(); };
}

/* ---------- onboarding ---------- */
const ONBOARD_STEPS = ["nickname", "avatar", "class", "board", "language"];

function startOnboarding(editing) {
  const draft = editing
    ? { nickname: editing.nickname, avatar: editing.avatar, classId: editing.classId, board: editing.board, language: editing.language }
    : { nickname: "", avatar: null, classId: null, board: null, language: null };
  show({ mode: "onboard", step: 0, draft, editing: editing ? editing.id : null, back: app });
}

function choiceButtons(field, items, cls = "") {
  return `<div class="choices ${cls}">${items.map(i => `<button class="btn ${app.draft[field] === i.id ? "on" : ""}" type="button" data-choose="${esc(i.id)}"
    aria-pressed="${app.draft[field] === i.id}" ${i.lang ? `lang="${i.lang}"` : ""}>${i.emoji ? `<span class="emoji" aria-hidden="true">${i.emoji}</span><small>${esc(i.name)}</small>` : esc(i.name)}${i.sub ? `<small class="sub" lang="en">${esc(i.sub)}</small>` : ""}</button>`).join("")}</div>`;
}

function renderOnboard() {
  const d = app.draft, field = ONBOARD_STEPS[app.step];
  const nick = esc(d.nickname || "your child");
  const steps = `<div class="stepline"><span class="small muted">Step ${app.step + 1} of ${ONBOARD_STEPS.length}</span>
    <div class="steps" aria-hidden="true">${ONBOARD_STEPS.map((_, i) => `<span class="${i <= app.step ? "on" : ""}"></span>`).join("")}</div></div>`;
  let body;
  if (field === "nickname") {
    body = `<h1>${app.editing ? "Edit the profile" : "Add a child"}</h1>
      <form id="nickform" novalidate><label for="nick">What should Nitya call your child?</label>
        <input id="nick" type="text" autocomplete="off" maxlength="20" value="${esc(d.nickname)}" placeholder="e.g. Riya" aria-describedby="nickhelp">
        <p class="small muted" id="nickhelp">A nickname, not the full name. Letters only.</p>
        ${errorLine()}
        <button class="btn primary" type="submit">Next</button></form>`;
  } else if (field === "avatar") {
    body = `<h1>Choose an avatar for ${nick}</h1>${choiceButtons("avatar", M.AVATARS, "avatars")}`;
  } else if (field === "class") {
    const only = M.CLASSES_WITH_CONTENT.length === 1;
    const classes = M.CLASSES_WITH_CONTENT.map(c => ({ id: c, name: className(c), sub: only ? "The only class so far" : "" }));
    body = `<h1>Which class is ${nick} in?</h1>${choiceButtons("classId", classes)}<p class="small muted">More classes are on the way.</p>`;
  } else if (field === "board") {
    body = `<h1>Which board does ${nick}'s school follow?</h1>${choiceButtons("board", M.BOARDS)}`;
  } else {
    const langs = M.LANGUAGES.map(l => ({ ...l, lang: l.id === "en" ? "" : l.id, sub: l.id === "en" ? "" : "Coming soon: questions stay in English for now" }));
    body = `<h1>Language for ${nick}'s questions and voice</h1>${choiceButtons("language", langs)}`;
  }
  screen.innerHTML = `<div class="narrow">${gbar()}${steps}${body}${field !== "nickname" ? errorLine() : ""}
    <div class="row"><button class="ghost" type="button" id="obback">${app.step === 0 ? "Cancel" : "Back"}</button></div></div>`;

  const form = document.getElementById("nickform");
  if (form) {
    const input = document.getElementById("nick");
    input.focus();
    form.onsubmit = e => {
      e.preventDefault();
      const problem = M.nicknameProblem(input.value);
      d.nickname = input.value.trim();
      if (problem) { app.error = problem; render(); return; }
      app.error = null; app.step++; render();
    };
  }
  screen.querySelectorAll("[data-choose]").forEach(b => b.onclick = () => {
    d[field === "class" ? "classId" : field] = b.dataset.choose;
    app.error = null;
    const go = () => { if (app.step < ONBOARD_STEPS.length - 1) { app.step++; render(); } else finishOnboarding(); };
    // The chosen avatar stays ringed for a moment, so the grown-up sees what they picked.
    if (field === "avatar") { render(); setTimeout(() => { if (app.mode === "onboard" && ONBOARD_STEPS[app.step] === "avatar") go(); }, 300); } else go();
  });
  const back = document.getElementById("obback");
  back.hidden = app.step === 0 && !app.editing && !profiles.length;
  back.onclick = () => {
    app.error = null;
    if (app.step > 0) { app.step--; render(); } else show(app.back.mode === "pin" || app.back.mode === "loading" ? { mode: "profiles" } : app.back);
  };
}

function finishOnboarding() {
  const problems = M.profileProblems(app.draft, M.CLASSES_WITH_CONTENT);
  if (problems.length) { app.error = problems.join(" "); render(); return; }
  if (app.editing) {
    step(async () => {
      const updated = await backend.updateProfile(app.editing, app.draft);
      profiles = profiles.map(p => (p.id === updated.id ? updated : p));
      if (child && child.id === updated.id) { child = updated; refresh(); }
      show({ mode: "grownups", note: `${updated.nickname}'s profile is saved.` });
    });
    return;
  }
  show({ mode: "placement-offer", draft: app.draft });
}

async function createChild(draft) {
  const p = await backend.createProfile(draft);
  profiles.push(p);
  await openProfile(p);
}

/* ---------- placement check ---------- */
function renderPlacementOffer() {
  const d = app.draft;
  screen.innerHTML = `<div class="narrow">
    <div class="mascot">${MASCOT}<div class="bubble"><h2>A quick check?</h2>
      <p>${esc(d.nickname)} can answer ${M.PLACEMENT_LENGTH} questions, about 5 minutes, and Nitya will suggest the best class to start in. You can skip it.</p></div></div>
    ${errorLine()}
    <div class="row actions"><button class="btn primary" type="button" id="check">Start the check</button>
      <button class="ghost" type="button" id="skip">Skip and start in ${esc(className(d.classId))}</button></div></div>`;
  document.getElementById("check").onclick = () => {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    show({ mode: "placement", draft: d, qs: M.placementQuestions(d.classId, M.ALL_CONTENT, seed), i: 0, results: [] });
  };
  document.getElementById("skip").onclick = () => step(() => createChild(d));
}

function renderPlacement() {
  const q = app.qs[app.i];
  screen.innerHTML = `
    <div class="qtop"><div class="qtitle"><span class="muted small">Quick check</span><b>Question ${app.i + 1} of ${app.qs.length}</b></div>
      <button class="ghost iconbtn" type="button" id="stop" aria-label="Stop the check">${ICONS.close}<span class="lbl">Stop</span></button></div>
    ${app.confirmStop ? stopCard("Stop the check?", "Nothing from the check is saved. You can start it again.", "Stop the check") : ""}
    <div class="qprog" role="progressbar" aria-label="Questions done" aria-valuemin="0" aria-valuemax="${app.qs.length}" aria-valuenow="${app.i}">${app.qs.map((_, i) => `<span class="${i < app.i ? "done" : i === app.i ? "now" : ""}"></span>`).join("")}</div>
    <div class="mascot">${MASCOT}<div class="bubble"><p class="prompt" tabindex="-1">${promptHtml(q.prompt)}</p>${sayBtn(q.prompt)}</div></div>
    ${dotsSvg(q.visual)}
    ${optionButtons(q.options, "data-opt")}
    <p class="small muted">No marks here. Just do your best!</p>`;
  autoSay(`placement${app.i}`, q.prompt);
  screen.querySelectorAll("[data-opt]").forEach(b => b.onclick = () => {
    app.results.push(M.checkAnswer(q, b.dataset.opt));
    app.confirmStop = false;
    if (++app.i < app.qs.length) render();
    else show({ mode: "placement-result", draft: app.draft, suggestion: M.placementSuggestion(app.draft.classId, app.draft.nickname, app.results, M.CLASSES_WITH_CONTENT) });
  });
  document.getElementById("stop").onclick = () => { app.confirmStop = true; render(); };
  wireStopCard(() => show({ mode: "placement-offer", draft: app.draft }));
}

function renderPlacementResult() {
  const { draft: d, suggestion: s } = app;
  const differs = s.suggested !== d.classId;
  screen.innerHTML = `<div class="narrow">
    <div class="mascot">${owl("happy")}<div class="bubble"><h2>All done!</h2><p>${esc(s.message)}</p></div></div>
    <p class="muted">${differs ? "Grown-up, please choose the class to start in." : `${esc(d.nickname)} will start in ${esc(className(s.suggested))}.`} You can change it later in Grown-ups.</p>
    ${errorLine()}
    <div class="row actions"><button class="btn primary" type="button" id="use">Start in ${esc(className(s.suggested))}</button>
      ${differs ? `<button class="ghost" type="button" id="keep">Keep ${esc(className(d.classId))}</button>` : ""}</div></div>`;
  document.getElementById("use").onclick = () => step(() => createChild({ ...d, classId: s.suggested }));
  const keep = document.getElementById("keep");
  if (keep) keep.onclick = () => step(() => createChild(d));
}

/* ---------- grown-ups ---------- */
const icon = d => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  settings: icon(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
  edit: icon(`<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>`),
  download: icon(`<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>`),
  trash: icon(`<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>`),
  plus: icon(`<path d="M12 5v14M5 12h14"/>`),
  lock: icon(`<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>`),
  out: icon(`<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4"/><path d="M6 12h10"/>`),
  arrow: icon(`<path d="M5 12h14M13 6l6 6-6 6"/>`),
  close: icon(`<path d="M6 6l12 12M18 6L6 18"/>`),
  book: icon(`<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>`),
  chev: icon(`<path d="M9 6l6 6-6 6"/>`),
  chart: icon(`<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>`),
};
const GOOGLE_G = `<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
const FLAG = `<svg width="18" height="18" viewBox="0 0 24 24" aria-label="Pass mark" role="img"><path d="M6 21V4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M6 4h12l-3 4 3 4H6z" fill="currentColor"/></svg>`;
const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
// A quiz in progress is kept on this device after every answer, so Stop, a reload or the back button can carry on later.
const QUIZ_KEY = id => `nitya-quiz-${id}`;
const boardName = id => M.BOARDS.find(b => b.id === id)?.name ?? id;
const languageName = id => M.LANGUAGES.find(l => l.id === id)?.name ?? id;
const starText = n => `${n} ${n === 1 ? "star" : "stars"}`;
/** The strip on every grown-up screen, so it is clear the child has left their own screens. */
const gbar = () => `<div class="gbar">${ICONS.lock}<span>Grown-ups area</span></div>`;
/** "Stop now?" with Keep going as the safe, first choice. */
const stopCard = (title, text, stopLabel) => `<div class="confirm" role="alertdialog" aria-labelledby="stoph" aria-describedby="stopp">
    <b id="stoph">${esc(title)}</b><p id="stopp" class="small">${esc(text)}</p>
    <div class="row"><button class="btn primary" type="button" id="keepon">Keep going</button><button class="ghost" type="button" id="stopnow">${esc(stopLabel)}</button></div></div>`;
function wireStopCard(stop) {
  const keep = document.getElementById("keepon");
  if (!keep) return;
  keep.onclick = () => { app.confirmStop = false; render(); };
  document.getElementById("stopnow").onclick = () => { app.confirmStop = false; stop(); };
}
// What the full privacy notice says. The grievance contact is a placeholder until Nitya names one before launch.
const NOTICE = [
  ["What Nitya keeps", "For each child you add: a nickname (not the full name), an avatar, their class, board and language, and their quiz answers, marks and progress. For you: your email address, the date you agreed, and a scrambled copy of your PIN."],
  ["Why", "To pick the right next question for each child, to unlock topics in order, and to show you their progress. Nothing else."],
  ["Where it is kept", "In Nitya's own database in Mumbai, India, so it comes back when you sign in on another device. It is never sold, shared or used for ads, and Nitya has no trackers, chat or links out of the app."],
  ["How long", "Until you delete it. Deleting a child in Grown-ups removes their profile and progress at once."],
  ["Your rights", "You can see and download a child's data at any time (Grown-ups, then Settings), correct it (Edit profile), and delete it. You can withdraw consent at any time: delete each child, then sign out, and Nitya stops keeping anything new."],
  ["Questions or complaints", "Write to Nitya's grievance officer. Their name and email are added here before Nitya launches."],
];

function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderGrownups() {
  if (!app.sums) loadFamily();
  screen.innerHTML = `<div class="narrow">
    ${gbar()}<h1>Your family</h1>
    ${account.email ? `<p class="muted">Signed in as ${esc(account.email)}</p>` : ""}
    ${app.note ? `<p class="note" role="status">${esc(app.note)}</p>` : ""}
    ${errorLine()}
    <div class="family">${profiles.map(p => `<div class="member">
      <span class="emoji" aria-hidden="true">${M.avatarEmoji(p.avatar)}</span>
      <div><b>${esc(p.nickname)}</b><div class="small muted">${esc(className(p.classId))} · ${esc(boardName(p.board))} · <span ${p.language === "en" ? "" : `lang="${esc(p.language)}"`}>${esc(languageName(p.language))}</span></div>
        <div class="small sumline">${esc(app.sums?.[p.id] ?? "…")}</div></div>
      <div class="row">
        <button class="ghost tonal" type="button" data-progress="${p.id}">${ICONS.chart}Progress</button>
        <button class="ghost" type="button" data-settings="${p.id}">${ICONS.settings}Settings</button>
      </div></div>`).join("")}
      <button class="ghost addkid" type="button" id="add">${ICONS.plus}Add a child</button></div>
    ${account.isAdmin
      ? `<div class="panel"><span class="label">Admin</span><p class="small muted">Check questions that failed a check, set each class's default pass mark and marks off, and set the level bands.</p>
          <div class="row"><button class="ghost tonal" type="button" id="admin">Open the admin panel${ICONS.arrow}</button></div></div>`
      : DEMO ? `<div class="panel"><span class="label">Admin (demo)</span><p class="small muted">In the real app only Nitya's admin sees the admin panel. In the demo you can try it.</p>
          <div class="row"><button class="ghost tonal" type="button" id="demoadmin">Make me the admin${ICONS.arrow}</button></div></div>` : ""}
    <div class="row account"><button class="ghost quiet" type="button" id="pin">${ICONS.lock}Change the PIN</button>
      <button class="ghost quiet" type="button" id="signout">${ICONS.out}Sign out</button></div>
    <div class="row"><button class="btn primary" type="button" id="done">${child ? `Back to ${esc(child.nickname)}` : "Choose a child"}</button></div>
  </div>`;
  screen.querySelectorAll("[data-settings]").forEach(b => b.onclick = () => openChildSettings(b.dataset.settings));
  screen.querySelectorAll("[data-progress]").forEach(b => b.onclick = () => openProgress(b.dataset.progress));
  const adminBtn = document.getElementById("admin");
  if (adminBtn) adminBtn.onclick = () => openAdmin("queue");
  const demoAdmin = document.getElementById("demoadmin");
  if (demoAdmin) demoAdmin.onclick = () => step(async () => {
    await backend.setDemoAdmin(true);
    account = await backend.account();
    await openAdmin("queue");
  });
  document.getElementById("add").onclick = () => startOnboarding();
  document.getElementById("pin").onclick = () => show({ mode: "set-pin", first: null, then: "grownups", cancel: () => show({ mode: "grownups" }) });
  document.getElementById("signout").onclick = () => step(signOut);
  // Reloading the child picks up quiz settings and questions changed here or in the admin panel.
  document.getElementById("done").onclick = () => step(async () => {
    if (!child) return show({ mode: "profiles" });
    await saving;
    await openProfile(profiles.find(p => p.id === child.id) ?? child);
  });
}

async function loadFamily() {
  app.sums = {};
  const here = app;
  try {
    const all = await Promise.all(profiles.map(p => backend.profileData(p.id)));
    profiles.forEach((p, i) => { here.sums[p.id] = familyLine(p, all[i]); });
  } catch (e) { return; }
  if (app === here) render();
}

function familyLine(p, d) {
  const total = M.contentForClass(p.classId).length;
  const cleared = d.topics.filter(t => t.state === "cleared").length;
  return `${cleared} of ${total} topics cleared · ${playedText(lastPlayed(d))}`;
}

function lastPlayed(d) {
  return d.attempts.reduce((a, x) => (!a || x.startedAt > a ? x.startedAt : a), null);
}

function playedText(iso) {
  if (!iso) return "not played yet";
  const day = s => new Date(s).toDateString();
  if (day(iso) === day(Date.now())) return "played today";
  if (day(iso) === day(Date.now() - 864e5)) return "played yesterday";
  return `played on ${new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;
}

async function openProgress(profileId) {
  await step(async () => {
    const p = profiles.find(x => x.id === profileId);
    const [d, classes, mine] = await Promise.all([backend.profileData(p.id), backend.classSettings(), backend.childSettings(p.id)]);
    const topics = M.contentForClass(p.classId).map(c => c.topic);
    const pass = M.effectiveSettings(classDefaults(classes, p.classId), mine).passMarks;
    show({ mode: "child-progress", profile: p, data: d, sum: M.summarize(p.classId, topics, d), passMarks: pass });
  });
}

function renderChildProgress() {
  const p = app.profile, s = app.sum, d = app.data, name = esc(p.nickname);
  const MAX = M.maxMarks(p.classId);
  const topics = M.contentForClass(p.classId).map(c => c.topic);
  const rows = topics.map((t, i) => {
    const e = s.progress.topics[t.id], stars = s.stars[t.id] || 0;
    const chip = e.state === "cleared" ? `<span class="chip cleared">Cleared</span>` : e.state === "current" ? `<span class="chip current">Up next</span>` : `<span class="chip">Locked</span>`;
    const meta = e.attempts ? `Best ${e.bestScore} / ${MAX} · ${e.attempts} ${e.attempts === 1 ? "try" : "tries"}${stars ? ` · ${starText(stars)}` : ""}` : e.state === "locked" ? `Opens after topic ${i}` : "Not started";
    return `<div class="prow"><div><div class="row" style="gap:8px"><b>${esc(t.title)}</b>${chip}</div><div class="small muted">${esc(meta)}</div></div>
      ${e.state === "locked" ? "" : `<button class="ghost quiet" type="button" data-newq="${t.id}" ${newqBusy ? "disabled" : ""}>${newqBusy === t.id ? "Making questions…" : "Get new questions"}</button>`}</div>`;
  }).join("");
  const areas = weakAreas(s).map(a => `<div class="area"><div><b>${esc(byId(a.tid).subSkillNames[a.skill] || a.skill)}</b><div class="small muted">${esc(byId(a.tid).topic.title)} · ${Math.round(a.acc * 100)}% right</div></div>
      <span class="mini" aria-hidden="true"><b style="width:${a.acc * 100}%"></b></span></div>`).join("");
  const lost = d.responses.reduce((a, r) => a + (r.marksDelta < 0 ? -r.marksDelta : 0), 0);
  const recent = [...d.attempts].filter(a => a.finishedAt).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 6);
  screen.innerHTML = `<div class="narrow">
    ${gbar()}<h1>${name}'s progress</h1>
    <p class="muted">${esc(className(p.classId))} · ${esc(familyLine(p, d))}. Each quiz needs ${app.passMarks} of ${MAX} marks.</p>
    ${app.newqNote ? `<p class="note" role="status">${esc(app.newqNote)}</p>` : ""}
    <section class="setting"><h3>Topics</h3>${rows}
      <p class="small muted">"Get new questions" adds fresh questions to a topic ${name} has seen a lot of. Families can ask ${M.NEW_QUESTIONS_PER_DAY} times a day.</p></section>
    <section class="setting"><h3>Improvement areas</h3>${areas || `<p class="small muted">Nothing to work on yet. Skills under 80% right show up here after a quiz.</p>`}</section>
    <section class="setting"><h3>Right first time, by level</h3>${levelRows(s)}</section>
    <section class="setting"><h3>Recent quizzes</h3>
      ${recent.length ? `<div class="log">${recent.map(a => `<div><span>${esc(new Date(a.startedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" }))}</span><span>${esc(topicTitle(a.topicId))}</span>
        <span>${a.practice ? "Practice" : `${a.marks} / ${MAX}`}</span><span>${a.practice ? "" : a.cleared ? "Cleared" : "Not yet"}</span></div>`).join("")}</div>` : `<p class="small muted">No quizzes yet.</p>`}
      <p class="small muted">Marks lost to wrong first tries: ${lost}.</p></section>
    <div class="row"><button class="btn primary" type="button" id="done">Back to Grown-ups</button></div>
  </div>`;
  screen.querySelectorAll("[data-newq]").forEach(b => b.onclick = async () => {
    await askNewQuestions(b.dataset.newq, p.id);
    if (app.mode === "child-progress") render();
  });
  document.getElementById("done").onclick = () => show({ mode: "grownups" });
}

function weakAreas(s) {
  return Object.entries(s.skills)
    .map(([k, v]) => { const [tid, skill] = k.split("|"); return { tid, skill, acc: v.right / v.total, total: v.total }; })
    .filter(a => a.total >= 2 && a.acc < 0.8 && s.progress.topics[a.tid])
    .sort((a, b) => a.acc - b.acc)
    .slice(0, 4);
}

function levelRows(s) {
  return [1, 2, 3, 4].map(l => {
    const v = s.levels[l];
    const pct = v && v.total ? Math.round((v.right / v.total) * 100) : null;
    return `<div class="lvlrow"><span>L${l} ${LEVEL_NAMES[l]}</span><span class="mini" aria-hidden="true"><b style="width:${pct ?? 0}%"></b></span><span>${pct === null ? "–" : pct + "%"}</span></div>`;
  }).join("");
}

/* ---------- a child's quiz settings (grown-ups) ---------- */
async function openChildSettings(profileId) {
  await step(async () => {
    const [classes, mine] = await Promise.all([backend.classSettings(), backend.childSettings(profileId)]);
    show({ mode: "child-settings", profile: profiles.find(p => p.id === profileId), classes, mine });
  });
}

const numberField = (id, label, value) =>
  `<label><span>${label}</span><input type="number" inputmode="numeric" id="${id}" value="${value}"></label>`;

function renderChildSettings() {
  const p = app.profile, name = esc(p.nickname), cls = esc(className(p.classId));
  const def = classDefaults(app.classes, p.classId);
  const eff = M.effectiveSettings(def, app.mine);
  const MAX = M.maxMarks(p.classId);
  const percent = app.mine.passPercent ?? def.passPercent;
  const byClass = M.classLook(p.classId), shown = M.lookFor(p.classId, app.mine.look);
  const looks = [
    [null, `Follow the class: ${LOOK_NAMES[byClass].toLowerCase()} for ${cls}`, "Playful up to Class 5, clean from Class 6.", byClass],
    ["play", LOOK_NAMES.play, "Bright colours, big buttons and the owl.", "play"],
    ["focus", LOOK_NAMES.focus, "Calm colours, simple cards and A/B/C answers.", "focus"],
  ];
  // The pass mark: the class default, two common choices, or any other number.
  const presets = [[null, "Default", `${def.passPercent}%`], [50, "Gentler", "50%"], [80, "Stretch", "80%"]].filter(([v]) => v !== def.passPercent);
  const custom = app.customPass || (app.mine.passPercent !== null && !presets.some(([v]) => v === app.mine.passPercent));
  const passOn = v => !custom && app.mine.passPercent === v;
  const warn = percent < 40 ? `That's very low: ${name} would clear a topic with only ${eff.passMarks} marks.` : percent > 90 ? "That's very high: one or two wrong first tries could mean not passing." : "";
  const voice = voiceChoice(p) ?? (shown === "play" ? "on" : "off");
  const seg = (attr, value, on, label, sub = "") => `<button class="ghost ${on ? "on" : ""}" type="button" ${attr}="${value}" aria-pressed="${on}">${label}${sub ? `<small>${sub}</small>` : ""}</button>`;
  screen.innerHTML = `<div class="narrow">
    ${gbar()}<h1>Settings for ${name}</h1>
    <section class="setting">
      <h3>Profile</h3>
      <div class="row" style="justify-content:space-between"><span class="muted">${name} · ${cls} · ${esc(boardName(p.board))} · <span ${p.language === "en" ? "" : `lang="${esc(p.language)}"`}>${esc(languageName(p.language))}</span></span>
        <button class="ghost" type="button" data-edit="${p.id}">${ICONS.edit}Edit profile</button></div>
    </section>
    <section class="setting">
      <div class="row" style="justify-content:space-between"><h3>${name}'s quizzes</h3>${app.mine.passPercent !== null || app.mine.wrongPenalty !== null ? `<span class="chip current">Changed</span>` : ""}</div>
      <p class="small muted">These apply to every topic, from the next quiz. Higher pushes further; lower makes it easier.</p>
      <span class="sublabel">Pass mark</span>
      <div class="segctl" role="group" aria-label="Pass mark">${presets.map(([v, label, sub]) => seg("data-pass", v ?? "default", passOn(v), label, sub)).join("")}${seg("data-pass", "custom", custom, "Custom", custom ? `${percent}%` : "")}</div>
      ${custom ? `<div class="row"><label class="inline" for="my-pass">Pass mark, in %</label><input type="number" inputmode="numeric" id="my-pass" value="${percent}" min="1" max="100">
        <button class="ghost tonal" type="button" id="savepass">Save</button></div>` : ""}
      <span class="sublabel">Marks off for a wrong first try</span>
      <div class="segctl" role="group" aria-label="Marks off for a wrong first try">${[0, 1, 2, 3, 4].map(v => seg("data-pen", v, eff.wrongPenalty === v, v === 0 ? "None" : String(v), v === def.wrongPenalty ? "default" : "")).join("")}</div>
      <p class="live" aria-live="polite">${name} needs <b>${eff.passMarks} of ${MAX}</b> marks (${percent}%) to clear a topic, and a wrong first try takes away ${eff.wrongPenalty}.</p>
      ${warn ? `<p class="warn">${warn}</p>` : ""}
      ${app.note ? `<p class="note" role="status">${esc(app.note)}</p>` : ""}
      ${errorLine()}
    </section>
    <section class="setting">
      <h3>How Nitya looks for ${name}</h3>
      <div class="looks" role="group" aria-label="Look">${looks.map(([id, title, text, swatch]) => `
        <button class="ghost ${app.mine.look === id ? "on" : ""}" type="button" data-pick-look="${id ?? ""}" aria-pressed="${app.mine.look === id}">
          <span class="swatch ${swatch}" aria-hidden="true"></span><span><span>${esc(title)}</span><small>${esc(text)}</small></span></button>`).join("")}</div>
      ${app.lookNote ? `<p class="note" role="status">${esc(app.lookNote)}</p>` : ""}
    </section>
    <section class="setting">
      <h3>Voice and sounds</h3>
      <p class="small muted">Reads lessons, questions, hints and praise aloud, with a short sound for right and wrong. On for the playful look unless you turn it off. Kept on this device.</p>
      <div class="segctl" role="group" aria-label="Voice and sounds">${seg("data-voice", "on", voice === "on", "On")}${seg("data-voice", "off", voice === "off", "Off")}</div>
    </section>
    <section class="setting">
      <h3>${name}'s data</h3>
      <p class="small muted">Everything Nitya keeps for ${name}, as a file you can keep.</p>
      <div class="row"><button class="ghost" type="button" data-download="${p.id}">${ICONS.download}Download ${name}'s data</button></div>
      ${app.exported ? dataSummary(app.exported, MAX) : ""}
    </section>
    <section class="setting danger-zone">
      <h3>Remove ${name}</h3>
      ${app.confirmDelete ? `
        <p><b>Delete ${name}?</b> This removes ${name}'s profile, quiz results and progress from Nitya's database. It can't be undone.</p>
        <div class="row"><button class="ghost" type="button" data-download="${p.id}">${ICONS.download}Download ${name}'s data first</button></div>
        <label for="confirmname">Type ${name} to confirm</label>
        <input id="confirmname" type="text" autocomplete="off" value="">
        <div class="row"><button class="ghost danger sure" type="button" id="reallydelete" disabled>${ICONS.trash}Delete ${name}</button>
          <button class="ghost quiet" type="button" id="nodelete">Cancel</button></div>`
        : `<p class="small muted">Deletes ${name}'s profile and progress for good.</p>
        <div class="row"><button class="ghost quiet danger" type="button" data-delete="${p.id}">${ICONS.trash}Remove ${name}…</button></div>`}
    </section>
    <div class="row"><button class="btn primary" type="button" id="done">Back to Grown-ups</button></div>
  </div>`;
  screen.querySelectorAll("[data-pick-look]").forEach(b => b.onclick = () => saveLook(b.dataset.pickLook || null));
  screen.querySelectorAll("[data-pass]").forEach(b => b.onclick = () => {
    const v = b.dataset.pass;
    if (v === "custom") { app.customPass = true; app.note = null; render(); document.getElementById("my-pass")?.focus(); return; }
    app.customPass = false;
    saveMine(def, { passPercent: v === "default" ? null : Number(v), wrongPenalty: app.mine.wrongPenalty });
  });
  const savePass = () => saveMine(def, { passPercent: Number(document.getElementById("my-pass").value), wrongPenalty: app.mine.wrongPenalty });
  const sp = document.getElementById("savepass");
  if (sp) {
    sp.onclick = savePass;
    document.getElementById("my-pass").onkeydown = e => { if (e.key === "Enter") savePass(); };
  }
  screen.querySelectorAll("[data-pen]").forEach(b => b.onclick = () => saveMine(def, { passPercent: app.mine.passPercent, wrongPenalty: Number(b.dataset.pen) }));
  screen.querySelectorAll("[data-voice]").forEach(b => b.onclick = () => {
    try { storage.setItem(VOICE_KEY(p.id), b.dataset.voice); } catch (e) {}
    render();
  });
  screen.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => startOnboarding(p));
  screen.querySelectorAll("[data-download]").forEach(b => b.onclick = () => step(async () => {
    const value = { exportedAt: new Date().toISOString(), profile: p, ...(await backend.profileData(p.id)), quizSettings: await backend.childSettings(p.id) };
    try { download(`nitya-${p.nickname}.json`, value); } catch (e) {}
    show({ ...app, exported: { name: p.nickname, value }, note: null, error: null });
  }));
  const del = screen.querySelector("[data-delete]");
  if (del) del.onclick = () => { app.confirmDelete = true; render(); document.getElementById("confirmname").focus(); };
  const typed = document.getElementById("confirmname");
  if (typed) {
    const really = document.getElementById("reallydelete");
    typed.oninput = () => { really.disabled = typed.value.trim().toLowerCase() !== p.nickname.toLowerCase(); };
    really.onclick = () => step(async () => {
      await backend.deleteProfile(p.id);
      profiles = profiles.filter(x => x.id !== p.id);
      if (child && child.id === p.id) { child = null; data = null; sum = null; }
      if (!profiles.length) { startOnboarding(); return; }
      show({ mode: "grownups", note: `${p.nickname}'s profile and progress are deleted.` });
    });
    document.getElementById("nodelete").onclick = () => { app.confirmDelete = false; render(); };
  }
  document.getElementById("done").onclick = () => show({ mode: "grownups" });
}

function dataSummary(exp, MAX) {
  const v = exp.value, p = v.profile;
  const done = v.attempts.filter(a => a.finishedAt);
  return `<div class="datasum" role="status">
    <p class="small">Downloaded <b>nitya-${esc(exp.name)}.json</b>. Here is what it holds:</p>
    <ul class="points small"><li>Profile: ${esc(p.nickname)}, ${esc(className(p.classId))}, ${esc(boardName(p.board))}, ${esc(languageName(p.language))}, avatar ${esc(p.avatar)}</li>
      <li>${done.length} ${done.length === 1 ? "quiz" : "quizzes"} and ${v.responses.length} answers</li>
      <li>Quiz settings: ${v.quizSettings.passPercent === null ? "class default pass mark" : `${v.quizSettings.passPercent}% to pass`}, ${v.quizSettings.wrongPenalty === null ? "class default marks off" : `${v.quizSettings.wrongPenalty} off for a wrong first try`}</li></ul>
    ${done.length ? `<div class="log">${done.slice(-8).reverse().map(a => `<div><span>${esc(new Date(a.startedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" }))}</span><span>${esc(topicTitle(a.topicId))}</span>
      <span>${a.practice ? "Practice" : `${a.marks} / ${MAX}`}</span><span>${a.practice ? "" : a.cleared ? "Cleared" : "Not yet"}</span></div>`).join("")}</div>` : ""}
    <details><summary>Show the raw file</summary><pre class="data">${esc(JSON.stringify(v, null, 2))}</pre></details>
    <div class="row"><button class="ghost quiet" type="button" onclick="window.print()">Print this</button></div>
  </div>`;
}

function saveMine(def, choice) {
  const next = { ...choice, look: app.mine.look };
  // The default, chosen again, is kept as "the default", so it follows the admin's.
  if (next.passPercent === def.passPercent) next.passPercent = null;
  if (next.wrongPenalty === def.wrongPenalty) next.wrongPenalty = null;
  const problem = M.childSettingsProblem(next);
  if (problem) { app.error = problem; app.note = null; render(); return; }
  const profileId = app.profile.id;
  step(async () => {
    await backend.saveChildSettings(profileId, next);
    app.mine = next;
    if (child && child.id === profileId) settings.child = next;
    if (next.passPercent === null || [50, 80].includes(next.passPercent)) app.customPass = false;
    app.note = next.passPercent === null && next.wrongPenalty === null ? `Saved. ${app.profile.nickname} uses the class default.` : "Saved.";
    app.error = null;
    app.lookNote = null;
    render();
  });
}

const LOOK_NAMES = { play: "Playful", focus: "Clean" };

/** Saves the look for the child on this page; null lets the class decide. */
function saveLook(choice) {
  const p = app.profile;
  const next = { ...app.mine, look: choice };
  step(async () => {
    await backend.saveChildSettings(p.id, next);
    app.mine = next;
    if (child && child.id === p.id) settings.child = next;
    const shown = M.lookFor(p.classId, choice);
    app.lookNote = `Saved. ${p.nickname} sees the ${LOOK_NAMES[shown].toLowerCase()} look${choice ? "" : `, chosen by ${className(p.classId)}`}.`;
    app.note = null;
    app.error = null;
    render();
  });
}

/* ---------- the admin panel ---------- */
const ADMIN_TABS = [["queue", "Review queue"], ["classes", "Class settings"], ["bands", "Level bands"], ["newq", "New questions"]];
const CHECK_NAMES = { answer: "Right answer", options: "Options", scope: "Syllabus scope", level: "Level tag", wording: "Wording and safety" };
const sourceLabel = q => q.source === "csv" ? `CSV: ${q.sourceRef ?? "no row"}` : q.source === "website" ? `Website: ${q.sourceRef ?? ""}` : `Template${q.sourceRef ? `: ${q.sourceRef}` : ""}`;
const topicTitle = id => byId(id)?.topic.title ?? id;

async function openAdmin(tab, extra = {}) {
  await step(async () => {
    const next = { mode: "admin", tab, ...extra };
    if (tab === "queue") next.queue = await backend.reviewQueue();
    if (tab === "classes") next.classes = await backend.classSettings();
    if (tab === "bands") next.cuts = M.cutsOf(await backend.levelBands());
    if (tab === "newq") {
      const [log, counts] = await Promise.all([
        backend.questionRequests(20), Promise.all(M.ALL_CONTENT.map(c => backend.questions(c.topic.id).then(q => q.length))),
      ]);
      Object.assign(next, { log, counts });
    }
    show(next);
  });
}

function reviewCard(e) {
  const q = e.question, c = byId(q.topicId);
  const problems = e.report ? M.reportProblems(e.report) : ["It has no check report."];
  const confirming = d => app.confirm === `${d}:${q.id}`;
  return `<div class="qcard">
    <div class="small muted">${esc(topicTitle(q.topicId))} · L${q.level} ${LEVEL_NAMES[q.level]} · ${esc(c?.subSkillNames[q.subSkill] ?? q.subSkill)} · ${esc(sourceLabel(q))}</div>
    <p class="prompt">${promptHtml(q.prompt)}</p>
    ${dotsSvg(q.visual)}
    ${q.options ? `<div class="optlist">${q.options.map(o => `<span class="${q.answers.includes(o) ? "ans" : ""}">${q.answers.includes(o) ? "✓ " : ""}${esc(o)}</span>`).join("")}</div>` : ""}
    <p class="small">Answer given: <b>${esc(q.answers.join(", "))}</b></p>
    <ul class="problems">${problems.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    <div class="row">
      ${M.canFixHere(q) ? `<button class="ghost tonal" type="button" data-fixq="${q.id}">${ICONS.edit}Fix</button>` : ""}
      <button class="ghost" type="button" data-decide="rejected" data-q="${q.id}">${confirming("rejected") ? "Tap again to reject" : "Reject"}</button>
      <button class="ghost quiet" type="button" data-decide="approved" data-q="${q.id}">${confirming("approved") ? "Tap again to approve as it is" : "Approve anyway"}</button>
    </div>
    ${M.canFixHere(q) ? "" : `<p class="small muted">This came from a CSV, so fix it in the Drive file (${esc(q.sourceRef ?? "its row")}). The next sync checks it again.</p>`}
  </div>`;
}

function renderAdmin() {
  const tabs = `<div class="tabs" role="tablist" aria-label="Admin sections">${ADMIN_TABS.map(([id, name]) => `<button class="${app.tab === id ? "on" : ""}" type="button" role="tab"
    aria-selected="${app.tab === id}" data-tab="${id}">${esc(name)}</button>`).join("")}</div>`;
  let body = "";
  if (app.tab === "queue") {
    body = app.queue.length
      ? `<p class="muted">${app.queue.length} ${app.queue.length === 1 ? "question failed" : "questions failed"} a check. Children never see a question until it is approved.</p>${app.queue.map(reviewCard).join("")}`
      : `<p class="muted">Nothing to review. Questions that fail a check wait here.</p>`;
  } else if (app.tab === "classes") {
    const cell = (c, f, label) => `<input type="number" inputmode="numeric" data-class="${c.classId}" data-f="${f}" value="${c[f]}" aria-label="${esc(className(c.classId))}: ${label}">`;
    body = `<p class="muted">Each class's default pass mark, as a percentage of the 68 marks a quiz can give, and the marks off for a wrong first try. Every topic in the class uses them, for every child whose parent hasn't chosen their own in Quiz settings.</p>
      <div class="classgrid">
        <span class="label">Class</span><span class="label">Pass mark, %</span><span class="label">Marks off</span>
        ${app.classes.map(c => `<b>${esc(className(c.classId))}</b>${cell(c, "passPercent", "pass mark in percent")}${cell(c, "wrongPenalty", "marks off")}`).join("")}
      </div>
      <div class="sticky-save">
        <p class="${app.classMsg?.error ? "error" : "small muted"}" role="status" id="classmsg">${app.classMsg ? esc(app.classMsg.text) : ""}</p>
        <button class="ghost tonal" type="button" id="saveclasses">Save</button></div>`;
  } else if (app.tab === "bands") {
    const c = app.cuts;
    const pct = (f, label) => `<label>${label}<input type="number" inputmode="numeric" id="cut-${f}" value="${c[f]}"></label>`;
    body = `<p class="muted">How often children should get a question right first time at each level. A question whose live results fall outside its level's band goes back through the checks.</p>
      <div class="nums">${pct("l1", "L1 Easy from %")}${pct("l2", "L2 Medium from %")}${pct("l3", "L3 Hard from %")}</div>
      <ul class="points small" id="bandtext">${bandText(c)}</ul>
      <div class="row"><button class="ghost tonal" type="button" id="savebands">Save the bands</button></div>`;
  } else if (app.tab === "newq") {
    body = `<p class="muted">Make questions from a topic's templates. Each one is checked; those that fail wait in the review queue. Families can ask ${M.NEW_QUESTIONS_PER_DAY} times a day; you can ask any time.</p>
      <div class="family">${M.ALL_CONTENT.map((c, i) => `<div class="member"><div><b>${esc(c.topic.title)}</b><div class="small muted">${esc(className(c.topic.classId))} · ${app.counts[i]} approved questions</div></div>
        <div class="row"><button class="ghost" type="button" data-adminnewq="${c.topic.id}" ${newqBusy ? "disabled" : ""}>${newqBusy === c.topic.id ? "Making questions…" : "New questions"}</button></div></div>`).join("")}</div>
      <span class="label">Recent requests</span>
      ${app.log.length ? `<div class="log">${app.log.map(r => `<div><span>${esc(new Date(r.requestedAt).toLocaleString())}</span><span>${esc(topicTitle(r.topicId))}</span>
        <span>${r.by === "child" ? "A family" : "The admin"}</span><span>${r.added} added${r.sentToReview ? `, ${r.sentToReview} to review` : ""}</span></div>`).join("")}</div>` : `<p class="small muted">No requests yet.</p>`}`;
  }
  screen.innerHTML = `
    <div class="row"><button class="ghost quiet backlink" type="button" id="back">‹ Grown-ups</button></div>
    ${gbar()}<h1>Admin panel</h1>
    ${tabs}
    ${app.note ? `<p class="note" role="status">${esc(app.note)}</p>` : ""}
    ${app.newqNote ? `<p class="note" role="status">${esc(app.newqNote)}</p>` : ""}
    ${errorLine()}
    ${body}`;

  document.getElementById("back").onclick = () => show({ mode: "grownups" });
  screen.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => openAdmin(b.dataset.tab));
  screen.querySelectorAll("[data-class]").forEach(i => i.oninput = () => { const m = document.getElementById("classmsg"); m.className = "small"; m.textContent = "Unsaved changes."; });
  screen.querySelectorAll("[data-decide]").forEach(b => b.onclick = () => {
    const key = `${b.dataset.decide}:${b.dataset.q}`;
    if (app.confirm !== key) { app.confirm = key; render(); return; }
    step(async () => {
      await backend.reviewQuestion(b.dataset.q, { decision: b.dataset.decide });
      await openAdmin("queue", { note: b.dataset.decide === "approved" ? "Approved. Children can get it in their next quiz." : "Rejected. Children won't see it." });
      toTop();
    });
  });
  screen.querySelectorAll("[data-fixq]").forEach(b => b.onclick = () => {
    const entry = app.queue.find(e => e.question.id === b.dataset.fixq);
    show({ mode: "fix", entry, edits: M.editsOf(entry.question), report: entry.report, candidate: null });
  });
  const saveClasses = document.getElementById("saveclasses");
  if (saveClasses) saveClasses.onclick = () => {
    // The message shows by the Save button, at the end of a long list.
    const say = (text, error) => { app.classMsg = { text, error }; app.note = null; render(); };
    const read = f => c => Number(screen.querySelector(`[data-class="${c.classId}"][data-f="${f}"]`).value);
    const edited = app.classes.map(c => ({ ...c, passPercent: read("passPercent")(c), wrongPenalty: read("wrongPenalty")(c) }));
    const changed = edited.filter((c, i) => c.passPercent !== app.classes[i].passPercent || c.wrongPenalty !== app.classes[i].wrongPenalty);
    const problems = changed.flatMap(c => M.classSettingsProblems(c).map(p => `${className(c.classId)}: ${p}`));
    if (problems.length) return say(problems.join(" "), true);
    if (!changed.length) return say("Nothing changed.", false);
    step(async () => {
      try { for (const c of changed) await backend.saveClassSettings(c); } catch (err) { return say(err.message, true); }
      await openAdmin("classes", { classMsg: { text: `Saved ${changed.map(c => className(c.classId)).join(", ")}. Quizzes started from now use it.` } });
    });
  };
  const cut = f => Number(document.getElementById(`cut-${f}`).value);
  const readCuts = () => ({ l1: cut("l1"), l2: cut("l2"), l3: cut("l3") });
  if (app.tab === "bands") {
    screen.querySelectorAll("[id^=cut-]").forEach(i => i.oninput = () => {
      const c = readCuts();
      document.getElementById("bandtext").innerHTML = M.bandCutsProblem(c) ? `<li class="error">${esc(M.bandCutsProblem(c))}</li>` : bandText(c);
    });
    document.getElementById("savebands").onclick = () => {
      const c = readCuts();
      const problem = M.bandCutsProblem(c);
      if (problem) { app.error = problem; app.note = null; render(); return; }
      step(async () => { await backend.saveLevelBands(c); await openAdmin("bands", { note: "The level bands are saved." }); });
    };
  }
  screen.querySelectorAll("[data-adminnewq]").forEach(b => b.onclick = async () => {
    await askNewQuestions(b.dataset.adminnewq);
    const note = app.newqNote;
    await openAdmin("newq", { newqNote: note });
    toTop();
  });
}

/** The admin panel's messages sit at the top, and the card that was tapped may be gone. */
function toTop() { try { window.scrollTo(0, 0); } catch (e) {} }

function bandText(c) {
  return `<li>L1 Easy: ${c.l1}% or more right first time</li><li>L2 Medium: ${c.l2}% to ${c.l1}%</li>
    <li>L3 Hard: ${c.l3}% to ${c.l2}%</li><li>L4 Olympiad: under ${c.l3}%</li>`;
}

/* ---------- fixing a question (admin) ---------- */
function renderFix() {
  const q = app.entry.question, c = byId(q.topicId), e = app.edits;
  const text = (f, label, hint = "") => `<label for="f-${f}">${label}</label><input id="f-${f}" type="text" value="${esc(e[f])}" autocomplete="off">${hint ? `<p class="small muted">${hint}</p>` : ""}`;
  const report = app.report;
  const checks = report ? Object.entries(CHECK_NAMES).map(([k, name]) => `<li class="${report[k].passed ? "ok" : "bad"}">${report[k].passed ? "✓" : "✗"} ${esc(name)}${report[k].problems.length ? `: ${esc(report[k].problems.join(" "))}` : ""}</li>`).join("") : "";
  const ready = app.candidate && app.report;
  screen.innerHTML = `<div class="narrow" style="max-width:720px">
    ${gbar()}<span class="label">Admin · Fix a question</span><h1>${esc(topicTitle(q.topicId))}</h1>
    <p class="small muted">${esc(sourceLabel(q))} · id ${esc(q.id)}</p>
    <form id="fixform" novalidate>
      ${text("prompt", "Question")}
      ${text("options", "Options", 'Separate them with "|", like 6 | 7 | 8.')}
      ${text("answers", "Right answer")}
      <label for="f-level">Level</label><select id="f-level">${[1, 2, 3, 4].map(l => `<option value="${l}" ${String(l) === e.level ? "selected" : ""}>L${l} ${LEVEL_NAMES[l]}</option>`).join("")}</select>
      <label for="f-subSkill">Skill</label><select id="f-subSkill">${Object.entries(c.subSkillNames).map(([id, name]) => `<option value="${esc(id)}" ${id === e.subSkill ? "selected" : ""}>${esc(name)}</option>`).join("")}</select>
      ${text("hint", "Hint after a wrong first try")}
      ${text("explanation", "Working shown after a wrong answer")}
      ${text("reason", "Reason shown with the praise")}
      ${text("picture", "Picture", 'Dots, like "3 blue, 2 orange" or "5 blue 2 crossed". Leave empty for none.')}
      ${text("working", "Working", 'How the answer is worked out, so the checks can recompute it: a sum like "4 + 3", "count dots", or JSON.')}
    </form>
    ${errorLine()}
    ${report ? `<div class="panel"><span class="label">${ready ? "Checks on your fix" : "Checks on the question now"}</span><ul class="checks">${checks}</ul></div>` : ""}
    <div class="row"><button class="ghost" type="button" id="check">Check my fix</button>
      <button class="btn primary" type="button" id="save" ${ready ? "" : "disabled"}>${ready && !app.report.passed ? (app.confirmSave ? "Tap again to approve anyway" : "Approve with these problems") : "Save and approve"}</button>
      <button class="ghost" type="button" id="cancel">Cancel</button></div>
  </div>`;
  const read = () => {
    const out = {};
    for (const f of ["prompt", "options", "answers", "hint", "explanation", "reason", "picture", "working"]) out[f] = document.getElementById(`f-${f}`).value;
    out.level = document.getElementById("f-level").value;
    out.subSkill = document.getElementById("f-subSkill").value;
    return out;
  };
  document.getElementById("check").onclick = () => {
    app.edits = read();
    app.confirmSave = false;
    try {
      app.candidate = M.applyEdits(q, app.edits);
      app.report = M.recheck(app.candidate, M.ALL_CONTENT.map(M.topicInfo));
      app.error = null;
    } catch (err) {
      app.candidate = null; app.error = err.message;
    }
    render();
  };
  // Changing a field after a check means checking again before saving.
  screen.querySelectorAll("#fixform input, #fixform select").forEach(i => i.oninput = () => {
    if (!app.candidate) return;
    app.candidate = null;
    const save = document.getElementById("save");
    save.disabled = true;
    save.textContent = "Save and approve";
  });
  document.getElementById("save").onclick = () => {
    if (!app.report.passed && !app.confirmSave) { app.confirmSave = true; render(); return; }
    step(async () => {
      await backend.reviewQuestion(q.id, { decision: "fixed", question: app.candidate, report: app.report });
      await openAdmin("queue", { note: "Fixed and approved. Children can get it in their next quiz." });
    });
  };
  document.getElementById("cancel").onclick = () => openAdmin("queue");
}

/* ---------- topics and quizzes ---------- */
function goDash() { app = { mode: "dash" }; render(); }

function openTopic(topicId) {
  app = { mode: "lesson", topicId, page: 0 };
  render();
}

/** The engine's attempt number: a cleared topic starts counting again, for the practice offer. */
function attemptNoFor(topicId) {
  const e = sum.progress.topics[topicId];
  return e.state === "cleared" ? 1 : e.attempts + 1;
}

function startQuiz(topicId, practiceSkill) {
  const all = banks[topicId] ?? byId(topicId).bank;
  const bank = practiceSkill ? all.filter(q => q.subSkill === practiceSkill) : all;
  const play = {
    id: crypto.randomUUID(), topicId, attemptNo: (sum.plays[topicId] ?? 0) + 1,
    practice: !!practiceSkill, startedAt: new Date().toISOString(),
  };
  data.attempts.push({ ...play, finishedAt: null, marks: null, cleared: null, stars: null });
  refresh();
  const profileId = child.id;
  persist(() => backend.startAttempt(profileId, play));
  app = {
    mode: "quiz", topicId, practiceSkill, bank, practiceTotal: Math.min(PRACTICE_LENGTH, bank.length), playId: play.id,
    state: M.startQuiz({ classId: child.classId, topicId, attemptNo: attemptNoFor(topicId), seenBefore: sum.seen[topicId] || [], ...quizSettings() }),
    phase: "ask", feedback: null, prevMarks: 0, delta: null, tries: [],
  };
  app.q = M.nextQuestion(app.state, app.bank);
  keepQuiz();
  render();
}

function keepQuiz() {
  const keep = ["mode", "topicId", "practiceSkill", "bank", "practiceTotal", "playId", "state", "phase", "feedback", "fbText", "prevMarks", "delta", "q", "tries"];
  try { storage.setItem(QUIZ_KEY(child.id), JSON.stringify(Object.fromEntries(keep.map(k => [k, app[k]])))); } catch (e) {}
}

function keptQuiz() {
  if (!child) return null;
  try {
    const q = JSON.parse(storage.getItem(QUIZ_KEY(child.id)) || "null");
    // A quiz on a topic that has since been cleared or locked, or one already finished, isn't offered again.
    if (!q || !q.state || !sum.progress.topics[q.topicId] || sum.progress.topics[q.topicId].state === "locked") return null;
    if (!data.attempts.some(a => a.id === q.playId && !a.finishedAt)) return null;
    return q;
  } catch (e) { return null; }
}

function dropQuiz() { try { storage.setItem(QUIZ_KEY(child.id), "null"); } catch (e) {} }

function nextQ() {
  app.prevMarks = app.state.marks;
  app.delta = null;
  app.q = M.nextQuestion(app.state, app.bank);
  app.phase = "ask";
  app.feedback = null;
  app.fbText = "";
  app.tries = [];
  keepQuiz();
  render();
}

/** Saves the question just finished, with its retry if there was one. */
function saveResponse(q) {
  const r = app.state.responses[app.state.responses.length - 1];
  const row = {
    attemptId: app.playId, seq: app.state.responses.length, questionId: q.id, level: q.level, subSkill: q.subSkill,
    firstTryCorrect: r.firstTryCorrect, retryCorrect: r.retryCorrect, marksDelta: r.marksDelta,
  };
  data.responses.push(row);
  persist(() => backend.recordResponse(row));
}

function quizDone() {
  const s = app.state;
  return app.practiceSkill ? s.asked.length >= app.practiceTotal && !s.pendingRetry : M.isFinished(s);
}

function finish() {
  const s = app.state;
  const playId = app.playId, profileId = child.id;
  const play = data.attempts.find(a => a.id === playId);
  dropQuiz();
  if (app.practiceSkill) {
    const result = { marks: s.marks, cleared: false, stars: 0, passMarks: s.passMarks, maxMarks: maxMarks(), correct: s.correct };
    Object.assign(play, { finishedAt: new Date().toISOString(), marks: result.marks, cleared: false, stars: 0 });
    persist(() => backend.finishAttempt(playId, result));
    refresh();
    app = { mode: "practice-done", topicId: app.topicId, skill: app.practiceSkill, correct: s.correct, total: s.asked.length };
    render();
    return;
  }
  const outcome = M.finishQuiz(s);
  const result = { marks: outcome.marks, cleared: outcome.cleared, stars: outcome.stars, passMarks: outcome.passMarks, maxMarks: outcome.maxMarks, correct: outcome.correct };
  Object.assign(play, { finishedAt: new Date().toISOString(), marks: result.marks, cleared: result.cleared, stars: result.stars });
  const r = M.recordAttempt(sum.progress, topicList(), app.topicId, outcome.marks, outcome.cleared);
  data.topics = Object.entries(r.progress.topics).map(([topicId, e]) => ({ topicId, state: e.state, attempts: e.attempts, bestMarks: e.bestScore }));
  const rows = data.topics;
  persist(() => backend.finishAttempt(playId, result));
  persist(() => backend.saveTopicProgress(profileId, rows));
  refresh();
  app = { mode: "result", topicId: app.topicId, outcome, effect: r.effect };
  render();
}

/* ---------- screens ---------- */
function renderDash() {
  const topics = topicList();
  const MAX = maxMarks();
  const play = look() === "play";
  const states = topics.map(t => sum.progress.topics[t.id]);
  const clearedCount = states.filter(s => s.state === "cleared").length;
  const totalStars = Object.values(sum.stars).reduce((a, b) => a + b, 0);
  const next = M.nextClass(child.classId);
  const pass = quizSettings().passMarks, passPct = (pass / MAX) * 100;
  const kept = keptQuiz();
  const upNext = topics.find(t => sum.progress.topics[t.id].state === "current");

  const rows = topics.map((t, i) => {
    const e = sum.progress.topics[t.id];
    const stars = sum.stars[t.id] || 0;
    const bestPct = Math.min(100, (e.bestScore / MAX) * 100);
    const chip = e.state === "cleared" ? `<span class="chip cleared">Cleared</span>` : e.state === "current" ? `<span class="chip current">Up next</span>` : `<span class="chip">Locked</span>`;
    const starsHtml = stars ? `<span class="stars-sm" role="img" aria-label="${stars} of 3 stars"><span aria-hidden="true">${"★".repeat(stars)}${"☆".repeat(3 - stars)}</span></span>` : "";
    // Playful shows a young child only the stars; clean shows the best marks and tries as well.
    const score = e.attempts
      ? play ? starsHtml || `<span>${e.attempts} ${e.attempts === 1 ? "try" : "tries"}</span>` : `<span>Best ${e.bestScore} / ${MAX} · ${e.attempts} ${e.attempts === 1 ? "try" : "tries"}</span>${starsHtml}`
      : e.state === "locked" ? `<span>Opens after topic ${i}</span>` : `<span>Not started</span>`;
    const act = e.state === "current"
      ? `<button class="chipbtn" type="button" data-open="${t.id}">${e.attempts ? word("retry") : "Start"}</button>`
      : e.state === "cleared" ? `<button class="chipbtn soft" type="button" data-open="${t.id}">Practise</button>` : "";
    // The clean look's ring fills with the best score so far.
    const ring = e.state === "cleared" ? 100 : Math.round(bestPct);
    const node = `<span class="num" style="--p:${ring}" aria-hidden="true">${e.state === "cleared" ? "✓" : e.state === "locked" ? lockIcon() : i + 1}</span>`;
    // Clean keeps a long syllabus short: cleared and locked topics are one-line rows, only the next topic is a card.
    if (!play && e.state !== "current") {
      return `<div class="topic ${e.state} slim">${node}
        <div class="tmain"><h3>${esc(t.title)}</h3><div class="tmeta">${score}</div></div>
        ${e.state === "cleared" ? `<button class="ghost quiet" type="button" data-open="${t.id}" aria-label="Practise ${esc(t.title)}">Practise${ICONS.chev}</button>` : ""}</div>`;
    }
    return `<div class="topic ${e.state}">${node}
      <div class="tmain"><div class="row" style="gap:8px"><h3>${esc(t.title)}</h3>${chip}</div><div class="tmeta">${score}</div></div>
      <div class="act">${act}</div></div>`;
  }).join("");

  const areas = weakAreas(sum);
  const weakest = areas.find(a => sum.progress.topics[a.tid].state !== "locked");
  const cls = className(child.classId);
  const carry = kept ? `<div class="carry block" role="region" aria-label="Carry on">
      <div><span class="label">Carry on</span><b>${esc(byId(kept.topicId).topic.title)}</b>
        <span class="small muted">Question ${kept.phase === "ask" ? kept.state.asked.length + 1 : kept.state.asked.length} of ${kept.practiceSkill ? kept.practiceTotal : M.QUIZ_LENGTH}</span></div>
      <button class="btn primary" type="button" id="carry">Carry on</button></div>` : "";
  screen.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <div class="who"><span class="emoji" aria-hidden="true">${M.avatarEmoji(child.avatar)}</span><b>${esc(child.nickname)}</b></div>
      <div class="row"><button class="ghost" type="button" id="switch">Switch child</button>
        <button class="ghost" type="button" id="grownups">${ICONS.lock}Grown-ups</button></div></div>
    ${saveError ? `<p class="banner" role="alert">${esc(saveError)}</p>` : ""}
    ${carry}
    <section class="block">
      <div class="dash-head">
        <div style="display:grid;gap:4px"><span class="label">${play ? "My maths" : "Class dashboard"}</span><h1>${esc(cls)} Maths</h1></div>
        <div class="row" style="gap:24px">
          <div><div class="bigstat">${clearedCount} / ${topics.length}</div><div class="small muted">topics cleared</div></div>
          <div><div class="bigstat"><span class="starglyph" aria-hidden="true">★</span> ${totalStars}</div><div class="small muted">stars</div></div>
        </div>
      </div>
      <div class="overall">
        <div class="segs" style="--n:${topics.length}" role="img" aria-label="${clearedCount} of ${topics.length} topics cleared">${states.map(s => `<span class="seg ${s.state}"></span>`).join("")}</div>
        ${play ? (sum.promoted ? `<p class="small muted">${esc(cls)} complete!</p>` : "")
          : `<p class="small muted">${sum.promoted ? `${esc(cls)} complete!${next ? ` ${esc(className(next))} opens when its topics are ready.` : ""}` : `Clear every topic to move up${next ? ` to ${esc(className(next))}` : ""}. Each quiz needs ${passPercent()}% (${pass} of ${MAX} marks).`}</p>`}
        ${!play && upNext && !kept ? `<div class="row"><button class="btn primary" type="button" data-open="${upNext.id}">Continue: ${esc(upNext.title)}</button></div>` : ""}
      </div>
    </section>
    <div class="topics">${rows}</div>
    ${play
      ? weakest ? `<div class="mascot">${owl("think")}<div class="bubble"><h2>Let's practise ${esc(byId(weakest.tid).subSkillNames[weakest.skill] || weakest.skill).toLowerCase()}!</h2>
          <div class="row"><button class="btn primary" type="button" data-practice="${weakest.tid}|${weakest.skill}">Play</button></div></div></div>` : ""
      : `<div class="panels">
      <div class="panel"><span class="label">Improvement areas</span>${areas.length ? areas.map(a => {
        const c = byId(a.tid);
        const open = sum.progress.topics[a.tid].state !== "locked";
        return `<div class="area"><div><b>${esc(c.subSkillNames[a.skill] || a.skill)}</b><div class="small muted">${esc(c.topic.title)} · ${Math.round(a.acc * 100)}% right</div></div>
          ${open ? `<button class="ghost" type="button" data-practice="${a.tid}|${a.skill}">Practise</button>` : ""}
          <span class="mini" aria-hidden="true"><b style="width:${a.acc * 100}%"></b></span></div>`;
      }).join("") : `<p class="muted small">Nothing to work on yet. After each quiz, skills under 80% show up here with a practice button.</p>`}</div>
      <div class="panel"><span class="label">Right first time, by level</span>${levelRows(sum)}</div>
    </div>`}`;
  screen.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openTopic(b.dataset.open));
  screen.querySelectorAll("[data-practice]").forEach(b => b.onclick = () => { const [t, s] = b.dataset.practice.split("|"); startQuiz(t, s); });
  const c = document.getElementById("carry");
  if (c) c.onclick = () => { app = { ...kept, mode: "quiz" }; render(); };
  document.getElementById("switch").onclick = () => askPin("To switch to another child.", () => show({ mode: "profiles" }));
  document.getElementById("grownups").onclick = () => askPin("To open the grown-ups' page.", () => show({ mode: "grownups" }));
}

function lockIcon() {
  return `<svg width="16" height="18" viewBox="0 0 16 18" aria-label="Locked"><rect x="1" y="8" width="14" height="9" rx="2" fill="var(--muted)"/><path d="M4 8V5a4 4 0 0 1 8 0v3" fill="none" stroke="var(--muted)" stroke-width="2"/></svg>`;
}

function renderLesson() {
  const c = byId(app.topicId);
  const pages = c.lesson;
  const n = pages.length + 1;
  const crumbs = `<div class="qtop"><div class="qtitle"><span class="muted small">${esc(c.topic.title)}</span><b>Lesson ${Math.min(app.page + 1, n)} of ${n}</b></div>
    ${app.peek ? `<button class="ghost" type="button" id="backq">Back to my question</button>` : `<button class="ghost" type="button" id="todash">${word("map")}</button>`}</div>`;
  if (app.page < pages.length) {
    const p = pages[app.page];
    const count = app.counted ?? [];
    const total = p.visual ? p.visual.groups.reduce((a, g) => a + g.count, 0) : 0;
    const ready = !p.visual || count.length === total;
    screen.innerHTML = `${crumbs}
      <div class="mascot">${MASCOT}<div class="bubble"><h2 tabindex="-1">${esc(p.title)}</h2><p>${esc(p.text)}</p>${sayBtn(`${p.title}. ${p.text}`)}</div></div>
      ${p.visual ? `${tapDots(p.visual, count)}<p class="small muted center" aria-live="polite">${count.length ? `${count.length} counted` : "Tap each dot to count it."}</p>` : ""}
      <div class="row lessonnav">${app.page > 0 ? `<button class="ghost" type="button" id="back">Back</button>` : ""}
        <button class="btn primary ${ready && p.visual ? "ready" : ""}" type="button" id="next">Next</button></div>`;
    autoSay(`lesson${app.topicId}${app.page}`, `${p.title}. ${p.text}`);
    screen.querySelectorAll("[data-dot]").forEach(b => b.onclick = () => {
      const k = b.dataset.dot;
      if (count.includes(k)) return;
      app.counted = [...count, k];
      if (childVoice()) speak(NUMBER_WORDS[app.counted.length - 1] ?? String(app.counted.length));
      render();
      document.querySelector(`[data-dot="${k}"]`)?.focus();
    });
    document.getElementById("next").onclick = () => { app.page++; app.counted = []; render(); };
    const back = document.getElementById("back");
    if (back) back.onclick = () => { app.page--; app.counted = []; render(); };
  } else {
    const t = c.tryIt;
    const picks = app.tryPicks ?? [];
    const got = picks.includes(t.answer);
    const wrong = picks.filter(x => x !== t.answer);
    screen.innerHTML = `${crumbs}
      <div class="mascot">${MASCOT}<div class="bubble"><span class="label">Try it</span><p class="prompt" tabindex="-1">${promptHtml(t.prompt)}</p>${sayBtn(t.prompt)}</div></div>
      ${dotsSvg(t.visual)}
      ${optionButtons(t.options, "data-try", { disabled: got, tried: wrong, right: got ? [t.answer] : null })}
      <div id="tryfb">${got ? feedbackCard("good", "You got it!", esc(t.praise)) : wrong.length ? feedbackCard("gentle", "Let's look again.", `${esc(t.help)} Try again!`) : ""}</div>
      <div class="row">${got ? `<button class="btn primary" type="button" id="go">${app.peek ? "Back to my question" : "Start the quiz"}</button>` : ""}
        <button class="ghost" type="button" id="back">Back</button></div>`;
    autoSay(`try${app.topicId}`, t.prompt);
    document.getElementById("back").onclick = () => { app.page--; app.tryPicks = []; render(); };
    screen.querySelectorAll("[data-try]:not([disabled])").forEach(b => b.onclick = () => {
      const ok = b.dataset.try === t.answer;
      app.tryPicks = [...picks, b.dataset.try];
      chime(ok ? "good" : "gentle");
      render();
      const text = ok ? `You got it! ${t.praise}` : `Let's look again. ${t.help} Try again!`;
      announce(text);
      autoSay(`try${app.topicId}${app.tryPicks.length}`, text);
      afterAnswer(ok ? document.getElementById("go") : screen.querySelector("[data-try]:not([disabled])"));
    });
    const go = document.getElementById("go");
    if (go) go.onclick = () => app.peek ? backToQuiz() : startQuiz(app.topicId);
  }
  const td = document.getElementById("todash");
  if (td) td.onclick = goDash;
  const bq = document.getElementById("backq");
  if (bq) bq.onclick = backToQuiz;
}

function tapDots(visual, counted) {
  return `<div class="visual tapdots">${visual.groups.map((g, gi) => `<div class="dotgroup">${Array.from({ length: g.count }, (_, i) => {
    const k = `${gi}-${i}`, n = counted.indexOf(k);
    const crossed = g.crossed && i >= g.count - g.crossed;
    return `<button class="tapdot ${g.color} ${n >= 0 ? "counted" : ""} ${crossed ? "crossed" : ""}" type="button" data-dot="${k}" aria-label="${n >= 0 ? `Counted, ${n + 1}` : `${g.color} dot${crossed ? ", crossed out" : ""}`}">${n >= 0 ? n + 1 : ""}</button>`;
  }).join("")}</div>`).join("")}</div>`;
}

function afterAnswer(target) {
  // Show the feedback and the next step, and move focus to it, without jumping the question off a tall screen.
  const fb = document.getElementById("fbcard");
  requestAnimationFrame(() => {
    try { (target?.closest(".row") ?? fb)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) {}
    try { if (fb) fb.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) {}
    target?.focus({ preventScroll: true });
  });
}

function backToQuiz() { app = app.saved; app.prevMarks = app.state.marks; render(); }

function marksBar() {
  const s = app.state;
  const MAX = maxMarks();
  const PASS = s.passMarks;
  const passPct = (PASS / MAX) * 100;
  const q = s.marks >= PASS;
  const d = app.delta;
  const track = `<div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="${MAX}" aria-valuenow="${s.marks}" aria-label="Marks: ${s.marks}, ${PASS} to pass">
      <div class="fill ${q ? "qualified" : ""}" id="fill" style="width:${(Math.min(app.prevMarks, MAX) / MAX) * 100}%"></div>
      <div class="passmark ${q ? "crossed" : ""}" style="left:${passPct}%"><span>${look() === "play" ? FLAG : `${q ? "✓ " : ""}Pass ${PASS}`}</span></div>
    </div>`;
  // Playful: a bar that fills towards a flag, with no numbers, rules or penalties for a young child to read.
  if (look() === "play") return `<div class="marks meter">${track}</div>`;
  const deltaHtml = d === null || d === undefined ? "" : d > 0 ? `<span class="delta up">+${d}</span>` : d < 0 ? `<span class="delta down">−${-d}</span>` : "";
  return `<div class="marks">
    <div class="marks-top">
      <div class="row" style="gap:8px"><span class="label">Marks</span><span class="marks-num">${s.marks}</span>${deltaHtml}</div>
      <span class="qual ${q ? "yes" : ""}">${q ? "Pass mark crossed!" : `${PASS - s.marks} more to pass`}</span>
    </div>
    ${track}
    <details class="howmarks"><summary>How marks work</summary>
      <p class="small muted">Right answers: Easy +1, Medium +2, Hard +3, Olympiad +4. A wrong first try takes away ${s.wrongPenalty}; the second try is for practice.</p></details>
  </div>`;
}

function renderQuiz() {
  const { q, state: s } = app;
  const practice = !!app.practiceSkill;
  const total = practice ? app.practiceTotal : M.QUIZ_LENGTH;
  const qNo = app.phase === "ask" ? s.asked.length + 1 : s.asked.length;
  const locked = app.phase === "done";
  const c = byId(app.topicId);
  const done = s.asked.length - (app.phase === "retry" ? 1 : 0);
  const tag = practice ? `<span class="lvl practice">Practice · no marks</span>` : `<span class="lvl">L${q.level} ${LEVEL_NAMES[q.level]} <i>· worth ${M.MARKS_BY_LEVEL[q.level]} ${M.MARKS_BY_LEVEL[q.level] === 1 ? "mark" : "marks"}</i></span>`;
  screen.innerHTML = `
    <div class="qtop">
      <div class="qtitle"><span class="muted small">${esc(c.topic.title)}${practice ? ` · Practice: ${esc(c.subSkillNames[app.practiceSkill])}` : ""}</span>
        <b>Question ${qNo} of ${total}</b></div>
      <button class="ghost iconbtn" type="button" id="relesson" aria-label="See the lesson">${ICONS.book}<span class="lbl">Lesson</span></button>
      <button class="ghost iconbtn" type="button" id="stopq" aria-label="Stop the quiz">${ICONS.close}<span class="lbl">Stop</span></button></div>
    ${app.confirmStop ? stopCard("Stop now?", `You can carry on later from question ${qNo}.`, "Stop") : ""}
    <div class="qprog" role="progressbar" aria-label="Questions done" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}">${
      Array.from({ length: total }, (_, i) => `<span class="${i < done ? "done" : i === done ? "now" : ""}"></span>`).join("")}</div>
    ${saveError ? `<p class="banner" role="alert">${esc(saveError)}</p>` : ""}
    ${practice ? "" : marksBar()}
    <div class="mascot">${MASCOT}<div class="bubble">${tag}<p class="prompt" tabindex="-1">${promptHtml(q.prompt)}</p>${sayBtn(app.fbText ? `${q.prompt} ${app.fbText}` : q.prompt)}</div></div>
    ${dotsSvg(q.visual)}
    ${optionButtons(q.options, "data-opt", { disabled: locked, tried: app.tries ?? [], right: locked ? q.answers : null })}
    ${locked ? "" : keyHint(q.options.length)}
    <div id="fb">${app.feedback ?? ""}</div>
    ${locked ? `<div class="row"><button class="btn primary wide" type="button" id="cont">${quizDone() ? (practice ? "Finish practice" : "See my result") : "Next question"}</button></div>` : ""}`;
  autoSay(`q${app.playId}${s.asked.length}${app.phase}`, app.phase === "ask" ? q.prompt : app.fbText);

  // The clean look's A/B/C keys answer from a keyboard, and Enter or → moves on. The playful look leaves keys alone, for little hands on a laptop.
  if (look() === "focus") document.onkeydown = e => {
    if (app.mode !== "quiz" || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, textarea, select")) return;
    const cont = document.getElementById("cont");
    if (cont && (e.key === "ArrowRight" || (e.key === "Enter" && document.activeElement === document.body))) { e.preventDefault(); cont.click(); return; }
    const b = screen.querySelectorAll("[data-opt]")[KEYS.indexOf(e.key.toUpperCase())];
    if (e.key.length === 1 && b && !b.disabled) b.click();
  };
  const fill = document.getElementById("fill");
  if (fill) requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (Math.min(s.marks, maxMarks()) / maxMarks()) * 100 + "%"; }));

  document.getElementById("relesson").onclick = () => { const saved = app; app = { mode: "lesson", topicId: saved.topicId, page: 0, peek: true, saved }; render(); };
  document.getElementById("stopq").onclick = () => { app.confirmStop = true; render(); document.getElementById("keepon")?.focus(); };
  wireStopCard(() => { keepQuiz(); goDash(); });
  const cont = document.getElementById("cont");
  if (cont) cont.onclick = () => (quizDone() ? finish() : nextQ());
  screen.querySelectorAll("[data-opt]:not([disabled])").forEach(b => b.onclick = () => answer(b.dataset.opt));
}

function answer(choice) {
  const q = app.q;
  let ok = false;
  app.prevMarks = app.state.marks;
  app.confirmStop = false;
  if (app.phase === "ask") {
    const r = M.answerFirstTry(app.state, q, choice);
    app.state = r.state;
    app.delta = r.result.marksDelta;
    ok = r.result.kind === "praise";
    if (ok) {
      saveResponse(q);
      app.phase = "done";
      const title = pick(["Super!", "Well done!", "Brilliant!", "Yes!"]);
      app.feedback = feedbackCard("good", title, esc(r.result.reason));
      app.fbText = `${title} ${r.result.reason}`;
    } else {
      app.phase = "retry";
      app.tries = [choice];
      // The retry never changes the marks (see answerRetry). The clean look says what the first try cost;
      // the playful look keeps marks out of a young child's way.
      const cost = -r.result.marksDelta;
      const note = look() === "play" ? "" : cost > 0 ? `That try cost ${cost} ${cost === 1 ? "mark" : "marks"}. Your next try is just for practice.` : "Your next try is just for practice.";
      app.feedback = feedbackCard("gentle", "Nice try! Here's a hint.", `${esc(r.result.hint)} Have another go.`, note);
      app.fbText = `Nice try! Here's a hint. ${r.result.hint} Have another go.`;
    }
  } else if (app.phase === "retry") {
    const r = M.answerRetry(app.state, q, choice);
    app.state = r.state;
    saveResponse(q);
    app.phase = "done";
    ok = r.retryCorrect;
    if (!r.retryCorrect) app.tries = [...(app.tries ?? []), choice];
    app.feedback = r.retryCorrect
      ? feedbackCard("good", "You worked it out!", esc(r.explanation))
      : feedbackCard("gentle", "Let's do it together.", `${esc(r.explanation)} The answer is <b>${esc(r.answer)}</b>.`);
    app.fbText = r.retryCorrect ? `You worked it out! ${r.explanation}` : `Let's do it together. ${r.explanation} The answer is ${r.answer}.`;
  }
  keepQuiz();
  chime(ok ? "good" : "gentle");
  render();
  announce(app.fbText);
  afterAnswer(app.phase === "done" ? document.getElementById("cont") : screen.querySelector("[data-opt]:not([disabled])"));
}

function renderResult() {
  const { outcome: o, effect } = app;
  const c = byId(app.topicId);
  const MAX = maxMarks();
  const cls = className(child.classId);
  const play = look() === "play";
  const passPct = (o.passMarks / MAX) * 100;
  const bar = `<div class="marks"><div class="marks-top"><div><span class="label">Final marks</span><div class="marks-num">${o.marks} / ${MAX}</div></div>
      <span class="qual ${o.cleared ? "yes" : ""}">${o.cleared ? "Above the pass mark" : `${o.passMarks - o.marks} short of the pass mark`}</span></div>
    <div class="track"><div class="fill ${o.cleared ? "qualified" : ""}" style="width:${(o.marks / MAX) * 100}%"></div><div class="passmark ${o.cleared ? "crossed" : ""}" style="left:${passPct}%"><span>${play ? FLAG : `Pass ${o.passMarks}`}</span></div></div>
    <div class="small muted">${o.correct} of ${M.QUIZ_LENGTH} right first time</div></div>`;
  // Playful: the bar and the flag, without numbers a young child can't read yet. Grown-ups see the marks on the Progress page.
  const shownBar = play ? `<div class="marks meter"><div class="track" role="img" aria-label="${o.cleared ? "Past the flag" : "Not yet at the flag"}"><div class="fill ${o.cleared ? "qualified" : ""}" style="width:${(o.marks / MAX) * 100}%"></div>
      <div class="passmark ${o.cleared ? "crossed" : ""}" style="left:${passPct}%"><span>${FLAG}</span></div></div></div>` : bar;
  const nextStar = !play && o.cleared && o.stars < 3 ? `<p class="small muted center">Next star at ${o.stars === 1 ? M.TWO_STARS : M.THREE_STARS} marks.</p>` : "";

  if (o.cleared && effect.kind === "promoted") {
    const next = effect.to ? className(effect.to) : null;
    screen.innerHTML = `
      <div class="cert">${owl("happy")}<span class="label">Certificate</span><h1 tabindex="-1">${esc(cls)} Maths complete!</h1>
        <p>${esc(child.nickname)} cleared all ${topicList().length} topics.${next ? ` Ready for ${esc(next)}!` : ""}</p>
        ${starsHtml(o.stars)}
        ${next ? `<p class="small muted">${esc(next)} opens when its topics are ready.</p>` : ""}</div>
      ${shownBar}
      <div class="row actions"><button class="btn primary" type="button" id="dash">See my ${esc(cls)} dashboard</button></div>`;
    autoSay(`result${app.topicId}`, `${cls} Maths complete!`);
  } else if (o.cleared) {
    const next = byId(effect.topicId);
    screen.innerHTML = `
      <div class="mascot">${owl("happy")}<div class="bubble"><h2 tabindex="-1">Topic cleared!</h2><p>${esc(c.topic.title)} is done. The next topic is open.</p></div></div>
      ${starsHtml(o.stars)}${nextStar}
      ${shownBar}
      <div class="row actions">
        <button class="btn primary" type="button" id="nexttopic">Next topic: ${esc(next.topic.title)}</button>
        <button class="ghost" type="button" id="dash">${word("map")}</button>
        <button class="ghost" type="button" id="again">${word("again")}</button>
      </div>`;
    document.getElementById("nexttopic").onclick = () => openTopic(next.topic.id);
    autoSay(`result${app.topicId}`, `Topic cleared! ${c.topic.title} is done.`);
  } else {
    const weak = o.weakSubSkills[0];
    const practise = o.offerPractice && weak;
    const close = o.marks >= o.passMarks * 0.75;
    const title = close ? "So close!" : practise ? "Good effort! Let's practise first." : "Good effort! Let's have another go.";
    const body = play ? `You got ${o.correct} right first time.` : `You got ${o.correct} of ${M.QUIZ_LENGTH} right first time. You need ${o.passMarks} marks to open the next topic, and harder questions give more marks.`;
    screen.innerHTML = `
      <div class="mascot">${owl("think")}<div class="bubble"><h2 tabindex="-1">${title}</h2><p>${body}</p></div></div>
      ${shownBar}
      <div class="row actions">
        ${practise ? `<button class="btn primary" type="button" id="practice">Practise ${esc((c.subSkillNames[weak] || weak).toLowerCase())}</button>` : ""}
        <button class="${practise ? "ghost" : "btn primary"}" type="button" id="lesson">Watch the lesson again</button>
        <button class="ghost" type="button" id="again">Try with new questions</button>
        <button class="ghost" type="button" id="dash">${word("map")}</button>
      </div>`;
    document.getElementById("lesson").onclick = () => openTopic(app.topicId);
    const pr = document.getElementById("practice");
    if (pr) pr.onclick = () => startQuiz(app.topicId, weak);
    autoSay(`result${app.topicId}`, `${title} ${body}`);
  }
  const again = document.getElementById("again");
  if (again) again.onclick = () => startQuiz(app.topicId);
  document.getElementById("dash").onclick = goDash;
  if (o.cleared) chime("good");
}

function starsHtml(n) {
  return `<div class="stars" role="img" aria-label="${n} of 3 stars">${[0, 1, 2].map(i => `<span class="${i < n ? "on" : "off"}" style="--i:${i}" aria-hidden="true">${i < n ? "★" : "☆"}</span>`).join("")}</div>`;
}

function renderPracticeDone() {
  const c = byId(app.topicId);
  screen.innerHTML = `
    <div class="mascot">${owl("happy")}<div class="bubble"><h2 tabindex="-1">Practice done!</h2><p>You got ${app.correct} of ${app.total} on ${esc(c.subSkillNames[app.skill])}. Practice does not change your marks.</p></div></div>
    <div class="row actions"><button class="btn primary" type="button" id="quiz">Try the quiz again</button><button class="ghost" type="button" id="dash">${word("map")}</button></div>`;
  autoSay(`practice${app.topicId}`, `Practice done! You got ${app.correct} of ${app.total}.`);
  document.getElementById("quiz").onclick = () => startQuiz(app.topicId);
  document.getElementById("dash").onclick = goDash;
}

/* ---------- side panel: the grown-up view during a quiz, tester tools in the demo ---------- */
function renderSide() {
  if (app.mode !== "quiz") {
    const tools = DEMO && app.mode === "dash";
    stage.classList.toggle("solo", !tools);
    side.hidden = !tools;
    if (!tools) { side.innerHTML = ""; return; }
    side.innerHTML = `<span class="label">Tester tools (not in the app)</span>
      <p class="small muted">The demo keeps everything in this browser. Reset to start again from sign-in, with the built-in questions only.</p>
      <div class="tools"><button class="ghost" type="button" id="reset">Reset the demo</button></div>
      <p class="small muted">To try the admin panel, open Grown-ups and tap "Make me the admin".</p>`;
    const reset = document.getElementById("reset");
    reset.onclick = () => {
      if (!reset.dataset.sure) { reset.dataset.sure = "1"; reset.textContent = "Tap again to reset"; return; }
      for (const k of [M.DEMO_KEY, M.demoBankKey(M.DEMO_KEY), OLD_BANK_KEY]) { try { storage.setItem(k, "null"); } catch (e) {} }
      try { storage.setItem(CURRENT_KEY, ""); } catch (e) {}
      try { profiles.forEach(p => storage.setItem(QUIZ_KEY(p.id), "null")); } catch (e) {}
      account = null; child = null; data = null; sum = null; profiles = []; banks = {};
      show({ mode: "signin" });
    };
    return;
  }
  stage.classList.remove("solo");
  side.hidden = false;
  const s = app.state;
  const rungs = [4, 3, 2, 1].map(l => `<div class="rung ${s.level === l ? "on" : ""}"><span>L${l} ${LEVEL_NAMES[l]}</span><span>${s.responses.filter(r => r.level === l && r.firstTryCorrect).length}✓</span></div>`).join("");
  side.innerHTML = `<span class="label">Tester view (not in the app)</span>
    <span class="small muted">Highlighted: level of the next question</span>
    <div class="ladder">${rungs}</div>
    <div class="stat"><span>Marks</span><b>${s.marks} / ${maxMarks()}</b></div>
    <div class="stat"><span>Right first time</span><b>${s.correct} / ${s.asked.length}</b></div>
    <div class="stat"><span>Attempt</span><b>${s.attemptNo}</b></div>
    ${DEMO ? `<div class="tools"><span class="label">Tester tools</span>
      <button class="ghost" type="button" id="tright">Right</button>
      <button class="ghost" type="button" id="twrongonce">Wrong once (shows the hint)</button>
      <button class="ghost" type="button" id="twrong">Wrong twice</button>
      <button class="ghost" type="button" id="tnext" ${app.phase === "done" ? "" : "disabled"}>Next</button></div>` : ""}`;
  if (!DEMO) return;
  const q = app.q;
  const wrong = () => q.options.find(o => !q.answers.includes(o) && !(app.tries ?? []).includes(o)) ?? q.options.find(o => !q.answers.includes(o));
  document.getElementById("tright").onclick = () => tester(q.answers[0]);
  document.getElementById("twrong").onclick = () => tester(wrong());
  document.getElementById("twrongonce").onclick = () => { if (app.phase === "ask") answer(wrong()); else tester(wrong()); };
  document.getElementById("tnext").onclick = () => { if (app.phase === "done") quizDone() ? finish() : nextQ(); };
}

function tester(choice) {
  if (app.phase === "done") { quizDone() ? finish() : nextQ(); return; }
  answer(choice);
  if (app.phase === "retry") answer(app.q.options.find(o => !app.q.answers.includes(o) && !(app.tries ?? []).includes(o)) ?? choice);
}

const SCREENS = {
  loading: () => { screen.innerHTML = `<div class="hero">${MASCOT}<p class="muted">Loading…</p></div>`; },
  error: () => { screen.innerHTML = `<div class="narrow">${errorLine()}</div>`; },
  signin: renderSignin, "email-sent": renderEmailSent, consent: renderConsent, notice: renderNotice, "set-pin": renderSetPin, pin: renderPin, "forgot-pin": renderForgotPin,
  profiles: renderProfiles, onboard: renderOnboard, "placement-offer": renderPlacementOffer, placement: renderPlacement,
  "placement-result": renderPlacementResult, grownups: renderGrownups, "child-settings": renderChildSettings,
  admin: renderAdmin, fix: renderFix, "child-progress": renderChildProgress,
  dash: renderDash, lesson: renderLesson, quiz: renderQuiz, result: renderResult, "practice-done": renderPracticeDone,
};

/* ---------- the two looks ---------- */
// A child's own screens float on the page in the child's look; grown-up screens use the clean look.
const KID_SCREENS = ["placement-offer", "placement", "placement-result", "dash", "lesson", "quiz", "result", "practice-done"];
const PLAYING = ["dash", "lesson", "quiz", "result", "practice-done"];

function look() {
  if (PLAYING.includes(app.mode) && child) return M.lookFor(child.classId, settings.child?.look);
  if (app.mode.startsWith("placement") && app.draft?.classId) return M.classLook(app.draft.classId);
  return "focus";
}

function render() {
  if (!["pin", "set-pin"].includes(app.mode)) document.onkeydown = null;
  const kid = KID_SCREENS.includes(app.mode);
  document.documentElement.dataset.look = look();
  document.documentElement.dataset.screen = kid ? "kid" : "grown";
  screen.classList.toggle("kid", kid);
  (SCREENS[app.mode] || SCREENS.error)();
  renderSide();
  tag.textContent = DEMO ? "Demo · everything stays in this browser" : account?.email ?? "";
  trackHistory();
  // A new screen, or a new question, starts at the top with focus on its heading or question.
  const view = app.mode + (app.topicId || "") + (app.page ?? "") + (app.step ?? "") + (app.i ?? "") + (app.mode === "quiz" ? app.q.id : "");
  if (view !== lastView) {
    const fresh = app.mode !== lastViewMode;
    lastView = view;
    lastViewMode = app.mode;
    try { window.scrollTo(0, 0); } catch (e) {}
    if (fresh) { screen.classList.remove("enter"); void screen.offsetWidth; screen.classList.add("enter"); }
    if (!screen.contains(document.activeElement) || document.activeElement === screen) {
      const head = screen.querySelector(".prompt[tabindex], h1, h2[tabindex], h2");
      if (head) { if (!head.hasAttribute("tabindex")) head.setAttribute("tabindex", "-1"); head.focus({ preventScroll: true }); }
    }
  }
}
let lastView = "", lastViewMode = "";

/* ---------- the back button ---------- */
// Each new screen adds a history entry, so Android's back gesture steps back inside Nitya instead of leaving it.
let historyMode = null;
function trackHistory() {
  if (app.mode === historyMode) return;
  historyMode = app.mode;
  try { history.pushState({ nitya: app.mode }, ""); } catch (e) {}
}
window.addEventListener("popstate", () => {
  historyMode = null;   // the screen we land on pushes a fresh entry, so back keeps working
  const m = app.mode;
  if (m === "quiz" || m === "placement") { app.confirmStop = true; return render(); }
  if (m === "lesson") return app.peek ? backToQuiz() : goDash();
  if (["result", "practice-done"].includes(m)) return goDash();
  if (m === "pin" && app.cancel) return app.cancel();
  if (["child-settings", "child-progress", "admin"].includes(m)) return show({ mode: "grownups" });
  if (m === "fix") return openAdmin("queue");
  if (m === "notice" || m === "forgot-pin") return show(app.back && app.back.mode !== m ? app.back : { mode: "signin" });
  if (m === "onboard") { const b = document.getElementById("obback"); if (b && !b.hidden) return b.click(); }
  if (m === "grownups" && child) return goDash();
  render();
});

boot();
