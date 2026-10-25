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
  modeBtn.innerHTML = dark ? `${SUN}Light` : `${MOON}Dark`;
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

const MASCOT = `<svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
  <ellipse cx="32" cy="36" rx="24" ry="24" fill="var(--sun)"/>
  <circle cx="23" cy="30" r="8" fill="var(--card)"/><circle cx="41" cy="30" r="8" fill="var(--card)"/>
  <circle cx="24" cy="31" r="4" fill="var(--ink)"/><circle cx="40" cy="31" r="4" fill="var(--ink)"/>
  <path d="M28 41 L32 46 L36 41 Z" fill="var(--coral)"/>
  <path d="M16 19 Q23 14 29 19 M35 19 Q41 14 48 19" fill="none" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/>
  <path d="M26 50 Q32 54 38 50" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linecap="round"/></svg>`;

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

/* ---------- speech ---------- */
function speak(text) {
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 0.9; speechSynthesis.speak(u); } catch (e) {}
}
const SPEAKER = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>`;
const listenBtn = text => `<button class="ghost" type="button" data-say="${esc(text)}">${SPEAKER}Listen</button>`;
screen.addEventListener("click", e => { const b = e.target.closest("[data-say]"); if (b) speak(b.dataset.say); });

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
/** One answer button. The clean look shows its key (A, B, C) and lets a keyboard press it. */
function optionButtons(options, attr, { disabled = false, tried = null } = {}) {
  return `<div class="opts">${options.map((o, i) => `<button class="btn ${String(o).length > 3 ? "long" : ""}" type="button" ${attr}="${esc(o)}" ${disabled ? "disabled" : ""}>
    <span class="key" aria-hidden="true">${KEYS[i] ?? ""}</span><span>${esc(o)}</span>${o === tried ? `<span class="tried-note">tried</span>` : ""}</button>`).join("")}</div>`;
}
const keyHint = n => `<p class="keyhint small muted">Tap an answer, or press ${[...KEYS.slice(0, n)].join(", ").replace(/, ([^,]*)$/, " or $1")}.</p>`;

const ICON_GOOD = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--leaf)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>`;
const ICON_HINT = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--coral)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/></svg>`;
/** A feedback card: "good" after a right answer, "gentle" with a hint or the worked answer. `note` is a small line under it. */
const feedbackCard = (kind, title, body, note = "") =>
  `<div class="feedback ${kind}">${kind === "good" ? ICON_GOOD : ICON_HINT}<div><b class="fb-title">${title}</b>${body}${note ? `<p class="fb-note">${note}</p>` : ""}</div></div>`;

/* ---------- sign-in ---------- */
function renderSignin() {
  screen.innerHTML = `<div class="narrow">
    <div class="hero">${MASCOT}<h1>Welcome to Nitya</h1><p>Maths practice that grows with your child, one topic at a time.</p></div>
    <p class="muted">Grown-ups sign in here. Children play inside your account, each with their own profile.</p>
    <button class="btn primary wide" type="button" id="google">Continue with Google</button>
    <div class="or">or</div>
    <form id="emailform" novalidate>
      <label for="email">Your email</label>
      <input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" value="${esc(app.email ?? "")}">
      <button class="ghost" type="submit">Email me a sign-in link</button>
    </form>
    ${errorLine()}
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
}

function renderEmailSent() {
  screen.innerHTML = `<div class="narrow">
    <div class="hero">${MASCOT}<h1>Check your email</h1><p>We sent a sign-in link to <b>${esc(app.email)}</b>. Open it on this device to come back signed in.</p></div>
    ${DEMO ? `<p class="note">Demo: no email was sent. Tap below to carry on as if you opened the link.</p>
      <button class="btn primary wide" type="button" id="open">Open the link</button>` : ""}
    ${errorLine()}
    <button class="ghost" type="button" id="back">Use a different email</button>
  </div>`;
  const open = document.getElementById("open");
  if (open) open.onclick = () => step(async () => { await backend.openDemoLink(); account = await backend.account(); await route(); });
  document.getElementById("back").onclick = () => show({ mode: "signin", email: app.email });
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
    <p>Nitya is for children, so the law (COPPA, and India's DPDP Act) asks a parent to agree before anything about a child is saved.</p>
    <ul class="points">${M.CONSENT_POINTS.map(p => `<li>${esc(p)}</li>`).join("")}</ul>
    <label class="check"><input type="checkbox" id="agree"> <span>${esc(M.CONSENT_AGREEMENT)}</span></label>
    ${errorLine()}
    <div class="row"><button class="btn primary" type="button" id="ok" disabled>I agree</button>
      <button class="ghost" type="button" id="signout">Sign out</button></div>
    <p class="small muted">Consent version ${esc(M.CONSENT_VERSION)}. The date you agree is kept with it.</p>
  </div>`;
  const agree = document.getElementById("agree"), ok = document.getElementById("ok");
  agree.onchange = () => { ok.disabled = !agree.checked; };
  ok.onclick = () => step(async () => {
    await backend.giveConsent(M.CONSENT_VERSION);
    account = await backend.account();
    await route();
  });
  document.getElementById("signout").onclick = () => step(signOut);
}

/* ---------- parent PIN ---------- */
let pinLockedUntil = 0, pinWrong = 0, pinTimer = null;

function pinPad(title, text) {
  const n = (app.pin || "").length;
  return `<div class="narrow" style="justify-items:center;text-align:center">
    <span class="label">Grown-ups only</span><h1>${esc(title)}</h1><p>${esc(text)}</p>
    <div class="pin-dots" aria-label="${n} of 4 digits">${[0, 1, 2, 3].map(i => `<span class="${i < n ? "on" : ""}"></span>`).join("")}</div>
    ${errorLine()}
    <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => `<button class="btn" type="button" data-digit="${d}">${d}</button>`).join("")}
      <button class="btn" type="button" id="pinback" aria-label="Delete a digit">⌫</button>
      <button class="btn" type="button" data-digit="0">0</button>
      <span></span></div>
    ${app.cancel ? `<button class="ghost" type="button" id="pincancel">Cancel</button>` : ""}
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
  screen.innerHTML = pinPad(confirming ? "Type the PIN again" : "Set a parent PIN",
    confirming ? "Just to be sure." : "4 digits that only grown-ups know. Nitya asks for it before switching children, editing a profile or opening settings.");
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
    app.error = `Too many tries. Wait ${wait} seconds.`;
    clearTimeout(pinTimer);
    pinTimer = setTimeout(() => { if (app.mode === "pin") { app.error = null; render(); } }, wait * 1000);
  }
  screen.innerHTML = pinPad("Parent PIN", app.purpose);
  wirePinPad(pin => step(async () => {
    if (Date.now() < pinLockedUntil) { render(); return; }
    if (await M.verifyPin(pin, account.pinHash)) { pinWrong = 0; app.then(); return; }
    pinWrong++;
    if (pinWrong >= M.PIN_TRIES) { pinWrong = 0; pinLockedUntil = Date.now() + M.PIN_WAIT_SECONDS * 1000; }
    app.error = "That isn't the PIN. Try again.";
    render();
  }));
}

