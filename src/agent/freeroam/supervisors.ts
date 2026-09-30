import { AutoFire, Approach, Aim } from "./aim";
import type { Behaviour, Ctx } from "./behaviour";
import type { DecisionOutcome } from "./decisions";
import { Cruise, DriveTo, Escape, ExitVehicle, FR_PROFILES, Pursue } from "./drive";
import { Collect, Enter, Flee, Hold, TakeCover, Turn, WalkTo, WalkToPoint } from "./foot";
import { createTracked, type ThreatSense, type Tracked } from "./world";

/**
 * Supervisors: the strategy tier.
 *
 * A strategy decision ("carry on with the objective", "lose the pursuit") is
 * too long to be one behaviour. A supervisor looks at the situation every
 * half second — the way a player glances at the objective marker and the
 * road — and picks the next step from the same repertoire of local behaviours
 * the tactical decisions use: walk, drive, get in, chase, run, engage. It
 * never does anything the tactical decisions could not, and it never acts on
 * the world itself; it only chooses which behaviour runs next.
 */

/** One step of a strategy: the layers to run. `undefined` leaves a layer alone; `null` clears it. */
export interface Step {
  /** Equal keys mean "the same step": a running one is not restarted. */
  key: string;
  label: string;
  make(): { loco?: Behaviour; aim?: Behaviour | null; trigger?: Behaviour | null };
}

export type Plan = { step: Step } | { outcome: DecisionOutcome };

export interface Supervisor {
  readonly name: string;
  plan(ctx: Ctx): Plan;
  /** A step it chose has ended, and how; a supervisor learns what not to try again. */
  stepEnded?(key: string, outcome: DecisionOutcome, now: number): void;
}

/** Outcomes that mean "that did not work". */
const FAILED: ReadonlySet<DecisionOutcome> = new Set<DecisionOutcome>([
  "blocked",
  "stuck",
  "target_unavailable",
  "timed_out",
  "no_effect",
]);

const walk = (id: string, sprint: boolean, label: string): Step => ({
  key: `${sprint ? "sprint" : "walk"}:${id}`,
  label,
  make: () => ({ loco: new WalkTo(id, sprint), aim: null, trigger: null }),
});

const enter = (id: string): Step => ({
  key: `enter:${id}`,
  label: `Go and take ${id.toUpperCase()}`,
  make: () => ({ loco: new Enter(id, true), aim: null, trigger: null }),
});

const driveTo = (id: string, park: boolean, label: string): Step => ({
  key: `drive:${id}:${park ? "park" : "go"}`,
  label,
  make: () => ({ loco: new DriveTo(id, FR_PROFILES.road, park) }),
});

const wait: Step = {
  key: "wait",
  label: "Wait and watch",
  make: () => ({ loco: new Hold(Infinity) }),
};

const exit: Step = {
  key: "exit",
  label: "Stop and get out",
  make: () => ({ loco: new ExitVehicle(), aim: null, trigger: null }),
};

/**
 * What has been learned about the stage in hand, kept across the decisions
 * that carry it out. "Carry on with the objective" is often chosen again and
 * again; without a memory each choice would walk into the same fence, fail at
 * once, and be chosen again. A new stage, or a new run (the clock goes back),
 * starts with a clean slate.
 */
export class StageMemory {
  private stage = -1;
  private last = -Infinity;
  /** Steps that did not work, and until when (simulated seconds). */
  readonly banned = new Map<string, number>();
  /** On foot: the nearest place not yet seen, then another tour. */
  readonly foot = new ExploreSupervisor({ far: false, max: 1e9, budgetS: 1e9, tours: true });
  /** By road: a place a good way off. */
  readonly road = new ExploreSupervisor({ far: true, max: 1e9, budgetS: 1e9 });

  sync(stage: number, now: number): void {
    if (stage !== this.stage || now < this.last) {
      this.stage = stage;
      this.banned.clear();
      this.foot.reset();
      this.road.reset();
    }
    this.last = now;
  }

