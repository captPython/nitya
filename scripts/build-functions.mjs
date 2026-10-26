// Bundles the server functions for Supabase Edge Functions: each entry in
// src/server and everything it uses, into one file next to its function's
// index.ts. Run before `supabase functions deploy` (see README).
import { build } from "esbuild";

const FUNCTIONS = [
  ["src/server/edge.ts", "new-questions"],
  ["src/server/edge-family.ts", "family-questions"],
];

for (const [entry, name] of FUNCTIONS) {
  await build({
    entryPoints: [entry],
    outfile: `supabase/functions/${name}/server.js`,
    bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true,
    banner: { js: `// Built by \`npm run functions\` from ${entry}. Don't edit.` },
  });
  console.log(`supabase/functions/${name}/server.js`);
}
