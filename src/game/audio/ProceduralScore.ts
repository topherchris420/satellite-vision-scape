import {
  BAR_SECONDS,
  BEAT_SECONDS,
  TEMPO,
  chordAt,
  midiToHz,
  notesFor,
  type NoteEvent,
} from "../afterhours/composition";
import { LAYER_IDS, type LayerId } from "../afterhours/progress";

/**
 * Plays the procedural puzzle / concert score (see `composition.ts`). This
 * music is generated for gameplay and is never mixed over the album.
 *
 * Notes are scheduled on the AudioContext clock one beat at a time, a
 * little ahead of playback, from the render loop (no timers). Persistent
 * nodes — one bus per layer, the pad filter, the melody delay, the pitch
 * offsets and the reference drone — are created once and reused, so
 * repeated tuning sessions and concert replays never accumulate nodes.
 * Short-lived note voices disconnect themselves when they end.
 */

type Channel = LayerId | "reference";

export interface ScoreTargets {
  levels: Record<Channel, number>;
  /** Pitch offset (cents) for pitch-tuned layers. */
  detuneCents: Record<LayerId, number>;
  /** Timing offset (beats) for phase-tuned layers. */
  offsetBeats: Record<LayerId, number>;
  /** Sustained reference tone following the chord root (pitch tuning). */
  drone: number;
  /** Drone register: octave offset from the bass root. */
  droneOctave: number;
  /** Harmony filter opening, 0..1. */
  bloom: number;
  /** Send levels: straight to the score bus, or into the vehicle radio. */
  direct: number;
  radio: number;
  /** Overall music volume 0..1. */
  volume: number;
}

export function createScoreTargets(): ScoreTargets {
  return {
    levels: { rhythm: 0, bass: 0, harmony: 0, melody: 0, reference: 0 },
    detuneCents: { rhythm: 0, bass: 0, harmony: 0, melody: 0 },
    offsetBeats: { rhythm: 0, bass: 0, harmony: 0, melody: 0 },
    drone: 0,
    droneOctave: 1,
    bloom: 0.5,
    direct: 1,
    radio: 0,
    volume: 0.7,
  };
}

/** How far ahead of the clock beats are scheduled (s). */
const LOOKAHEAD = 0.3;
const MAX_OFFSET = 0.5 * BEAT_SECONDS;
const CHANNELS: readonly Channel[] = [...LAYER_IDS, "reference"];
const PHRASES = 4;

export class ProceduralScore {
  running = false;
  /** Context time of beat 0. */
  startTime = 0;
  /** Voices whose nodes are still connected (for leak checks). */
  get activeVoices(): number {
    return this.live.length;
  }

  private readonly ctx: AudioContext;
  private readonly noise: AudioBuffer | null;
  private readonly bus: Record<Channel, GainNode>;
  private readonly mix: GainNode;
  private readonly out: GainNode;
  private readonly directSend: GainNode;
  private readonly radioSend: GainNode;
  private readonly padFilter: BiquadFilterNode;
  private readonly leadIn: GainNode;
  private readonly delay: DelayNode;
  private readonly delayFeedback: GainNode;
  private readonly delayWet: GainNode;
  private readonly detune: Record<"bass" | "harmony", ConstantSourceNode>;
  private readonly drone: OscillatorNode;
  private readonly droneGain: GainNode;
  private readonly patterns: Record<Channel, NoteEvent[][]>;
  private readonly targets = new Map<AudioParam, number>();
  private nextBeat = 0;
  private offsets: Record<LayerId, number> = { rhythm: 0, bass: 0, harmony: 0, melody: 0 };
  private levels: Record<Channel, number> = {
    rhythm: 0,
    bass: 0,
    harmony: 0,
    melody: 0,
    reference: 0,
  };
  private stopAt = 0;
  /** Scheduled voices: cleaned up on `ended`, or by the sweep once past their end. */
  private live: { end: number; cleanup: () => void }[] = [];

