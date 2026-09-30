import type { FreeRoamDecision } from "./decisions";
import { decisionKey } from "./decisions";
import type { FreeRoamObservation, ObservedEntity } from "./observation";

/**
 * Which decisions are on offer.
 *
 * The legal set is a pure function of the observation — of what a player
 * could see and do — so it can be derived again anywhere: by the runtime when
 * a late answer arrives (is it still legal in the world as it is now?), by the
 * server before it asks a model (is the client offering only what the
 * situation allows?), and by a test. Nothing in it needs the game.
 *
 * The tiers, as a player thinks about them:
 *
 *   on foot   walk, turn, jump, get in, line up, fire, run, hide
 *   driving   pedals, wheel, the road, a chase, a getaway, getting out
 *   strategy  what to do next, in a phrase: carry on, get a vehicle, lose the pursuit
 */

export type Situation = Omit<FreeRoamObservation, "legal">;

export const LEGAL_LIMITS = {
  vehicles: 3,
  places: 4,
  people: 4,
  shards: 3,
  engage: 3,
  total: 64,
} as const;

const PEOPLE = new Set(["pedestrian", "security", "target"]);

function standing(e: ObservedEntity): boolean {
  return e.healthPct === null || e.healthPct > 0;
}

const byDistance = (a: ObservedEntity, b: ObservedEntity) => a.distanceM - b.distanceM;

export function deriveLegal(o: Situation): FreeRoamDecision[] {
  const out: FreeRoamDecision[] = [];
  const seen = new Set<string>();
  const add = (d: FreeRoamDecision) => {
    const key = decisionKey(d);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };
  const p = o.player;
  // Dead, or held in a transition: there is nothing to choose but to wait.
  const held = !p.alive || p.busy || p.locomotion === "entering_vehicle" || p.locomotion === "exiting_vehicle";
  if (held) {
    add({ type: "WAIT" });
    return out;
  }

  const visible = o.nearbyEntities.filter((e) => e.visibility === "visible");
  const people = visible.filter((e) => PEOPLE.has(e.type) && standing(e)).sort(byDistance);
  const hostile = people.filter((e) => e.hostile);
  const vehicles = visible.filter((e) => e.type === "vehicle").sort(byDistance);
  const shards = visible.filter((e) => e.type === "collectible").sort(byDistance);
  const att = o.attention;
  const threatened = att.level >= 1 || att.pursued || hostile.some((e) => e.type === "security");
  const objective = o.objective !== null && o.objective.status === "active" && o.objective.stage.count > 0;
  const onFoot = p.locomotion === "on_foot";

  // Strategy first: the phrase-sized choices.
  if (objective) add({ type: "CONTINUE_OBJECTIVE" });
  if (objective && o.objective && (o.objective.requiresVehicle || (o.objective.target?.distanceM ?? 0) > 150)) {
    add({ type: "CHANGE_ROUTE", route: "roads" });
    add({ type: "CHANGE_ROUTE", route: "direct" });
  }
  if (threatened) add({ type: "EVADE_PURSUIT" });
  if (!objective || o.objective?.kind === "explore") add({ type: "EXPLORE" });
  if (onFoot) {
    for (const v of vehicles.filter((e) => e.enterable).slice(0, LEGAL_LIMITS.vehicles))
      add({ type: "ENTER_VEHICLE", target: v.id });
    for (const s of shards.slice(0, LEGAL_LIMITS.shards)) add({ type: "COLLECT_ITEM", target: s.id });
    for (const e of hostile.slice(0, LEGAL_LIMITS.engage)) add({ type: "ENGAGE_TARGET", target: e.id });
    if (p.aiming || o.aiming.target) add({ type: "DISENGAGE" });
  } else {
    add({ type: "LEAVE_VEHICLE" });
  }

  if (onFoot) {
    if (objective && o.objective?.target) {
      add({ type: "MOVE_TO_TARGET", target: "objective" });
      add({ type: "SPRINT_TO_TARGET", target: "objective" });
    }
    for (const v of vehicles.slice(0, LEGAL_LIMITS.vehicles)) add({ type: "MOVE_TO_TARGET", target: v.id });
    for (const place of o.places.slice(0, LEGAL_LIMITS.places)) add({ type: "MOVE_TO_TARGET", target: place.id });
    add({ type: "TURN_LEFT" });
    add({ type: "TURN_RIGHT" });
    if (p.grounded) add({ type: "JUMP" });
    // Aim at people, the ones that are a threat first.
    const aimable = [...hostile, ...people.filter((e) => !e.hostile)].slice(0, LEGAL_LIMITS.people);
    for (const e of aimable) add({ type: "AIM_TARGET", target: e.id });
    if (p.weapon.ammo + p.weapon.reserve > 0) add({ type: "FIRE" });
    if (p.prompt.vehicleId) add({ type: "ENTER_NEARBY_VEHICLE", target: p.prompt.vehicleId });
    if (threatened) {
      add({ type: "FLEE" });
      add({ type: "TAKE_COVER" });
    }
  } else {
    // The pedals and the wheel are offered when they would do something: no braking at a standstill,
    // no steering a car that is not moving, no straightening a car that is already straight.
    const speed = Math.abs(p.speedMps);
    const straight = o.driving !== null && o.driving.onRoad && Math.abs(o.driving.headingErrorDeg ?? 0) < 4;
    if (speed < 22) add({ type: "ACCELERATE" });
    if (speed > 0.5) add({ type: "BRAKE" });
    if (speed < 5) add({ type: "REVERSE" });
    if (speed > 1) {
      add({ type: "STEER_LEFT" });
      add({ type: "STEER_RIGHT" });
      if (!straight) add({ type: "STRAIGHTEN" });
    }
    if (o.driving?.obstacle) add({ type: "AVOID_OBSTACLE" });
    if (o.driving && o.driving.roadHeadingDeg !== null) add({ type: "FOLLOW_ROAD" });
    for (const v of vehicles.slice(0, LEGAL_LIMITS.vehicles)) add({ type: "PURSUE_TARGET", target: v.id });
    if (threatened) add({ type: "ESCAPE" });
    add({ type: "EXIT_VEHICLE" });
  }
  add({ type: "WAIT" });
  return out.slice(0, LEGAL_LIMITS.total);
}
