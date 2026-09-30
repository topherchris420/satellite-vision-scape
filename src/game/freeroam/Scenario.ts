import { buildings, parkingLots } from "@/lib/site-layout";
import { RandomStream, deriveSeed } from "@/lib/freeroam/rng";
import { wrapPi } from "@/lib/freeroam/contracts";
import { getFenceLayout } from "@/lib/site-fences";
import { PLAYER_SPAWN } from "../world/spawns";
import { CollisionLayer } from "../world/colliders";
import type { CollisionWorld } from "../world/CollisionWorld";
import type { GroundQuery } from "../world/GroundQuery";
import type { ChallengeDefinition, ChallengeKind, Criterion, StageDef } from "./Challenges";
import type { FleetKind } from "./fleet";
import { LANDMARKS } from "./landmarks";
import type { PedSpec } from "./Pedestrians";
import type { TargetSpec } from "./RangeTargets";
import type { RoadNetwork } from "./Roads";
import type { GuardSpec } from "./Security";
import type { CollectibleSpec, EnvironmentEventSpec, LocationSpec } from "./Sites";
import type { TrafficSpec } from "./Traffic";

/**
 * A scenario is a seed and a challenge, and everything they imply: where the
 * pedestrians walk, which vehicles idle at the kerb, where the shards lie,
 * when the dust arrives and what has to be done. `buildScenario` is a pure
 * function — no clock, no `Math.random`, no state — so a person and an agent
 * given the same seed start in the same world, and a replay finds it again.
 */

export const SCENARIO_VERSION = 1;
export const DEFAULT_SEED = 48291;
export const DEFAULT_CHALLENGE = "borrowed-wheels";

export type TimeOfDay = "day" | "dusk" | "night";

export interface ScenarioContext {
  roads: RoadNetwork;
  collision: CollisionWorld;
  ground: GroundQuery;
}

export interface ScenarioSpec {
  version: typeof SCENARIO_VERSION;
  seed: number;
  challengeId: string;
  timeOfDay: TimeOfDay;
  playerSpawn: { x: number; z: number; yaw: number };
  pedestrians: PedSpec[];
  /** Civilians who drive the civil traffic; dormant until their vehicle is taken. */
  drivers: PedSpec[];
  traffic: TrafficSpec[];
  guards: GuardSpec[];
  collectibles: CollectibleSpec[];
  locations: LocationSpec[];
  events: EnvironmentEventSpec[];
  targets: TargetSpec[];
  challenge: ChallengeDefinition;
}

export interface ChallengeInfo {
  id: string;
  title: string;
  kind: ChallengeKind;
  brief: string;
}

export const CHALLENGES: readonly ChallengeInfo[] = [
  {
    id: "borrowed-wheels",
    title: "Borrowed Wheels",
    kind: "chain",
    brief: "Take a vehicle that is not yours, reach the checkpoint, then shake the site's response.",
  },
  {
    id: "checkpoint-race",
    title: "Checkpoint race",
    kind: "race",
    brief: "Get into UV-1 and take every checkpoint in order.",
  },
  {
    id: "vehicle-delivery",
    title: "Vehicle delivery",
    kind: "delivery",
    brief: "Deliver the hauler to the depot without wrecking it.",
  },
  {
    id: "reach-destination",
    title: "Reach the destination",
    kind: "reach",
    brief: "Get to the marked place, by any means.",
  },
  {
    id: "escape-pursuit",
    title: "Escape the pursuit",
    kind: "escape",
    brief: "The alarm is up. Get away from security and stay away.",
  },
  {
    id: "precision-drive",
    title: "Precision driving",
    kind: "precision",
    brief: "Thread the marked gates in UV-1 without touching anything.",
  },
  {
    id: "collect-shards",
    title: "Collect signal shards",
    kind: "collect",
    brief: "Find and pick up ten signal shards before time runs out.",
  },
  {
    id: "shooting-range",
    title: "Shooting range",
    kind: "shooting",
    brief: "Bring down six drones with the sidearm. Aim first.",
  },
  {
    id: "follow-target",
    title: "Follow the target",
    kind: "follow",
    brief: "Get a vehicle and stay on the tail of the scout for forty seconds.",
  },
  {
    id: "survive",
    title: "Survive",
    kind: "survive",
    brief: "The alarm is up. Stay alive for ninety seconds.",
  },
  {
    id: "stealth-approach",
    title: "Stealth approach",
    kind: "stealth",
    brief: "Reach the marked place without raising attention above Noticed.",
  },
  {
    id: "clean-drive",
    title: "Drive clean",
    kind: "clean_drive",
    brief: "Drive six hundred metres in UV-1 without a single collision.",
  },
  {
    id: "exploration",
    title: "Exploration",
    kind: "exploration",
    brief: "Visit four of the site's landmarks.",
  },
  {
    id: "free-play",
    title: "Free play",
    kind: "free",
    brief: "No goal. The site is yours: shards to find, vehicles to try, a crowd to keep out of trouble.",
  },
];