  constructor(ctx: AudioContext, direct: AudioNode, radio: AudioNode, noise: AudioBuffer | null) {
    this.ctx = ctx;
    this.noise = noise;
    this.mix = ctx.createGain();
    this.mix.gain.value = 0.85;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.directSend = ctx.createGain();
    this.radioSend = ctx.createGain();
    this.radioSend.gain.value = 0;
    this.mix.connect(this.out);
    this.out.connect(this.directSend);
    this.out.connect(this.radioSend);
    this.directSend.connect(direct);
    this.radioSend.connect(radio);

    const bus = {} as Record<Channel, GainNode>;
    for (const c of CHANNELS) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.mix);
      bus[c] = g;
    }
    this.bus = bus;

    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = "lowpass";
    this.padFilter.frequency.value = 1200;
    this.padFilter.Q.value = 0.5;
    this.padFilter.connect(bus.harmony);

    this.leadIn = ctx.createGain();
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = BEAT_SECONDS * 0.75;
    this.delayFeedback = ctx.createGain();
    this.delayFeedback.gain.value = 0.28;
    this.delayWet = ctx.createGain();
    this.delayWet.gain.value = 0.3;
    this.leadIn.connect(bus.melody);
    this.leadIn.connect(this.delay);
    this.delay.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);
    this.delay.connect(this.delayWet);
    this.delayWet.connect(bus.melody);

    this.detune = {
      bass: ctx.createConstantSource(),
      harmony: ctx.createConstantSource(),
    };
    this.detune.bass.offset.value = 0;
    this.detune.harmony.offset.value = 0;
    this.detune.bass.start();
    this.detune.harmony.start();

    this.drone = ctx.createOscillator();
    this.drone.type = "sine";
    this.drone.frequency.value = midiToHz(57);
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.drone.connect(this.droneGain);
    this.droneGain.connect(bus.reference);
    this.drone.start();

    // The whole score repeats every four bars; precompute its note lists.
    const patterns = {} as Record<Channel, NoteEvent[][]>;
    for (const c of CHANNELS) {
      patterns[c] = Array.from({ length: PHRASES }, (_, bar) => notesFor(c, bar));
    }
    this.patterns = patterns;
  }

  /** Seconds since beat 0 on the audio clock. */
  get position(): number {
    return this.running ? Math.max(0, this.ctx.currentTime - this.startTime) : 0;
  }

  /** Start the clock (beat 0) at `at` (defaults to just ahead of now). */
  start(at = this.ctx.currentTime + 0.08): void {
    this.running = true;
    this.startTime = at;
    this.nextBeat = 0;
    this.stopAt = 0;
  }

  /** Fade out and stop scheduling once silent. */
  stop(): void {
    // Idempotent: repeated calls must not keep postponing the stop.
    if (!this.running || this.stopAt > 0) return;
    this.stopAt = this.ctx.currentTime + 1.2;
    this.target(this.out.gain, 0, 0.25);
  }

  /** Needed again during a fade-out: carry on without restarting the clock. */
  cancelStop(): void {
    this.stopAt = 0;
  }

  get stopping(): boolean {
    return this.stopAt > 0;
  }

  private target(param: AudioParam, value: number, tau: number): void {
    const last = this.targets.get(param);
    if (last !== undefined && Math.abs(last - value) < 1e-4) return;
    this.targets.set(param, value);
    param.setTargetAtTime(value, this.ctx.currentTime, tau);
  }

  update(t: ScoreTargets): void {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    if (this.stopAt > 0) {
      if (now >= this.stopAt) {
        this.running = false;
        this.stopAt = 0;
        for (const c of CHANNELS) this.target(this.bus[c].gain, 0, 0.05);
        this.target(this.droneGain.gain, 0, 0.05);
      }
      return;
    }
    this.target(this.out.gain, t.volume, 0.15);
    this.target(this.directSend.gain, t.direct, 0.3);
    this.target(this.radioSend.gain, t.radio, 0.3);
    for (const c of CHANNELS) {
      this.levels[c] = t.levels[c];
      this.target(this.bus[c].gain, t.levels[c] * CHANNEL_GAIN[c], 0.35);
    }
    this.target(this.detune.bass.offset, t.detuneCents.bass, 0.05);
    this.target(this.detune.harmony.offset, t.detuneCents.harmony, 0.05);
    this.offsets = t.offsetBeats;
    this.target(
      this.padFilter.frequency,
      450 * Math.pow(7, Math.min(1, Math.max(0, t.bloom))),
      0.6,
    );
    this.target(this.droneGain.gain, t.drone * 0.16, 0.2);
    this.droneOctave = t.droneOctave;
    this.schedule(now);
  }

  private droneOctave = 1;

  private schedule(now: number): void {
    // After a stall, skip beats that are already in the past.
    const current = Math.floor((now - this.startTime) / BEAT_SECONDS);
    if (this.nextBeat < current - 1) this.nextBeat = current;
    while (this.startTime + this.nextBeat * BEAT_SECONDS < now + LOOKAHEAD + MAX_OFFSET) {
      this.scheduleBeat(this.nextBeat, now);
      this.nextBeat++;
    }
  }

  private scheduleBeat(beat: number, now: number): void {
    const bar = Math.floor(beat / TEMPO.beatsPerBar);
    const inBar = beat - bar * TEMPO.beatsPerBar;
    const phrase = bar % PHRASES;
    const barStart = this.startTime + bar * BAR_SECONDS;
    if (inBar === 0) {
      // The reference drone follows the chord root.
      const root = chordAt(bar).root + 12 * this.droneOctave;
      this.drone.frequency.setTargetAtTime(midiToHz(root), Math.max(now, barStart), 0.02);
    }
    for (const c of CHANNELS) {
      // Silent layers are not scheduled at all.
      if (this.levels[c] < 0.002) continue;
      const offset = c === "reference" ? 0 : this.offsets[c] * BEAT_SECONDS;
      for (const n of this.patterns[c][phrase]) {
        if (n.beat < inBar || n.beat >= inBar + 1) continue;
        const time = Math.max(now + 0.005, barStart + n.beat * BEAT_SECONDS + offset);
        this.voice(n, time);
      }
    }
  }

  /**
   * Register a voice ending at `end` (context time). The returned cleanup
   * runs on `ended`; `sweep` runs it anyway once the end time has passed,
   * so nothing stays connected even if an `ended` event never arrives.
   */
  private finish(
    end: number,
    nodes: AudioNode[],
    params: [ConstantSourceNode, AudioParam][] = [],
  ): () => void {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      for (const n of nodes) n.disconnect();
      for (const [source, param] of params) {
        try {
          source.disconnect(param);
        } catch {
          // Already disconnected.
        }
      }
    };
    this.live.push({ end, cleanup });
    return cleanup;
  }

  /** Disconnect every voice that has finished (called every frame). */
  sweep(): void {
    const now = this.ctx.currentTime;
    let w = 0;
    for (let i = 0; i < this.live.length; i++) {
      const v = this.live[i];
      if (v.end + 0.25 < now) v.cleanup();
      else this.live[w++] = v;
    }
    this.live.length = w;
  }

  private envelope(
    gain: GainNode,
    t: number,
    peak: number,
    attack: number,
    hold: number,
    release: number,
  ) {
    const g = gain.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.setValueAtTime(Math.max(0.0002, peak), t + attack + hold);
    g.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    return t + attack + hold + release + 0.02;
  }

  private voice(n: NoteEvent, t: number): void {
    const ctx = this.ctx;
    const len = n.length * BEAT_SECONDS;
    switch (n.voice) {
      case "kick": {
        const osc = ctx.createOscillator();
        osc.frequency.setValueAtTime(115, t);
        osc.frequency.exponentialRampToValueAtTime(42, t + 0.14);
        const g = ctx.createGain();
        const end = this.envelope(g, t, 0.85 * n.velocity, 0.004, 0.02, 0.3);
        osc.connect(g).connect(this.bus.rhythm);
        osc.onended = this.finish(end, [osc, g]);
        osc.start(t);
        osc.stop(end);
        return;
      }
      case "hat":
      case "rim": {
        if (!this.noise) return;
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        const f = ctx.createBiquadFilter();
        const hat = n.voice === "hat";
        f.type = hat ? "highpass" : "bandpass";
        f.frequency.value = hat ? 7200 : 1900;
        f.Q.value = hat ? 0.7 : 3;
        const g = ctx.createGain();
        const end = this.envelope(
          g,
          t,
          (hat ? 0.11 : 0.3) * n.velocity,
          0.002,
          0.004,
          hat ? 0.045 : 0.08,
        );
        src.connect(f).connect(g).connect(this.bus.rhythm);
        src.onended = this.finish(end, [src, f, g]);
        src.start(t, Math.random() * 1.5, end - t);
        return;
      }
      case "bass": {
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = midiToHz(n.midi);
        const sub = ctx.createOscillator();
        sub.type = "sine";
        sub.frequency.value = midiToHz(n.midi);
        const f = ctx.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.value = 650;
        const g = ctx.createGain();
        const end = this.envelope(g, t, 0.34 * n.velocity, 0.012, Math.max(0.02, len * 0.7), 0.12);
        this.detune.bass.connect(osc.detune);
        this.detune.bass.connect(sub.detune);
        osc.connect(f);
        sub.connect(f);
        f.connect(g).connect(this.bus.bass);
        osc.onended = this.finish(
          end,
          [osc, sub, f, g],
          [
            [this.detune.bass, osc.detune],
            [this.detune.bass, sub.detune],
          ],
        );
        osc.start(t);
        sub.start(t);
        osc.stop(end);
        sub.stop(end);
        return;
      }
      case "pad": {
        const g = ctx.createGain();
        const end = this.envelope(g, t, 0.05, 0.6, Math.max(0.05, len - 0.6), 0.9);
        g.connect(this.padFilter);
        const oscs: OscillatorNode[] = [];
        for (const cents of [-7, 7]) {
          const osc = ctx.createOscillator();
          osc.type = "sawtooth";
          osc.frequency.value = midiToHz(n.midi);
          osc.detune.value = cents;
          this.detune.harmony.connect(osc.detune);
          osc.connect(g);
          osc.start(t);
          osc.stop(end);
          oscs.push(osc);
        }
        oscs[0].onended = this.finish(
          end,
          [oscs[0], oscs[1], g],
          [
            [this.detune.harmony, oscs[0].detune],
            [this.detune.harmony, oscs[1].detune],
          ],
        );
        return;
      }
      case "lead": {
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = midiToHz(n.midi);
        const g = ctx.createGain();
        const end = this.envelope(g, t, 0.13 * n.velocity, 0.018, Math.max(0.03, len * 0.55), 0.35);
        osc.connect(g).connect(this.leadIn);
        osc.onended = this.finish(end, [osc, g]);
        osc.start(t);
        osc.stop(end);
        return;
      }
      case "click": {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = midiToHz(n.midi);
        const g = ctx.createGain();
        const end = this.envelope(g, t, 0.16 * n.velocity, 0.002, 0.01, 0.07);
        osc.connect(g).connect(this.bus.reference);
        osc.onended = this.finish(end, [osc, g]);
        osc.start(t);
        osc.stop(end);
        return;
      }
    }
  }

  dispose(): void {
    this.running = false;
    for (const v of this.live) v.cleanup();
    this.live.length = 0;
    for (const s of [this.detune.bass, this.detune.harmony, this.drone]) {
      try {
        s.stop();
      } catch {
        // Already stopped.
      }
    }
    const nodes: AudioNode[] = [
      this.mix,
      this.out,
      this.directSend,
      this.radioSend,
      this.padFilter,
      this.leadIn,
      this.delay,
      this.delayFeedback,
      this.delayWet,
      this.detune.bass,
      this.detune.harmony,
      this.drone,
      this.droneGain,
      ...CHANNELS.map((c) => this.bus[c]),
    ];
    for (const n of nodes) n.disconnect();
    this.targets.clear();
  }
}

/** Relative level of each layer in the mix. */
const CHANNEL_GAIN: Record<Channel, number> = {
  rhythm: 0.9,
  bass: 1,
  harmony: 1,
  melody: 0.9,
  reference: 0.8,
};
