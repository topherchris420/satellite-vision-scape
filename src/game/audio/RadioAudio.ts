/**
 * The physical vehicle radio, realised in Web Audio.
 *
 * One HTMLAudioElement streams the album (preload "none": a track is only
 * fetched when it is about to play) and is routed into the shared
 * AudioContext through a MediaElementAudioSourceNode created exactly once.
 * Because there is only one element and one source node, only one album
 * stream can ever play, whichever vehicle owns the radio.
 *
 *   album ─ source ─ albumGain ─ fx shelf ─┐
 *   numbers-station voice ─ numbersGain ───┤
 *   score (Frequency 420) ─ signalGain ────┼─ stationIn ─ power ─ duck ─ volume ─┬─ cabin ───────────────────▶ music bus
 *   static ─ bandpass ─ staticGain ────────┘                     (meter)         └─ lowpass ─ exterior ─ panner ─▶ music bus
 *
 * Inside the cab the radio is heard directly; outside, the exterior path is
 * positioned at the owning vehicle, attenuated with distance and muffled
 * unless a door is open. The two paths cross-fade smoothly.
 */

export type RadioPlaybackStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "buffering"
  | "blocked"
  | "error";

export interface RadioAudioFrame {
  /** The album should be playing now. */
  playAlbum: boolean;
  trackSrc: string;
  /** Seek request in seconds (consumed when applied). */
  seek: number | null;
  /** Station strengths on the dial (0..1). */
  albumLevel: number;
  numbersLevel: number;
  signalLevel: number;
  staticLevel: number;
  /** Radio switched on and owned by a vehicle. */
  power: boolean;
  /** Ducking multiplier (tuning sessions). */
  duck: number;
  /** Music volume 0..1. */
  volume: number;
  /** 1 seated in the owning vehicle … 0 outside it. */
  cabin: number;
  /** Largest door opening of the owning vehicle (0 shut … 1 open). */
  door: number;
  /** Radio position in the world (owning vehicle). */
  x: number;
  y: number;
  z: number;
  /** Altered Signal treatment of the album, 0 = clean. */
  fx: number;
  /** Seconds, for slow effect modulation. */
  time: number;
}

/** Headroom so a mastered track near 0 dBFS sits under the engine and effects. */
const RADIO_TRIM = 0.5;
const SMOOTH = 0.12;
const DOOR_CLOSED_CUTOFF = 750;
const DOOR_OPEN_CUTOFF = 7000;

export class RadioAudio {
  readonly element: HTMLAudioElement;
  status: RadioPlaybackStatus = "idle";
  /** Fired when a track finishes, fails to load, or playback is refused. */
  onEnded: (() => void) | null = null;
  onError: ((message: string) => void) | null = null;
  onStatus: ((status: RadioPlaybackStatus) => void) | null = null;

  private readonly ctx: AudioContext;
  private readonly source: MediaElementAudioSourceNode;
  private readonly albumGain: GainNode;
  private readonly fxShelf: BiquadFilterNode;
  readonly numbersIn: GainNode;
  readonly signalIn: GainNode;
  private readonly staticSource: AudioBufferSourceNode;
  private readonly staticFilter: BiquadFilterNode;
  private readonly staticGain: GainNode;
  private readonly stationIn: GainNode;
  private readonly power: GainNode;
  private readonly duck: GainNode;
  private readonly volume: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly cabin: GainNode;
  private readonly exteriorFilter: BiquadFilterNode;
  private readonly exterior: GainNode;
  private readonly panner: PannerNode;
  private readonly meterData: Float32Array<ArrayBuffer>;
  private readonly targets = new Map<AudioParam, number>();
  private pendingSeek: number | null = null;
  private wantPlay = false;
  private suspended = false;
  private hidden = false;
  private playRequest = 0;
  private disposed = false;
  private readonly listeners: [string, EventListener][] = [];

