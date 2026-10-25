# Nitya

Nitya (नित्य) is an adaptive maths learning and quiz app for children, from LKG to Class 12, following the NCERT/CBSE syllabus.

Each class has topics that unlock in order. A topic is a short lesson followed by a 20-question adaptive quiz across four levels: Easy, Medium, Hard and Olympiad. Marks are weighted by level, and a child moves up a class only after clearing every topic in it.

## What is here

- `src/engine.ts`: the adaptive quiz engine (level changes, hint retries, level-weighted marks, pass mark).
- `src/progression.ts`: topic unlocking and class promotion.
- `src/content/`: seeded question generators. UKG has 5 topics with 80 questions each (20 per level).
- `src/accounts/`: sign-in, parental consent, child profiles, the parent PIN, the placement check and saved progress (see Accounts below).
- `preview/`: the app's page (`app.js`, `template.html`) and the build that makes it one HTML file, as the demo preview or the real app.
- `src/validation/`: the validation engine that checks every question before a child sees it (see below).
- `src/supply/`: the question supply engine: New questions, CSV import, the admin's Drive folder, and saving to the database (see below).
- `scripts/questions.ts`: commands that fill the question bank in the database.
- `docs/question-template.csv`: a sample question CSV to copy.
- `test/`: Vitest tests for the engine, progression, content, validation, question supply and accounts.

## Commands

```sh
npm install
npm test           # run the tests
npm run typecheck  # strict TypeScript check
npm run preview    # build the demo, dist/preview.html, then open it in a browser
npm run app        # build the real app, dist/app/index.html (see Setting up sign-in below)
npm run test:db    # database tests (see Database below)
npm run questions -- <command>   # fill the question bank (see Question supply below)
```

## Validation

`validateQuestion(question, { classId, subSkills })` runs five checks and returns a report that can be stored as `question_checks.report`:

- **Answer:** the engine recomputes the answer from the question's `working` without trusting the generator. Exactly one option must be right, the working must use the numbers the question shows, and the explanation must state the answer. A question with no working (a CSV or website import) fails this check and goes to manual review.
- **Options:** 2 to 4 options, no duplicates, the answer among them, and wrong options of the same kind as the answer and close enough to be believable mistakes.
- **Scope:** numbers stay inside the class's range (UKG: 0 to 50), sums stay inside the topic's limit (UKG adding and taking away: 10), and the skill belongs to the topic. Limits live in `src/validation/rules.ts`; a class with no limits there fails until they are added.
- **Level:** a rough estimate from number size, thinking steps and whether a picture helps. It flags a tag 2 or more levels away; live results catch closer calls.
- **Wording:** prompt length for the class (UKG: 25 words), no unsafe words, no links, and no empty hint, explanation or reason.

`checkLiveBand(stats)` compares a question's first-try success rate with its level's band after 30 plays, and says which level it looks like when it falls outside.

## Question supply

Questions reach the bank three ways. Every question passes through the validation engine on the way in: one that passes is saved as approved, and one that fails is saved as `in_review` with its report, for the admin to fix or reject.

- **Built-in banks:** the 400 UKG questions. `npm run questions -- seed` loads them; running it again changes nothing.
- **New questions:** makes fresh questions from a topic's templates with a new random seed, 20 per level by default, skipping any the bank already has. It runs only when someone asks: `npm run questions -- new <topic-id>` for now, and a button for admins, parents and children with the admin panel. The demo preview has the button in its tester tools. Each request is logged in `question_requests`. A level stops short when its templates have no new questions left (today UKG adding and taking away have none left at L1, and counting and before-and-after have fewer than 15 at L1 and L2).
- **CSV files:** `npm run questions -- import <file.csv>`, or `npm run questions -- sync-drive` for the admin's Google Drive folder.

The same question is never saved twice: two questions in one topic with the same words and picture are the same question, whatever their ids or levels. Questions with the same maths (like 3 + 4 and 4 + 3) share a variant group, and the quiz engine keeps them out of the same quiz.

### CSV format

One question per row, with these columns (see `docs/question-template.csv`):

| Column | What goes in it |
| --- | --- |
| `id` | Optional. Give each row an id if you will edit it later: a row without one gets an id made from its words, so editing the words makes it a new question. |
| `topic_id` | A topic id, such as `ukg-addition-10`. |
| `level` | 1 to 4 (or L1 to L4). |
| `sub_skill` | One of the topic's sub-skills, such as `count-on`. |
| `format` | `tap-picture`, `mcq`, `fill-blank`, `count`, and so on. |
| `prompt` | The question. |
| `options` | The choices, separated by `\|`. |
| `answers` | The right answer (or answers, separated by `\|`). |
| `hint`, `explanation`, `reason` | The hint after a wrong first try, the working shown after a wrong answer, and the one-line reason shown with the praise. |
| `picture` | Optional dots, like `3 blue, 2 orange` or `5 blue 2 crossed`. |
| `working` | How the answer is worked out, so the checks can recompute it: a sum like `4 + 3` or `9 - 2 - 3`, `count dots`, or JSON for other kinds (see `Working` in `src/types.ts`). Without it the question goes to review. |

A row that can't be read is reported with its row number and skipped; the other rows are still saved.

### The admin's Drive folder

