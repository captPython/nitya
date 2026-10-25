const M = Nitya;
const backend = M.createBackend();
const DEMO = backend.mode === "demo";
const LEVEL_NAMES = { 1: "Easy", 2: "Medium", 3: "Hard", 4: "Olympiad" };
const PRACTICE_LENGTH = 8;
const CURRENT_KEY = "nitya-current-profile";
const BANK_KEY = "nitya-ukg-bank-v1";
const storage = M.browserStorage();
const screen = document.getElementById("screen");
const side = document.getElementById("side");
const stage = document.getElementById("stage");
const tag = document.getElementById("tag");
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pick = a => a[Math.floor(Math.random() * a.length)];
const byId = id => M.ALL_CONTENT.find(t => t.topic.id === id);

const MASCOT = `<svg width="60" height="60" viewBox="0 0 64 64" aria-hidden="true">
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

const classTopics = () => M.contentForClass(child.classId);
const topicList = () => classTopics().map(t => t.topic);
const maxMarks = () => M.maxMarks(child.classId);
const className = id => M.CLASS_NAMES[id];
function refresh() { sum = M.summarize(child.classId, topicList(), data); }

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
  data = await backend.profileData(p.id);
  refresh();
  goDash();
}

async function boot() {
  render();
  await step(async () => { account = await backend.account(); await route(); });
}

/* ---------- question bank (demo only) ---------- */
// New questions saves only its seed: replaying the seeds in order makes the same questions again.
const BUILT_IN = new Map(M.ALL_CONTENT.map(t => [t.topic.id, [...t.bank]]));
let bankStore = null, bankNote = null, bankBusy = false;
function loadSeeds() {
  try { const s = JSON.parse(storage.getItem(BANK_KEY) || "{}"); return s && typeof s === "object" ? s : {}; } catch (e) { return {}; }
}
function saveSeeds(seeds) { try { storage.setItem(BANK_KEY, JSON.stringify(seeds)); } catch (e) {} }
async function addFromSeed(topicId, seed) {
  const content = byId(topicId);
  const summary = await M.addNewQuestions(bankStore, content, { seed });
  content.bank.push(...summary.approved.map(id => bankStore.rows.get(id).question));
  return summary;
}
async function initBank() {
  for (const t of M.ALL_CONTENT) t.bank = [...BUILT_IN.get(t.topic.id)];
  bankStore = new M.MemoryQuestionStore(M.ALL_CONTENT.map(M.topicInfo));
  await M.seedBank(bankStore, M.ALL_CONTENT);
  for (const [topicId, seeds] of Object.entries(loadSeeds())) {
    if (byId(topicId)) for (const seed of seeds) await addFromSeed(topicId, seed);
  }
}
function describeAdded(content, summary) {
  const perLevel = summary.asked / 4;
  const byLevel = [1, 2, 3, 4].map(l => summary.approved.filter(id => bankStore.rows.get(id).question.level === l).length);
  const short = [1, 2, 3, 4].filter(l => byLevel[l - 1] < perLevel)
    .map(l => byLevel[l - 1] ? `${LEVEL_NAMES[l]} had only ${byLevel[l - 1]} new ones left` : `${LEVEL_NAMES[l]} has no new ones left`);
  const held = summary.inReview.length ? ` ${summary.inReview.length} failed a check and wait for the admin.` : "";
  return `${content.topic.title}: added ${summary.approved.length} new questions.${short.length ? ` ${short.join("; ")}.` : ""}${held}`;
}
async function newQuestions(topicId) {
  if (bankBusy || !bankStore) return;
  bankBusy = true;
  try {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const summary = await addFromSeed(topicId, seed);
    if (summary.approved.length) {
      const seeds = loadSeeds();
      (seeds[topicId] || (seeds[topicId] = [])).push(seed);
      saveSeeds(seeds);
    }
    bankNote = describeAdded(byId(topicId), summary);
  } catch (e) {
    bankNote = "Couldn't make new questions: " + e.message;
  }
  bankBusy = false;
  render();
}

/* ---------- speech ---------- */
function speak(text) {
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 0.9; speechSynthesis.speak(u); } catch (e) {}
}
const listenBtn = text => `<button class="ghost" type="button" data-say="${esc(text)}">Listen</button>`;
screen.addEventListener("click", e => { const b = e.target.closest("[data-say]"); if (b) speak(b.dataset.say); });

/* ---------- dots ---------- */
function dotsSvg(visual) {
  if (!visual) return "";
  const R = 11, G = 6, STEP = 2 * R + G, GROUP_GAP = 30;
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
    <div class="kids">${profiles.map(p => `<button class="btn kid" type="button" data-kid="${p.id}">
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
    <div class="opts">${q.options.map(o => `<button class="btn" type="button" data-opt="${esc(o)}">${esc(o)}</button>`).join("")}</div>
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
        <button class="ghost" type="button" data-edit="${p.id}">Edit</button>
        <button class="ghost" type="button" data-download="${p.id}">Download data</button>
        <button class="ghost" type="button" data-delete="${p.id}">${app.confirmDelete === p.id ? `Tap again to delete ${esc(p.nickname)}` : "Delete"}</button>
      </div></div>`).join("")}</div>
    ${app.exported ? `<details><summary>Show ${esc(app.exported.name)}'s data</summary><pre class="data">${esc(JSON.stringify(app.exported.value, null, 2))}</pre></details>` : ""}
    <div class="row"><button class="ghost" type="button" id="add">Add a child</button>
      <button class="ghost" type="button" id="pin">Change the PIN</button>
      <button class="ghost" type="button" id="signout">Sign out</button></div>
    <div class="row"><button class="btn primary" type="button" id="done">${child ? `Back to ${esc(child.nickname)}` : "Choose a child"}</button></div>
  </div>`;
  screen.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => startOnboarding(profiles.find(p => p.id === b.dataset.edit)));
  screen.querySelectorAll("[data-download]").forEach(b => b.onclick = () => step(async () => {
    const p = profiles.find(x => x.id === b.dataset.download);
    const value = { exportedAt: new Date().toISOString(), profile: p, ...(await backend.profileData(p.id)) };
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
  document.getElementById("add").onclick = () => startOnboarding();
  document.getElementById("pin").onclick = () => show({ mode: "set-pin", first: null, then: "grownups", cancel: () => show({ mode: "grownups" }) });
  document.getElementById("signout").onclick = () => step(signOut);
  document.getElementById("done").onclick = () => (child ? goDash() : show({ mode: "profiles" }));
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
  const content = byId(topicId);
  const bank = practiceSkill ? content.bank.filter(q => q.subSkill === practiceSkill) : content.bank;
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
    state: M.startQuiz({ classId: child.classId, topicId, attemptNo: attemptNoFor(topicId), seenBefore: sum.seen[topicId] || [] }),
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
    const result = { marks: s.marks, cleared: false, stars: 0, passMarks: M.PASS_MARKS, maxMarks: maxMarks(), correct: s.correct };
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
  const passPct = (M.PASS_MARKS / MAX) * 100;
  const next = M.nextClass(child.classId);

  const rows = topics.map((t, i) => {
    const e = sum.progress.topics[t.id];
    const stars = sum.stars[t.id] || 0;
    const bestPct = Math.min(100, (e.bestScore / MAX) * 100);
    const chip = e.state === "cleared" ? `<span class="chip cleared">Cleared</span>` : e.state === "current" ? `<span class="chip current">Up next</span>` : `<span class="chip">Locked</span>`;
    const score = e.attempts
      ? `<span>Best ${e.bestScore} / ${MAX}</span><span class="mini" aria-hidden="true"><b class="${e.bestScore >= M.PASS_MARKS ? "ok" : ""}" style="width:${bestPct}%"></b><i style="left:${passPct}%"></i></span><span>${e.attempts} ${e.attempts === 1 ? "try" : "tries"}</span>${stars ? `<span class="stars-sm" aria-label="${stars} stars">${"★".repeat(stars)}${"☆".repeat(3 - stars)}</span>` : ""}`
      : e.state === "locked" ? `<span>Opens after topic ${i}</span>` : `<span>Not started</span>`;
    const act = e.state === "current"
      ? `<button class="chipbtn" type="button" data-open="${t.id}">${e.attempts ? "Try again" : "Start"}</button>`
      : e.state === "cleared" ? `<button class="chipbtn soft" type="button" data-open="${t.id}">Practise</button>` : "";
    return `<div class="topic ${e.state}">
      <span class="num" aria-hidden="true">${e.state === "cleared" ? "✓" : e.state === "locked" ? lockIcon() : i + 1}</span>
      <div class="tmain"><div class="row" style="gap:8px"><h3>${esc(t.title)}</h3>${chip}</div><div class="tmeta">${score}</div></div>
      <div class="act">${act}</div></div>`;
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
    <div class="dash-head">
      <div style="display:grid;gap:4px"><span class="label">Class dashboard</span><h1>${esc(cls)} Maths</h1></div>
      <div class="row" style="gap:24px">
        <div><div class="bigstat">${clearedCount} / ${topics.length}</div><div class="small muted">topics cleared</div></div>
        <div><div class="bigstat" style="color:var(--sun)">★ ${totalStars}</div><div class="small muted">stars</div></div>
      </div>
    </div>
    <div class="overall">
      <div class="segs" aria-label="${clearedCount} of ${topics.length} topics cleared">${states.map(s => `<span class="seg ${s.state}"></span>`).join("")}</div>
      <p class="small muted">${sum.promoted ? `${esc(cls)} complete!${next ? ` ${esc(className(next))} opens when its topics are ready.` : ""}` : `Clear every topic to move up${next ? ` to ${esc(className(next))}` : ""}. Each quiz needs ${M.PASS_MARKS} of ${MAX} marks.`}</p>
    </div>
    <div class="topics">${rows}</div>
    <div class="panels">
      <div class="panel"><span class="label">Improvement areas</span>${areasHtml}</div>
      <div class="panel"><span class="label">Right first time, by level</span>${levelsHtml}</div>
    </div>`;
  screen.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openTopic(b.dataset.open));
  screen.querySelectorAll("[data-practice]").forEach(b => b.onclick = () => { const [t, s] = b.dataset.practice.split("|"); startQuiz(t, s); });
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
      <div class="opts">${t.options.map(o => `<button class="btn" type="button" data-try="${esc(o)}">${esc(o)}</button>`).join("")}</div>
      <div id="tryfb"></div>
      <div class="row">${listenBtn(t.prompt)}<button class="ghost" type="button" id="back">Back</button></div>`;
    document.getElementById("back").onclick = () => { app.page--; render(); };
    screen.querySelectorAll("[data-try]").forEach(b => b.onclick = () => {
      const fb = document.getElementById("tryfb");
      if (b.dataset.try === t.answer) {
        b.classList.add("right");
        fb.innerHTML = `<div class="feedback good"><b>You got it!</b> ${esc(t.praise)}</div>
          <div class="row" style="margin-top:12px"><button class="btn primary" type="button" id="go">${app.peek ? "Back to my question" : "Start the quiz"}</button></div>`;
        document.getElementById("go").onclick = () => app.peek ? backToQuiz() : startQuiz(app.topicId);
      } else {
        b.classList.add("tried");
        fb.innerHTML = `<div class="feedback gentle"><b>Let's look again.</b> ${esc(t.help)} Try again!</div>`;
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
  const passPct = (M.PASS_MARKS / MAX) * 100;
  const q = s.marks >= M.PASS_MARKS;
  const d = app.delta;
  const deltaHtml = d === null || d === undefined ? "" : d > 0 ? `<span class="delta up">+${d}</span>` : d < 0 ? `<span class="delta down">−${-d}</span>` : "";
  return `<div class="marks">
    <div class="marks-top">
      <div><span class="label">Marks</span><div><span class="marks-num">${s.marks}</span>${deltaHtml}</div></div>
      <span class="qual ${q ? "yes" : ""}">${q ? "Pass mark crossed! Keep going to the end." : `${M.PASS_MARKS - s.marks} more ${M.PASS_MARKS - s.marks === 1 ? "mark" : "marks"} to pass`}</span>
    </div>
    <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="${MAX}" aria-valuenow="${s.marks}" aria-label="Marks">
      <div class="fill ${q ? "qualified" : ""}" id="fill" style="width:${(Math.min(app.prevMarks, MAX) / MAX) * 100}%"></div>
      <div class="passmark ${q ? "crossed" : ""}" style="left:${passPct}%"><span>${q ? "✓ " : ""}Pass ${M.PASS_MARKS}</span></div>
    </div>
    <div class="small muted">Right answers: Easy +1, Medium +2, Hard +3, Olympiad +4. A wrong first try takes away 1.</div>
  </div>`;
}

