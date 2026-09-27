#!/usr/bin/env node
/**
 * Secret-boundary check on a real production build.
 *
 * Builds the app with a fake TypeSafe credential (a canary) in the build
 * environment, then fails if the canary — or any key-shaped string, the
 * upstream endpoint, or the variable's name — appears anywhere in the client
 * assets, or if the canary was baked into the server bundle at build time
 * (the server must read it at run time, never inline it).
 *
 *   node scripts/verify-secret-boundary.mjs          # build, then scan
 *   node scripts/verify-secret-boundary.mjs --scan   # scan an existing build
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CANARY = "svs-secret-boundary-canary-2026-do-not-ship";

if (!process.argv.includes("--scan")) {
  const build = spawnSync("bun", ["run", "build"], {
    stdio: "inherit",
    env: { ...process.env, TYPESAFE_API_KEY: CANARY, TYPESAFE_MODEL: "jev-latest" },
  });
  if (build.status !== 0) {
    console.error("FAIL: the production build did not complete");
    process.exit(1);
  }
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const TEXT = /\.(js|mjs|cjs|map|html|json|css|txt|webmanifest)$/;
const client = walk(".output/public").filter((p) => TEXT.test(p));
const serverFiles = walk(".output/server").filter((p) => TEXT.test(p));
if (client.length === 0) {
  console.error("FAIL: no client assets found under .output/public");
  process.exit(1);
}

const failures = [];
for (const path of client) {
  const text = readFileSync(path, "utf8");
  if (text.includes(CANARY)) failures.push(`${path}: contains the canary credential`);
  if (/apikey_[A-Za-z0-9_]{20,}/.test(text)) failures.push(`${path}: contains a key-shaped string`);
  if (text.includes("api.typesafe.ai")) failures.push(`${path}: contains the upstream endpoint`);
  if (text.includes("TYPESAFE_API_KEY")) failures.push(`${path}: names the credential variable`);
}
for (const path of serverFiles) {
  if (readFileSync(path, "utf8").includes(CANARY))
    failures.push(`${path}: the credential was inlined into the server bundle at build time`);
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log(
  `PASS: ${client.length} client assets and ${serverFiles.length} server files scanned; no credential, key, upstream endpoint or variable name crossed into the client, and nothing was inlined at build time.`,
);
