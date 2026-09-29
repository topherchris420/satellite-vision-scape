import { compassOf, wrapPi } from "@/lib/freeroam/contracts";
import type { EntityView, PlaceView, SelfView } from "@/game/freeroam/View";
import { round } from "../observation";
import type { AimState } from "./behaviour";
import type { FreeRoamBridge } from "./bridge";
import { deriveLegal, type Situation } from "./legal";
import {
  FR_OBSERVATION_SCHEMA,
  type CollisionRisk,
  type FreeRoamObservation,
  type ObservedEntity,
} from "./observation";

/**
 * Turns the game, as a player perceives it, into a `FreeRoamObservation`.
 *
 * Everything here comes through the bridge's read-only view: the HUD's own
 * numbers, the prompt on screen, the crosshair, the people and vehicles the
 * player can see, a coarse impression of what is only heard, and a fading
 * memory of what was seen a moment ago. Nothing that is out of sight and out
 * of earshot is reported: absence in the observation is ignorance, not
 * emptiness.
 */

const RECENT_S = 20;
const MAX_EVENTS = 8;
const MAX_VISIBLE = 10;
const MAX_MEMORY = 3;
const MAX_HEARD = 3;
const MAX_PLACES = 8;
const HUD_ENTITY_RANGE = 250;
const PERSON_HEIGHT = 1.78;

const memoryScratch: EntityView[] = [];
const placeScratch: PlaceView[] = [];