function renderQuiz() {
  const { q, state: s } = app;
  const practice = !!app.practiceSkill;
  const total = practice ? app.practiceTotal : M.QUIZ_LENGTH;
  const qNo = app.phase === "ask" ? s.asked.length + 1 : s.asked.length;
  const locked = app.phase === "done";
  const c = byId(app.topicId);
  screen.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <span class="muted small">${esc(c.topic.title)}${practice ? ` · Practice: ${esc(c.subSkillNames[app.practiceSkill])}` : ""} · Question ${qNo} of ${total}</span>
      <button class="ghost" type="button" id="relesson">See the lesson</button></div>
    ${saveError ? `<p class="banner" role="alert">${esc(saveError)}</p>` : ""}
    ${practice ? "" : marksBar()}
    <div class="mascot">${MASCOT}<div class="bubble"><span class="lvl">L${q.level} ${LEVEL_NAMES[q.level]} <i>· worth ${M.MARKS_BY_LEVEL[q.level]} ${M.MARKS_BY_LEVEL[q.level] === 1 ? "mark" : "marks"}</i></span><p class="prompt">${esc(q.prompt)}</p></div></div>
    ${dotsSvg(q.visual)}
    <div class="opts">${q.options.map(o => `<button class="btn" type="button" data-opt="${esc(o)}" ${locked ? "disabled" : ""}>${esc(o)}</button>`).join("")}</div>
    <div id="fb">${app.feedback ?? ""}</div>
    <div class="row">${listenBtn(q.prompt)}${locked ? `<button class="btn primary" type="button" id="cont">${quizDone() ? (practice ? "Finish practice" : "See my result") : "Next question"}</button>` : ""}</div>`;

  if (locked) screen.querySelectorAll("[data-opt]").forEach(b => { if (q.answers.includes(b.dataset.opt)) b.classList.add("right"); });
  if (app.phase === "retry" && app.tried) {
    const t = [...screen.querySelectorAll("[data-opt]")].find(b => b.dataset.opt === app.tried);
    if (t) { t.classList.add("tried"); t.disabled = true; }
  }
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
      app.feedback = `<div class="feedback good"><b>${pick(["Super!", "Well done!", "Brilliant!", "Yes!"])}</b> ${esc(r.result.reason)}</div>`;
    } else {
      app.phase = "retry";
      app.tried = choice;
      app.feedback = `<div class="feedback gentle"><b>Nice try! Here's a hint.</b> ${esc(r.result.hint)} Have another go.</div>`;
    }
  } else if (app.phase === "retry") {
    const r = M.answerRetry(app.state, q, choice);
    app.state = r.state;
    saveResponse(q);
    app.phase = "done";
    app.feedback = r.retryCorrect
      ? `<div class="feedback good"><b>You worked it out!</b> ${esc(r.explanation)}</div>`
      : `<div class="feedback gentle"><b>Let's do it together.</b> ${esc(r.explanation)} The answer is <b>${esc(r.answer)}</b>.</div>`;
  }
  render();
}

