import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The credential boundary, on the source tree. The TypeSafe key is read in
 * exactly one server module and handed to the handler. Browser code must not
 * read it, must not ask for a `VITE_` copy (Vite would inline it), and must
 * not import server modules. `scripts/verify-secret-boundary.mjs` builds the
 * production client with a canary key and scans every emitted asset too.
 */

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? walk(path)
      : /\.(ts|tsx|js|mjs)$/.test(name)
        ? [path]
        : [];
  });
}

const all = walk("src");
const server = (path: string) =>
  path.startsWith(join("src", "server")) || path.endsWith(join("src", "server.ts"));
const serverRoute = (path: string) => /src\/routes\/api\./.test(path);
const browser = all.filter((p) => !server(p) && !serverRoute(p) && !p.endsWith("routeTree.gen.ts"));
const read = (p: string) => readFileSync(p, "utf8");

describe("credential boundary (source)", () => {
  test("no browser module names the key, a VITE_ copy of it, or reads the server environment", () => {
    const offenders = browser.filter((p) =>
      /TYPESAFE_API_KEY|VITE_TYPESAFE|process\.env/.test(read(p)),
    );
    expect(offenders.map((p) => relative(".", p))).toEqual([]);
  });

  test("no browser module imports server code or the upstream endpoint", () => {
    const offenders = browser.filter(
      (p) =>
        /from\s+["'][^"']*\/server\/|from\s+["']@\/server\//.test(read(p)) ||
        read(p).includes("api.typesafe.ai"),
    );
    expect(offenders.map((p) => relative(".", p))).toEqual([]);
  });

  test("the key is read by the server entry only", () => {
    const readers = all
      .filter((p) =>
        /process\.env(\.TYPESAFE_API_KEY|\[\s*["']TYPESAFE_API_KEY["']\s*\])/.test(read(p)),
      )
      .map((p) => relative(".", p));
    expect(readers).toEqual(["src/server/agent/jev.server.ts"]);
  });

  test("the only route that reaches the server module is the API route", () => {
    const importers = all
      .filter((p) => /server\/agent\/jev\.server/.test(read(p)))
      .map((p) => relative(".", p));
    expect(importers).toEqual(["src/routes/api.agent.jev.decision.ts"]);
  });

  test("a built client, if present, contains no credential, upstream adapter or server code", () => {
    // Run `bun run verify:secrets` to build with a canary key and scan it.
    const root = ".output/public";
    if (!existsSync(root)) return;
    const offenders = readdirSync(root, { recursive: true })
      .map((f) => join(root, String(f)))
      .filter((p) => /\.(js|mjs|map|html|json|css)$/.test(p))
      .filter((p) => {
        const text = read(p);
        return (
          text.includes("svs-secret-boundary-canary") ||
          /apikey_[A-Za-z0-9_]{20,}/.test(text) ||
          text.includes("api.typesafe.ai") ||
          text.includes("TYPESAFE_API_KEY")
        );
      });
    expect(offenders).toEqual([]);
  });
});