/* ---------- choosing a child ---------- */
function renderProfiles() {
  screen.innerHTML = `<div class="narrow" style="max-width:720px">
    <h1>Who's playing?</h1>
    <div class="kids">${profiles.map(p => `<button class="btn kid-btn" type="button" data-kid="${p.id}">
      <span class="emoji" aria-hidden="true">${M.avatarEmoji(p.avatar)}</span>${esc(p.nickname)}<small class="muted small">${esc(className(p.classId))}</small></button>`).join("")}</div>
    ${errorLine()}
    <div class="row"><button class="ghost" type="button" id="add">Add a child</button>
      <button class="ghost" type="button" id="grownups">Grown-ups</button></div>
  </div>`;
  screen.querySelectorAll("[data-kid]").forEach(b => b.onclick = () => step(() => openProfile(profiles.find(p => p.id === b.dataset.kid))));
  document.getElementById("add").onclick = () => askPin("To add a child.", startOnboarding);
  document.getElementById("grownups").onclick = () => askPin("To open the grown-ups' page.", () => show({ mode: "grownups" }));
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
    aria-pressed="${app.draft[field] === i.id}">${i.emoji ? `<span class="emoji" aria-hidden="true">${i.emoji}</span><small>${esc(i.name)}</small>` : esc(i.name)}</button>`).join("")}</div>`;
}

function renderOnboard() {
  const d = app.draft, field = ONBOARD_STEPS[app.step];
  const nick = esc(d.nickname || "your child");
  const steps = `<div class="steps" aria-label="Step ${app.step + 1} of ${ONBOARD_STEPS.length}">${ONBOARD_STEPS.map((_, i) => `<span class="${i <= app.step ? "on" : ""}"></span>`).join("")}</div>`;
  let body;
  if (field === "nickname") {
    body = `<h1>${app.editing ? "Edit the profile" : "Add a child"}</h1>
      <form id="nickform" novalidate><label for="nick">What should Nitya call your child?</label>
        <input id="nick" type="text" autocomplete="off" maxlength="20" value="${esc(d.nickname)}" placeholder="Riya">
        <p class="small muted">A nickname, not the full name.</p>
        ${errorLine()}
        <button class="btn primary" type="submit">Next</button></form>`;
  } else if (field === "avatar") {
    body = `<h1>Pick an animal friend for ${nick}</h1>${choiceButtons("avatar", M.AVATARS, "avatars")}`;
  } else if (field === "class") {
    const classes = M.CLASSES_WITH_CONTENT.map(c => ({ id: c, name: className(c) }));
    body = `<h1>Which class is ${nick} in?</h1>${choiceButtons("classId", classes)}<p class="small muted">More classes are on the way.</p>`;
  } else if (field === "board") {
    body = `<h1>Which board does ${nick}'s school follow?</h1>${choiceButtons("board", M.BOARDS)}`;
  } else {
    body = `<h1>Which language does ${nick} like best?</h1>${choiceButtons("language", M.LANGUAGES)}<p class="small muted">Questions are in English for now.</p>`;
  }
  screen.innerHTML = `<div class="narrow">${steps}${body}${field !== "nickname" ? errorLine() : ""}
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
    if (app.step < ONBOARD_STEPS.length - 1) { app.step++; render(); } else finishOnboarding();
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
    <div class="row"><button class="btn primary" type="button" id="check">Start the check</button>
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
    <div class="row" style="justify-content:space-between"><span class="muted small">Quick check · Question ${app.i + 1} of ${app.qs.length}</span>
      <button class="ghost" type="button" id="stop">Stop the check</button></div>
    <div class="steps">${app.qs.map((_, i) => `<span class="${i < app.i ? "on" : ""}"></span>`).join("")}</div>
    <div class="mascot">${MASCOT}<div class="bubble"><p class="prompt">${esc(q.prompt)}</p></div></div>
    ${dotsSvg(q.visual)}
    ${optionButtons(q.options, "data-opt")}
    <div class="row">${listenBtn(q.prompt)}</div>
    <p class="small muted">No marks here. Just do your best!</p>`;
  screen.querySelectorAll("[data-opt]").forEach(b => b.onclick = () => {
    app.results.push(M.checkAnswer(q, b.dataset.opt));
    if (++app.i < app.qs.length) render();
    else show({ mode: "placement-result", draft: app.draft, suggestion: M.placementSuggestion(app.draft.classId, app.draft.nickname, app.results, M.CLASSES_WITH_CONTENT) });
  });
  document.getElementById("stop").onclick = () => show({ mode: "placement-offer", draft: app.draft });
}

