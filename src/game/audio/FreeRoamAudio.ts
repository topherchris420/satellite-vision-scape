import type { EventBus } from "../core/EventBus";
import type { FreeRoamEvents, ShotRecord } from "../freeroam/types";
import type { GameAudio } from "./GameAudio";

/**
 * The sound of a Free Roam run, built from the same oscillators and noise as
 * the rest of the game's audio: shots, a siren while a pursuit is on, hits, and
 * short cues for objectives. It only listens: nothing here is read back by the
 * simulation, and without an unlocked audio context every call does nothing.
 */

/** A notional reference: a shot this far away (metres) is at half volume. */
const SHOT_FALLOFF_M = 45;

/** Below this the sound is not worth creating nodes for. */
const INAUDIBLE = 0.015;

export function shotLoudness(distanceM: number): number {
  return 1 / (1 + (Math.max(0, distanceM) / SHOT_FALLOFF_M) ** 2);
}

interface Siren {
  osc: OscillatorNode;
  lfo: OscillatorNode;
  gain: GainNode;
}

export class FreeRoamAudio {
  private readonly off: (() => void)[] = [];
  private siren: Siren | null = null;
  /** A pursuit is on, whether or not audio has been unlocked yet. */
  private pursued = false;

  constructor(
    private readonly audio: Pick<GameAudio, "context" | "sfxBus" | "noiseBuffer" | "onUnlock">,
    events: EventBus<FreeRoamEvents>,
    private readonly listener: () => { x: number; z: number },
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
        if (e.by.kind === "player") this.burst(0.2, 900, 0.09, "bandpass");
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
      // A pursuit can start before the first click; the siren joins as soon as sound can.
      this.audio.onUnlock(() => this.applySiren()),
    );
  }

  /** The siren should be sounding. Exposed for tests: the graph itself needs a real context. */
  get sirenWanted(): boolean {
    return this.pursued;
  }

  private onShot(shot: ShotRecord): void {
    const here = this.listener();
    const loudness = shotLoudness(Math.hypot(shot.ox - here.x, shot.oz - here.z));
    if (loudness < INAUDIBLE) return;
    const peak = (shot.source === "security" ? 0.32 : 0.46) * loudness;
    // A crack through a bandpass, and a short low body underneath it.
    this.burst(peak, shot.source === "security" ? 1500 : 2100, 0.09, "bandpass");
    this.notes([150], peak * 0.8, 0.12, "sine");
  }

  private setPursuit(on: boolean): void {
    this.pursued = on;
    this.applySiren();
  }

  private applySiren(): void {
    const ctx = this.audio.context;
    const bus = this.audio.sfxBus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    if (this.pursued && !this.siren) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 780;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.42;
      const depth = ctx.createGain();
      depth.gain.value = 260;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 1000;
      filter.Q.value = 0.8;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.055, t + 1.4);
      lfo.connect(depth);
      depth.connect(osc.frequency);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(bus);
      osc.onended = () => gain.disconnect();
      osc.start(t);
      lfo.start(t);
      this.siren = { osc, lfo, gain };
    } else if (!this.pursued && this.siren) {
      const { osc, lfo, gain } = this.siren;
      this.siren = null;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.9);
      osc.stop(t + 1);
      lfo.stop(t + 1);
    }
  }

  private burst(peak: number, frequency: number, decay: number, type: BiquadFilterType): void {
    const ctx = this.audio.context;
    const bus = this.audio.sfxBus;
    const noise = this.audio.noiseBuffer;
    if (!ctx || !bus || !noise || peak < INAUDIBLE) return;
    const t = ctx.currentTime;
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
  private notes(frequencies: readonly number[], peak: number, length: number, type: OscillatorType = "triangle"): void {
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
