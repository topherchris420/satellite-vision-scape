import * as THREE from "three";
import { Game } from "../src/game/Game";
import type { GameAction } from "../src/lib/freeroam/contracts";
import type { FrameContext } from "../src/lib/freeroam/contracts";

/** Shared fixtures for the Free Roam suites. */

export const FRAME = 1 / 60;
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000);

export function step(g: Game, frames = 1, dt = FRAME): void {
  for (let i = 0; i < frames; i++) g.frame(dt, { simulate: true, camera, establishing: false });
}

/** Let provider promises settle between frames, as the browser's event loop does. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** Step until `until` holds or `seconds` pass; returns the simulated seconds used. */
export async function run(g: Game, seconds: number, until: () => boolean = () => false, dt = FRAME): Promise<number> {
  let frames = 0;
  for (; frames < Math.round(seconds / dt) && !until(); frames++) {
    step(g, 1, dt);
    await flush();
  }
  return frames * dt;
}

/** A headless game with a Free Roam run started, one frame in. */
export function frGame(options: { seed?: number; challenge?: string } = {}): Game {
  const g = new Game({ visuals: false, storage: null });
  g.roam.play({ seed: options.seed ?? 48291, challenge: options.challenge ?? "free-play" });
  step(g);
  return g;
}

/** Put the avatar beside a vehicle's driver door (test setup, not gameplay). */
export function standAtDoor(g: Game, vehicleId = "uv-1"): void {
  const door = g.freeRoam.view.doorPoint(vehicleId, g.freeRoam.playerPosition());
  if (!door) throw new Error(`no such vehicle: ${vehicleId}`);
  g.player.teleport(door.x, door.z, 0);
  g.player.interpolate(1);
  step(g, 10);
}

/**
 * A producer a test controls: it is an agent as far as the bus can tell, so
 * whatever it emits travels the road a real agent's behaviours travel.
 */
export class ScriptedAgent {
  readonly source = "agent" as const;
  actions: GameAction[] = [];
  frames = 0;
  produce(_frame: FrameContext, out: GameAction[]): void {
    this.frames++;
    for (const a of this.actions) out.push(a);
  }
}

/** Hand the avatar to a scripted agent, through the same call the runtime uses. */
export function takeOver(g: Game, agent: ScriptedAgent): void {
  g.freeRoam.control.setMode("JEV");
  g.freeRoam.control.agent = agent;
}

// --- Decision providers for the runtime tests ---------------------------------------------------

import { decided, failure, type FailureKind, type ProviderResult } from "../src/agent/provider";
import type { FreeRoamDecision } from "../src/agent/freeroam/decisions";
import type { FreeRoamProvider } from "../src/agent/freeroam/runtime";
import type { FreeRoamObservation } from "../src/agent/freeroam/observation";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A provider whose answers are chosen by the test. */
export class TestProvider implements FreeRoamProvider {
  readonly id: string;
  readonly label: string;
  readonly source = "test" as const;
  calls = 0;
  observations: FreeRoamObservation[] = [];
  constructor(
    id = "test",
    public pick: (o: FreeRoamObservation) => unknown = (o) => o.legal[0],
    public fail: FailureKind | null = null,
  ) {
    this.id = id;
    this.label = `Test provider (${id})`;
  }
  async decide({ observation }: { sequence: number; observation: FreeRoamObservation; signal: AbortSignal }): Promise<ProviderResult<FreeRoamDecision>> {
    this.calls++;
    this.observations.push(observation);
    if (this.fail) return failure<FreeRoamDecision>(this.fail, `test failure: ${this.fail}`);
    return decided<FreeRoamDecision>(this.pick(observation), { confidence: 0.7 });
  }
}

/** A provider whose answers the test releases by hand (or never). */
export class ManualFrProvider implements FreeRoamProvider {
  readonly id = "manual";
  readonly label = "Manual test provider";
  readonly source = "test" as const;
  readonly requests: { sequence: number; signal: AbortSignal; observation: FreeRoamObservation; resolve: (r: ProviderResult<FreeRoamDecision>) => void }[] = [];
  decide({ sequence, observation, signal }: { sequence: number; observation: FreeRoamObservation; signal: AbortSignal }): Promise<ProviderResult<FreeRoamDecision>> {
    const d = deferred<ProviderResult<FreeRoamDecision>>();
    this.requests.push({ sequence, signal, observation, resolve: d.resolve });
    return d.promise;
  }
  answer(index: number, decision: unknown): void {
    this.requests[index].resolve(decided<FreeRoamDecision>(decision, { confidence: 0.6 }));
  }
}
