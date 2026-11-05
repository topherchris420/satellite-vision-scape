import type { EventBus } from "../core/EventBus";
import type { FreeRoamEvents, ShotRecord } from "../freeroam/types";
import type { GameAudio } from "./GameAudio";

/**
 * The sound of a Free Roam run, built from the same oscillators and noise as
 * the rest of the game's audio: shots that crack and roll back off the hills,
 * bullets that whiz past, a site alarm while a pursuit is on and a siren on
 * every response unit that is out (placed where the unit is, and bent by its
 * speed toward or away from the listener), hits, and short cues for
 * objectives. It only listens: nothing here is read back by the simulation,
 * and without an unlocked audio context every call does nothing.
 */

/** A notional reference: a shot this far away (metres) is at half volume. */
const SHOT_FALLOFF_M = 45;

/** Below this the sound is not worth creating nodes for. */
const INAUDIBLE = 0.015;

/** A bullet that passes closer than this (metres) to the listener is heard going by. */
const WHIZ_RADIUS = 4.5;

/** Speed of sound, m/s (for the siren's Doppler shift). */
const SOUND_SPEED = 343;

/** Most unit sirens sounding at once. */
const MAX_SIRENS = 3;

export function shotLoudness(distanceM: number): number {
  return 1 / (1 + (Math.max(0, distanceM) / SHOT_FALLOFF_M) ** 2);
}

/**
 * Closest approach (metres, in plan) of a shot's path to a point, or Infinity
 * if the bullet stopped before it got level with the point.
 */
export function shotPassDistance(
  shot: Pick<ShotRecord, "ox" | "oz" | "dx" | "dz" | "distance">,
  x: number,
  z: number,
): number {
  const flat = Math.hypot(shot.dx, shot.dz);
  if (flat < 1e-6) return Infinity;
  const ux = shot.dx / flat;
  const uz = shot.dz / flat;
  const along = (x - shot.ox) * ux + (z - shot.oz) * uz;
  const reach = shot.distance * flat;
  if (along < 0 || along > reach + 1) return Infinity;
  return Math.abs((x - shot.ox) * uz - (z - shot.oz) * ux);
}

/** Doppler factor for a source closing on the listener at `closing` m/s (negative: receding). */
export function dopplerFactor(closing: number): number {
  const c = Math.max(-0.5 * SOUND_SPEED, Math.min(0.5 * SOUND_SPEED, closing));
  return SOUND_SPEED / (SOUND_SPEED - c);
}

/** A response unit with its siren on, as presentation sees it. */
export interface SirenSource {
  id: string;
  x: number;
  y: number;
  z: number;
}

interface Alarm {
  osc: OscillatorNode;
  lfo: OscillatorNode;
  gain: GainNode;
}

interface UnitSiren {
  osc: OscillatorNode;
  lfo: OscillatorNode;
  gain: GainNode;
  panner: PannerNode;
  /** Last distance to the listener, for the closing speed. */
  distance: number;
  closing: number;
  seen: boolean;
}

export class FreeRoamAudio {
  private readonly off: (() => void)[] = [];
  private alarm: Alarm | null = null;
  private readonly sirens = new Map<string, UnitSiren>();
  /** A pursuit is on, whether or not audio has been unlocked yet. */
  private pursued = false;

  constructor(
    private readonly audio: Pick<GameAudio, "context" | "sfxBus" | "noiseBuffer" | "onUnlock">,
    events: EventBus<FreeRoamEvents>,
    private readonly listener: () => { x: number; z: number },
    /** Response units out on a call (their sirens sound where they are). */
    private readonly units: () => readonly SirenSource[] = () => [],
  ) {
    this.off.push(
      events.on("shot", (e) => this.onShot(e)),
      events.on("dryFire", () => this.click(0.1, 1900)),
      events.on("reloaded", () => {
        this.click(0.14, 1300);
        this.click(0.18, 900, 0.11);
      }),
      events.on("pursuit", (e) => this.setPursuit(e.phase === "started")),
      events.on("attention", (e) => {
        if (e.level > e.previous) this.notes([520, 390], 0.05, 0.09);
      }),
      events.on("personHit", (e) => {
        if (e.by.kind !== "player") return;
        // A hit is felt as much as heard: a dull thud, and a bright tick when it was a head.
        this.burst(0.2, 900, 0.09, "bandpass");
        this.notes([e.zone === "head" ? 1760 : 1320], 0.05, 0.05, "sine");
        if (e.killed) this.notes([196, 147], 0.08, 0.16, "triangle");
      }),
      events.on("playerDamaged", () => {
        this.burst(0.34, 260, 0.2, "lowpass");
        this.notes([92], 0.26, 0.22, "sine");
      }),
      events.on("collected", () => this.notes([880, 1320], 0.07, 0.1)),
      events.on("vehicleStolen", () => this.notes([740, 740, 740], 0.05, 0.07, "square")),
      events.on("locationUsed", () => this.notes([660, 990], 0.06, 0.09)),
      events.on("stage", (e) => {
        if (e.index > 0) this.notes([587, 880], 0.09, 0.14);
      }),
      events.on("challenge", (e) => {
        this.setPursuit(false);
        if (e.status === "success") this.notes([523, 659, 784, 1047], 0.11, 0.17);
        else this.notes([440, 349, 262], 0.11, 0.24);
      }),
      events.on("reset", () => this.setPursuit(false)),
      events.on("started", () => this.setPursuit(false)),
      events.on("stopped", () => this.setPursuit(false)),
      // A pursuit can start before the first click; the alarm joins as soon as sound can.
      this.audio.onUnlock(() => this.applyAlarm()),
    );
  }