function renderPlacementResult() {
  const { draft: d, suggestion: s } = app;
  const differs = s.suggested !== d.classId;
  screen.innerHTML = `<div class="narrow">
    <div class="mascot">${MASCOT}<div class="bubble"><h2>All done!</h2><p>${esc(s.message)}</p></div></div>
    <p class="muted">Grown-up, please choose the class to start in. You can change it later in Grown-ups.</p>
    ${errorLine()}
    <div class="row"><button class="btn primary" type="button" id="use">Start in ${esc(className(s.suggested))}</button>
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
};

function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderGrownups() {
  screen.innerHTML = `<div class="narrow">
    <span class="label">Grown-ups</span><h1>Your family</h1>
    ${account.email ? `<p class="muted">Signed in as ${esc(account.email)}</p>` : ""}
    ${app.note ? `<p class="note" role="status">${esc(app.note)}</p>` : ""}
    ${errorLine()}
    <div class="family">${profiles.map(p => `<div class="member">
      <span class="emoji" aria-hidden="true">${M.avatarEmoji(p.avatar)}</span>
      <div><b>${esc(p.nickname)}</b><div class="small muted">${esc(className(p.classId))} · ${esc(M.BOARDS.find(b => b.id === p.board)?.name ?? p.board)} · ${esc(M.LANGUAGES.find(l => l.id === p.language)?.name ?? p.language)}</div></div>
      <div class="row">
        <button class="ghost tonal" type="button" data-settings="${p.id}">${ICONS.settings}Settings</button>
        <button class="ghost" type="button" data-edit="${p.id}">${ICONS.edit}Edit<span class="roomy"> profile</span></button>
      </div>
      <div class="row member-more">
        <button class="ghost quiet" type="button" data-download="${p.id}">${ICONS.download}Download<span class="roomy"> data</span></button>
        <button class="ghost quiet danger ${app.confirmDelete === p.id ? "sure" : ""}" type="button" data-delete="${p.id}">${ICONS.trash}${app.confirmDelete === p.id ? `Tap again to delete ${esc(p.nickname)}` : "Delete"}</button>
      </div></div>`).join("")}
      <button class="ghost addkid" type="button" id="add">${ICONS.plus}Add a child</button></div>
    ${app.exported ? `<details><summary>Show ${esc(app.exported.name)}'s data</summary><pre class="data">${esc(JSON.stringify(app.exported.value, null, 2))}</pre></details>` : ""}
    ${account.isAdmin
      ? `<div class="panel"><span class="label">Admin</span><p class="small muted">Check questions that failed a check, set each class's default pass mark and marks off, and set the level bands.</p>
          <div class="row"><button class="ghost tonal" type="button" id="admin">Open the admin panel${ICONS.arrow}</button></div></div>`
      : DEMO ? `<div class="panel"><span class="label">Admin (demo)</span><p class="small muted">In the real app only Nitya's admin sees the admin panel. In the demo you can try it.</p>
          <div class="row"><button class="ghost tonal" type="button" id="demoadmin">Make me the admin${ICONS.arrow}</button></div></div>` : ""}
    <div class="row account"><button class="ghost quiet" type="button" id="pin">${ICONS.lock}Change the PIN</button>
      <button class="ghost quiet" type="button" id="signout">${ICONS.out}Sign out</button></div>
    <div class="row"><button class="btn primary" type="button" id="done">${child ? `Back to ${esc(child.nickname)}` : "Choose a child"}</button></div>
  </div>`;
  screen.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => startOnboarding(profiles.find(p => p.id === b.dataset.edit)));
  screen.querySelectorAll("[data-download]").forEach(b => b.onclick = () => step(async () => {
    const p = profiles.find(x => x.id === b.dataset.download);
    const value = { exportedAt: new Date().toISOString(), profile: p, ...(await backend.profileData(p.id)), quizSettings: await backend.childSettings(p.id) };
    try { download(`nitya-${p.nickname}.json`, value); } catch (e) {}
    show({ ...app, exported: { name: p.nickname, value }, note: `${p.nickname}'s data is downloading. It is also shown below.`, error: null });
  }));
  screen.querySelectorAll("[data-delete]").forEach(b => b.onclick = () => step(async () => {
    const id = b.dataset.delete;
    if (app.confirmDelete !== id) { show({ ...app, confirmDelete: id }); return; }
    const gone = profiles.find(p => p.id === id);
    await backend.deleteProfile(id);
    profiles = profiles.filter(p => p.id !== id);
    if (child && child.id === id) { child = null; data = null; sum = null; }
    if (!profiles.length) { startOnboarding(); return; }
    show({ mode: "grownups", note: `${gone.nickname}'s profile and progress are deleted.` });
  }));
  screen.querySelectorAll("[data-settings]").forEach(b => b.onclick = () => openChildSettings(b.dataset.settings));
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
  const lim = M.QUIZ_LIMITS, MAX = M.maxMarks(p.classId);
  const percent = app.mine.passPercent ?? def.passPercent;
  const changed = app.mine.passPercent !== null || app.mine.wrongPenalty !== null;
  const byClass = M.classLook(p.classId);
  const looks = [
    [null, `Follow the class: ${LOOK_NAMES[byClass].toLowerCase()} for ${cls}`, "Playful up to Class 5, clean from Class 6.", byClass],
    ["play", LOOK_NAMES.play, "Bright colours, big buttons and the owl.", "play"],
    ["focus", LOOK_NAMES.focus, "Calm colours, simple cards and A/B/C answers.", "focus"],
  ];
  screen.innerHTML = `<div class="narrow">
    <span class="label">Grown-ups</span><h1>Settings for ${name}</h1>
    <p class="muted">These apply to every topic ${name} plays, from the next quiz. Choose what fits ${name}: higher to push further, lower to make it easier.</p>
    <div class="setting">
      <div class="row" style="justify-content:space-between"><h3>${name}'s quizzes</h3>${changed ? `<span class="chip current">Changed</span>` : ""}</div>
      <div class="limits">
        ${numberField("my-pass", "Pass mark, in %", percent)}
        ${numberField("my-pen", "Marks off for a wrong first try", eff.wrongPenalty)}
      </div>
      <p class="small muted">${percent}% is ${eff.passMarks} of the ${MAX} marks a quiz can give. ${cls}'s default is ${def.passPercent}% to pass and ${def.wrongPenalty} ${def.wrongPenalty === 1 ? "mark" : "marks"} off for a wrong first try. A pass mark can be ${lim.passPercent.min}% to ${lim.passPercent.max}%, and marks off ${lim.wrongPenalty.min} to ${lim.wrongPenalty.max}.</p>
      ${app.note ? `<p class="note" role="status">${esc(app.note)}</p>` : ""}
      ${errorLine()}
      <div class="row"><button class="ghost tonal" type="button" id="savemine">Save</button>
        ${changed ? `<button class="ghost quiet" type="button" id="usedefault">Use ${cls}'s default</button>` : ""}</div>
    </div>
    <div class="setting">
      <h3>How Nitya looks for ${name}</h3>
      <div class="looks" role="group" aria-label="Look">${looks.map(([id, title, text, swatch]) => `
        <button class="ghost ${app.mine.look === id ? "on" : ""}" type="button" data-pick-look="${id ?? ""}" aria-pressed="${app.mine.look === id}">
          <span class="swatch ${swatch}" aria-hidden="true"></span><span><span>${esc(title)}</span><small>${esc(text)}</small></span></button>`).join("")}</div>
      ${app.lookNote ? `<p class="note" role="status">${esc(app.lookNote)}</p>` : ""}
    </div>
    <div class="row"><button class="btn primary" type="button" id="done">Back to Grown-ups</button></div>
  </div>`;
  screen.querySelectorAll("[data-pick-look]").forEach(b => b.onclick = () => saveLook(b.dataset.pickLook || null));
  document.getElementById("savemine").onclick = () => saveMine(def, {
    passPercent: Number(document.getElementById("my-pass").value), wrongPenalty: Number(document.getElementById("my-pen").value),
  });
  const reset = document.getElementById("usedefault");
  if (reset) reset.onclick = () => saveMine(def, { passPercent: null, wrongPenalty: null });
  document.getElementById("done").onclick = () => show({ mode: "grownups" });
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
    <p class="prompt">${esc(q.prompt)}</p>
    ${dotsSvg(q.visual)}
    ${q.options ? `<div class="optlist">${q.options.map(o => `<span class="${q.answers.includes(o) ? "ans" : ""}">${esc(o)}</span>`).join("")}</div>` : ""}
    <p class="small">Answer given: <b>${esc(q.answers.join(", "))}</b></p>
    <ul class="problems">${problems.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    <div class="row">
      <button class="ghost" type="button" data-decide="approved" data-q="${q.id}">${confirming("approved") ? "Tap again to approve as it is" : "Approve"}</button>
      ${M.canFixHere(q) ? `<button class="ghost" type="button" data-fixq="${q.id}">Fix</button>` : ""}
      <button class="ghost" type="button" data-decide="rejected" data-q="${q.id}">${confirming("rejected") ? "Tap again to reject" : "Reject"}</button>
    </div>
    ${M.canFixHere(q) ? "" : `<p class="small muted">This came from a CSV, so fix it in the Drive file (${esc(q.sourceRef ?? "its row")}). The next sync checks it again.</p>`}
  </div>`;
}

