# Nitya

Nitya (नित्य) is an adaptive maths learning and quiz app for children, from LKG to Class 12, following the NCERT/CBSE syllabus.

Each class has topics that unlock in order. A topic is a short lesson followed by a 20-question adaptive quiz across four levels: Easy, Medium, Hard and Olympiad. Marks are weighted by level, and a child moves up a class only after clearing every topic in it.

## What is here

- `src/engine.ts`: the adaptive quiz engine (level changes, hint retries, level-weighted marks, pass mark).
- `src/progression.ts`: topic unlocking and class promotion.
- `src/content/`: seeded question generators. UKG has 5 topics with 80 questions each (20 per level).
- `preview/`: a single-file playable preview of the UKG class.
- `test/`: Vitest tests for the engine, progression and content.

## Commands

```sh
npm install
npm test           # run the tests
npm run typecheck  # strict TypeScript check
npm run preview    # build dist/preview.html, then open it in a browser
```

## Database

The Supabase schema lives in `supabase/migrations`:

- `20261025100000_initial_schema.sql`: tables for the question bank, check runs and admin reviews, parents, consent records, child profiles, topic progress, quizzes and answers, level bands, and the admin and per-child topic settings. Row-level security means each family sees only its own data, only admins can change the question bank and settings, and admins get no access to family data.
- `20261025100100_reference_data.sql`: the 5 UKG topics, the level bands (L1 85%+, L2 65 to 85%, L3 50 to 65%, L4 under 50%) and each topic's defaults (pass mark 44, 1 mark off for a wrong first try).

To apply them to a Supabase project, run the files in name order in the SQL editor, or use the Supabase CLI (`supabase link`, then `supabase db push`). To make someone an admin, add their user id to `public.admins` from the dashboard.

The database tests run the migrations on a fresh Postgres database, using `test/db/supabase-stub.sql` to stand in for Supabase's auth schema and roles:

```sh
DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:db
```