/** A short lower-case word from any state string. */
function word(text: string, fallback = "unknown"): string {
  const w = text.toLowerCase().replace(/[^a-z_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
  return /^[a-z]/.test(w) ? w : fallback;
}

const label = (text: string, max = 40) => text.replace(/\p{Cc}/gu, " ").slice(0, max);

/** [right, up, ahead] of (x, y, z) from the viewer facing `yaw`. */
function relative(s: SelfView, x: number, y: number, z: number): [number, number, number] {
  const dx = x - s.x;
  const dz = z - s.z;
  const f = s.facingYaw;
  const ahead = dx * Math.sin(f) + dz * Math.cos(f);
  const right = -dx * Math.cos(f) + dz * Math.sin(f);
  return [round(right), round(y - s.y), round(ahead)];
}

function relativeVelocity(s: SelfView, vx: number, vz: number): [number, number] {
  const dx = vx - s.vx;
  const dz = vz - s.vz;
  const f = s.facingYaw;
  return [round(-dx * Math.cos(f) + dz * Math.sin(f)), round(dx * Math.sin(f) + dz * Math.cos(f))];
}

function entity(s: SelfView, e: EntityView, basis: "sight" | "sound" | "memory"): ObservedEntity {
  const seen = basis === "sight";
  return {
    id: e.id,
    type: e.type,
    visibility: seen ? "visible" : "occluded",
    basis,
    label: label(e.label),
    distanceM: round(e.distance, seen ? 1 : 0),
    bearingDeg: Math.max(-180, Math.min(180, e.bearingDeg)),
    relative: relative(s, e.x, e.y, e.z),
    velocity: seen ? relativeVelocity(s, e.vx, e.vz) : null,
    state: word(e.state),
    healthPct: seen ? e.healthPct : null,
    hostile: seen ? e.hostile : false,
    occupied: seen ? e.occupied : false,
    enterable: seen ? e.enterable : false,
    lastSeenAgoS: basis === "memory" ? (e.ageS ?? 0) : null,
  };
}

function riskOf(gap: number, closing: number): { risk: CollisionRisk; ttc: number | null } {
  if (closing <= 0.3) return { risk: gap < 2 ? "high" : "none", ttc: null };
  const ttc = gap / closing;
  const risk: CollisionRisk = ttc < 1.2 || gap < 3 ? "imminent" : ttc < 2.5 ? "high" : ttc < 5 ? "low" : "none";
  return { risk, ttc: round(ttc, 1) };
}

/** Everything about the situation except the run's own bookkeeping and the legal set. */
export function buildSituation(bridge: FreeRoamBridge, aim: AimState): Situation {
  const fr = bridge.fr;
  const view = fr.view;
  const s = bridge.refreshSelf();
  bridge.perceive();
  const spec = fr.scenario;
  const hud = fr.hud.getSnapshot();
  const driven = fr.driven;
  const driving = s.locomotion === "driving";

  // --- Who and what is around ---------------------------------------------------------------
  const listed: ObservedEntity[] = [];
  const inView = new Set<string>();
  for (const e of bridge.visible.slice(0, MAX_VISIBLE)) {
    listed.push(entity(s, e, "sight"));
    inView.add(e.id);
  }
  for (const e of bridge.visible) inView.add(e.id);
  view.memories(s, inView, memoryScratch, 25, MAX_MEMORY);
  for (const e of memoryScratch) listed.push(entity(s, e, "memory"));
  for (const e of bridge.heard.slice(0, MAX_HEARD)) listed.push(entity(s, e, "sound"));
  const nearbyEntities = listed.slice(0, 16);

  // --- Places -------------------------------------------------------------------------------------
  view.places(s, placeScratch);
  const places = placeScratch
    .filter((p) => p.distance <= HUD_ENTITY_RANGE * 3)
    .slice(0, MAX_PLACES)
    .map((p) => ({
      id: p.id,
      label: label(p.label),
      kind: p.kind,
      distanceM: p.distance,
      bearingDeg: Math.max(-180, Math.min(180, p.bearingDeg)),
    }));

  // --- Objective ----------------------------------------------------------------------------------
  const o = view.objective(s);
  const objective: Situation["objective"] = o
    ? {
        id: word(o.id, "challenge").replace(/_/g, "-"),
        kind: word(o.kind),
        title: label(o.title, 80),
        hint: label(o.hint, 200),
        stage: { index: o.stageIndex, count: o.stageCount },
        progress: Math.max(0, Math.min(1, o.progress)),
        status: o.status as "idle" | "active" | "success" | "failed",
        target: o.target
          ? {
              distanceM: o.target.distance,
              bearingDeg: Math.max(-180, Math.min(180, o.target.bearingDeg)),
              radiusM: round(o.target.radius, 0),
            }
          : null,
        requiresVehicle: o.requiresVehicle,
        vehicleId: o.vehicleId,
        timeRemainingS: o.timeRemainingS,
        success: (hud.criteria?.success ?? []).slice(0, 8).map((c) => ({ label: label(c.label, 60), met: c.met })),
        failure: (hud.criteria?.failure ?? []).slice(0, 8).map((c) => ({ label: label(c.label, 60), met: c.met })),
      }
    : null;

  // --- Driving ------------------------------------------------------------------------------------
  let drivingInfo: Situation["driving"] = null;
  if (driving && driven) {
    const d = view.driving(s);
    if (d) {
      const ob = d.obstacle;
      const { risk, ttc } = ob ? riskOf(ob.gap, ob.closingSpeed) : { risk: "none" as CollisionRisk, ttc: null };
      drivingInfo = {
        vehicleId: d.vehicleId,
        onRoad: d.onRoad,
        laneOffsetM: d.laneOffset,
        roadHeadingDeg: d.roadHeadingDeg,
        headingErrorDeg: d.headingErrorDeg,
        upcomingTurnDeg: d.upcomingTurnDeg,
        collisionRisk: risk,
        timeToCollisionS: ttc,
        obstacle: ob
          ? {
              kind: ob.kind,
              id: ob.id,
              gapM: round(ob.gap, 1),
              closingSpeedMps: round(ob.closingSpeed, 1),
              bearingDeg: Math.max(-180, Math.min(180, ob.bearingDeg)),
            }
          : null,
      };
    }
  }

  // --- Aiming -------------------------------------------------------------------------------------
  const sense = view.sampleAim(s.aiming, bridge.observeAim);
  const focus = pickFocus(bridge, s, aim);
  let target: Situation["aiming"]["target"] = null;
  if (focus && !driving) {
    const py = focus.y + PERSON_HEIGHT * 0.6;
    const dx = focus.x - sense.cx;
    const dy = py - sense.cy;
    const dz = focus.z - sense.cz;
    const len = Math.hypot(dx, dy, dz) || 1;
    const desiredYaw = Math.atan2(dx, dz);
    const desiredPitch = -Math.asin(Math.max(-1, Math.min(1, dy / len)));
    const eYaw = wrapPi(desiredYaw - s.cameraYaw);
    const ePitch = desiredPitch - s.cameraPitch;
    const dot = (sense.ax * dx + sense.ay * dy + sense.az * dz) / len;
    target = {
      id: focus.id,
      // Positive: the target is to the right of / above the crosshair.
      yawErrorDeg: round((-eYaw * 180) / Math.PI, 1),
      pitchErrorDeg: round((-ePitch * 180) / Math.PI, 1),
      totalErrorDeg: round((Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI, 1),
      distanceM: round(Math.hypot(dx, dz), 0),
      onTarget: sense.personId === focus.id,
    };
  }
  const attention = view.attention();

  // --- Recent events -----------------------------------------------------------------------------
  const now = fr.simTime;
  const recentEvents = bridge.notes
    .filter((n) => now - n.t <= RECENT_S)
    .slice(-MAX_EVENTS)
    .map((n) => ({ ageS: round(now - n.t, 1), type: n.type, detail: n.detail ? label(n.detail, 48) : null }));

  const w = s.weapon;
  return {
    schema: FR_OBSERVATION_SCHEMA,
    sequence: 0,
    timestampMs: 0,
    scenario: {
      seed: spec?.seed ?? 0,
      challenge: word(spec?.challenge.id ?? "free-play", "free-play").replace(/_/g, "-"),
      title: label(spec?.challenge.title ?? "Free play", 60),
      timeOfDay: s.timeOfDay,
      elapsedS: round(now, 1),
      environment: hud.environment.slice(0, 3).map((t) => label(t, 60)),
    },
    controller: { mode: "JEV", provider: "none", latencyMs: null },
    player: {
      locomotion: s.locomotion,
      position: [round(s.x), round(s.y), round(s.z)],
      headingDeg: compassOf(s.facingYaw),
      speedMps: round(driving ? s.forwardSpeed : s.speed),
      grounded: s.grounded,
      health: Math.max(0, Math.min(100, Math.round(s.health))),
      alive: s.alive,
      busy: s.busy,
      aiming: s.aiming,
      weapon: { ammo: w.ammo, reserve: w.reserve, reloading: w.reloading, ready: w.ready },
      vehicle:
        driving && driven
          ? {
              id: driven.id.toLowerCase(),
              label: label(driven.label),
              healthPct: Math.max(0, Math.min(100, Math.round(driven.health))),
              headlights: driven.headlights,
            }
          : null,
      prompt: { text: hud.prompt ? label(hud.prompt, 60) : null, vehicleId: view.promptVehicle() },
      sightRangeM: round(fr.perception.visionRange(s.timeOfDay), 0),
    },
    objective,
    places,
    nearbyEntities,
    driving: drivingInfo,
    aiming: {
      active: s.aiming,
      spreadDeg: round(sense.spreadDeg, 1),
      crosshair: {
        on: sense.personId ?? (sense.vehicleId ? sense.vehicleId.toLowerCase() : null),
        kind: sense.kind === "none" ? "none" : sense.kind,
        hostile: sense.hostile,
        distanceM: sense.kind === "none" ? null : round(sense.distance, 0),
      },
      target,
    },
    attention: {
      level: attention.level,
      name: label(attention.name, 24),
      meter: Math.max(0, Math.min(5, attention.meter)),
      pursued: attention.pursued,
      guardsInView: attention.guardsInView,
      lastSeenAgoS: attention.lastSeenAgoS,
      unseenForS: attention.unseenForS,
      responseUnits: attention.responseUnits,
    },
    recentEvents,
    execution: null,
    previousOutcome: null,
  };
}

/** The person the sights should be judged against: the engaged target, else the nearest visible threat ahead. */
function pickFocus(bridge: FreeRoamBridge, s: SelfView, aim: AimState): EntityView | null {
  if (aim.targetId) {
    const engaged = bridge.visible.find((e) => e.id === aim.targetId);
    if (engaged) return engaged;
  }
  let best: EntityView | null = null;
  for (const e of bridge.visible) {
    if (!e.hostile || (e.type !== "security" && e.type !== "target")) continue;
    if (e.healthPct !== null && e.healthPct <= 0) continue;
    if (Math.abs(e.bearingDeg) > 70) continue;
    if (!best || e.distance < best.distance) best = e;
  }
  void s;
  return best;
}

/** The full observation for `sequence`: the situation plus the run's own bookkeeping and the legal set. */
export function completeObservation(
  situation: Situation,
  extras: {
    sequence: number;
    timestampMs: number;
    mode: "JEV" | "ASSIST";
    provider: string;
    latencyMs: number | null;
    execution: FreeRoamObservation["execution"];
    previousOutcome: FreeRoamObservation["previousOutcome"];
  },
): FreeRoamObservation {
  const legal = deriveLegal(situation);
  return {
    ...situation,
    sequence: extras.sequence,
    timestampMs: extras.timestampMs,
    controller: { mode: extras.mode, provider: extras.provider, latencyMs: extras.latencyMs },
    execution: extras.execution,
    previousOutcome: extras.previousOutcome,
    legal,
  };
}