  /** The pursuit's sound should be on. Exposed for tests: the graph itself needs a real context. */
  get sirenWanted(): boolean {
    return this.pursued;
  }

  /** Unit sirens sounding now (0 without a context). */
  get sirenCount(): number {
    return this.sirens.size;
  }

  private onShot(shot: ShotRecord): void {
    const here = this.listener();
    const distance = Math.hypot(shot.ox - here.x, shot.oz - here.z);
    const loudness = shotLoudness(distance);
    if (loudness >= INAUDIBLE) {
      const peak = (shot.source === "security" ? 0.32 : 0.46) * loudness;
      // A crack through a bandpass, a short low body underneath it…
      this.burst(peak, shot.source === "security" ? 1500 : 2100, 0.09, "bandpass");
      this.notes([150], peak * 0.8, 0.12, "sine");
      // …and the report rolling back off the ranges a moment later.
      this.burst(peak * 0.22, 700, 0.32, "lowpass", 0.18 + Math.min(0.4, distance / 400));
      this.burst(peak * 0.12, 520, 0.45, "lowpass", 0.42 + Math.min(0.5, distance / 300));
    }
    // A shot at the player that missed: it goes past the ear.
    if (shot.source === "security" && shot.hit !== "person") {
      const pass = shotPassDistance(shot, here.x, here.z);
      if (pass < WHIZ_RADIUS) this.whiz(1 - pass / WHIZ_RADIUS);
    }
  }

  private setPursuit(on: boolean): void {
    this.pursued = on;
    this.applyAlarm();
    if (!on) this.silenceUnits();
  }

  /**
   * Per rendered frame (presentation): place each responding unit's siren
   * where the unit is and bend its pitch by how fast it is closing.
   */
  frame(dt: number): void {
    const ctx = this.audio.context;
    const bus = this.audio.sfxBus;
    if (!ctx || !bus) return;
    if (!this.pursued) {
      if (this.sirens.size > 0) this.silenceUnits();
      return;
    }
    const here = this.listener();
    for (const s of this.sirens.values()) s.seen = false;
    const units = this.units();
    for (let i = 0; i < units.length && i < MAX_SIRENS; i++) {
      const u = units[i];
      let s = this.sirens.get(u.id);
      const distance = Math.hypot(u.x - here.x, u.z - here.z);
      if (!s) {
        s = this.startUnit(ctx, bus, distance);
        this.sirens.set(u.id, s);
      }
      s.seen = true;
      if (dt > 0) {
        const closing = (s.distance - distance) / dt;
        s.closing += (closing - s.closing) * Math.min(1, dt * 4);
        s.distance = distance;
      }
      const t = ctx.currentTime;
      const p = s.panner;
      if (p.positionX) {
        p.positionX.setTargetAtTime(u.x, t, 0.05);
        p.positionY.setTargetAtTime(u.y + 1.6, t, 0.05);
        p.positionZ.setTargetAtTime(u.z, t, 0.05);
      } else p.setPosition(u.x, u.y + 1.6, u.z);
      s.osc.detune.setTargetAtTime(1200 * Math.log2(dopplerFactor(s.closing)), t, 0.08);
    }
    for (const [id, s] of this.sirens) {
      if (s.seen) continue;
      this.stopUnit(s);
      this.sirens.delete(id);
    }
  }