function renderAdmin() {
  const tabs = `<div class="tabs" role="tablist">${ADMIN_TABS.map(([id, name]) => `<button class="ghost ${app.tab === id ? "on" : ""}" type="button" role="tab"
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
      ${app.classMsg ? `<p class="${app.classMsg.error ? "error" : "note"}" role="status">${esc(app.classMsg.text)}</p>` : ""}
      <div class="row"><button class="ghost" type="button" id="saveclasses">Save</button></div>`;
  } else if (app.tab === "bands") {
    const c = app.cuts;
    const pct = (f, label) => `<label>${label}<input type="number" inputmode="numeric" id="cut-${f}" value="${c[f]}"></label>`;
    body = `<p class="muted">How often children should get a question right first time at each level. A question whose live results fall outside its level's band goes back through the checks.</p>
      <div class="nums">${pct("l1", "L1 Easy from %")}${pct("l2", "L2 Medium from %")}${pct("l3", "L3 Hard from %")}</div>
      <ul class="points small" id="bandtext">${bandText(c)}</ul>
      <div class="row"><button class="ghost" type="button" id="savebands">Save the bands</button></div>`;
  } else if (app.tab === "newq") {
    body = `<p class="muted">Make questions from a topic's templates. Each one is checked; those that fail wait in the review queue. Families can ask ${M.NEW_QUESTIONS_PER_DAY} times a day; you can ask any time.</p>
      <div class="family">${M.ALL_CONTENT.map((c, i) => `<div class="member"><div><b>${esc(c.topic.title)}</b><div class="small muted">${esc(className(c.topic.classId))} · ${app.counts[i]} approved questions</div></div>
        <div class="row"><button class="ghost" type="button" data-adminnewq="${c.topic.id}" ${newqBusy ? "disabled" : ""}>${newqBusy === c.topic.id ? "Making questions…" : "New questions"}</button></div></div>`).join("")}</div>
      <span class="label">Recent requests</span>
      ${app.log.length ? `<div class="log">${app.log.map(r => `<div><span>${esc(new Date(r.requestedAt).toLocaleString())}</span><span>${esc(topicTitle(r.topicId))}</span>
        <span>${r.by === "child" ? "A child" : "A grown-up"}</span><span>${r.added} added${r.sentToReview ? `, ${r.sentToReview} to review` : ""}</span></div>`).join("")}</div>` : `<p class="small muted">No requests yet.</p>`}`;
  }
  screen.innerHTML = `
    <div class="row" style="justify-content:space-between"><div style="display:grid;gap:4px"><span class="label">Admin</span><h1>Admin panel</h1></div>
      <button class="ghost" type="button" id="back">Back to Grown-ups</button></div>
    ${tabs}
    ${app.note ? `<p class="note" role="status">${esc(app.note)}</p>` : ""}
    ${app.newqNote ? `<p class="note" role="status">${esc(app.newqNote)}</p>` : ""}
    ${errorLine()}
    ${body}`;

  document.getElementById("back").onclick = () => show({ mode: "grownups" });
  screen.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => openAdmin(b.dataset.tab));
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
    <span class="label">Admin · Fix a question</span><h1>${esc(topicTitle(q.topicId))}</h1>
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
    phase: "ask", feedback: null, prevMarks: 0, delta: null,
  };
  app.q = M.nextQuestion(app.state, app.bank);
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

function nextQ() {
  app.prevMarks = app.state.marks;
  app.delta = null;
  app.q = M.nextQuestion(app.state, app.bank);
  app.phase = "ask";
  app.feedback = null;
  app.tried = null;
  render();
}

function finish() {
  const s = app.state;
  const playId = app.playId, profileId = child.id;
  const play = data.attempts.find(a => a.id === playId);
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
  const states = topics.map(t => sum.progress.topics[t.id]);
  const clearedCount = states.filter(s => s.state === "cleared").length;
  const totalStars = Object.values(sum.stars).reduce((a, b) => a + b, 0);
  const next = M.nextClass(child.classId);
  const pass = quizSettings().passMarks, passPct = (pass / MAX) * 100;

  const rows = topics.map((t, i) => {
    const e = sum.progress.topics[t.id];
    const stars = sum.stars[t.id] || 0;
    const bestPct = Math.min(100, (e.bestScore / MAX) * 100);
    const chip = e.state === "cleared" ? `<span class="chip cleared">Cleared</span>` : e.state === "current" ? `<span class="chip current">Up next</span>` : `<span class="chip">Locked</span>`;
    const score = e.attempts
      ? `<span>Best ${e.bestScore} / ${MAX}</span><span class="mini" aria-hidden="true"><b class="${e.bestScore >= pass ? "ok" : ""}" style="width:${bestPct}%"></b><i style="left:${passPct}%"></i></span><span>${e.attempts} ${e.attempts === 1 ? "try" : "tries"}</span>${stars ? `<span class="stars-sm" aria-label="${stars} stars">${"★".repeat(stars)}${"☆".repeat(3 - stars)}</span>` : ""}`
      : e.state === "locked" ? `<span>Opens after topic ${i}</span>` : `<span>Not started</span>`;
    const act = e.state === "current"
      ? `<button class="chipbtn" type="button" data-open="${t.id}">${e.attempts ? "Try again" : "Start"}</button>`
      : e.state === "cleared" ? `<button class="chipbtn soft" type="button" data-open="${t.id}">Practise</button>` : "";
    const newq = e.state === "locked" ? "" : `<button class="linkbtn" type="button" data-newq="${t.id}" ${newqBusy ? "disabled" : ""}>${newqBusy === t.id ? "Making questions…" : "New questions"}</button>`;
    // The clean look's ring fills with the best score so far.
    const ring = e.state === "cleared" ? 100 : Math.round(bestPct);
    return `<div class="topic ${e.state}">
      <span class="num" style="--p:${ring}" aria-hidden="true">${e.state === "cleared" ? "✓" : e.state === "locked" ? lockIcon() : i + 1}</span>
      <div class="tmain"><div class="row" style="gap:8px"><h3>${esc(t.title)}</h3>${chip}</div><div class="tmeta">${score}</div></div>
      <div class="act">${act}${newq}</div></div>`;
  }).join("");

  const areas = Object.entries(sum.skills)
    .map(([k, v]) => { const [tid, skill] = k.split("|"); return { tid, skill, acc: v.right / v.total, total: v.total }; })
    .filter(a => a.total >= 2 && a.acc < 0.8 && sum.progress.topics[a.tid])
    .sort((a, b) => a.acc - b.acc)
    .slice(0, 4);
  const areasHtml = areas.length
    ? areas.map(a => {
        const c = byId(a.tid);
        const open = sum.progress.topics[a.tid].state !== "locked";
        return `<div class="area"><div><b>${esc(c.subSkillNames[a.skill] || a.skill)}</b><div class="small muted">${esc(c.topic.title)} · ${Math.round(a.acc * 100)}% right</div></div>
          ${open ? `<button class="ghost" type="button" data-practice="${a.tid}|${a.skill}">Practise</button>` : ""}
          <span class="mini" aria-hidden="true"><b style="width:${a.acc * 100}%"></b></span></div>`;
      }).join("")
    : `<p class="muted small">Nothing to work on yet. After each quiz, skills under 80% show up here with a practice button.</p>`;

  const levelsHtml = [1, 2, 3, 4].map(l => {
    const v = sum.levels[l];
    const pct = v && v.total ? Math.round((v.right / v.total) * 100) : null;
    return `<div class="lvlrow"><span>L${l} ${LEVEL_NAMES[l]}</span><span class="mini" aria-hidden="true"><b style="width:${pct ?? 0}%"></b></span><span>${pct === null ? "–" : pct + "%"}</span></div>`;
  }).join("");

  const cls = className(child.classId);
  screen.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <div class="who"><span class="emoji" aria-hidden="true">${M.avatarEmoji(child.avatar)}</span><b>${esc(child.nickname)}</b></div>
      <div class="row"><button class="ghost" type="button" id="switch">Switch child</button>
        <button class="ghost" type="button" id="grownups">Grown-ups</button></div></div>
    ${saveError ? `<p class="banner" role="alert">${esc(saveError)}</p>` : ""}
    ${app.newqNote ? `<p class="note" role="status">${esc(app.newqNote)}</p>` : ""}
    <section class="block">
      <div class="dash-head">
        <div style="display:grid;gap:4px"><span class="label">Class dashboard</span><h1>${esc(cls)} Maths</h1></div>
        <div class="row" style="gap:24px">
          <div><div class="bigstat">${clearedCount} / ${topics.length}</div><div class="small muted">topics cleared</div></div>
          <div><div class="bigstat"><span style="color:var(--star)" aria-hidden="true">★</span> ${totalStars}</div><div class="small muted">stars</div></div>
        </div>
      </div>
      <div class="overall">
        <div class="segs" style="--n:${topics.length}" aria-label="${clearedCount} of ${topics.length} topics cleared">${states.map(s => `<span class="seg ${s.state}"></span>`).join("")}</div>
        <p class="small muted">${sum.promoted ? `${esc(cls)} complete!${next ? ` ${esc(className(next))} opens when its topics are ready.` : ""}` : `Clear every topic to move up${next ? ` to ${esc(className(next))}` : ""}. Each quiz needs ${passPercent()}% (${pass} of ${MAX} marks).`}</p>
      </div>
    </section>
    <div class="topics">${rows}</div>
    <div class="panels">
      <div class="panel"><span class="label">Improvement areas</span>${areasHtml}</div>
      <div class="panel"><span class="label">Right first time, by level</span>${levelsHtml}</div>
    </div>`;
  screen.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openTopic(b.dataset.open));
  screen.querySelectorAll("[data-practice]").forEach(b => b.onclick = () => { const [t, s] = b.dataset.practice.split("|"); startQuiz(t, s); });
  screen.querySelectorAll("[data-newq]").forEach(b => b.onclick = async () => { await askNewQuestions(b.dataset.newq, child.id); toTop(); });
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
  const crumbs = `<div class="row" style="justify-content:space-between"><span class="muted small">${esc(c.topic.title)} · Lesson ${Math.min(app.page + 1, n)} of ${n}</span>
    ${app.peek ? `<button class="ghost" type="button" id="backq">Back to my question</button>` : `<button class="ghost" type="button" id="todash">Class map</button>`}</div>`;
  if (app.page < pages.length) {
    const p = pages[app.page];
    screen.innerHTML = `${crumbs}
      <div class="mascot">${MASCOT}<div class="bubble"><h2>${esc(p.title)}</h2><p>${esc(p.text)}</p></div></div>
      ${dotsSvg(p.visual)}
      <div class="row">${listenBtn(p.text)}
        ${app.page > 0 ? `<button class="ghost" type="button" id="back">Back</button>` : ""}
        <button class="btn primary" type="button" id="next">Next</button></div>`;
    document.getElementById("next").onclick = () => { app.page++; render(); };
    const back = document.getElementById("back");
    if (back) back.onclick = () => { app.page--; render(); };
  } else {
    const t = c.tryIt;
    screen.innerHTML = `${crumbs}
      <div class="mascot">${MASCOT}<div class="bubble"><span class="label">Try it</span><p class="prompt">${esc(t.prompt)}</p></div></div>
      ${dotsSvg(t.visual)}
      ${optionButtons(t.options, "data-try")}
      <div id="tryfb"></div>
      <div class="row">${listenBtn(t.prompt)}<button class="ghost" type="button" id="back">Back</button></div>`;
    document.getElementById("back").onclick = () => { app.page--; render(); };
    screen.querySelectorAll("[data-try]").forEach(b => b.onclick = () => {
      const fb = document.getElementById("tryfb");
      if (b.dataset.try === t.answer) {
        b.classList.add("right");
        fb.innerHTML = `${feedbackCard("good", "You got it!", esc(t.praise))}
          <div class="row" style="margin-top:12px"><button class="btn primary" type="button" id="go">${app.peek ? "Back to my question" : "Start the quiz"}</button></div>`;
        document.getElementById("go").onclick = () => app.peek ? backToQuiz() : startQuiz(app.topicId);
      } else {
        b.classList.add("tried");
        fb.innerHTML = feedbackCard("gentle", "Let's look again.", `${esc(t.help)} Try again!`);
      }
    });
  }
  const td = document.getElementById("todash");
  if (td) td.onclick = goDash;
  const bq = document.getElementById("backq");
  if (bq) bq.onclick = backToQuiz;
}