function renderResult() {
  const { outcome: o, effect } = app;
  const c = byId(app.topicId);
  const MAX = maxMarks();
  const cls = className(child.classId);
  const passPct = (M.PASS_MARKS / MAX) * 100;
  const bar = `<div class="marks"><div class="marks-top"><div><span class="label">Final marks</span><div class="marks-num">${o.marks} / ${MAX}</div></div>
      <span class="qual ${o.cleared ? "yes" : ""}">${o.cleared ? "Above the pass mark" : `${M.PASS_MARKS - o.marks} short of the pass mark`}</span></div>
    <div class="track"><div class="fill ${o.cleared ? "qualified" : ""}" style="width:${(o.marks / MAX) * 100}%"></div><div class="passmark ${o.cleared ? "crossed" : ""}" style="left:${passPct}%"><span>Pass ${M.PASS_MARKS}</span></div></div>
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
      <div class="mascot">${MASCOT}<div class="bubble"><h2>Almost there!</h2><p>You need ${M.PASS_MARKS} marks to open the next topic. Harder questions give more marks.</p></div></div>
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
      <p class="small muted">The demo keeps everything in this browser. Reset to start again from sign-in.</p>
      <div class="tools"><button class="ghost" type="button" id="reset">Reset the demo</button></div>
      <div class="tools"><span class="label">Question bank</span>
        <p class="small muted">New questions makes fresh questions from the topic's templates, checks every one, and adds the ones that pass. Quizzes start using them straight away.</p>
        ${classTopics().map(t => `<div class="bankrow"><span class="small"><b>${esc(t.topic.title)}</b> · <span class="muted">${t.bank.length} questions</span></span>
          <button class="ghost" type="button" data-newq="${t.topic.id}" ${bankStore && !bankBusy ? "" : "disabled"}>New questions</button></div>`).join("")}
        ${bankNote ? `<p class="small" role="status">${esc(bankNote)}</p>` : ""}</div>`;
    side.querySelectorAll("[data-newq]").forEach(b => b.onclick = () => newQuestions(b.dataset.newq));
    const reset = document.getElementById("reset");
    reset.onclick = async () => {
      if (!reset.dataset.sure) { reset.dataset.sure = "1"; reset.textContent = "Tap again to reset"; return; }
      try { storage.setItem("nitya-demo-v1", "null"); storage.setItem(CURRENT_KEY, ""); } catch (e) {}
      saveSeeds({}); bankNote = null; bankStore = null;
      account = null; child = null; data = null; sum = null; profiles = [];
      show({ mode: "signin" });
      await initBank(); render();
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
  "placement-result": renderPlacementResult, grownups: renderGrownups,
  dash: renderDash, lesson: renderLesson, quiz: renderQuiz, result: renderResult, "practice-done": renderPracticeDone,
};

function render() {
  if (!["pin", "set-pin"].includes(app.mode)) document.onkeydown = null;
  (SCREENS[app.mode] || SCREENS.error)();
  renderSide();
  tag.textContent = DEMO ? "Demo · everything stays in this browser" : account?.email ?? "";
  const view = app.mode + (app.topicId || "") + (app.page ?? "") + (app.step ?? "") + (app.i ?? "");
  if (view !== lastView) { lastView = view; try { window.scrollTo(0, 0); } catch (e) {} }
}
let lastView = "";

boot();
initBank().then(render, e => { bankNote = "Couldn't load the question bank: " + e.message; render(); });
