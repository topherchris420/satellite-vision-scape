import type { ActionSource } from "@/lib/freeroam/contracts";

/**
 * Types shared by the Free Roam simulation: people on foot, damage, and the
 * events every other system (attention, challenges, metrics, traces, audio,
 * effects) listens to. Events say what happened in the world; nothing that
 * listens to them can change what happened.
 */

export type PersonKind = "pedestrian" | "security" | "target";

/** Where damage came from, and from where in the world (people react to the direction). */
export type DamageSource =
  | { kind: "player"; source: ActionSource; x: number; z: number }
  | { kind: "security"; id: string; x: number; z: number }
  | { kind: "vehicle"; id: string; driver: "player" | "ai"; source: ActionSource; x: number; z: number }
  | { kind: "world" };

export type HitZone = "head" | "body";

/** A body on foot that can be seen, shot, bumped and knocked down. */
export interface Person {
  readonly id: string;
  readonly kind: PersonKind;
  readonly label: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  health: number;
  readonly maxHealth: number;
  /** Inside the active radius, and simulated. Dormant people are frozen and unseen. */
  active: boolean;
  /** Not incapacitated. */
  alive: boolean;
  /** On the ground for a moment (knocked down): not a valid target, not a threat. */
  down: boolean;
  /** Regards the player as an enemy right now. */
  hostile: boolean;
  readonly radius: number;
  readonly height: number;
  /** Short state word for observations and traces ("walking", "fleeing"…). */
  readonly state: string;
  damage(amount: number, source: DamageSource, zone: HitZone): void;
}

export const PERSON = { radius: 0.33, height: 1.78, headFraction: 0.82 } as const;

export type HitKind = "none" | "world" | "ground" | "vehicle" | "person";

export interface ShotRecord {
  t: number;
  shooter: string;
  source: ActionSource | "security";
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  hit: HitKind;
  distance: number;
  targetId: string | null;
  zone: HitZone | null;
  /** Degrees between the bullet and the direction to the nearest valid target, if any. */
  aimErrorDeg: number | null;
  /** A hostile target was in the cone ahead when the trigger was pulled. */
  hadTarget: boolean;
  hitCivilian: boolean;
}

export type CollisionOther = "vehicle" | "world" | "person";

/** Everything the simulation announces. */
export type FreeRoamEvents = {
  started: { seed: number; challenge: string };
  reset: { seed: number; challenge: string };
  stopped: { t: number };
  shot: ShotRecord;
  dryFire: { t: number };
  reloaded: { t: number };
  personHit: {
    t: number;
    id: string;
    kind: PersonKind;
    damage: number;
    zone: HitZone;
    by: DamageSource;
    killed: boolean;
  };
  playerDamaged: { t: number; amount: number; by: string; health: number };
  playerDown: { t: number; by: string };
  playerRespawned: { t: number };
  vehicleCollision: {
    t: number;
    vehicleId: string;
    speed: number;
    other: CollisionOther;
    playerDriven: boolean;
    detail?: string;
  };
  attention: { t: number; level: number; previous: number; meter: number; cause: string };
  pursuit: { t: number; phase: "started" | "escaped" };
  collected: { t: number; id: string; total: number };
  vehicleStolen: { t: number; vehicleId: string; witnessed: boolean };
  locationUsed: { t: number; id: string; kind: string };
  stage: { t: number; challenge: string; index: number; id: string; total: number };
  challenge: { t: number; status: "success" | "failed"; reason: string };
  environment: { t: number; event: string; active: boolean };
  unnecessary: { t: number; reason: string };
};