function backToQuiz() { app = app.saved; app.prevMarks = app.state.marks; render(); }

function marksBar() {
  const s = app.state;
  const MAX = maxMarks();
  const PASS = s.passMarks;
  const passPct = (PASS / MAX) * 100;
  const q = s.marks >= PASS;
  const d = app.delta;
  const deltaHtml = d === null || d === undefined ? "" : d > 0 ? `<span class="delta up">+${d}</span>` : d < 0 ? `<span class="delta down">−${-d}</span>` : "";
  return `<div class="marks">
    <div class="marks-top">
      <div><span class="label">Marks</span><div><span class="marks-num">${s.marks}</span>${deltaHtml}</div></div>
      <span class="qual ${q ? "yes" : ""}">${q ? "Pass mark crossed! Keep going to the end." : `${PASS - s.marks} more ${PASS - s.marks === 1 ? "mark" : "marks"} to pass`}</span>
    </div>
    <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="${MAX}" aria-valuenow="${s.marks}" aria-label="Marks">
      <div class="fill ${q ? "qualified" : ""}" id="fill" style="width:${(Math.min(app.prevMarks, MAX) / MAX) * 100}%"></div>
      <div class="passmark ${q ? "crossed" : ""}" style="left:${passPct}%"><span>${q ? "✓ " : ""}Pass ${PASS}</span></div>
    </div>
    <div class="small muted">Right answers: Easy +1, Medium +2, Hard +3, Olympiad +4. A wrong first try takes away ${s.wrongPenalty}.</div>
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
  const tried = app.phase === "retry" ? app.tried : null;
  screen.innerHTML = `
    <div class="qtop">
      <div class="qtitle"><span class="muted small">${esc(c.topic.title)}${practice ? ` · Practice: ${esc(c.subSkillNames[app.practiceSkill])}` : ""}</span>
        <b>Question ${qNo} of ${total}</b></div>
      <button class="ghost" type="button" id="relesson">See the lesson</button></div>
    <div class="qprog" role="progressbar" aria-label="Questions done" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}">${
      Array.from({ length: total }, (_, i) => `<span class="${i < done ? "done" : i === done ? "now" : ""}"></span>`).join("")}</div>
    ${saveError ? `<p class="banner" role="alert">${esc(saveError)}</p>` : ""}
    ${practice ? "" : marksBar()}
    <div class="mascot">${MASCOT}<div class="bubble"><span class="lvl">L${q.level} ${LEVEL_NAMES[q.level]} <i>· worth ${M.MARKS_BY_LEVEL[q.level]} ${M.MARKS_BY_LEVEL[q.level] === 1 ? "mark" : "marks"}</i></span><p class="prompt">${esc(q.prompt)}</p></div></div>
    ${dotsSvg(q.visual)}
    ${optionButtons(q.options, "data-opt", { disabled: locked, tried })}
    ${locked ? "" : keyHint(q.options.length)}
    <div id="fb">${app.feedback ?? ""}</div>
    <div class="row">${listenBtn(q.prompt)}${locked ? `<button class="btn primary" type="button" id="cont">${quizDone() ? (practice ? "Finish practice" : "See my result") : "Next question"}</button>` : ""}</div>`;

  if (locked) screen.querySelectorAll("[data-opt]").forEach(b => { if (q.answers.includes(b.dataset.opt)) b.classList.add("right"); });
  if (tried) {
    const t = [...screen.querySelectorAll("[data-opt]")].find(b => b.dataset.opt === tried);
    if (t) { t.classList.add("tried"); t.disabled = true; }
  }
  // The clean look's A/B/C keys answer from a keyboard. The playful look leaves keys alone, for little hands on a laptop.
  if (look() === "focus") document.onkeydown = e => {
    if (app.mode !== "quiz" || e.ctrlKey || e.metaKey || e.altKey) return;
    const b = screen.querySelectorAll("[data-opt]")[KEYS.indexOf(e.key.toUpperCase())];
    if (e.key.length === 1 && b && !b.disabled) b.click();
  };
  const fill = document.getElementById("fill");
  if (fill) requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = (Math.min(s.marks, maxMarks()) / maxMarks()) * 100 + "%"; }));

  document.getElementById("relesson").onclick = () => { const saved = app; app = { mode: "lesson", topicId: saved.topicId, page: 0, peek: true, saved }; render(); };
  const cont = document.getElementById("cont");
  if (cont) cont.onclick = () => (quizDone() ? finish() : nextQ());
  screen.querySelectorAll("[data-opt]:not([disabled])").forEach(b => b.onclick = () => answer(b.dataset.opt));
}

function answer(choice) {
  const q = app.q;
  app.prevMarks = app.state.marks;
  if (app.phase === "ask") {
    const r = M.answerFirstTry(app.state, q, choice);
    app.state = r.state;
    app.delta = r.result.marksDelta;
    if (r.result.kind === "praise") {
      saveResponse(q);
      app.phase = "done";
      app.feedback = feedbackCard("good", pick(["Super!", "Well done!", "Brilliant!", "Yes!"]), esc(r.result.reason));
    } else {
      app.phase = "retry";
      app.tried = choice;
      // The retry never changes the marks (see answerRetry), so the child can try without worry.
      app.feedback = feedbackCard("gentle", "Nice try! Here's a hint.", `${esc(r.result.hint)} Have another go.`, "This try is for practice. It won't change your marks.");
    }
  } else if (app.phase === "retry") {
    const r = M.answerRetry(app.state, q, choice);
    app.state = r.state;
    saveResponse(q);
    app.phase = "done";
    app.feedback = r.retryCorrect
      ? feedbackCard("good", "You worked it out!", esc(r.explanation))
      : feedbackCard("gentle", "Let's do it together.", `${esc(r.explanation)} The answer is <b>${esc(r.answer)}</b>.`);
  }
  render();
}

function renderResult() {
  const { outcome: o, effect } = app;
  const c = byId(app.topicId);
  const MAX = maxMarks();
  const cls = className(child.classId);
  const passPct = (o.passMarks / MAX) * 100;
  const bar = `<div class="marks"><div class="marks-top"><div><span class="label">Final marks</span><div class="marks-num">${o.marks} / ${MAX}</div></div>
      <span class="qual ${o.cleared ? "yes" : ""}">${o.cleared ? "Above the pass mark" : `${o.passMarks - o.marks} short of the pass mark`}</span></div>
    <div class="track"><div class="fill ${o.cleared ? "qualified" : ""}" style="width:${(o.marks / MAX) * 100}%"></div><div class="passmark ${o.cleared ? "crossed" : ""}" style="left:${passPct}%"><span>Pass ${o.passMarks}</span></div></div>
    <div class="small muted">${o.correct} of ${M.QUIZ_LENGTH} right first time</div></div>`;

  if (o.cleared && effect.kind === "promoted") {
    const next = effect.to ? className(effect.to) : null;
    screen.innerHTML = `
      <div class="cert">${MASCOT}<span class="label">Certificate</span><h1>${esc(cls)} Maths complete!</h1>
        <p>${esc(child.nickname)} cleared all ${topicList().length} topics.${next ? ` Ready for ${esc(next)}!` : ""}</p>
        <div class="stars" aria-label="${o.stars} stars">${"★".repeat(o.stars)}${"☆".repeat(3 - o.stars)}</div>
        ${next ? `<p class="small muted">${esc(next)} opens when its topics are ready.</p>` : ""}</div>
      ${bar}
      <div class="row"><button class="btn primary" type="button" id="dash">See my ${esc(cls)} dashboard</button></div>`;
  } else if (o.cleared) {
    const next = byId(effect.topicId);
    screen.innerHTML = `
      <div class="mascot">${MASCOT}<div class="bubble"><h2>Topic cleared!</h2><p>${esc(c.topic.title)} is done. The next topic is open.</p></div></div>
      <div class="stars" aria-label="${o.stars} stars">${"★".repeat(o.stars)}${"☆".repeat(3 - o.stars)}</div>
      ${bar}
      <div class="row">
        <button class="btn primary" type="button" id="nexttopic">Next topic: ${esc(next.topic.title)}</button>
        <button class="ghost" type="button" id="dash">Class map</button>
        <button class="ghost" type="button" id="again">Play this one again</button>
      </div>`;
    document.getElementById("nexttopic").onclick = () => openTopic(next.topic.id);
  } else {
    const weak = o.weakSubSkills[0];
    screen.innerHTML = `
      <div class="mascot">${MASCOT}<div class="bubble"><h2>Almost there!</h2><p>You need ${o.passMarks} marks to open the next topic. Harder questions give more marks.</p></div></div>
      ${bar}
      <div class="row">
        <button class="btn primary" type="button" id="lesson">Watch the lesson again</button>
        <button class="ghost" type="button" id="again">Try with new questions</button>
        ${o.offerPractice && weak ? `<button class="ghost" type="button" id="practice">Extra practice: ${esc(c.subSkillNames[weak] || weak)}</button>` : ""}
        <button class="ghost" type="button" id="dash">Class map</button>
      </div>`;
    document.getElementById("lesson").onclick = () => openTopic(app.topicId);
    const pr = document.getElementById("practice");
    if (pr) pr.onclick = () => startQuiz(app.topicId, weak);
  }
  const again = document.getElementById("again");
  if (again) again.onclick = () => startQuiz(app.topicId);
  document.getElementById("dash").onclick = goDash;
}

function renderPracticeDone() {
  const c = byId(app.topicId);
  screen.innerHTML = `
    <div class="mascot">${MASCOT}<div class="bubble"><h2>Practice done!</h2><p>You got ${app.correct} of ${app.total} on ${esc(c.subSkillNames[app.skill])}. Practice does not change your marks.</p></div></div>
    <div class="row"><button class="btn primary" type="button" id="quiz">Try the quiz again</button><button class="ghost" type="button" id="dash">Class map</button></div>`;
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
    side.innerHTML = `<span class="label">Tester tools (demo only)</span>
      <p class="small muted">The demo keeps everything in this browser. Reset to start again from sign-in, with the built-in questions only.</p>
      <div class="tools"><button class="ghost" type="button" id="reset">Reset the demo</button></div>
      <p class="small muted">To try the admin panel, open Grown-ups and tap "Make me the admin".</p>`;
    const reset = document.getElementById("reset");
    reset.onclick = () => {
      if (!reset.dataset.sure) { reset.dataset.sure = "1"; reset.textContent = "Tap again to reset"; return; }
      for (const k of [M.DEMO_KEY, M.demoBankKey(M.DEMO_KEY), OLD_BANK_KEY]) { try { storage.setItem(k, "null"); } catch (e) {} }
      try { storage.setItem(CURRENT_KEY, ""); } catch (e) {}
      account = null; child = null; data = null; sum = null; profiles = []; banks = {};
      show({ mode: "signin" });
    };
    return;
  }
  stage.classList.remove("solo");
  side.hidden = false;
  const s = app.state;
  const rungs = [4, 3, 2, 1].map(l => `<div class="rung ${s.level === l ? "on" : ""}"><span>L${l} ${LEVEL_NAMES[l]}</span><span>${s.responses.filter(r => r.level === l && r.firstTryCorrect).length}✓</span></div>`).join("");
  side.innerHTML = `<span class="label">Grown-up view</span>
    <span class="small muted">Highlighted: level of the next question</span>
    <div class="ladder">${rungs}</div>
    <div class="stat"><span>Marks</span><b>${s.marks} / ${maxMarks()}</b></div>
    <div class="stat"><span>Right first time</span><b>${s.correct} / ${s.asked.length}</b></div>
    <div class="stat"><span>Attempt</span><b>${s.attemptNo}</b></div>
    ${DEMO ? `<div class="tools"><span class="label">Tester tools</span>
      <button class="ghost" type="button" id="tright">Answer right</button>
      <button class="ghost" type="button" id="twrong">Answer wrong</button></div>` : ""}`;
  if (!DEMO) return;
  const q = app.q;
  const wrong = () => q.options.find(o => !q.answers.includes(o) && o !== app.tried) ?? q.options.find(o => !q.answers.includes(o));
  document.getElementById("tright").onclick = () => tester(q.answers[0]);
  document.getElementById("twrong").onclick = () => tester(wrong());
}

function tester(choice) {
  if (app.phase === "done") { quizDone() ? finish() : nextQ(); return; }
  answer(choice);
  if (app.phase === "retry") answer(app.q.options.find(o => !app.q.answers.includes(o) && o !== app.tried) ?? choice);
}

const SCREENS = {
  loading: () => { screen.innerHTML = `<div class="hero">${MASCOT}<p class="muted">Loading…</p></div>`; },
  error: () => { screen.innerHTML = `<div class="narrow">${errorLine()}</div>`; },
  signin: renderSignin, "email-sent": renderEmailSent, consent: renderConsent, "set-pin": renderSetPin, pin: renderPin,
  profiles: renderProfiles, onboard: renderOnboard, "placement-offer": renderPlacementOffer, placement: renderPlacement,
  "placement-result": renderPlacementResult, grownups: renderGrownups, "child-settings": renderChildSettings,
  admin: renderAdmin, fix: renderFix,
  dash: renderDash, lesson: renderLesson, quiz: renderQuiz, result: renderResult, "practice-done": renderPracticeDone,
};

/* ---------- the two looks ---------- */
// A child's own screens float on the page in the child's look; grown-up screens use the clean look.
const KID_SCREENS = ["profiles", "placement-offer", "placement", "placement-result", "dash", "lesson", "quiz", "result", "practice-done"];
const PLAYING = ["dash", "lesson", "quiz", "result", "practice-done"];

function look() {
  if (PLAYING.includes(app.mode) && child) return M.lookFor(child.classId, settings.child?.look);
  if (app.mode.startsWith("placement") && app.draft?.classId) return M.classLook(app.draft.classId);
  if (app.mode === "profiles") return profiles.some(p => M.classLook(p.classId) === "play") ? "play" : "focus";
  return "focus";
}

function render() {
  if (!["pin", "set-pin"].includes(app.mode)) document.onkeydown = null;
  document.documentElement.dataset.look = look();
  screen.classList.toggle("kid", KID_SCREENS.includes(app.mode));
  (SCREENS[app.mode] || SCREENS.error)();
  renderSide();
  tag.textContent = DEMO ? "Demo · everything stays in this browser" : account?.email ?? "";
  const view = app.mode + (app.topicId || "") + (app.page ?? "") + (app.step ?? "") + (app.i ?? "");
  if (view !== lastView) { lastView = view; try { window.scrollTo(0, 0); } catch (e) {} }
}
let lastView = "";

boot();