  stepEnded(key: string, outcome: DecisionOutcome, now: number): void {
    this.foot.stepEnded(key, outcome, now);
    this.road.stepEnded(key, outcome, now);
    if (FAILED.has(outcome)) this.banned.set(key, now + 90);
  }

  ok(key: string, now: number): boolean {
    return (this.banned.get(key) ?? 0) <= now;
  }
}

/** Carry on with whatever the current stage asks. */
export class ObjectiveSupervisor implements Supervisor {
  readonly name = "objective";
  private readonly evade = new EvadeSupervisor();
  private readonly record = createTracked();

  constructor(private readonly memory: StageMemory = new StageMemory()) {}

  stepEnded(key: string, outcome: DecisionOutcome, now: number): void {
    this.memory.stepEnded(key, outcome, now);
    if (key.startsWith("look:")) this.spins++;
  }

  private ok(key: string, now: number): boolean {
    return this.memory.ok(key, now);
  }

  plan(ctx: Ctx): Plan {
    const world = ctx.world;
    const stage = world.stage();
    if (!stage || !stage.active) return { outcome: "done" };
    const b = ctx.body;
    this.memory.sync(stage.index, b.time);
    const driving = b.locomotion === "driving";
    const onFoot = b.locomotion === "on_foot";
    if (!driving && !onFoot) return { step: wait };
    const marker = world.marker();

    switch (stage.kind) {
      case "enter_vehicle": {
        const id = stage.vehicleId;
        if (!id) return { outcome: "target_unavailable" };
        if (driving) return b.vehicleId?.toLowerCase() === id ? { step: wait } : { step: exit };
        return { step: enter(id) };
      }
      case "escape":
      case "survive":
        return this.evade.plan(ctx);
      case "follow": {
        const lead = stage.vehicleId;
        if (!lead) return { outcome: "target_unavailable" };
        if (driving) {
          return {
            step: {
              key: `pursue:${lead}`,
              label: `Chase ${lead.toUpperCase()}`,
              make: () => ({ loco: new Pursue(lead, 20) }),
            },
          };
        }
        const v = world.nearestVisible(b, ["vehicle"], { enterable: true }, this.record);
        return v ? { step: enter(v.id) } : marker ? { step: walk("objective", true, "Head for the marker") } : { step: wait };
      }
      case "shoot": {
        if (driving) return { step: exit };
        const t = world.nearestVisible(b, ["target"], { hostile: true }, this.record);
        if (t) {
          const id = t.id;
          return {
            step: {
              key: `engage:${id}`,
              label: `Take on ${id}`,
              make: () => ({ loco: new Approach(id), aim: new Aim(id), trigger: new AutoFire(id) }),
            },
          };
        }
        return marker ? { step: walk("objective", true, "Head for the targets") } : { step: wait };
      }
      case "collect": {
        if (!marker) return { step: wait };
        if (driving) return { step: driveTo("objective", false, "Drive over the shard") };
        // Shards in view first, nearest first; the marker's own pick if none is seen (or reachable).
        let best: Tracked | null = null;
        for (const t of this.visibleShards(ctx)) {
          if (!this.ok(`collect:${t.id}`, b.time)) continue;
          if (!best || Math.hypot(t.x - b.x, t.z - b.z) < Math.hypot(best.x - b.x, best.z - b.z)) best = t;
        }
        if (best) {
          const id = best.id;
          return {
            step: {
              key: `collect:${id}`,
              label: "Run to a shard",
              make: () => ({ loco: new Collect(id), aim: null, trigger: null }),
            },
          };
        }
        if (this.ok("sprint:objective", b.time)) return { step: walk("objective", true, "Run to the nearest shard") };
        // The marker cannot be reached (behind a fence, say): go and look elsewhere; other shards will come into view.
        return this.memory.foot.plan(ctx);
      }
      default:
        break;
    }

    // reach, stealth_reach, checkpoints, deliver, clean_drive, explore: go to the marker.
    if (!marker && stage.kind !== "clean_drive") return { step: wait };
    if (onFoot) {
      // On foot unless a vehicle is needed, or the marker turned out to be unreachable on foot
      // (behind a fence whose barrier only a vehicle raises).
      const byFoot = !stage.requiresVehicle && this.ok("sprint:objective", b.time) && this.ok("walk:objective", b.time);
      if (byFoot || stage.kind === "clean_drive") {
        if (stage.kind === "clean_drive") return this.needVehicle(ctx, stage.vehicleId);
        // Stealth is walked; everything else is run.
        return { step: walk("objective", stage.kind !== "stealth_reach", "Head for the marker") };
      }
      return this.needVehicle(ctx, stage.vehicleId);
    }
    // A clean drive is distance without a scratch: go from place to place by the roads.
    if (stage.kind === "clean_drive") return this.memory.road.plan(ctx);
    return { step: driveTo("objective", stage.kind === "deliver", "Drive to the marker") };
  }

