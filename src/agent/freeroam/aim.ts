import { wrapPi } from "@/lib/freeroam/contracts";
import { clamp, dist2d, type Behaviour, type Ctx } from "./behaviour";
import type { DecisionOutcome } from "./decisions";
import { PathWalker } from "./foot";
import { createAimSense, createTracked, type AimSense } from "./world";

/**
 * Aiming and shooting, as a person does them.
 *
 * Aiming is physical: the behaviour turns the camera (LOOK) until the
 * crosshair ray from the shoulder rests on the target, exactly as a hand on a
 * mouse would. It reads where the ray is *now* and how far that is from the
 * target, and closes the gap at a bounded turn rate. Firing is a separate
 * layer with its own discipline: it pulls the trigger only when the weapon is
 * ready and the sights are steady on what was meant, and then the raycast
 * decides what happens. Neither layer can ask for a hit.
 */

export const AIM = {
  /** Fastest the sights swing, radians per second (a firm wrist flick). */
  turnRate: 6,
  /** Proportional gain of the swing (per second). */
  gain: 14,
  /** Height of the aim point on a person, as a fraction of their height. */
  torso: 0.6,
  /** Look-ahead on a moving target, seconds. */
  lead: 0.06,
  /** Steady on target this long before the first shot, seconds. */
  settleS: 0.12,
  /** Give up on an occluded target after this long. */
  lostS: 1.5,
  /** Shots that count as one FIRE burst. */
  burst: 3,
  /** Beyond this range the sidearm is not worth firing. */
  effectiveRange: 30,
  /** Where an approaching shooter stops. */
  standoff: 20,
} as const;

const RAD = 180 / Math.PI;

/** Bring the sights onto a target. Sustained: it tracks until replaced. */
export class Aim implements Behaviour {
  readonly name = "aim";
  private lostS = 0;
  private alignedS = 0;
  private readonly record = createTracked();
  private readonly sense: AimSense = createAimSense();

  constructor(readonly targetId: string) {}

  update(ctx: Ctx): DecisionOutcome | null {
    const b = ctx.body;
    const a = ctx.aim;
    a.active = false;
    a.targetId = this.targetId;
    a.onTarget = false;
    a.blockedBy = null;
    if (b.locomotion !== "on_foot") return "locomotion_changed";
    if (!b.alive) return "interrupted";
    if (b.busy) return null;

    // The sights are up for as long as this behaviour lives, target or not.
    ctx.out.aim = true;
    ctx.cameraOwned = true;
    a.active = true;

    const t = ctx.world.track(this.targetId, b, this.record);
    if (!t) return "target_unavailable";
    if (!t.alive) return "done";
    if (!t.visible) {
      this.lostS += ctx.dt;
      a.onTargetS = 0;
      if (this.lostS > AIM.lostS) return "target_lost";
    } else this.lostS = 0;

    const s = ctx.world.aim(this.sense);
    const py = t.y + t.height * AIM.torso;
    const tx = t.x + t.vx * AIM.lead;
    const tz = t.z + t.vz * AIM.lead;
    const dx = tx - s.cx;
    const dy = py - s.cy;
    const dz = tz - s.cz;
    const len = Math.hypot(dx, dy, dz) || 1;
    const desiredYaw = Math.atan2(dx, dz);
    // The camera's pitch is positive downwards: a ray with direction y has pitch −asin(y).
    const desiredPitch = -Math.asin(clamp(dy / len, -1, 1));
    const eYaw = wrapPi(desiredYaw - b.cameraYaw);
    const ePitch = desiredPitch - b.cameraPitch;

    const limit = AIM.turnRate * ctx.dt;
    const k = Math.min(1, AIM.gain * ctx.dt);
    ctx.out.lookYaw -= clamp(eYaw * k, -limit, limit);
    ctx.out.lookPitch -= clamp(ePitch * k, -limit, limit);

    const dot = (s.ax * dx + s.ay * dy + s.az * dz) / len;
    a.errorDeg = Math.acos(clamp(dot, -1, 1)) * RAD;
    a.yawErrorDeg = eYaw * RAD;
    a.pitchErrorDeg = ePitch * RAD;
    const onIntended = s.onKind === "person" && s.onId === this.targetId;
    // The crosshair may clear a bystander that the bullet, leaving from the chest, would not:
    // whoever is first in the bullet's path other than the target holds the shot.
    const inTheWay = s.bulletId !== null && s.bulletId !== this.targetId ? s.bulletId : null;
    a.onTarget = onIntended && t.visible && inTheWay === null;
    if (s.onKind === "person" && s.onId !== null && s.onId !== this.targetId) a.blockedBy = s.onId;
    else if (inTheWay !== null) a.blockedBy = inTheWay;
    this.alignedS = a.onTarget ? this.alignedS + ctx.dt : 0;
    a.onTargetS = this.alignedS;
    return null;
  }
}