  private startUnit(ctx: AudioContext, bus: GainNode, distance: number): UnitSiren {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 980;
    // The wail: a slow sweep up and down.
    const lfo = ctx.createOscillator();
    lfo.type = "triangle";
    lfo.frequency.value = 0.38 + (distance % 7) * 0.01;
    const depth = ctx.createGain();
    depth.gain.value = 330;
    const shape = ctx.createBiquadFilter();
    shape.type = "bandpass";
    shape.frequency.value = 1150;
    shape.Q.value = 1.1;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.06, t + 0.6);
    const panner = ctx.createPanner();
    panner.panningModel = "equalpower";
    panner.distanceModel = "inverse";
    panner.refDistance = 14;
    panner.rolloffFactor = 1.15;
    panner.maxDistance = 900;
    lfo.connect(depth);
    depth.connect(osc.frequency);
    osc.connect(shape);
    shape.connect(gain);
    gain.connect(panner);
    panner.connect(bus);
    osc.onended = () => panner.disconnect();
    osc.start(t);
    lfo.start(t);
    return { osc, lfo, gain, panner, distance, closing: 0, seen: true };
  }

  private stopUnit(s: UnitSiren): void {
    const ctx = this.audio.context;
    if (!ctx) return;
    const t = ctx.currentTime;
    s.gain.gain.cancelScheduledValues(t);
    s.gain.gain.setValueAtTime(s.gain.gain.value, t);
    s.gain.gain.linearRampToValueAtTime(0, t + 0.8);
    s.osc.stop(t + 0.9);
    s.lfo.stop(t + 0.9);
  }

  private silenceUnits(): void {
    for (const s of this.sirens.values()) this.stopUnit(s);
    this.sirens.clear();
  }

  /** The site's own alarm: a low two-tone drone under the unit sirens while a pursuit is on. */
  private applyAlarm(): void {
    const ctx = this.audio.context;
    const bus = this.audio.sfxBus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    if (this.pursued && !this.alarm) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 560;
      const lfo = ctx.createOscillator();
      lfo.type = "square";
      lfo.frequency.value = 0.9;
      const depth = ctx.createGain();
      depth.gain.value = 70;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 900;
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.022, t + 1.4);
      lfo.connect(depth);
      depth.connect(osc.frequency);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(bus);
      osc.onended = () => gain.disconnect();
      osc.start(t);
      lfo.start(t);
      this.alarm = { osc, lfo, gain };
    } else if (!this.pursued && this.alarm) {
      const { osc, lfo, gain } = this.alarm;
      this.alarm = null;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.9);
      osc.stop(t + 1);
      lfo.stop(t + 1);
    }
  }

  /** A bullet going past: a fast falling hiss. */
  private whiz(closeness: number): void {
    const ctx = this.audio.context;
    const bus = this.audio.sfxBus;
    const noise = this.audio.noiseBuffer;
    if (!ctx || !bus || !noise) return;
    const t = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(5200, t);
    filter.frequency.exponentialRampToValueAtTime(1400, t + 0.16);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.06 + closeness * 0.16, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(bus);
    source.onended = () => gain.disconnect();
    source.start(t, 0.3, 0.22);
  }

  private burst(
    peak: number,
    frequency: number,
    decay: number,
    type: BiquadFilterType,
    delay = 0,
  ): void {
    const ctx = this.audio.context;
    const bus = this.audio.sfxBus;
    const noise = this.audio.noiseBuffer;
    if (!ctx || !bus || !noise || peak < INAUDIBLE * 0.5) return;
    const t = ctx.currentTime + delay;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(bus);
    source.onended = () => gain.disconnect();
    source.start(t, 0, decay + 0.02);
  }

  private click(peak: number, frequency: number, delay = 0): void {
    const ctx = this.audio.context;
    const bus = this.audio.sfxBus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = frequency;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    osc.connect(gain);
    gain.connect(bus);
    osc.onended = () => gain.disconnect();
    osc.start(t);
    osc.stop(t + 0.05);
  }

  /** Notes played one after another. */
  private notes(
    frequencies: readonly number[],
    peak: number,
    length: number,
    type: OscillatorType = "triangle",
  ): void {
    const ctx = this.audio.context;
    const bus = this.audio.sfxBus;
    if (!ctx || !bus) return;
    frequencies.forEach((frequency, i) => {
      const t = ctx.currentTime + i * length * 0.8;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = frequency;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(peak, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
      osc.connect(gain);
      gain.connect(bus);
      osc.onended = () => gain.disconnect();
      osc.start(t);
      osc.stop(t + length + 0.05);
    });
  }

  dispose(): void {
    for (const off of this.off) off();
    this.off.length = 0;
    this.setPursuit(false);
  }
}
