import { AutoFire, Approach, Aim } from "./aim";
import type { Behaviour, Ctx } from "./behaviour";
import type { DecisionOutcome } from "./decisions";
import { Cruise, DriveTo, Escape, ExitVehicle, FR_PROFILES, Pursue } from "./drive";
import { Enter, Flee, Hold, TakeCover, WalkTo } from "./foot";
import { createTracked, type ThreatSense } from "./world";

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
}

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

/** Carry on with whatever the current stage asks. */
export class ObjectiveSupervisor implements Supervisor {
  readonly name = "objective";
  private readonly evade = new EvadeSupervisor();
  private readonly record = createTracked();

  plan(ctx: Ctx): Plan {
    const world = ctx.world;
    const stage = world.stage();
    if (!stage || !stage.active) return { outcome: "done" };
    const b = ctx.body;
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
      case "collect":
        if (!marker) return { step: wait };
        return driving
          ? { step: driveTo("objective", false, "Drive over the shard") }
          : { step: walk("objective", true, "Run to the nearest shard") };
      default:
        break;
    }

    // reach, stealth_reach, checkpoints, deliver, clean_drive, explore: go to the marker.
    if (!marker && stage.kind !== "clean_drive") return { step: wait };
    if (onFoot) {
      if (stage.requiresVehicle) {
        const id =
          stage.vehicleId ?? world.nearestVisible(b, ["vehicle"], { enterable: true }, this.record)?.id ?? null;
        if (id) return { step: enter(id) };
        return marker ? { step: walk("objective", true, "Look for a vehicle") } : { step: wait };
      }
      // Stealth is walked; everything else is run.
      return { step: walk("objective", stage.kind !== "stealth_reach", "Head for the marker") };
    }
    if (stage.kind === "clean_drive")
      return {
        step: {
          key: "cruise",
          label: "Drive carefully along the road",
          make: () => ({ loco: new Cruise(false) }),
        },
      };
    return { step: driveTo("objective", stage.kind === "deliver", "Drive to the marker") };
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

/** Wander the map's named places, nearest first, on foot or by road. */
export class ExploreSupervisor implements Supervisor {
  readonly name = "explore";
  private readonly visited = new Set<string>();
  private current: string | null = null;
  private startedAt = NaN;

  plan(ctx: Ctx): Plan {
    const b = ctx.body;
    if (Number.isNaN(this.startedAt)) this.startedAt = b.time;
    if (b.time - this.startedAt > 180 || this.visited.size >= 4) return { outcome: "done" };
    if (b.locomotion !== "on_foot" && b.locomotion !== "driving") return { step: wait };
    const places = ctx.world.places(b);
    if (this.current) {
      const p = places.find((x) => x.id === this.current);
      if (!p || Math.hypot(p.x - b.x, p.z - b.z) < 14) {
        this.visited.add(this.current);
        this.current = null;
      }
    }
    if (!this.current) {
      let best: string | null = null;
      let bestD = Infinity;
      for (const p of places) {
        if (this.visited.has(p.id)) continue;
        const d = Math.hypot(p.x - b.x, p.z - b.z);
        if (d < 25) {
          this.visited.add(p.id);
          continue;
        }
        if (d < bestD) {
          bestD = d;
          best = p.id;
        }
      }
      if (!best) return { outcome: "done" };
      this.current = best;
    }
    const id = this.current;
    return b.locomotion === "driving"
      ? { step: driveTo(id, false, `Drive to ${id}`) }
      : { step: walk(id, true, `Head for ${id}`) };
  }
}