/** One FIRE decision: pull the trigger along wherever the sights are pointing. */
export class Fire implements Behaviour {
  readonly name = "fire";
  private shots = 0;
  private waitS = 0;
  private wasReady = true;

  update(ctx: Ctx): DecisionOutcome | null {
    const b = ctx.body;
    if (b.locomotion !== "on_foot") return "locomotion_changed";
    if (!b.alive) return "interrupted";
    if (b.busy) return null;
    if (b.ammo <= 0 && b.reserve <= 0) return "not_ready";
    if (!b.weaponReady) {
      this.waitS += ctx.dt;
      // Between the shots of a burst the weapon is merely cooling down.
      if (this.shots > 0) return this.waitS > 1 ? "fired" : null;
      return this.waitS > 2.5 ? "not_ready" : null;
    }
    // With a target in the sights, wait until they are steady on it.
    const a = ctx.aim;
    if (a.active && a.targetId !== null && this.shots === 0) {
      if (!a.onTarget || a.onTargetS < AIM.settleS) {
        this.waitS += ctx.dt;
        return this.waitS > 1.5 ? "not_ready" : null;
      }
    }
    ctx.out.fire = true;
    if (this.wasReady) this.shots++;
    this.wasReady = false;
    return this.shots >= AIM.burst ? "fired" : null;
  }
}

/**
 * Repeated, disciplined fire at one target until it is down: only with the
 * crosshair on it, never with a bystander in the way, never dry.
 */
export class AutoFire implements Behaviour {
  readonly name = "auto_fire";
  private elapsed = 0;
  private readonly record = createTracked();

  constructor(readonly targetId: string) {}

  update(ctx: Ctx): DecisionOutcome | null {
    const b = ctx.body;
    if (b.locomotion !== "on_foot") return "locomotion_changed";
    if (!b.alive) return "interrupted";
    this.elapsed += ctx.dt;
    if (this.elapsed > 30) return "timed_out";
    const t = ctx.world.track(this.targetId, b, this.record);
    if (!t) return "target_unavailable";
    if (!t.alive) return "done";
    if (b.ammo <= 0 && b.reserve <= 0) return "not_ready";
    if (b.busy || !b.weaponReady) return null;
    const a = ctx.aim;
    if (!a.active || a.targetId !== this.targetId) return null;
    if (a.blockedBy !== null || !a.onTarget || a.onTargetS < AIM.settleS) return null;
    if (dist2d(b.x, b.z, t.x, t.z) > AIM.effectiveRange * 1.5) return null;
    ctx.out.fire = true;
    return null;
  }
}

/**
 * Get into a good firing position: in range, in sight, and standing still.
 * Holds when it is already there.
 */
export class Approach implements Behaviour {
  readonly name = "approach";
  private readonly walker = new PathWalker();
  private elapsed = 0;
  private retarget = 0;
  private lostS = 0;
  private readonly record = createTracked();

  constructor(readonly targetId: string) {}

  update(ctx: Ctx): DecisionOutcome | null {
    const b = ctx.body;
    if (b.locomotion !== "on_foot") return "locomotion_changed";
    if (!b.alive) return "interrupted";
    if (b.busy) return null;
    this.elapsed += ctx.dt;
    if (this.elapsed > 60) return "timed_out";
    const t = ctx.world.track(this.targetId, b, this.record);
    if (!t) return "target_unavailable";
    if (!t.alive) return "done";
    const d = dist2d(b.x, b.z, t.x, t.z);
    if (t.visible && d <= AIM.effectiveRange && d >= 4) {
      // In position: stand and shoot.
      this.lostS = 0;
      return null;
    }
    if (!t.visible) {
      this.lostS += ctx.dt;
      if (this.lostS > 8 && d < 6) return "target_lost";
    }
    this.retarget -= ctx.dt;
    if (this.retarget <= 0) {
      this.retarget = 0.5;
      this.walker.setGoal(t.x, t.z, AIM.standoff);
    }
    const r = this.walker.step(ctx, true);
    if (r === "arrived") return t.visible ? null : this.lostS > 4 ? "target_lost" : null;
    return r === "blocked" ? "blocked" : r === "stuck" ? "stuck" : null;
  }
}
