/**
 * Capture the capability probes from a real run: the labelled scripted
 * baseline plays After Hours headless, and the first observation that shows
 * each probe's situation is kept, exactly as a provider received it
 * (addressed to Jev, so the live probe run can send it unchanged).
 *
 * The baseline tunes too cleanly ever to overshoot a terminal, so a second,
 * heavy-handed pass (the same policy, but always a long hold on a terminal
 * dial — run A's habit) produces the overshoot situations. Either way the
 * observation is the game's own: only the policy that walked into it differs.
 *
 *   bun scripts/capture-probes.ts [--out evals/after-hours-probes.json]
 *
 * Deterministic: the same build captures the same observations. Also prints
 * how often each situation came up in the run — the weight a failure there
 * carries in a whole mission.
 */
import { writeFileSync } from "node:fs";
import * as THREE from "three";
import { Game } from "../src/game/Game";
import type { WorldObservation } from "../src/agent/observation";
import { MockProvider } from "../src/agent/providers/local";
import { createAfterHoursBaseline } from "../src/agent/tasks/afterHoursBaseline";
import { validateObservation } from "../src/agent/tasks/registry";
import { AFTER_HOURS_PROBES, PROBE_SCHEMA, type ProbeFile } from "../src/agent/probes/afterHours";
import type { AfterHoursState } from "../src/agent/tasks/afterHoursSchema";

const args = process.argv.slice(2);
const out = args.includes("--out")
  ? args[args.indexOf("--out") + 1]
  : "evals/after-hours-probes.json";

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000);
const kept = new Map<string, { observation: WorldObservation; capturedBy: string }>();
const seen = new Map<string, number>();
let decisions = 0;

async function play(heavyHanded: boolean): Promise<void> {
  const game = new Game({ visuals: false, storage: null });
  game.afterHours.start();
  const step = () => game.frame(1 / 60, { simulate: true, camera, establishing: false });
  step();
  const baseline = createAfterHoursBaseline();
  game.agent.runtime.start(
    "agent",
    new MockProvider((o) => {
      const obs = o as WorldObservation<AfterHoursState>;
      if (!heavyHanded) decisions++;
      for (const probe of AFTER_HOURS_PROBES) {
        if (!probe.matches(obs)) continue;
        if (!heavyHanded) seen.set(probe.id, (seen.get(probe.id) ?? 0) + 1);
        if (!kept.has(probe.id)) {
          const copy = structuredClone(o);
          copy.controller = { mode: "agent", provider: "jev" };
          kept.set(probe.id, {
            observation: copy,
            capturedBy: heavyHanded ? "heavy-handed baseline" : "baseline",
          });
        }
      }
      const intent = baseline(o);
      return heavyHanded && intent.intent === "tune_terminal"
        ? { ...intent, amount: "long" }
        : intent;
    }),
  );
  const missing = () => AFTER_HOURS_PROBES.some((p) => !kept.has(p.id));
  for (let i = 0; i < 900 * 60 && !game.afterHours.progress.concertCompleted; i++) {
    if (heavyHanded && !missing()) break;
    step();
    for (let k = 0; k < 4; k++) await Promise.resolve();
  }
  game.dispose();
}

await play(false);
if (AFTER_HOURS_PROBES.some((p) => !kept.has(p.id))) await play(true);

const missing = AFTER_HOURS_PROBES.filter((p) => !kept.has(p.id)).map((p) => p.id);
const file: ProbeFile = {
  schema: PROBE_SCHEMA,
  environment: "pine-gap",
  task: "after-hours",
  capturedAt: new Date().toISOString().slice(0, 10),
  capturedWith:
    "scripted After Hours baseline (?controller=mock), headless; a heavy-handed variant (long holds on terminals) where the baseline never reaches the situation",
  probes: AFTER_HOURS_PROBES.filter((p) => kept.has(p.id)).map((p) => ({
    id: p.id,
    ...kept.get(p.id)!,
  })),
};
for (const f of file.probes) {
  const v = validateObservation(f.observation);
  if (!v.ok) throw new Error(`${f.id}: captured observation is invalid: ${v.error}`);
}
writeFileSync(out, JSON.stringify(file, null, 1) + "\n");
console.log(
  JSON.stringify(
    {
      out,
      decisions,
      captured: file.probes.length,
      missing,
      situationsPerRun: Object.fromEntries(
        AFTER_HOURS_PROBES.map((p) => [p.id, seen.get(p.id) ?? 0]),
      ),
    },
    null,
    1,
  ),
);
process.exit(missing.length === 0 ? 0 : 1);
