import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The authority boundary for Free Roam, on the source tree. The agent decides
 * what it wants; the simulation decides whether it happens. Nothing that
 * chooses, validates, records or describes can reach world state; the one
 * road to the avatar is the action bus; and nothing that decides what happens
 * in the world reads a clock or a random number the trace could not replay.
 */

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Source with comments removed, so prose about `Math.random` is not mistaken for using it. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const imports = (path: string) => [...code(path).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
const touchesGame = (i: string) => i.includes("game/") || i.includes("/Game");

const AGENT = files("src/agent/freeroam");
/** The only agent modules that read the game: the bridge and the observation builder read it (and never write it); the session composes. */
const READS_THE_GAME = new Set(["bridge.ts", "observe.ts", "session.ts"]);
const base = (p: string) => p.split("/").pop()!;

describe("import boundary", () => {
  test("choosing, validating, recording and driving modules import nothing from the game", () => {
    for (const path of AGENT) {
      if (READS_THE_GAME.has(base(path))) continue;
      expect({ path, game: imports(path).filter(touchesGame) }).toEqual({ path, game: [] });
    }
  });

  test("the bridge and the observation builder read the game through its read-only view", () => {
    const bridge = imports("src/agent/freeroam/bridge.ts").filter(touchesGame);
    for (const i of bridge) expect(/View|FreeRoam$|types$|Weapons$|EventBus$|events$/.test(i)).toBe(true);
    expect(imports("src/agent/freeroam/observe.ts").filter(touchesGame)).toEqual(["@/game/freeroam/View"]);
  });

  test("the shared vocabulary imports neither the game nor the agent", () => {
    for (const path of files("src/lib/freeroam")) {
      const bad = imports(path).filter((i) => touchesGame(i) || i.includes("agent/"));
      expect({ path, bad }).toEqual({ path, bad: [] });
    }
  });

  test("the game layer does not depend on the decision layer (only the session is wired in, by Game)", () => {
    for (const path of files("src/game/freeroam")) {
      const bad = imports(path).filter((i) => i.includes("agent/freeroam"));
      expect({ path, bad }).toEqual({ path, bad: [] });
    }
    const game = imports("src/game/Game.ts").filter((i) => i.includes("agent/freeroam"));
    expect(game).toEqual(["../agent/freeroam/session"]);
  });

  test("no browser module names the decision service's credential", () => {
    const all = [...files("src/agent/freeroam"), ...files("src/game/freeroam"), ...files("src/lib/freeroam"), ...files("src/components/game")];
    const offenders = all.filter((p) => /TYPESAFE|VITE_TYPESAFE|process\.env/.test(code(p)));
    expect(offenders).toEqual([]);
  });
});

describe("write authority", () => {
  const MUTATIONS = /\.(teleport|place|setPosition|resetState|damagePlayer|applyImpulse|wake|despawn|spawn)\s*\(/;

  test("the bridge only reads: no assignments into the world and no mutating calls", () => {
    const src = code("src/agent/freeroam/bridge.ts");
    expect(src).not.toMatch(MUTATIONS);
    // Assignments to anything reached through the game objects.
    expect(src).not.toMatch(/\b(?:fr|this\.fr|host|this\.host)\.[A-Za-z_.[\]]+\s*(?:=|\+=|-=)(?!=)/);
  });

  test("the pilot, the behaviours and the runtime never touch the world at all: they take a body and a read-only world and return controls", () => {
    for (const name of ["pilot.ts", "behaviour.ts", "foot.ts", "drive.ts", "aim.ts", "supervisors.ts", "runtime.ts", "assist.ts", "legal.ts", "decisions.ts", "observation.ts"]) {
      const src = code(`src/agent/freeroam/${name}`);
      expect({ name, mutating: MUTATIONS.test(src) }).toEqual({ name, mutating: false });
    }
  });

  test("the session writes to the world in exactly the ways a person's UI does: start, reset, stop, and the control stack", () => {
    const src = code("src/agent/freeroam/session.ts");
    const calls = new Set([...src.matchAll(/\bthis\.fr\.([A-Za-z]+)\s*\(/g)].map((m) => m[1]));
    const allowed = new Set(["start", "reset", "stop", "setGhost", "objectiveMarker", "worldHash"]);
    expect([...calls].filter((c) => !allowed.has(c))).toEqual([]);
    const control = new Set([...src.matchAll(/\bcontrol\.([A-Za-z]+)/g)].map((m) => m[1]));
    for (const c of control) expect(["setMode", "beginReplay", "endReplay", "replay", "pacer", "mode", "agent", "assist", "bus", "onFrame"]).toContain(c);
    expect(src).not.toMatch(/\.player\b|\.vehicles\b|\.interaction\b|\.collision\b/);
  });

  test("the only thing an agent hands the avatar is GameActions: the control stack takes no position, velocity or state", () => {
    const src = code("src/game/freeroam/ControlStack.ts");
    expect(src).not.toMatch(/\.position\.set|\.velocity\s*=|teleport\(/);
    const controller = code("src/game/freeroam/AvatarController.ts");
    expect(controller).not.toMatch(/\.position\.set|\.velocity\s*=|teleport\(/);
  });
});

describe("determinism hygiene", () => {
  test("nothing that decides what happens in the world reads a clock or a random number", () => {
    const presentation = new Set(["FreeRoamVisuals.ts", "FreeRoamHud.ts"]);
    const sim = [...files("src/game/freeroam").filter((p) => !presentation.has(base(p))), ...files("src/lib/freeroam")];
    const offenders = sim.filter((p) => /Math\.random\s*\(|Date\.now\s*\(|performance\.now\s*\(|new Date\s*\(/.test(code(p)));
    expect(offenders.filter((p) => base(p) !== "ghost.ts")).toEqual([]);
  });

  test("the only clock the decision layer reads is the wall clock for latency, and it is injectable", () => {
    const users = AGENT.filter((p) => /performance\.now\s*\(|Date\.now\s*\(/.test(code(p))).map(base);
    for (const u of users) expect(["session.ts", "trace.ts", "runtime.ts", "providers/jev.ts", "jev.ts", "loop.ts"]).toContain(u);
  });
});
