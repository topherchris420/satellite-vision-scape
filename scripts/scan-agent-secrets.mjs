import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = ".output/public";
if (!existsSync(root)) throw new Error("Build the production client first");
let count = 0;
function walk(path) {
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs|map|html|json)$/.test(p)) {
      count++;
      const text = readFileSync(p, "utf8");
      if (
        text.includes("svs-secret-boundary-canary-2026") ||
        /apikey_[a-zA-Z0-9_]{20,}/.test(text) ||
        text.includes("api.typesafe.ai/v1/systemone") ||
        text.includes("TYPESAFE_API_KEY")
      )
        throw new Error(`Server boundary crossed in ${p}`);
    }
  }
}
walk(root);
console.log(
  `PASS: ${count} client artifacts contain no credential canary, API key, or upstream adapter`,
);
