// Builds the page as one HTML file.
//   node preview/build.mjs         dist/preview.html: the demo, as published for testing
//   node preview/build.mjs --app   dist/app/index.html: the real app, using the Supabase
//                                  project in NITYA_SUPABASE_URL and NITYA_SUPABASE_KEY
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const app = process.argv.includes("--app");
const url = process.env.NITYA_SUPABASE_URL ?? "";
const key = process.env.NITYA_SUPABASE_KEY ?? "";
if (app && (!url || !key)) console.warn("NITYA_SUPABASE_URL or NITYA_SUPABASE_KEY is not set, so the app will run the demo.");

const out = await build({
  entryPoints: [app ? "src/app-entry.ts" : "src/preview-entry.ts"],
  bundle: true, format: "iife", globalName: "Nitya", target: "es2020", write: false, minify: app,
  define: { __SUPABASE_URL__: JSON.stringify(url), __SUPABASE_KEY__: JSON.stringify(key) },
});
const engine = out.outputFiles[0].text;
const script = readFileSync("preview/app.js", "utf8");
const page = readFileSync("preview/template.html", "utf8")
  .replace("/*ENGINE*/", () => engine)
  .replace("/*APP*/", () => script);
const file = app ? "dist/app/index.html" : "dist/preview.html";
mkdirSync(app ? "dist/app" : "dist", { recursive: true });
writeFileSync(file, page);
console.log(file, page.length, "bytes");