  private spins = 0;

  /** Get hold of a vehicle: the named one, else the nearest in view, else look around for one. */
  private needVehicle(ctx: Ctx, named: string | null): Plan {
    const b = ctx.body;
    const id = named ?? ctx.world.nearestVisible(b, ["vehicle"], { enterable: true }, this.record)?.id ?? null;
    if (id) {
      this.spins = 0;
      return { step: enter(id) };
    }
    if (this.spins >= 8) return { outcome: "target_unavailable" };
    const n = this.spins;
    return {
      step: {
        key: `look:${n}`,
        label: "Look round for a vehicle",
        make: () => ({ loco: new Turn(1), aim: null, trigger: null }),
      },
    };
  }

  private readonly scratch = createTracked();

  /** Every shard in view, nearest first (the world hands back one at a time). */
  private visibleShards(ctx: Ctx): Tracked[] {
    const out: Tracked[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const t = ctx.world.nearestVisible(ctx.body, ["collectible"], {}, this.scratch, seen);
      if (!t) break;
      seen.add(t.id);
      out.push({ ...t });
    }
    return out;
  }
}

/** Lose whatever is hunting the player: drive away, or get to a vehicle, or run and hide. */
export class EvadeSupervisor implements Supervisor {
  readonly name = "evade";
  private calmS = 0;
  private lastT = NaN;
  private readonly threat: ThreatSense = { x: 0, z: 0, active: false, level: 0, pursued: false, lastSeenAgoS: null };
  private readonly record = createTracked();

  plan(ctx: Ctx): Plan {
    const b = ctx.body;
    const dt = Number.isNaN(this.lastT) ? 0 : Math.max(0, b.time - this.lastT);
    this.lastT = b.time;
    const threat = ctx.world.threat(b, this.threat);
    this.calmS = threat.active ? 0 : this.calmS + dt;
    if (b.locomotion === "driving") {
      if (this.calmS > 5) return { outcome: "escaped" };
      return {
        step: {
          key: "escape",
          label: "Drive away",
          make: () => ({ loco: new Escape() }),
        },
      };
    }
    if (b.locomotion !== "on_foot") return { step: wait };
    if (this.calmS > 5) return { outcome: "escaped" };
    if (!threat.active) return { step: wait };
    const v = ctx.world.nearestVisible(b, ["vehicle"], { enterable: true }, this.record);
    if (v && Math.hypot(v.x - b.x, v.z - b.z) < 40) return { step: enter(v.id) };
    if (threat.level >= 3) {
      return {
        step: {
          key: "cover",
          label: "Take cover",
          make: () => ({ loco: new TakeCover(), aim: null, trigger: null }),
        },
      };
    }
    return {
      step: {
        key: "flee",
        label: "Run for it",
        make: () => ({ loco: new Flee(), aim: null, trigger: null }),
      },
    };
  }
}

/** Wander the map's named places, on foot or by road. */
export class ExploreSupervisor implements Supervisor {
  readonly name = "explore";
  private readonly visited = new Set<string>();
  private readonly banned = new Map<string, number>();
  private current: string | null = null;
  private startedAt = NaN;
  /** The point being struck out for, and how many have been tried (they fan out round the compass). */
  private striking: { x: number; z: number; n: number } | null = null;
  private strikes = 0;
  private readonly far: boolean;
  private readonly max: number;
  private readonly budgetS: number;
  private readonly tours: boolean;

