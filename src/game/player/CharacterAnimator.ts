import { clamp, damp, lerp, smoothstep, TAU } from "../core/math";

/**
 * Joint angles for the procedural soldier rig (radians, metres for hipsY).
 * Limb conventions: positive `*Hip` / `*Arm` swing the limb forward, positive
 * knees and elbows flex, positive spine pitch leans forward.
 */
export interface CharacterPose {
  hipsY: number;
  pelvisYaw: number;
  pelvisRoll: number;
  spinePitch: number;
  spineYaw: number;
  headPitch: number;
  lHip: number;
  rHip: number;
  lHipOut: number;
  rHipOut: number;
  lKnee: number;
  rKnee: number;
  lAnkle: number;
  rAnkle: number;
  lArm: number;
  rArm: number;
  lArmOut: number;
  rArmOut: number;
  lElbow: number;
  rElbow: number;
  bank: number;
}

export function createPose(): CharacterPose {
  return {
    hipsY: 0,
    pelvisYaw: 0,
    pelvisRoll: 0,
    spinePitch: 0,
    spineYaw: 0,
    headPitch: 0,
    lHip: 0,
    rHip: 0,
    lHipOut: 0,
    rHipOut: 0,
    lKnee: 0,
    rKnee: 0,
    lAnkle: 0,
    rAnkle: 0,
    lArm: 0,
    rArm: 0,
    lArmOut: 0,
    rArmOut: 0,
    lElbow: 0,
    rElbow: 0,
    bank: 0,
  };
}

const POSE_KEYS = Object.keys(createPose()) as (keyof CharacterPose)[];

function blendInto(out: CharacterPose, a: CharacterPose, b: CharacterPose, t: number): void {
  for (let i = 0; i < POSE_KEYS.length; i++) {
    const k = POSE_KEYS[i];
    out[k] = a[k] + (b[k] - a[k]) * t;
  }
}

export interface AnimationParams {
  /** Actual horizontal speed, m/s. */
  speed: number;
  grounded: boolean;
  airTime: number;
  verticalVelocity: number;
  /** Body yaw rate, rad/s (banking into turns). */
  turnRate: number;
  /** 0 standing … 1 fully seated (driven by the interaction choreography). */
  seatWeight: number;
  /** Vehicle steering −1 … 1, for hands on the wheel. */
  steer: number;
}

/** Stride length (one full two-step cycle, metres) as speed rises. */
function cycleLength(speed: number): number {
  if (speed < 2) return lerp(1.25, 1.5, speed / 2);
  if (speed < 4) return lerp(1.5, 2.35, (speed - 2) / 2);
  return lerp(2.35, 3.3, clamp((speed - 4) / 3, 0, 1));
}

/**
 * Procedural gait. The cycle phase advances with distance travelled (not
 * time), so feet never skate: a slower body takes proportionally slower
 * steps. Idle, locomotion, airborne and seated poses are blended by smoothed
 * weights, which gives natural transitions between every state.
 */
export class CharacterAnimator {
  readonly pose = createPose();
  /** Called at each heel strike with the foot index (0 left, 1 right). */
  onFootstep: ((foot: 0 | 1, speed: number) => void) | null = null;

  private phase = 0;
  private time = 0;
  private speed = 0;
  private airWeight = 0;
  private bank = 0;
  private readonly idle = createPose();
  private readonly loco = createPose();
  private readonly air = createPose();
  private readonly seated = createPose();
  private readonly mix = createPose();

  reset(): void {
    this.phase = 0;
    this.speed = 0;
    this.airWeight = 0;
    this.bank = 0;
  }

  update(dt: number, params: AnimationParams): CharacterPose {
    this.time += dt;
    this.speed = damp(this.speed, params.speed, 10, dt);
    const s = this.speed;

    // Advance the gait by distance; detect heel strikes for footstep events.
    const before = this.phase;
    this.phase += (TAU * params.speed * dt) / cycleLength(s);
    const locoWeight = smoothstep(0.05, 0.7, s);
    if (params.grounded && locoWeight > 0.5 && this.onFootstep) {
      // Left heel strikes at phase π/2, right at 3π/2 (legs are π apart).
      for (const [foot, at] of [
        [0, Math.PI / 2],
        [1, (3 * Math.PI) / 2],
      ] as const) {
        const k0 = Math.floor((before - at) / TAU);
        const k1 = Math.floor((this.phase - at) / TAU);
        if (k1 > k0) this.onFootstep(foot, s);
      }
    }
    this.phase %= TAU * 64;

    this.airWeight = damp(this.airWeight, !params.grounded && params.airTime > 0.1 ? 1 : 0, 9, dt);
    this.bank = damp(this.bank, clamp(-params.turnRate * s * 0.022, -0.2, 0.2), 6, dt);

    this.buildIdle();
    this.buildLocomotion(s);
    this.buildAir(params.verticalVelocity);
    this.buildSeated(params.steer);

    blendInto(this.mix, this.idle, this.loco, locoWeight);
    blendInto(this.mix, this.mix, this.air, this.airWeight);
    blendInto(this.pose, this.mix, this.seated, smoothstep(0, 1, params.seatWeight));
    this.pose.bank = this.bank * (1 - params.seatWeight);
    return this.pose;
  }

