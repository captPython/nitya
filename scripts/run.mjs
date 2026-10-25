// Runs a TypeScript script: bundles it with esbuild, leaving npm packages
// as imports, then runs the bundle with the remaining arguments.
import { build } from "esbuild";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const [entry, ...args] = process.argv.slice(2);
if (!entry) throw new Error("Usage: node scripts/run.mjs <script.ts> [args]");
const outfile = `node_modules/.cache/nitya/${basename(entry, ".ts")}.mjs`;
await build({
  entryPoints: [entry], bundle: true, platform: "node", format: "esm", target: "node20",
  packages: "external", outfile, logLevel: "warning",
});
process.argv = [process.argv[0], entry, ...args];
await import(pathToFileURL(outfile).href);
