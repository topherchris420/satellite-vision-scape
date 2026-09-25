import type { SurfaceKind } from "../world/GroundQuery";

/** Continuous inputs sampled once per frame. */
export interface AudioFrame {
  engineOn: boolean;
  /** 0 idle … 1 red line. */
  rpm: number;
  throttle: number;
  /** Tyre slip for skid noise, m/s. */
  slip: number;
  /** Speed of whatever the camera follows, m/s (wind rush). */
  speed: number;
  surface: SurfaceKind;
}

const FOOTSTEP_BAND: Record<SurfaceKind, [number, number, number]> = {
  // [centre Hz, Q, decay s]
  dirt: [850, 0.9, 0.09],
  gravel: [2300, 0.7, 0.11],
  asphalt: [1500, 1.2, 0.06],
  concrete: [1800, 1.3, 0.06],
  grass: [600, 0.8, 0.1],
  water: [420, 0.6, 0.16],
};

/**
 * Procedural sound built entirely from Web Audio oscillators and filtered
 * noise: diesel engine, tyre scrub, wind, footsteps per surface, doors,
 * impacts and barrier motors. No audio files are loaded. The context is only
 * created from a user gesture (`unlock`), and every method is a no-op when
 * Web Audio is unavailable.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engine: {
    low: OscillatorNode;
    high: OscillatorNode;
    filter: BiquadFilterNode;
    gain: GainNode;
    clatterFilter: BiquadFilterNode;
    clatterGain: GainNode;
  } | null = null;
  private skid: { filter: BiquadFilterNode; gain: GainNode } | null = null;
  private wind: { filter: BiquadFilterNode; gain: GainNode } | null = null;
  private muted = false;
  private readonly volume = 0.55;

  get ready(): boolean {
    return this.ctx !== null;
  }

  /** Create (or resume) the audio graph. Must run inside a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor =
      typeof window !== "undefined"
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(ctx.destination);

    // Two seconds of white noise feed every noise-based sound.
    const length = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < length; i++) {
      seed = (seed * 16807) % 2147483647;
      data[i] = (seed / 2147483647) * 2 - 1;
    }

    // Engine: sawtooth + sub square through a lowpass, plus diesel clatter.
    const low = ctx.createOscillator();
    low.type = "sawtooth";
    const high = ctx.createOscillator();
    high.type = "square";
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 1.6;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    low.connect(filter);
    high.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    const clatterFilter = ctx.createBiquadFilter();
    clatterFilter.type = "bandpass";
    clatterFilter.Q.value = 2.5;
    const clatterGain = ctx.createGain();
    clatterGain.gain.value = 0;
    this.loopNoise().connect(clatterFilter);
    clatterFilter.connect(clatterGain);
    clatterGain.connect(this.master);
    low.start();
    high.start();
    this.engine = { low, high, filter, gain, clatterFilter, clatterGain };

    // Tyre scrub.
    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = "bandpass";
    skidFilter.Q.value = 0.9;
    const skidGain = ctx.createGain();
    skidGain.gain.value = 0;
    this.loopNoise().connect(skidFilter);
    skidFilter.connect(skidGain);
    skidGain.connect(this.master);
    this.skid = { filter: skidFilter, gain: skidGain };

    // Wind rush / outback ambience.
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "lowpass";
    windFilter.frequency.value = 420;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.012;
    this.loopNoise().connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.master);
    this.wind = { filter: windFilter, gain: windGain };
  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start(0, Math.random() * 1.5);
    return src;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx)
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  /** Pause all sound (game paused / hidden). */
  suspend(): void {
    if (this.ctx?.state === "running") void this.ctx.suspend();
  }

  resume(): void {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  update(frame: AudioFrame): void {
    const ctx = this.ctx;
    if (!ctx || !this.engine || !this.skid || !this.wind) return;
    const now = ctx.currentTime;
    const e = this.engine;
    const rpm = frame.engineOn ? frame.rpm : 0;
    const base = 30 + rpm * 92;
    e.low.frequency.setTargetAtTime(base, now, 0.06);
    e.high.frequency.setTargetAtTime(base * 0.5, now, 0.06);
    e.filter.frequency.setTargetAtTime(260 + rpm * 1300 + frame.throttle * 500, now, 0.08);
    e.gain.gain.setTargetAtTime(
      frame.engineOn ? 0.035 + frame.throttle * 0.05 + rpm * 0.025 : 0,
      now,
      0.12,
    );
    e.clatterFilter.frequency.setTargetAtTime(base * 6, now, 0.08);
    e.clatterGain.gain.setTargetAtTime(
      frame.engineOn ? 0.01 + frame.throttle * 0.012 : 0,
      now,
      0.12,
    );

    const loose =
      frame.surface === "dirt" || frame.surface === "gravel" || frame.surface === "grass";
    this.skid.filter.frequency.setTargetAtTime(loose ? 650 : 1250, now, 0.1);
    const skid = Math.max(0, Math.min(0.14, (frame.slip - 1.2) * 0.035));
    this.skid.gain.gain.setTargetAtTime(skid, now, 0.07);

    this.wind.filter.frequency.setTargetAtTime(380 + Math.min(900, frame.speed * 28), now, 0.3);
    this.wind.gain.gain.setTargetAtTime(0.012 + Math.min(0.05, frame.speed * 0.0016), now, 0.3);
  }

  /** Short filtered noise burst with an exponential decay envelope. */
  private burst(
    type: BiquadFilterType,
    frequency: number,
    q: number,
    peak: number,
    decay: number,
    delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(t, Math.random() * 1.5, decay + 0.05);
  }

  /** Decaying sine thump. */
  private thump(frequency: number, peak: number, decay: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(frequency, t);
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.55, t + decay);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }

  footstep(surface: SurfaceKind, intensity: number): void {
    const [f, q, decay] = FOOTSTEP_BAND[surface];
    this.burst("bandpass", f * (0.9 + Math.random() * 0.2), q, 0.05 + intensity * 0.07, decay);
  }

  land(surface: SurfaceKind, speed: number): void {
    const [f, q] = FOOTSTEP_BAND[surface];
    this.burst("bandpass", f * 0.8, q, Math.min(0.25, 0.06 + speed * 0.03), 0.14);
  }

  door(open: boolean): void {
    if (open) {
      this.burst("bandpass", 2600, 3, 0.08, 0.05);
    } else {
      this.burst("lowpass", 240, 0.7, 0.28, 0.16);
      this.thump(95, 0.22, 0.14);
    }
  }

  impact(speed: number): void {
    const level = Math.min(1, speed / 12);
    this.burst("lowpass", 320 + level * 500, 0.8, 0.12 + level * 0.35, 0.3);
    this.thump(58, 0.15 + level * 0.3, 0.25);
    if (speed > 4) this.burst("bandpass", 3200, 2, 0.05 * level, 0.18, 0.02);
  }

  gate(raising: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(raising ? 110 : 160, t);
    osc.frequency.linearRampToValueAtTime(raising ? 165 : 115, t + 0.9);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 500;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.03, t + 0.1);
    gain.gain.linearRampToValueAtTime(0.0001, t + 1.1);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 1.15);
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.engine = null;
    this.skid = null;
    this.wind = null;
    if (ctx) void ctx.close();
  }
}
