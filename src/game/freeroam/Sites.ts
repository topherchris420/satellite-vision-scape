import type { GroundQuery } from "../world/GroundQuery";

/**
 * Things to find and places to use in the Free Roam world: collectible
 * signal shards, three kinds of interactive location, and the scheduled
 * environmental events. All of them are described by the scenario's seed.
 */

// --- Collectibles ---------------------------------------------------------------

export interface CollectibleSpec {
  id: string;
  x: number;
  z: number;
  value: number;
}

export interface Collectible extends CollectibleSpec {
  y: number;
  collected: boolean;
  collectedAt: number;
}

/** Pick-up radius on foot and in a vehicle, metres. */
export const PICKUP_RADIUS = { foot: 2.2, vehicle: 3.4 } as const;

export class Collectibles {
  readonly items: Collectible[] = [];
  collectedCount = 0;
  collectedValue = 0;

  constructor(private readonly ground: GroundQuery) {}

  build(specs: readonly CollectibleSpec[]): void {
    this.items.length = 0;
    for (const s of specs) {
      this.items.push({
        ...s,
        y: this.ground.heightAt(s.x, s.z),
        collected: false,
        collectedAt: 0,
      });
    }
    this.collectedCount = 0;
    this.collectedValue = 0;
  }

  reset(): void {
    for (const c of this.items) {
      c.collected = false;
      c.collectedAt = 0;
    }
    this.collectedCount = 0;
    this.collectedValue = 0;
  }

  get remaining(): number {
    return this.items.length - this.collectedCount;
  }

  /** Collect anything within reach of (x, z). Calls `onCollect` for each. */
  step(x: number, z: number, inVehicle: boolean, now: number, onCollect: (c: Collectible) => void): void {
    const r = inVehicle ? PICKUP_RADIUS.vehicle : PICKUP_RADIUS.foot;
    for (const c of this.items) {
      if (c.collected) continue;
      const dx = c.x - x;
      const dz = c.z - z;
      if (dx * dx + dz * dz > r * r) continue;
      c.collected = true;
      c.collectedAt = now;
      this.collectedCount++;
      this.collectedValue += c.value;
      onCollect(c);
    }
  }
}

// --- Interactive locations --------------------------------------------------------

export type LocationKind = "clinic" | "ammo" | "motorpool";

export interface LocationSpec {
  id: string;
  kind: LocationKind;
  x: number;
  z: number;
}

export const LOCATION_INFO: Record<LocationKind, { label: string; prompt: string; cooldownS: number }> = {
  clinic: { label: "Field clinic", prompt: "Field clinic · restore health", cooldownS: 20 },
  ammo: { label: "Ammo locker", prompt: "Ammo locker · resupply", cooldownS: 10 },
  motorpool: { label: "Motor pool", prompt: "Motor pool · repair vehicle", cooldownS: 15 },
};

export const LOCATION_RANGE = 3.2;

export interface LocationState extends LocationSpec {
  /** Simulated seconds before it can be used again. */
  readyAt: number;
}

export class Locations {
  readonly items: LocationState[] = [];

  build(specs: readonly LocationSpec[]): void {
    this.items.length = 0;
    for (const s of specs) this.items.push({ ...s, readyAt: 0 });
  }

  reset(): void {
    for (const l of this.items) l.readyAt = 0;
  }

  nearest(x: number, z: number, range = LOCATION_RANGE): LocationState | null {
    let best: LocationState | null = null;
    let bestD = range;
    for (const l of this.items) {
      const d = Math.hypot(l.x - x, l.z - z);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return best;
  }
}

// --- Environmental events -----------------------------------------------------------

export type EnvironmentEventId = "dust_front" | "siren_test" | "convoy";

export interface EnvironmentEventSpec {
  id: EnvironmentEventId;
  /** Simulated seconds after the start. */
  startsAt: number;
  duration: number;
}

export const ENVIRONMENT_INFO: Record<EnvironmentEventId, string> = {
  dust_front: "A dust front rolls across the site: visibility drops",
  siren_test: "Scheduled siren test: everyone on site stops to listen",
  convoy: "A supply convoy is on the roads: traffic runs faster",
};

/** Air clarity while a dust front passes. */
export const DUST_CLARITY = 0.55;

export class Environment {
  readonly specs: EnvironmentEventSpec[] = [];
  private readonly on = new Set<EnvironmentEventId>();

  build(specs: readonly EnvironmentEventSpec[]): void {
    this.specs.length = 0;
    this.specs.push(...specs);
    this.on.clear();
  }

  reset(): void {
    this.on.clear();
  }

  isActive(id: EnvironmentEventId): boolean {
    return this.on.has(id);
  }

  get activeIds(): EnvironmentEventId[] {
    return [...this.on];
  }

  /** Start and end events as simulated time passes. Calls back on each change. */
  step(now: number, changed: (id: EnvironmentEventId, active: boolean) => void): void {
    for (const e of this.specs) {
      const active = now >= e.startsAt && now < e.startsAt + e.duration;
      if (active && !this.on.has(e.id)) {
        this.on.add(e.id);
        changed(e.id, true);
      } else if (!active && this.on.has(e.id)) {
        this.on.delete(e.id);
        changed(e.id, false);
      }
    }
  }
}