export function challengeInfo(id: string): ChallengeInfo | undefined {
  return CHALLENGES.find((c) => c.id === id);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Placement looks at the static site only. Vehicles and barrier booms move,
 * so a scenario that consulted them would come out differently depending on
 * where the last run left them: the same seed must always build the same world.
 */
const FOOT_MASK = CollisionLayer.Structure | CollisionLayer.Prop | CollisionLayer.Fence;
const CAR_MASK = CollisionLayer.Structure | CollisionLayer.Prop | CollisionLayer.Fence;

interface RoadSample {
  route: number;
  s: number;
  x: number;
  z: number;
  tx: number;
  tz: number;
}

/** Every road sampled every 12 m, in a fixed order. */
function sampleRoads(roads: RoadNetwork): RoadSample[] {
  const out: RoadSample[] = [];
  const pt = { x: 0, z: 0, tx: 0, tz: 0 };
  roads.routes.forEach((r, i) => {
    for (let s = 6; s < r.length - 6; s += 12) {
      roads.pointAt(i, s, pt);
      out.push({ route: i, s, x: pt.x, z: pt.z, tx: pt.tx, tz: pt.tz });
    }
  });
  return out;
}

function shuffle<T>(items: readonly T[], rng: RandomStream): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.float() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);

/**
 * Every cell of a 4 m grid that can be walked to from `from` while `free` holds, breadth first in a fixed
 * order (so the result is the same on every machine). A step is taken only if the cell, the midpoint and the
 * next cell are all free: with a 1 m radius those three circles cover the whole 4 m segment, so a thin wall
 * cannot be stepped over. Bounded to ±600 m so an open plain cannot run away.
 */
function floodFill(
  from: { x: number; z: number },
  free: (x: number, z: number) => boolean,
): { xs: number[]; zs: number[] } {
  const CELL = 4;
  const HALF = 150;
  const W = HALF * 2 + 1;
  const seen = new Uint8Array(W * W);
  const xs: number[] = [];
  const zs: number[] = [];
  const queue: number[] = [];
  const key = (ix: number, iz: number) => (ix + HALF) * W + (iz + HALF);
  seen[key(0, 0)] = 1;
  queue.push(0, 0);
  for (let head = 0; head < queue.length; head += 2) {
    const ix = queue[head];
    const iz = queue[head + 1];
    const cx = from.x + ix * CELL;
    const cz = from.z + iz * CELL;
    xs.push(cx);
    zs.push(cz);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = ix + dx;
      const nz = iz + dz;
      if (Math.abs(nx) > HALF || Math.abs(nz) > HALF || seen[key(nx, nz)]) continue;
      const px = from.x + nx * CELL;
      const pz = from.z + nz * CELL;
      // A cell is only marked once it has been reached: a wall between one neighbour and it must not
      // hide it from another.
      if (free(px, pz) && free((cx + px) / 2, (cz + pz) / 2)) {
        seen[key(nx, nz)] = 1;
        queue.push(nx, nz);
      }
    }
  }
  return { xs, zs };
}

