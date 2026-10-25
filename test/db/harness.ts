import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

const MIGRATIONS = "supabase/migrations";

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

/** A new, empty database with the Supabase stub and every migration applied. */
export async function createTestDb(): Promise<{ db: pg.Client; url: string; drop: () => Promise<void> }> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("Set DATABASE_URL to a Postgres server where the tests may create databases.");
  const name = `nitya_test_${process.pid}_${Date.now()}`;

  const root = new pg.Client({ connectionString: base });
  await root.connect();
  await root.query(`create database ${name}`);
  await root.end();

  const url = urlFor(base, name);
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query(readFileSync("test/db/supabase-stub.sql", "utf8"));
  for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort()) {
    await db.query(readFileSync(`${MIGRATIONS}/${file}`, "utf8"));
  }

  return {
    db,
    url,
    async drop() {
      await db.end();
      const cleanup = new pg.Client({ connectionString: base });
      await cleanup.connect();
      await cleanup.query(`drop database ${name} with (force)`);
      await cleanup.end();
    },
  };
}

/**
 * Runs `fn` in one transaction as a signed-in user (the way Supabase does for
 * API calls), or as anon when `userId` is null. Commits unless `rollback` is set.
 */
export async function as<T>(
  db: pg.Client,
  userId: string | null,
  fn: (db: pg.Client) => Promise<T>,
  opts: { rollback?: boolean } = {},
): Promise<T> {
  await db.query("begin");
  try {
    if (userId) {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
    } else {
      await db.query("set local role anon");
    }
    const out = await fn(db);
    await db.query(opts.rollback ? "rollback" : "commit");
    return out;
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
}