  constructor(options: { far?: boolean; max?: number; budgetS?: number; tours?: boolean } = {}) {
    this.far = options.far ?? false;
    this.max = options.max ?? 4;
    this.budgetS = options.budgetS ?? 180;
    this.tours = options.tours ?? false;
  }

  /** Forget where it has been and what did not work. */
  reset(): void {
    this.visited.clear();
    this.banned.clear();
    this.current = null;
    this.striking = null;
    this.strikes = 0;
    this.startedAt = NaN;
  }

  stepEnded(key: string, outcome: DecisionOutcome, now: number): void {
    if (!FAILED.has(outcome)) return;
    const id = key.split(":")[1];
    if (id) this.banned.set(id, now + 120);
  }

  plan(ctx: Ctx): Plan {
    const b = ctx.body;
    if (Number.isNaN(this.startedAt)) this.startedAt = b.time;
    if (b.time - this.startedAt > this.budgetS || this.visited.size >= this.max) return { outcome: "done" };
    if (b.locomotion !== "on_foot" && b.locomotion !== "driving") return { step: wait };
    const places = ctx.world.places(b);
    if (this.current) {
      const p = places.find((x) => x.id === this.current);
      if (!p || Math.hypot(p.x - b.x, p.z - b.z) < 14 || (this.banned.get(this.current) ?? 0) > b.time) {
        if (p && Math.hypot(p.x - b.x, p.z - b.z) < 14) this.visited.add(this.current);
        this.current = null;
      }
    }
    if (!this.current) {
      let best: string | null = null;
      // With tours, having been everywhere is the end of one tour, not of the search: begin another.
      for (let pass = 0; pass < (this.tours ? 2 : 1) && !best; pass++) {
        if (pass === 1) this.visited.clear();
        let bestScore = -Infinity;
        for (const p of places) {
          if ((this.banned.get(p.id) ?? 0) > b.time) continue;
          const d = Math.hypot(p.x - b.x, p.z - b.z);
          if (!this.far && this.visited.has(p.id)) continue;
          if (d < 25) {
            this.visited.add(p.id);
            continue;
          }
          // Exploring goes to the nearest; a long drive goes to a place a good way off, not the farthest.
          const score = this.far ? -Math.abs(d - 350) : -d;
          if (score > bestScore) {
            bestScore = score;
            best = p.id;
          }
        }
      }
      if (!best) {
        // No place on the map can be reached from here (they are inside the compound, and the way in is
        // shut): on foot, strike out across open ground instead, and see what comes into view.
        const step = this.tours && b.locomotion === "on_foot" ? this.wander(ctx) : null;
        return step ? { step } : { outcome: "done" };
      }
      this.current = best;
      this.striking = null;
    }
    const id = this.current;
    return b.locomotion === "driving"
      ? { step: driveTo(id, false, `Drive to ${id}`) }
      : { step: walk(id, true, `Head for ${id}`) };
  }

  private wander(ctx: Ctx): Step | null {
    const b = ctx.body;
    const here = this.striking;
    if (here && Math.hypot(here.x - b.x, here.z - b.z) > 7) return this.strike(here);
    // Fan out: each strike heads a golden angle round from the last, a good way off, over ground a walker can cross.
    for (let tries = 0; tries < 10; tries++) {
      this.strikes++;
      const a = this.strikes * 2.399963;
      const r = 70 + ((this.strikes * 37) % 60);
      const x = b.x + Math.sin(a) * r;
      const z = b.z + Math.cos(a) * r;
      if (ctx.world.route("foot", { x: b.x, z: b.z }, { x, z }, ctx.prefer, 6).length === 0) continue;
      this.striking = { x, z, n: this.strikes };
      return this.strike(this.striking);
    }
    return null;
  }

  private strike(s: { x: number; z: number; n: number }): Step {
    return {
      key: `strike:${s.n}`,
      label: "Strike out across open ground",
      make: () => ({ loco: new WalkToPoint(s.x, s.z, 6, true, 60), aim: null, trigger: null }),
    };
  }
}