The Drive folder is the editable master copy, and syncing copies it one way into the database. New rows are added; edited rows are updated, checked again, and start their live results again; a question whose row is deleted stays in the bank and is listed as missing, for the admin to retire. Plain CSV files and Google Sheets both work (a Sheet's first tab is read).

To set it up:

1. In Google Cloud, create a service account, enable the Google Drive API, and download the account's JSON key.
2. Share the Drive folder with the service account's email address, as a Viewer.
3. Run `DATABASE_URL=… DRIVE_FOLDER=<folder link> GOOGLE_SERVICE_ACCOUNT_KEY_FILE=key.json npm run questions -- sync-drive`.

`DATABASE_URL` is the project's Postgres connection string from the Supabase dashboard. Keep it and the key file out of the repository.

## Accounts

A parent owns the account and signs in with Google or a one-time email link. Children never sign in; each child has a profile inside the parent's account.

1. **Sign in** with Google or an email link.
2. **Consent:** the parent agrees to the points in `src/accounts/consent.ts`. The version and the time are saved, and nothing about a child is saved before it. Changing `CONSENT_VERSION` asks every parent again.
3. **Parent PIN:** 4 digits, not all the same and not in a row. The app keeps only a salted PBKDF2 hash. It is asked for before switching children, adding or editing a child, and opening Grown-ups; 5 wrong tries lock it for 30 seconds.
4. **Onboarding:** nickname, animal avatar, class, board and language, one big-button screen each. Only classes that have content are offered (UKG today).
5. **Placement check (optional):** 10 questions across the class's topics at Medium and above, with no marks shown. 90% or more suggests the next class and under 40% the one before, when that class has content. The parent chooses.
6. **Dashboard:** the child lands on their class map. Each profile keeps its own progress, and the app remembers who was playing on this device.

**Grown-ups** lists the children, and lets the parent edit a profile, download a profile's data as JSON, delete a profile with its progress, add a child, change the PIN and sign out.

Every quiz is saved as it is played: the play when it starts, each answer as it is given, and the marks and topic progress at the end. Practice rounds are saved too, but never change topic progress.

### The demo and the real app

The page talks to an account backend (`src/accounts/backend.ts`), and the same tests run against both kinds:

- **Demo** (`npm run preview`, and the published preview): pretend sign-in, and everything is kept in the browser's storage. Tester tools on the dashboard reset the demo and add questions; during a quiz they answer right or wrong.
- **Real app** (`npm run app`): Supabase Auth for sign-in, and the Supabase database for everything else, protected by row-level security. Without the two settings below it builds the demo instead.

### Setting up sign-in

1. **Supabase project:** create one in the region *South Asia (Mumbai)*, so children's data stays in India.
2. **Schema and questions:** apply the migrations (see Database below), then load the question bank with `DATABASE_URL=… npm run questions -- seed`. Saved answers point at questions in the bank, so this is needed before anyone plays.
3. **Email links:** in *Authentication*, keep the **Email** provider on. Supabase's built-in mailer sends only a few emails an hour, so add your own SMTP server under *Authentication → Emails* before real families use it.
4. **Google:** in Google Cloud, set up the Google Auth Platform (audience, the `openid` scope, branding), then create an OAuth client of type *Web application*. Add the app's address (origin only, like `https://nitya.example.com`) to *Authorized JavaScript origins*, and the callback URL shown on Supabase's **Google** provider page to *Authorized redirect URIs*. Paste the client ID and secret into that Google provider page.
5. **Redirect URLs:** in *Authentication → URL Configuration*, set the Site URL to the address where the app is hosted, and add that address to the Redirect URLs. Sign-in links and Google bring the parent back to the same page they started from.
6. **Build:** copy the project URL and the publishable key (`sb_publishable_…`; the older anon key also works) from *Settings → API Keys* or the project's *Connect* dialog, then run:

   ```sh
   NITYA_SUPABASE_URL=https://<project-ref>.supabase.co NITYA_SUPABASE_KEY=<publishable key> npm run app
   ```

   Host `dist/app/index.html` on any static host with HTTPS. The publishable key is meant to be public; row-level security is what protects each family's data. Never put a secret or service role key in the app.

## Database

The Supabase schema lives in `supabase/migrations`:

- `20261025100000_initial_schema.sql`: tables for the question bank, check runs and admin reviews, parents, consent records, child profiles, topic progress, quizzes and answers, level bands, and the admin and per-child topic settings. Row-level security means each family sees only its own data, only admins can change the question bank and settings, and admins get no access to family data.
- `20261025100100_reference_data.sql`: the 5 UKG topics, the level bands (L1 85%+, L2 65 to 85%, L3 50 to 65%, L4 under 50%) and each topic's defaults (pass mark 44, 1 mark off for a wrong first try).
- `20261025120000_question_requests.sql`: the log of New questions requests. A family sees only its own requests and the admin sees all; only the server writes it.
- `20261025130000_accounts.sql`: the parent PIN hash, the fixed onboarding choices for profiles, and practice plays.

To apply them to a Supabase project, run the files in name order in the SQL editor, or use the Supabase CLI (`supabase link`, then `supabase db push`). To make someone an admin, add their user id to `public.admins` from the dashboard.

The database tests run the migrations on a fresh Postgres database, using `test/db/supabase-stub.sql` to stand in for Supabase's auth schema and roles. The account tests also run the app's Supabase code against [PostgREST](https://postgrest.org) 12, the API server inside Supabase, so they need its `postgrest` program (set `POSTGREST_BIN` if it isn't on your PATH):

```sh
DATABASE_URL=postgres://postgres@localhost:5432/postgres POSTGREST_BIN=/path/to/postgrest npm run test:db
```
