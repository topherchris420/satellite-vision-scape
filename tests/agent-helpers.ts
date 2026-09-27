import * as THREE from "three";
import { Game } from "../src/game/Game";
import type { AgentIntent } from "../src/agent/contract";
import { decided, type AgentProvider, type ProviderResult } from "../src/agent/provider";

/** Shared fixtures for the agent test suites. */

export const FRAME = 1 / 60;
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000);

/** A headless game with After Hours started (as the briefing button does). */
export function afterHoursGame(): Game {
  const g = new Game({ visuals: false, storage: null });
  g.afterHours.start();
  step(g);
  return g;
}

export function step(g: Game): void {
  g.frame(FRAME, { simulate: true, camera, establishing: false });
}

/** Let provider promises settle between frames, as the browser's event loop does. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

export async function run(
  g: Game,
  seconds: number,
  until: () => boolean = () => false,
): Promise<number> {
  let frames = 0;
  for (; frames < Math.round(seconds / FRAME) && !until(); frames++) {
    step(g);
    await flush();
  }
  return frames * FRAME;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A provider whose answers the test releases by hand. */
export class ManualProvider implements AgentProvider {
  readonly id: string;
  readonly label = "Manual test provider";
  readonly source = "test" as const;
  readonly requests: {
    sequence: number;
    signal: AbortSignal;
    resolve: (r: ProviderResult) => void;
  }[] = [];

  constructor(id = "manual") {
    this.id = id;
  }

  decide({ sequence, signal }: { sequence: number; signal: AbortSignal }): Promise<ProviderResult> {
    const d = deferred<ProviderResult>();
    this.requests.push({ sequence, signal, resolve: d.resolve });
    return d.promise;
  }

  answer(index: number, intent: AgentIntent | unknown): void {
    this.requests[index].resolve(decided(intent));
  }
}

/** A provider that always answers `pick(observation)` immediately. */
export function scripted(
  pick: (o: import("../src/agent/observation").WorldObservation) => unknown,
  id = "script",
): AgentProvider {
  return {
    id,
    label: `Scripted test (${id})`,
    source: "test",
    decide: async ({ observation }) => decided(pick(observation)),
  };
}

/** Write `value` at a dotted path of plain data (for tests that corrupt it on purpose). */
export function setPath(target: unknown, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = target as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  const last = keys[keys.length - 1];
  if (value === undefined) delete node[last];
  else node[last] = value;
}
