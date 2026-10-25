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
