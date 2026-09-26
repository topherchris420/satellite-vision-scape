import { clamp, smoothstep } from "../core/math";
import type { StationId } from "./progress";
import { GREEN_MACHINE, type SoundtrackTrack } from "./soundtrack";

/**
 * Vehicle radio logic: power, the receiver dial, preset stations, the album
 * playlist position and which vehicle owns the (single) active radio. It is
 * renderer- and audio-agnostic; `RadioAudio` realises this state in Web
 * Audio, and headless tests drive it directly.
 *
 * Every station is fictional apart from the recordings it plays.
 */

export type StationKind = "album" | "numbers" | "signal";

export interface StationDef {
  id: StationId;
  label: string;
  /** Dial position in the receiver's fictional units. */
  frequency: number;
  kind: StationKind;
  /** Hidden from preset cycling until discovered. */
  hidden: boolean;
}

export const STATIONS: readonly StationDef[] = [
  {
    id: "indigo",
    label: "christopher woodyard (live)",
    frequency: 367.5,
    kind: "album",
    hidden: false,
  },
  { id: "numbers", label: "Numbers Station", frequency: 318.0, kind: "numbers", hidden: false },
  { id: "f420", label: "Frequency 420", frequency: 420.0, kind: "signal", hidden: true },
];

export const RADIO = {
  dialMin: 300,
  dialMax: 450,
  /** ± dial units over which a station fades in from static. */
  captureWidth: 2.2,
  /** ± dial units counted as holding a channel. */
  lockWidth: 0.4,
  /** Seconds the receiver must hold 420 to acquire it. */
  holdSeconds: 3,
  /** Dial step for a single tap of [ / ]. */
  tapStep: 0.5,
  /** Sweep rates while a tune key is held (units per second). */
  sweepSlow: 6,
  sweepFast: 26,
  /** Held longer than this, a sweep accelerates. */
  sweepAccelerateAfter: 1.1,
  /** A held key starts sweeping after this long (a tap only steps). */
  sweepDelay: 0.3,
  volumeStep: 0.1,
  /** "Previous" restarts the track when this far in. */
  restartThreshold: 3,
} as const;

export function stationById(id: StationId): StationDef {
  return STATIONS.find((s) => s.id === id) ?? STATIONS[0];
}

/** 1 exactly on a station, falling smoothly to 0 at the capture edge. */
export function signalStrength(frequency: number, stationFrequency: number): number {
  const d = Math.abs(frequency - stationFrequency);
  return 1 - smoothstep(RADIO.lockWidth * 0.5, RADIO.captureWidth, d);
}

export type RadioEvent =
  | { type: "ident"; station: StationDef; track: SoundtrackTrack | null }
  | { type: "track"; track: SoundtrackTrack; automatic: boolean }
  | { type: "power"; on: boolean }
  | { type: "owner"; ownerId: string | null; previous: string | null }
  | { type: "f420Discovered" }
  | { type: "volume"; volume: number };

export class RadioLogic {
  power = false;
  frequency: number = STATIONS[0].frequency;
  volume = 0.7;
  trackIndex = 0;
  /** Seconds into the current track. Authoritative only without audio. */
  position = 0;
  /** Vehicle id that owns the active radio (at most one). */
  ownerId: string | null = null;
  /** 420 is transmitting (after the coffee reward). */
  f420Transmitting = false;
  f420Discovered = false;
  /** 0..1 progress of holding the receiver on 420. */
  holdProgress = 0;
  /** Station currently captured by the dial, and its strength. */
  station: StationDef | null = STATIONS[0];
  strength = 1;
  /** A seek the audio layer should apply (restored positions, restarts). */
  seekRequest: number | null = 0;

  onEvent: ((e: RadioEvent) => void) | null = null;

  private lastIdent: StationId | null = null;
  private tuneHeld = 0;
  private tuneDirection = 0;

  get track(): SoundtrackTrack {
    return GREEN_MACHINE.tracks[this.trackIndex];
  }

  /** The album is audible on the dial right now. */
  get albumTuned(): boolean {
    return this.power && this.station?.kind === "album" && this.strength > 0.02;
  }

  private emit(e: RadioEvent): void {
    this.onEvent?.(e);
  }

  /** Stations offered by preset cycling (420 once discovered). */
  presets(): StationDef[] {
    return STATIONS.filter((s) => !s.hidden || (s.id === "f420" && this.f420Discovered));
  }

  restore(stationId: StationId, trackIndex: number, position: number): void {
    const station = stationById(stationId);
    this.frequency =
      station.id === "f420" && !this.f420Discovered ? STATIONS[0].frequency : station.frequency;
    this.trackIndex = clamp(Math.round(trackIndex), 0, GREEN_MACHINE.tracks.length - 1);
    this.position = Math.max(0, position);
    this.seekRequest = this.position;
    this.capture();
    this.lastIdent = this.station?.id ?? null;
  }

  setPower(on: boolean): void {
    if (this.power === on) return;
    this.power = on;
    this.emit({ type: "power", on });
    this.capture();
    this.announce(true);
  }

  togglePower(): void {
    this.setPower(!this.power);
  }

