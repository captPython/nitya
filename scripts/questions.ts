// Fills Nitya's question bank in the Supabase database.
//
//   npm run questions -- seed                       load the built-in banks (safe to run again)
//   npm run questions -- import <file.csv> [...]    import question CSVs
//   npm run questions -- sync-drive                 sync the admin's Drive folder of CSVs
//   npm run questions -- new <topic-id> [--per-level N] [--seed N]
//                                                   make new questions, as the New questions button does
//
// DATABASE_URL is the project's Postgres connection string. sync-drive also
// needs DRIVE_FOLDER (the folder's link or id) and
// GOOGLE_SERVICE_ACCOUNT_KEY_FILE (the service account's JSON key).

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { webcrypto } from "node:crypto";
import pg from "pg";
import { UKG_TOPICS } from "../src/content/ukg";
import { addNewQuestions, importCsvText, seedBank, syncCsvFolder, type ImportSummary, type ReviewItem } from "../src/supply";
import { driveFolder, type ServiceAccountKey } from "../src/supply/drive";
import { PgQuestionStore } from "../src/supply/pg-store";

/** Every topic with built-in content. Later classes add theirs here. */
const CONTENT = [...UKG_TOPICS];

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}. See the comment at the top of scripts/questions.ts.`);
  return value;
}

function flag(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} needs a whole number.`);
  return n;
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

function printReview(items: ReviewItem[]) {
  if (!items.length) return;
  console.log(`\n${count(items.length, "question")} went to the admin's review queue:`);
  for (const r of items) console.log(`  ${r.id}: ${r.problems.join(" ")}`);
}

/** Prints an import's summary and returns whether every row could be read. */
function printImport(s: ImportSummary): boolean {
  console.log(`Added ${s.added.length}, updated ${s.updated.length}, unchanged ${s.unchanged.length}, ` +
    `skipped ${s.duplicates.length} already in the bank under another id.`);
  printReview(s.inReview);
  if (s.errors.length) {
    console.log(`\n${count(s.errors.length, "row")} couldn't be read, and the rest were saved:`);
    for (const e of s.errors) console.log(`  ${e.file} row ${e.row}: ${e.message}`);
  }
  return s.errors.length === 0;
}

async function main(args: string[]): Promise<boolean> {
  const [command, ...rest] = args;
  const db = new pg.Client({ connectionString: env("DATABASE_URL") });
  await db.connect();
  const store = new PgQuestionStore(db);
  try {
    switch (command) {
      case "seed": {
        const s = await seedBank(store, CONTENT);
        console.log(`Built-in banks: added ${s.added.length}, updated ${s.updated.length}, unchanged ${s.unchanged.length}.`);
        printReview(s.inReview);
        return true;
      }
      case "import": {
        if (!rest.length) throw new Error("Name at least one CSV file.");
        let ok = true;
        for (const file of rest) {
          console.log(`${file}:`);
          ok = printImport(await importCsvText(store, readFileSync(file, "utf8"), basename(file))) && ok;
        }
        return ok;
      }
      case "sync-drive": {
        const key = JSON.parse(readFileSync(env("GOOGLE_SERVICE_ACCOUNT_KEY_FILE"), "utf8")) as ServiceAccountKey;
        const s = await syncCsvFolder(store, driveFolder({ folder: env("DRIVE_FOLDER"), key }));
        console.log(`Read ${count(s.files.length, "file")}: ${s.files.join(", ") || "none"}.`);
        const ok = printImport(s);
        if (s.missing.length) {
          console.log(`\n${count(s.missing.length, "question")} from CSVs ${s.missing.length === 1 ? "is" : "are"} no longer in any file. They were kept:`);
          console.log(`  ${s.missing.join(", ")}`);
        }
        return ok;
      }
      case "new": {
        const topicId = rest[0];
        const content = CONTENT.find(c => c.topic.id === topicId);
        if (!content) throw new Error(`Name a topic: ${CONTENT.map(c => c.topic.id).join(", ")}.`);
        const seed = flag(rest, "--seed") ?? webcrypto.getRandomValues(new Uint32Array(1))[0];
        const s = await addNewQuestions(store, content, { seed, perLevel: flag(rest, "--per-level") });
        console.log(`${topicId}, seed ${seed}: ${s.approved.length} approved of ${s.asked} asked for.`);
        printReview(s.inReview);
        return true;
      }
      default:
        throw new Error("Commands: seed, import <file.csv>, sync-drive, new <topic-id>.");
    }
  } finally {
    await db.end();
  }
}

main(process.argv.slice(2)).then(
  ok => { process.exitCode = ok ? 0 : 1; },
  err => { console.error((err as Error).message); process.exitCode = 1; },
);
