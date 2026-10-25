// Bundles the New questions server function for Supabase Edge Functions:
// src/server/edge.ts and everything it uses, into one file next to the
// function's index.ts. Run before `supabase functions deploy` (see README).
import { build } from "esbuild";

await build({
  entryPoints: ["src/server/edge.ts"],
  outfile: "supabase/functions/new-questions/server.js",
  bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true,
  banner: { js: "// Built by `npm run functions` from src/server/edge.ts. Don't edit." },
});
console.log("supabase/functions/new-questions/server.js");
