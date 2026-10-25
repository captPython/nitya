import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const out = await build({
  entryPoints: ["src/preview-entry.ts"],
  bundle: true, format: "iife", globalName: "Nitya", target: "es2020", write: false,
});
const engine = out.outputFiles[0].text;
const page = readFileSync("preview/template.html", "utf8").replace("/*ENGINE*/", () => engine);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/preview.html", page);
console.log("dist/preview.html", page.length, "bytes");