  /** Transfer the one active radio to another vehicle (or none). */
  claim(ownerId: string | null): void {
    if (this.ownerId === ownerId) return;
    const previous = this.ownerId;
    this.ownerId = ownerId;
    this.emit({ type: "owner", ownerId, previous });
  }

  setVolume(volume: number): void {
    const v = Math.round(clamp(volume, 0, 1) * 100) / 100;
    if (v === this.volume) return;
    this.volume = v;
    this.emit({ type: "volume", volume: v });
  }

  selectStation(id: StationId): void {
    const station = stationById(id);
    if (station.hidden && !(station.id === "f420" && this.f420Discovered)) return;
    this.frequency = station.frequency;
    this.capture();
    if (!this.power) {
      this.power = true;
      this.emit({ type: "power", on: true });
    }
    this.announce(true);
  }

  /** Jump to the next (or previous) preset. */
  cycleStation(direction: 1 | -1 = 1): void {
    const presets = this.presets();
    const current = presets.findIndex((s) => s.id === this.station?.id && this.strength > 0.5);
    const base = current >= 0 ? current : direction > 0 ? -1 : 0;
    const next = presets[(base + direction + presets.length) % presets.length];
    this.selectStation(next.id);
  }

  /** Nudge the dial by a number of units. */
  tune(delta: number): void {
    this.frequency = clamp(this.frequency + delta, RADIO.dialMin, RADIO.dialMax);
    this.capture();
  }

  /** One click of the dial (a key press or a tap), however short. */
  tuneStep(direction: number): void {
    const dir = Math.sign(direction);
    if (dir !== 0) this.tune(dir * RADIO.tapStep);
  }

  /**
   * Continuous tuning while a control is held: after `sweepDelay` the dial
   * sweeps, then accelerates. Presses themselves step via `tuneStep`, so a
   * tap shorter than a frame is never lost. `direction` is −1, 0 or +1.
   */
  tuneHold(direction: number, dt: number): void {
    const dir = Math.sign(direction);
    if (dir === 0) {
      this.tuneHeld = 0;
      this.tuneDirection = 0;
      return;
    }
    if (dir !== this.tuneDirection) {
      this.tuneDirection = dir;
      this.tuneHeld = 0;
      return;
    }
    this.tuneHeld += dt;
    if (this.tuneHeld < RADIO.sweepDelay) return;
    const rate = this.tuneHeld > RADIO.sweepAccelerateAfter ? RADIO.sweepFast : RADIO.sweepSlow;
    this.tune(dir * rate * dt);
  }

  nextTrack(automatic = false): void {
    this.setTrack((this.trackIndex + 1) % GREEN_MACHINE.tracks.length, automatic);
  }

  previousTrack(): void {
    if (this.position > RADIO.restartThreshold) {
      this.position = 0;
      this.seekRequest = 0;
      return;
    }
    const n = GREEN_MACHINE.tracks.length;
    this.setTrack((this.trackIndex - 1 + n) % n, false);
  }

  setTrack(index: number, automatic = false): void {
    this.trackIndex = clamp(index, 0, GREEN_MACHINE.tracks.length - 1);
    this.position = 0;
    this.seekRequest = 0;
    this.emit({ type: "track", track: this.track, automatic });
  }

  /** Record the audio element's real position (audio present). */
  syncPosition(seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 0) this.position = seconds;
  }

  /**
   * Advance by simulation time. Without audio (`simulatePlayback`), the
   * album position advances here so progression and persistence behave the
   * same whether or not sound is available.
   */
  update(dt: number, simulatePlayback: boolean): void {
    this.capture();
    if (simulatePlayback && this.albumTuned) {
      this.position += dt;
      if (this.position >= this.track.durationSeconds) this.nextTrack(true);
    }
    this.announce(false);

    // Holding the dial on 420 acquires the hidden channel.
    if (!this.f420Discovered) {
      const on =
        this.power &&
        this.f420Transmitting &&
        Math.abs(this.frequency - stationById("f420").frequency) <= RADIO.lockWidth;
      this.holdProgress = on
        ? Math.min(1, this.holdProgress + dt / RADIO.holdSeconds)
        : Math.max(0, this.holdProgress - dt / (RADIO.holdSeconds * 0.5));
      if (this.holdProgress >= 1) {
        this.f420Discovered = true;
        this.holdProgress = 1;
        this.emit({ type: "f420Discovered" });
        this.capture();
        this.announce(true);
      }
    }
  }

  /** Which station the dial is on (420 only while it transmits). */
  private capture(): void {
    let best: StationDef | null = null;
    let bestStrength = 0;
    for (const s of STATIONS) {
      if (s.id === "f420" && !this.f420Transmitting && !this.f420Discovered) continue;
      const strength = signalStrength(this.frequency, s.frequency);
      if (strength > bestStrength) {
        best = s;
        bestStrength = strength;
      }
    }
    this.station = best;
    this.strength = bestStrength;
  }

  /** Brief station identification when the captured station changes. */
  private announce(force: boolean): void {
    const id = this.power && this.station && this.strength > 0.5 ? this.station.id : null;
    if (!force && id === this.lastIdent) return;
    this.lastIdent = id;
    if (!id || !this.station) return;
    this.emit({
      type: "ident",
      station: this.station,
      track: this.station.kind === "album" ? this.track : null,
    });
  }
}