/** Build the complete description of a scenario. Pure and deterministic. */
export function buildScenario(seed: number, challengeId: string, ctx: ScenarioContext): ScenarioSpec {
  const info = challengeInfo(challengeId) ?? challengeInfo(DEFAULT_CHALLENGE)!;
  const id = info.id;
  const rng = new RandomStream(deriveSeed(seed, `scenario:${id}`));
  const { roads, collision, ground } = ctx;
  const spawn = { x: r2(PLAYER_SPAWN.x), z: r2(PLAYER_SPAWN.z), yaw: r2(PLAYER_SPAWN.yaw) };
  const samples = sampleRoads(roads);

  const foot = (x: number, z: number, r = 0.8): boolean => {
    const y = ground.heightAt(x, z);
    if (collision.overlapCircle(x, z, r, y + 0.3, y + 1.8, FOOT_MASK, null)) return false;
    // Not on a cliff: level within ±0.6 m at a stride's distance.
    return (
      Math.abs(ground.heightAt(x + 1.5, z) - y) < 0.6 &&
      Math.abs(ground.heightAt(x, z + 1.5) - y) < 0.6
    );
  };
  const car = (x: number, z: number): boolean => {
    const y = ground.heightAt(x, z);
    return !collision.overlapCircle(x, z, 2.7, y + 0.4, y + 2.0, CAR_MASK, null);
  };
  /** A point beside the road, `side` +1 left / −1 right of the route direction. */
  const roadside = (sm: RoadSample, side: 1 | -1, extra = 2.4): { x: number; z: number } => {
    const off = roads.routes[sm.route].halfWidth + extra;
    return { x: r2(sm.x + sm.tz * off * side), z: r2(sm.z - sm.tx * off * side) };
  };
  const at = (sm: RoadSample, ds: number): RoadSample => {
    const pt = { x: 0, z: 0, tx: 0, tz: 0 };
    const s = Math.max(0, Math.min(roads.routes[sm.route].length, sm.s + ds));
    roads.pointAt(sm.route, s, pt);
    return { route: sm.route, s, ...pt };
  };
  const within = (cx: number, cz: number, min: number, max: number) =>
    samples.filter((s) => {
      const d = dist(s.x, s.z, cx, cz);
      return d >= min && d <= max;
    });
  /**
   * The nearest ground a person can walk to from the spawn. A flood over a 3 m grid on static geometry,
   * run on first use: some landmark centres sit inside a compound that has no way in, and a marker
   * there could never be visited by anyone.
   */
  let flood: { xs: number[]; zs: number[] } | null = null;
  const reach = (x: number, z: number, within: number): { x: number; z: number } | null => {
    if (!flood) flood = floodFill(spawn, (px, pz) => foot(px, pz, 1.0));
    let best = -1;
    let bestD = within;
    for (let i = 0; i < flood.xs.length; i++) {
      const d = dist(flood.xs[i], flood.zs[i], x, z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best < 0 ? null : { x: r2(flood.xs[best]), z: r2(flood.zs[best]) };
  };

  // --- Pedestrians -------------------------------------------------------------------
  const pedestrians: PedSpec[] = [];
  const addPed = (path: [number, number][], role: PedSpec["role"]) => {
    if (path.some(([x, z]) => !foot(x, z))) return false;
    pedestrians.push({ id: `ped-${pedestrians.length + 1}`, path, style: rng.int(0, 1000), role });
    return true;
  };
  const nearPool = shuffle(within(spawn.x, spawn.z, 25, 230), rng);
  const farPool = shuffle(within(spawn.x, spawn.z, 230, 520), rng);
  let want = 10;
  for (const sm of nearPool) {
    if (want === 0) break;
    const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
    const a = roadside(sm, side);
    const b = roadside(at(sm, (rng.chance(0.5) ? 1 : -1) * rng.range(18, 40)), side);
    if (addPed([[a.x, a.z], [b.x, b.z]], "walker")) want--;
  }
  want = 6;
  for (const sm of shuffle(nearPool, rng)) {
    if (want === 0) break;
    const a = roadside(sm, 1, 2.2);
    const b = roadside(sm, -1, 2.2);
    if (addPed([[a.x, a.z], [b.x, b.z]], "crosser")) want--;
  }
  for (const li of [2, 0, 1]) {
    const lot = parkingLots[li];
    if (!lot) continue;
    const rot = lot.rotY ?? 0;
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    for (let k = 0; k < 2; k++) {
      const lx = (rng.float() - 0.5) * lot.size[0] * 0.7;
      const lz = (rng.float() - 0.5) * lot.size[1] * 0.7;
      const mx = (rng.float() - 0.5) * 8;
      const mz = (rng.float() - 0.5) * 8;
      const wx = lot.pos[0] + lx * c + lz * sn;
      const wz = lot.pos[1] - lx * sn + lz * c;
      addPed([[r2(wx), r2(wz)], [r2(wx + mx), r2(wz + mz)]], "loiterer");
    }
  }
  want = 8;
  for (const sm of farPool) {
    if (want === 0) break;
    const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
    const a = roadside(sm, side);
    const b = roadside(at(sm, rng.range(20, 45)), side);
    if (addPed([[a.x, a.z], [b.x, b.z]], "walker")) want--;
  }

  // --- Traffic ------------------------------------------------------------------------
  const traffic: TrafficSpec[] = [];
  const drivers: PedSpec[] = [];
  const counters: Partial<Record<FleetKind, number>> = {};
  const callsign = (kind: FleetKind): string => {
    const n = (counters[kind] = (counters[kind] ?? 0) + 1);
    const prefix = { utility: "SV", scout: "SC", hauler: "HL", response: "RU" }[kind];
    return `${prefix}-${n}`;
  };
  const addDriver = (spec: TrafficSpec) => {
    if (spec.role !== "civil") return;
    drivers.push({
      id: `drv-${drivers.length + 1}`,
      path: [[spec.depot?.x ?? 0, spec.depot?.z ?? 0]],
      style: rng.int(0, 1000),
      role: "loiterer",
    });
    spec.driverId = `drv-${drivers.length}`;
  };

  const drivable = shuffle(roads.drivableRoutes(240), rng);
  const kinds: FleetKind[] = ["utility", "scout", "utility", "hauler", "scout"];
  kinds.forEach((kind, i) => {
    const route = drivable[i % drivable.length];
    const length = roads.routes[route].length;
    let s = length * rng.range(0.3, 0.7);
    const pt = { x: 0, z: 0, tx: 0, tz: 0 };
    for (let tries = 0; tries < 8; tries++) {
      roads.pointAt(route, s, pt);
      if (dist(pt.x, pt.z, spawn.x, spawn.z) > 70) break;
      s = length * rng.range(0.3, 0.7);
    }
    const cruise = kind === "scout" ? rng.range(11, 13.5) : kind === "hauler" ? rng.range(7, 8.5) : rng.range(8.5, 11);
    const spec: TrafficSpec = {
      id: `civil-${i + 1}`,
      callsign: callsign(kind),
      kind,
      role: "civil",
      route,
      s: r2(s),
      dir: rng.chance(0.5) ? 1 : -1,
      cruise: r2(cruise),
      driverId: null,
    };
    addDriver(spec);
    traffic.push(spec);
  });

  // Vehicles idling at the kerb near the start: one to steal, one to try.
  const layByPool = shuffle(within(spawn.x, spawn.z, 70, 170), rng);
  let idleWanted = 2;
  for (const sm of layByPool) {
    if (idleWanted === 0) break;
    const side: 1 | -1 = 1;
    const spot = roadside(sm, side, 3.4);
    if (!car(spot.x, spot.z)) continue;
    if (dist(spot.x, spot.z, spawn.x, spawn.z) < 45) continue;
    // Two parked side by side share a door prompt, and the one wanted may never be the one offered.
    if (traffic.some((t) => t.idle && t.depot && dist(spot.x, spot.z, t.depot.x, t.depot.z) < 14)) continue;
    const kind: FleetKind = idleWanted === 2 ? "utility" : "scout";
    const spec: TrafficSpec = {
      id: `idle-${3 - idleWanted}`,
      callsign: callsign(kind),
      kind,
      role: "civil",
      route: sm.route,
      s: r2(sm.s),
      dir: 1,
      cruise: 10,
      driverId: null,
      idle: true,
      depot: { x: spot.x, z: spot.z, yaw: r2(Math.atan2(sm.tx, sm.tz)) },
    };
    addDriver(spec);
    traffic.push(spec);
    idleWanted--;
  }

  // Response units wait at depots well away from the start and from each other.
  const depots: RoadSample[] = [];
  for (const sm of shuffle(samples.filter((s) => dist(s.x, s.z, spawn.x, spawn.z) > 260), rng)) {
    if (depots.length === 3) break;
    if (depots.some((d) => dist(d.x, d.z, sm.x, sm.z) < 160)) continue;
    const spot = roadside(sm, 1, 3.4);
    if (!car(spot.x, spot.z)) continue;
    depots.push(sm);
    traffic.push({
      id: `unit-${depots.length}`,
      callsign: callsign("response"),
      kind: "response",
      role: "response",
      route: sm.route,
      s: r2(sm.s),
      dir: 1,
      cruise: 20,
      driverId: null,
      depot: { x: spot.x, z: spot.z, yaw: r2(Math.atan2(sm.tx, sm.tz)) },
    });
  }

  // --- Security -------------------------------------------------------------------------
  const guards: GuardSpec[] = [];
  for (const b of shuffle(buildings, rng)) {
    if (guards.length === 8) break;
    if (dist(b.pos[0], b.pos[1], -60, 40) > 340) continue;
    const a = rng.range(0, Math.PI * 2);
    const reach = Math.max(b.size[0], b.size[1]) / 2 + 3.2;
    const x = r2(b.pos[0] + Math.sin(a) * reach);
    const z = r2(b.pos[1] + Math.cos(a) * reach);
    if (!foot(x, z) || dist(x, z, spawn.x, spawn.z) < 30) continue;
    guards.push({ id: `guard-${guards.length + 1}`, post: { x, z, yaw: r2(a) } });
  }
  traffic
    .filter((t) => t.role === "response")
    .forEach((unit, i) => {
      for (const tag of ["a", "b"]) {
        guards.push({
          id: `crew-${i + 1}${tag}`,
          post: { x: unit.depot!.x, z: unit.depot!.z, yaw: unit.depot!.yaw },
          crewOf: unit.id,
        });
      }
    });

  // --- Collectibles --------------------------------------------------------------------------
  const collectibles: CollectibleSpec[] = [];
  const addShard = (x: number, z: number, value: number) => {
    if (!foot(x, z, 0.6)) return false;
    collectibles.push({ id: `shard-${collectibles.length + 1}`, x: r2(x), z: r2(z), value });
    return true;
  };
  const scatter = (count: number, min: number, max: number, value: number) => {
    let placed = 0;
    for (let tries = 0; tries < 400 && placed < count; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(min, max);
      if (addShard(spawn.x + Math.sin(a) * d, spawn.z + Math.cos(a) * d, value)) placed++;
    }
  };
  scatter(8, 35, 160, 10);
  let onRoad = 8;
  for (const sm of shuffle(samples.filter((s) => dist(s.x, s.z, spawn.x, spawn.z) < 380), rng)) {
    if (onRoad === 0) break;
    if (addShard(sm.x + sm.tz * 1.2, sm.z - sm.tx * 1.2, 15)) onRoad--;
  }
  scatter(8, 160, 450, 25);

  // --- Locations ------------------------------------------------------------------------------------
  const locations: LocationSpec[] = [];
  const place = (kind: LocationSpec["kind"], min: number, max: number) => {
    for (let tries = 0; tries < 400; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(min, max);
      const x = r2(spawn.x + Math.sin(a) * d);
      const z = r2(spawn.z + Math.cos(a) * d);
      if (foot(x, z, 1.4)) {
        locations.push({ id: `${kind}-1`, kind, x, z });
        return;
      }
    }
  };
  place("clinic", 45, 90);
  place("ammo", 60, 120);
  place("motorpool", 100, 170);

  // --- Environment ---------------------------------------------------------------------------------
  const events: EnvironmentEventSpec[] = [
    { id: "dust_front", startsAt: r2(rng.range(80, 140)), duration: 45 },
    { id: "siren_test", startsAt: r2(rng.range(200, 260)), duration: 10 },
    { id: "convoy", startsAt: r2(rng.range(300, 360)), duration: 60 },
  ];

  // --- Range targets ------------------------------------------------------------------------------
  const targets: TargetSpec[] = [];
  if (id === "shooting-range") {
    const facing = Math.PI; // targets stand facing the firing line (north of the start, facing south)
    for (let tries = 0; tries < 300 && targets.length < 6; tries++) {
      const a = spawn.yaw + rng.range(-0.7, 0.7);
      const d = rng.range(16, 40);
      const x = r2(spawn.x + Math.sin(a) * d);
      const z = r2(spawn.z + Math.cos(a) * d);
      if (!foot(x, z, 0.8) || targets.some((t) => dist(t.x, t.z, x, z) < 5)) continue;
      const moving = targets.length >= 4;
      targets.push({
        id: `target-${targets.length + 1}`,
        x,
        z,
        yaw: facing,
        ...(moving ? { to: [r2(x + 5), r2(z)] as [number, number] } : {}),
      });
    }
  }

  // A scout to follow starts a short drive from the start with a long, easy road ahead of it: no gate to stop
  // at and no hairpin, so the chase is about keeping up rather than about where the road happens to go.
  if (id === "follow-target") {
    const RUN = 420;
    const gates = getFenceLayout().gates;
    const pt = { x: 0, z: 0, tx: 0, tz: 0 };
    const easy = (sm: RoadSample, dir: 1 | -1, bend: number, gateGap: number): boolean => {
      const end = sm.s + dir * RUN;
      if (end < 0 || end > roads.routes[sm.route].length) return false;
      const yaws: number[] = [];
      for (let k = 0; k <= RUN; k += 12) {
        roads.pointAt(sm.route, sm.s + dir * k, pt);
        if (gates.some((g) => dist(g.center[0], g.center[1], pt.x, pt.z) < gateGap)) return false;
        yaws.push(Math.atan2(pt.tx * dir, pt.tz * dir));
      }
      for (let i = 3; i < yaws.length; i++) if (Math.abs(wrapPi(yaws[i] - yaws[i - 3])) > bend) return false;
      return true;
    };
    // Strictest first; relax only if this seed's roads offer nothing.
    const tiers: [number, number, number, number][] = [
      [70, 200, 0.5, 18],
      [60, 300, 0.8, 10],
    ];
    let lead: { sm: RoadSample; dir: 1 | -1 } | null = null;
    for (const [min, max, bend, gateGap] of tiers) {
      for (const sm of shuffle(within(spawn.x, spawn.z, min, max), rng)) {
        const dir: 1 | -1 | 0 = easy(sm, 1, bend, gateGap) ? 1 : easy(sm, -1, bend, gateGap) ? -1 : 0;
        if (dir !== 0) {
          lead = { sm, dir };
          break;
        }
      }
      if (lead) break;
    }
    if (lead) {
      const spec: TrafficSpec = {
        id: "civil-lead",
        callsign: callsign("scout"),
        kind: "scout",
        role: "civil",
        route: lead.sm.route,
        s: r2(lead.sm.s),
        dir: lead.dir,
        cruise: r2(rng.range(11, 12.5)),
        driverId: null,
        departsWithStage: true,
      };
      addDriver(spec);
      traffic.push(spec);
    }
  }

  const challenge = buildChallenge(info, {
    rng,
    spawn,
    roads,
    samples,
    traffic,
    drivers,
    landmarks: LANDMARKS,
    car,
    foot,
    reach,
    roadside,
    within,
  });

  const timeOfDay: TimeOfDay =
    id === "stealth-approach" || id === "escape-pursuit" ? "dusk" : id === "survive" ? "night" : "day";

  return {
    version: SCENARIO_VERSION,
    seed,
    challengeId: id,
    timeOfDay,
    playerSpawn: spawn,
    pedestrians,
    drivers,
    traffic,
    guards,
    collectibles,
    locations,
    events,
    targets,
    challenge,
  };
}

// --- Challenges ----------------------------------------------------------------------------------------

interface BuildCtx {
  rng: RandomStream;
  spawn: { x: number; z: number; yaw: number };
  roads: RoadNetwork;
  samples: RoadSample[];
  traffic: TrafficSpec[];
  drivers: PedSpec[];
  landmarks: readonly { id: string; label: string; x: number; z: number }[];
  car: (x: number, z: number) => boolean;
  foot: (x: number, z: number, r?: number) => boolean;
  reach: (x: number, z: number, within: number) => { x: number; z: number } | null;
  roadside: (sm: RoadSample, side: 1 | -1, extra?: number) => { x: number; z: number };
  within: (cx: number, cz: number, min: number, max: number) => RoadSample[];
}

function stage(id: string, kind: StageDef["kind"], title: string, hint: string, params: StageDef["params"]): StageDef {
  return { id, kind, title, hint, params };
}

function buildChallenge(info: ChallengeInfo, c: BuildCtx): ChallengeDefinition {
  const { rng, spawn } = c;
  const idle = c.traffic.filter((t) => t.idle);
  const stealTarget = idle[0];
  const loud = c.traffic.find((t) => t.kind === "scout" && t.role === "civil" && !t.idle);
  const stages: StageDef[] = [];
  let timeLimitS: number | null = null;
  let failOnDeath = false;
  const extraSuccess: Criterion[] = [];
  const extraFailure: Criterion[] = [];

  /** A road point far enough from `from` to be worth the trip. */
  const farPoint = (from: { x: number; z: number }, min: number, max: number) => {
    const pool = c.within(from.x, from.z, min, max);
    const draw = () => (pool.length > 0 ? pool[Math.floor(rng.float() * pool.length)] : c.samples[0]);
    let sm = draw();
    // The traced roads run under a few buildings; a marker there is one no car can reach. A pick that is fine
    // is kept as it was, so a seed whose marker was reachable still gets the same one.
    for (let tries = 0; tries < 40 && !c.car(sm.x, sm.z); tries++) sm = draw();
    return { x: r2(sm.x), z: r2(sm.z) };
  };

  switch (info.id) {
    case "borrowed-wheels": {
      const from = stealTarget?.depot ?? spawn;
      const cp = farPoint(from, 380, 620);
      stages.push(
        stage("steal", "enter_vehicle", "Take the vehicle", `Get into ${stealTarget?.callsign ?? "the idling vehicle"}, the one at the kerb`, {
          vehicleId: stealTarget?.callsign ?? "SV-1",
        }),
        stage("checkpoint", "reach", "Reach the checkpoint", "Drive to the marked checkpoint", {
          x: cp.x,
          z: cp.z,
          radius: 14,
          vehicle: "required",
        }),
        stage("escape", "escape", "Shake the response", "Security is after you. Get out of sight and stay out of sight", {
          hold: 6,
          alarm: 3.4,
        }),
      );
      timeLimitS = 900;
      failOnDeath = true;
      break;
    }
    case "checkpoint-race": {
      const pts: number[][] = [];
      let last: { x: number; z: number } = spawn;
      for (let i = 0; i < 5; i++) {
        const p = farPoint(last, 120, 260);
        pts.push([p.x, p.z]);
        last = p;
      }
      stages.push(
        stage("board", "enter_vehicle", "Get in", "Get into UV-1", { vehicleId: "UV-1" }),
        stage("race", "checkpoints", "Checkpoint", "Take the checkpoints in order", {
          points: pts,
          radius: 12,
          vehicle: true,
        }),
      );
      timeLimitS = 420;
      break;
    }
    case "vehicle-delivery": {
      const haul = c.traffic.find((t) => t.kind === "hauler");
      const dest = farPoint(spawn, 300, 480);
      stages.push(
        stage("board", "enter_vehicle", "Get the hauler", `Get into ${haul?.callsign ?? "HL-1"}`, {
          vehicleId: haul?.callsign ?? "HL-1",
        }),
        stage("deliver", "deliver", "Deliver it", "Drive it to the depot and stop there", {
          vehicleId: haul?.callsign ?? "HL-1",
          x: dest.x,
          z: dest.z,
          radius: 12,
          minHealth: 40,
        }),
      );
      timeLimitS = 600;
      break;
    }
    case "reach-destination": {
      const dest = farPoint(spawn, 320, 520);
      stages.push(stage("reach", "reach", "Reach the marked place", "Get to the marked place, by any means", { x: dest.x, z: dest.z, radius: 10, vehicle: "any" }));
      timeLimitS = 420;
      break;
    }
    case "escape-pursuit": {
      stages.push(stage("escape", "escape", "Escape", "The alarm is up. Get out of sight and stay out of sight", { hold: 8, alarm: 4.2 }));
      timeLimitS = 420;
      failOnDeath = true;
      break;
    }
    case "precision-drive": {
      const pts: number[][] = [];
      let last: { x: number; z: number } = spawn;
      for (let i = 0; i < 6; i++) {
        const p = farPoint(last, 60, 140);
        pts.push([p.x, p.z]);
        last = p;
      }
      stages.push(
        stage("board", "enter_vehicle", "Get in", "Get into UV-1", { vehicleId: "UV-1" }),
        stage("gates", "checkpoints", "Gate", "Drive through the marked gates without touching anything", {
          points: pts,
          radius: 4.5,
          vehicle: true,
          clean: true,
        }),
      );
      timeLimitS = 420;
      extraSuccess.push({ id: "clean", label: "No vehicle collisions", metric: "vehicleCollisions", op: "==", value: 0 });
      break;
    }
    case "collect-shards": {
      stages.push(stage("collect", "collect", "Collect signal shards", "Find and pick up ten signal shards", { count: 10 }));
      timeLimitS = 420;
      break;
    }
    case "shooting-range": {
      stages.push(stage("range", "shoot", "Bring down the drones", "Aim, then fire. Bring down all six drones", { count: 6 }));
      timeLimitS = 180;
      break;
    }
    case "follow-target": {
      const lead = c.traffic.find((t) => t.id === "civil-lead") ?? loud ?? c.traffic.find((t) => t.role === "civil" && !t.idle);
      stages.push(
        stage("board", "enter_vehicle", "Get a vehicle", "Get into any vehicle you can drive: UV-1 is by the car park", { vehicleId: "UV-1" }),
        stage("follow", "follow", "Follow the scout", `Stay within 6–45 m of ${lead?.callsign ?? "SC-1"} for 40 s`, {
          vehicleId: lead?.callsign ?? "SC-1",
          minD: 6,
          maxD: 45,
          loseD: 140,
          seconds: 40,
        }),
      );
      timeLimitS = 420;
      break;
    }
    case "survive": {
      stages.push(stage("survive", "survive", "Survive", "The alarm is up. Stay alive", { seconds: 90, alarm: 3.6 }));
      timeLimitS = 200;
      failOnDeath = true;
      break;
    }
    case "stealth-approach": {
      const dest = farPoint(spawn, 220, 320);
      stages.push(
        stage("approach", "stealth_reach", "Reach the marked place unseen", "Get to the marked place without raising attention above Noticed", {
          x: dest.x,
          z: dest.z,
          radius: 9,
          maxLevel: 1,
        }),
      );
      timeLimitS = 480;
      extraSuccess.push({ id: "quiet", label: "Attention stayed at Noticed or lower", metric: "attentionLevel", op: "<=", value: 1 });
      break;
    }
    case "clean-drive": {
      stages.push(
        stage("board", "enter_vehicle", "Get in", "Get into UV-1", { vehicleId: "UV-1" }),
        stage("drive", "clean_drive", "Drive clean", "Drive six hundred metres without a collision", { distance: 600, maxCollisions: 0 }),
      );
      timeLimitS = 480;
      extraSuccess.push({ id: "clean", label: "No vehicle collisions", metric: "vehicleCollisions", op: "==", value: 0 });
      break;
    }
    case "exploration": {
      // A landmark inside a walled compound is marked at the nearest ground that can be walked to.
      const open = c.landmarks.flatMap((l) => {
        const p = c.reach(l.x, l.z, 90);
        return p ? [[p.x, p.z]] : [];
      });
      const pts = open.length >= 4 ? open : c.landmarks.map((l) => [l.x, l.z]);
      stages.push(stage("visit", "explore", "Visit landmarks", "Visit four of the site's landmarks", { points: pts, radius: 16, count: 4 }));
      timeLimitS = 600;
      break;
    }
    default:
      break;
  }

  const success: Criterion[] = [];
  if (stages.length > 0)
    success.push({
      id: "stages",
      label: `Complete all ${stages.length} stage${stages.length === 1 ? "" : "s"}`,
      metric: "stagesCompleted",
      op: ">=",
      value: stages.length,
    });
  success.push({ id: "alive", label: "Finish with health above zero", metric: "playerHealth", op: ">", value: 0 });
  if (timeLimitS !== null)
    success.push({ id: "time", label: `Finish within ${timeLimitS} s`, metric: "elapsedS", op: "<=", value: timeLimitS });
  success.push(...extraSuccess);

  const failure: Criterion[] = [...extraFailure];
  if (failOnDeath) failure.push({ id: "death", label: "The player was incapacitated", metric: "deaths", op: ">", value: 0 });

  return {
    id: info.id,
    title: info.title,
    brief: info.brief,
    kind: info.kind,
    stages,
    timeLimitS,
    failOnDeath,
    success,
    failure,
  };
}
