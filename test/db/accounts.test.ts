import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabaseBackend, type AuthPort } from "../../src/accounts/supabase-backend";
import { UKG_TOPICS } from "../../src/content/ukg";
import { seedBank } from "../../src/supply";
import { PgQuestionStore } from "../../src/supply/pg-store";
import { accountContract } from "../accounts-contract";
import { as, createTestDb } from "./harness";
import { startPostgrest } from "./postgrest";

let db: pg.Client;
let drop: () => Promise<void>;
let api: Awaited<ReturnType<typeof startPostgrest>>;

/** Sign-in is Supabase Auth's job; here a parent is simply signed in as a known user. */
const signedInAs = (id: string, email: string): AuthPort => ({
  user: async () => ({ id, email }),
  signInWithGoogle: async () => {}, sendEmailLink: async () => {}, signOut: async () => {},
});

async function newParent() {
  const id = randomUUID();
  await db.query("insert into auth.users (id) values ($1)", [id]);
  return id;
}

beforeAll(async () => {
  let url: string;
  ({ db, url, drop } = await createTestDb());
  // Answers refer to questions, so the bank has to be there.
  await seedBank(new PgQuestionStore(db), UKG_TOPICS);
  api = await startPostgrest(db, url);
}, 60_000);

afterAll(async () => {
  await api?.stop();
  await drop?.();
});

accountContract("the Supabase backend", async () => {
  const id = await newParent();
  return supabaseBackend(api.clientFor(id), signedInAs(id, `${id}@example.com`));
});

describe("the Supabase backend", () => {
  it("makes the parent's row on first sign-in, once", async () => {
    const id = await newParent();
    const b = supabaseBackend(api.clientFor(id), signedInAs(id, "new@example.com"));
    expect(await b.account()).toEqual({ userId: id, email: "new@example.com", consentVersion: null, pinHash: null });
    await b.account();
    expect((await db.query("select count(*)::int n from public.parents where id = $1", [id])).rows[0].n).toBe(1);
  });

  it("returns nothing when signed out", async () => {
    const id = await newParent();
    const b = supabaseBackend(api.clientFor(id), { ...signedInAs(id, ""), user: async () => null });
    expect(await b.account()).toBeNull();
    await expect(b.giveConsent("v")).rejects.toThrow("Sign in first.");
  });

  it("asks again after the consent text changes, by giving the newest version", async () => {
    const id = await newParent();
    const b = supabaseBackend(api.clientFor(id), signedInAs(id, "x@example.com"));
    await b.account();
    await b.giveConsent("2026-10-25");
    await b.giveConsent("2027-01-01");
    expect((await b.account())?.consentVersion).toBe("2027-01-01");
  });
});

describe("the accounts migration", () => {
  it("lets a parent set only their own PIN, and only as a hash", async () => {
    const a = await newParent(), b = await newParent();
    await db.query("insert into public.parents (id) values ($1), ($2)", [a, b]);
    await expect(as(db, a, q => q.query("update public.parents set pin_hash = '1234' where id = $1", [a])))
      .rejects.toThrow("violates check constraint");
    const changed = await as(db, a, q => q.query("update public.parents set pin_hash = 'pbkdf2-sha256$1$c2FsdA==$aA==' where id = $1", [b]));
    expect(changed.rowCount).toBe(0);
    await expect(as(db, a, q => q.query("update public.parents set created_at = now() where id = $1", [a])))
      .rejects.toThrow("permission denied");
  });

  it("keeps a profile to the onboarding choices", async () => {
    const a = await newParent();
    await db.query("insert into public.parents (id) values ($1)", [a]);
    await db.query("insert into public.consents (parent_id, consent_version) values ($1, 'v1')", [a]);
    const add = (avatar: string, board: string, language: string, nickname = "Riya") => as(db, a, q => q.query(
      "insert into public.profiles (parent_id, nickname, avatar, class_id, board, language) values ($1, $2, $3, 'UKG', $4, $5)",
      [a, nickname, avatar, board, language]), { rollback: true });
    await expect(add("owl", "CBSE", "en")).resolves.toBeDefined();
    await expect(add("dragon", "CBSE", "en")).rejects.toThrow("profiles_avatar_choice");
    await expect(add("owl", "IB", "en")).rejects.toThrow("profiles_board_choice");
    await expect(add("owl", "CBSE", "English")).rejects.toThrow("profiles_language_choice");
    await expect(add("owl", "CBSE", "en", " Riya")).rejects.toThrow("profiles_nickname_trimmed");
  });
});
