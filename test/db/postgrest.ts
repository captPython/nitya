import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SECRET = "nitya-tests-only-jwt-secret-0123456789";

const base64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** A signed-in user's token, as Supabase Auth would issue it. */
export function jwtFor(userId: string): string {
  const head = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify({ sub: userId, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }));
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
  s.on("error", reject);
});

/**
 * Runs PostgREST, the API server inside Supabase, on a test database, behind
 * a small proxy at /rest/v1 as Supabase serves it. supabase-js then talks to
 * it exactly as the app will, with row-level security applied by token.
 */
export async function startPostgrest(db: pg.Client, databaseUrl: string): Promise<{
  clientFor: (userId: string) => SupabaseClient;
  stop: () => Promise<void>;
}> {
  await db.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticator') then
      create role authenticator login noinherit;
    end if;
  end $$`);
  await db.query("grant anon, authenticated to authenticator");

  const dbUrl = new URL(databaseUrl);
  dbUrl.username = "authenticator";
  dbUrl.password = "";
  const port = await freePort();
  const bin = process.env.POSTGREST_BIN ?? "postgrest";
  const proc: ChildProcess = spawn(bin, [], {
    env: {
      ...process.env,
      PGRST_DB_URI: dbUrl.toString(), PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: SECRET, PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: String(port),
      PGRST_DB_CHANNEL_ENABLED: "false", PGRST_LOG_LEVEL: "error",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proc.stderr?.on("data", d => { stderr += d; });
  const spawned = new Promise<void>((_, reject) => proc.on("error", err =>
    reject(new Error(`Couldn't start PostgREST (${bin}): ${err.message}. Set POSTGREST_BIN to its path.`))));

  // Wait until PostgREST answers with the schema loaded (503 means it is still loading).
  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/topics?select=id&limit=1`);
        if (res.status !== 503) return;
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`PostgREST didn't start: ${stderr}`);
  })();
  await Promise.race([ready, spawned]);

  const proxy: Server = createServer((req, res) => {
    const path = (req.url ?? "/").replace(/^\/rest\/v1/, "") || "/";
    const out = request({ host: "127.0.0.1", port, path, method: req.method, headers: req.headers }, upstream => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    });
    out.on("error", err => { res.writeHead(502); res.end(err.message); });
    req.pipe(out);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;

  return {
    clientFor: userId => createClient(`http://127.0.0.1:${proxyPort}`, "anon-key-unused-in-tests", {
      accessToken: async () => jwtFor(userId),
    }),
    async stop() {
      proc.kill();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    },
  };
}