  private buildIdle(): void {
    const t = this.time;
    const p = this.idle;
    const breathe = Math.sin(t * 1.7);
    const shift = Math.sin(t * 0.45);
    p.hipsY = -0.01 + breathe * 0.004;
    p.pelvisYaw = 0;
    p.pelvisRoll = shift * 0.025;
    p.spinePitch = 0.02 + breathe * 0.012;
    p.spineYaw = 0;
    p.headPitch = 0.04 + Math.sin(t * 0.31) * 0.03;
    p.lHip = 0.02;
    p.rHip = -0.02;
    p.lHipOut = 0.05;
    p.rHipOut = -0.05;
    p.lKnee = 0.06 + Math.max(0, shift) * 0.05;
    p.rKnee = 0.06 + Math.max(0, -shift) * 0.05;
    p.lAnkle = -0.06;
    p.rAnkle = -0.06;
    p.lArm = 0.04 + breathe * 0.01;
    p.rArm = 0.04 + breathe * 0.01;
    p.lArmOut = 0.13;
    p.rArmOut = -0.13;
    p.lElbow = 0.22;
    p.rElbow = 0.22;
  }

  private buildLocomotion(speed: number): void {
    const p = this.loco;
    const run = smoothstep(2.3, 4.2, speed);
    const sprint = smoothstep(4.8, 6.4, speed);
    const ph = this.phase;
    const hipAmp = lerp(0.42, 0.7, run) + sprint * 0.1;
    const kneeSwing = lerp(0.85, 1.45, run) + sprint * 0.2;
    const kneeBase = lerp(0.08, 0.22, run);
    const armAmp = lerp(0.32, 0.75, run) + sprint * 0.15;
    const leg = (phase: number) => {
      const swing = Math.max(0, Math.cos(phase));
      const hip = hipAmp * Math.sin(phase);
      const knee = kneeBase + kneeSwing * swing * swing;
      return { hip, knee, ankle: (hip - knee) * 0.55 + 0.08 };
    };
    const l = leg(ph);
    const r = leg(ph + Math.PI);
    p.lHip = l.hip;
    p.rHip = r.hip;
    p.lKnee = l.knee;
    p.rKnee = r.knee;
    p.lAnkle = l.ankle;
    p.rAnkle = r.ankle;
    p.lHipOut = 0.03;
    p.rHipOut = -0.03;
    // Walking peaks at mid-stance, running bottoms out there (compression).
    const bob = lerp(0.028, 0.06, run);
    const cycle2 = Math.cos(2 * ph);
    p.hipsY = lerp(-0.012 + bob * 0.5 * cycle2, -0.06 - bob * 0.5 * cycle2, run);
    p.pelvisYaw = Math.sin(ph) * lerp(0.1, 0.16, run);
    p.pelvisRoll = Math.sin(ph) * 0.03 * (1 - run);
    p.spineYaw = -p.pelvisYaw * 1.25;
    p.spinePitch = lerp(0.05, 0.2, run) + sprint * 0.1;
    p.headPitch = -p.spinePitch * 0.6 + 0.05;
    // Arms counter-swing their opposite legs.
    p.lArm = -armAmp * Math.sin(ph) * 0.9 + run * 0.15;
    p.rArm = armAmp * Math.sin(ph) * 0.9 + run * 0.15;
    p.lArmOut = lerp(0.12, 0.2, run);
    p.rArmOut = -lerp(0.12, 0.2, run);
    p.lElbow = lerp(0.3, 1.35, run) + Math.max(0, p.lArm) * 0.35;
    p.rElbow = lerp(0.3, 1.35, run) + Math.max(0, p.rArm) * 0.35;
  }

  private buildAir(verticalVelocity: number): void {
    const p = this.air;
    const rising = clamp(verticalVelocity / 5, -1, 1);
    p.hipsY = -0.03;
    p.pelvisYaw = 0;
    p.pelvisRoll = 0;
    p.spinePitch = 0.12 - rising * 0.06;
    p.spineYaw = 0;
    p.headPitch = 0.02;
    p.lHip = 0.55;
    p.rHip = -0.15;
    p.lHipOut = 0.06;
    p.rHipOut = -0.06;
    p.lKnee = 1.0;
    p.rKnee = 0.55;
    p.lAnkle = -0.3;
    p.rAnkle = -0.2;
    p.lArm = 0.45 + rising * 0.2;
    p.rArm = -0.1 + rising * 0.2;
    p.lArmOut = 0.45;
    p.rArmOut = -0.45;
    p.lElbow = 0.7;
    p.rElbow = 0.6;
  }

  private buildSeated(steer: number): void {
    const p = this.seated;
    p.hipsY = 0;
    p.pelvisYaw = 0;
    p.pelvisRoll = 0;
    p.spinePitch = -0.16;
    p.spineYaw = -steer * 0.04;
    p.headPitch = 0.12;
    p.lHip = 1.38;
    p.rHip = 1.38;
    p.lHipOut = 0.08;
    p.rHipOut = -0.08;
    p.lKnee = 0.72;
    p.rKnee = 0.72;
    p.lAnkle = -0.5;
    p.rAnkle = -0.5;
    // Hands on the wheel, riding round with the steering.
    p.lArm = 1.02 + steer * 0.12;
    p.rArm = 1.02 - steer * 0.12;
    p.lArmOut = 0.1;
    p.rArmOut = -0.1;
    p.lElbow = 0.52;
    p.rElbow = 0.52;
  }
}