  constructor(ctx: AudioContext, destination: AudioNode, noise: AudioBuffer | null) {
    this.ctx = ctx;
    const el = new Audio();
    el.preload = "none";
    el.crossOrigin = "anonymous";
    this.element = el;
    this.source = ctx.createMediaElementSource(el);

    this.albumGain = ctx.createGain();
    this.albumGain.gain.value = 0;
    this.fxShelf = ctx.createBiquadFilter();
    this.fxShelf.type = "highshelf";
    this.fxShelf.frequency.value = 3500;
    this.fxShelf.gain.value = 0;
    this.numbersIn = ctx.createGain();
    this.numbersIn.gain.value = 0;
    this.signalIn = ctx.createGain();
    this.signalIn.gain.value = 0;
    this.staticGain = ctx.createGain();
    this.staticGain.gain.value = 0;
    this.staticFilter = ctx.createBiquadFilter();
    this.staticFilter.type = "bandpass";
    this.staticFilter.frequency.value = 2200;
    this.staticFilter.Q.value = 0.6;
    this.staticSource = ctx.createBufferSource();
    this.staticSource.buffer = noise;
    this.staticSource.loop = true;

    this.stationIn = ctx.createGain();
    this.power = ctx.createGain();
    this.power.gain.value = 0;
    this.duck = ctx.createGain();
    this.volume = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.meterData = new Float32Array(this.analyser.fftSize);
    this.cabin = ctx.createGain();
    this.cabin.gain.value = 0;
    this.exteriorFilter = ctx.createBiquadFilter();
    this.exteriorFilter.type = "lowpass";
    this.exteriorFilter.frequency.value = DOOR_CLOSED_CUTOFF;
    this.exterior = ctx.createGain();
    this.exterior.gain.value = 0;
    const panner = ctx.createPanner();
    panner.panningModel = "equalpower";
    panner.distanceModel = "inverse";
    panner.refDistance = 2.5;
    panner.rolloffFactor = 1.1;
    panner.maxDistance = 10000;
    this.panner = panner;

    this.source.connect(this.albumGain);
    this.albumGain.connect(this.fxShelf);
    this.fxShelf.connect(this.stationIn);
    this.numbersIn.connect(this.stationIn);
    this.signalIn.connect(this.stationIn);
    this.staticSource.connect(this.staticFilter);
    this.staticFilter.connect(this.staticGain);
    this.staticGain.connect(this.stationIn);
    this.stationIn.connect(this.power);
    this.power.connect(this.duck);
    this.duck.connect(this.volume);
    this.volume.connect(this.analyser);
    this.volume.connect(this.cabin);
    this.volume.connect(this.exteriorFilter);
    this.exteriorFilter.connect(this.exterior);
    this.exterior.connect(panner);
    this.cabin.connect(destination);
    panner.connect(destination);
    if (noise) this.staticSource.start();

    this.listen("playing", () => this.setStatus("playing"));
    this.listen("waiting", () => {
      if (this.wantPlay) this.setStatus("buffering");
    });
    this.listen("stalled", () => {
      if (this.wantPlay && this.status !== "playing") this.setStatus("buffering");
    });
    this.listen("pause", () => {
      if (this.status === "playing" || this.status === "buffering") this.setStatus("paused");
    });
    this.listen("loadedmetadata", () => this.applyPendingSeek());
    this.listen("ended", () => this.onEnded?.());
    this.listen("error", () => {
      const code = el.error?.code ?? 0;
      // An error after src was cleared on dispose is expected.
      if (this.disposed || !el.getAttribute("src")) return;
      this.wantPlay = false;
      this.setStatus("error");
      this.onError?.(code === 2 ? "network" : code === 4 ? "unsupported" : "decode");
    });
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private listen(type: string, fn: () => void): void {
    this.element.addEventListener(type, fn);
    this.listeners.push([type, fn]);
  }

  private readonly onVisibility = () => {
    this.hidden = document.hidden;
    this.reconcile();
  };

  private setStatus(status: RadioPlaybackStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus?.(status);
  }

  /** Seconds into the current track (element clock). */
  get currentTime(): number {
    return this.element.currentTime || 0;
  }

  get duration(): number {
    const d = this.element.duration;
    return Number.isFinite(d) ? d : 0;
  }

  /** RMS level of the radio output (0..~1), from a real-time analyser. */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.meterData);
    let sum = 0;
    for (let i = 0; i < this.meterData.length; i++) sum += this.meterData[i] * this.meterData[i];
    return Math.sqrt(sum / this.meterData.length);
  }

  /** Pause for a paused game (the context is suspended too). */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    this.reconcile();
  }

  /** Called from a user gesture after the browser refused playback. */
  retry(): void {
    if (this.status === "blocked" || this.status === "error") {
      this.setStatus("idle");
      this.reconcile();
    }
  }

  private applyPendingSeek(): void {
    if (this.pendingSeek === null) return;
    const t = this.pendingSeek;
    this.pendingSeek = null;
    try {
      const max = this.duration > 0 ? Math.max(0, this.duration - 0.5) : t;
      this.element.currentTime = Math.min(t, max);
    } catch {
      // Seeking before metadata can throw on some engines; retry on metadata.
      this.pendingSeek = t;
    }
  }

  private reconcile(): void {
    const el = this.element;
    const shouldPlay = this.wantPlay && !this.suspended && !this.hidden;
    if (!shouldPlay) {
      if (!el.paused) el.pause();
      return;
    }
    if (!el.paused || this.status === "blocked" || this.status === "error") return;
    const request = ++this.playRequest;
    if (this.status !== "playing") this.setStatus("loading");
    let result: Promise<void> | undefined;
    try {
      result = el.play();
    } catch {
      result = Promise.reject(new Error("play failed"));
    }
    result?.catch((error: unknown) => {
      // A newer request (or a deliberate pause) supersedes this one.
      if (request !== this.playRequest || !this.wantPlay) return;
      const name = error instanceof DOMException ? error.name : "";
      if (name === "AbortError") return;
      this.setStatus(name === "NotAllowedError" ? "blocked" : "error");
      if (name !== "NotAllowedError") this.onError?.("play");
    });
  }

  private target(param: AudioParam, value: number, tau = SMOOTH): void {
    const last = this.targets.get(param);
    if (last !== undefined && Math.abs(last - value) < 1e-4) return;
    this.targets.set(param, value);
    param.setTargetAtTime(value, this.ctx.currentTime, tau);
  }

  /** Apply one frame of radio state. */
  update(f: RadioAudioFrame): void {
    const el = this.element;
    // Source selection (only one track can ever be loaded).
    const src = new URL(f.trackSrc, window.location.href).href;
    if (el.src !== src) {
      el.src = f.trackSrc;
      this.pendingSeek = f.seek ?? 0;
      if (this.status === "error") this.setStatus("idle");
    } else if (f.seek !== null) {
      this.pendingSeek = f.seek;
      if (el.readyState >= 1) this.applyPendingSeek();
    }
    if (f.playAlbum !== this.wantPlay) {
      this.wantPlay = f.playAlbum;
      if (!f.playAlbum && (this.status === "loading" || this.status === "buffering"))
        this.setStatus("paused");
    }
    this.reconcile();
    if (el.readyState >= 1 && this.pendingSeek !== null) this.applyPendingSeek();

    const on = f.power ? 1 : 0;
    this.target(this.power.gain, on, 0.08);
    this.target(this.albumGain.gain, f.albumLevel);
    this.target(this.numbersIn.gain, f.numbersLevel);
    this.target(this.signalIn.gain, f.signalLevel);
    this.target(this.staticGain.gain, f.staticLevel * 0.09);
    this.target(this.duck.gain, f.duck, 0.25);
    this.target(this.volume.gain, f.volume * RADIO_TRIM, 0.05);
    this.target(this.cabin.gain, f.cabin, 0.2);
    const door = Math.min(1, Math.max(0, f.door));
    this.target(this.exterior.gain, (1 - f.cabin) * (0.55 + 0.4 * door), 0.2);
    this.target(
      this.exteriorFilter.frequency,
      DOOR_CLOSED_CUTOFF * Math.pow(DOOR_OPEN_CUTOFF / DOOR_CLOSED_CUTOFF, door),
      0.15,
    );
    // Altered Signal: a slow, shallow high-shelf "breath" on the album only.
    const shelf = f.fx > 0 ? -2.5 * f.fx * (0.5 + 0.5 * Math.sin((f.time * Math.PI * 2) / 16)) : 0;
    this.fxShelf.gain.value = shelf;
    const p = this.panner;
    if (p.positionX) {
      p.positionX.value = f.x;
      p.positionY.value = f.y;
      p.positionZ.value = f.z;
    } else {
      p.setPosition(f.x, f.y, f.z);
    }
  }

  /** A short burst of static through the radio (station changes). */
  squelch(): void {
    const ctx = this.ctx;
    const buffer = this.staticSource.buffer;
    if (!buffer) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 2600;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.stationIn);
    src.onended = () => gain.disconnect();
    src.start(t, Math.random(), 0.3);
  }

  dispose(): void {
    this.disposed = true;
    this.wantPlay = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    for (const [type, fn] of this.listeners) this.element.removeEventListener(type, fn);
    this.listeners.length = 0;
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
    try {
      this.staticSource.stop();
    } catch {
      // Never started (no noise buffer).
    }
    for (const node of [
      this.source,
      this.albumGain,
      this.fxShelf,
      this.numbersIn,
      this.signalIn,
      this.staticSource,
      this.staticFilter,
      this.staticGain,
      this.stationIn,
      this.power,
      this.duck,
      this.volume,
      this.analyser,
      this.cabin,
      this.exteriorFilter,
      this.exterior,
      this.panner,
    ]) {
      node.disconnect();
    }
    this.targets.clear();
  }
}
