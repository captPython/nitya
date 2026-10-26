// The family-questions Supabase Edge Function. `npm run functions` bundles this
// file into supabase/functions/family-questions/server.js (see README).
import { createClient } from "@supabase/supabase-js";
import { ALL_CONTENT } from "../content";
import { familyQuestionsHandler } from "./family-questions";
import { familyDeps } from "./supabase-deps";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): unknown;
};

const env = (name: string) => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${name} is not set.`);
  return v;
};

// Supabase sets these for every Edge Function.
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(familyQuestionsHandler({ ...familyDeps(admin), contents: ALL_CONTENT }));
