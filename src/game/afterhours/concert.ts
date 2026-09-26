import { clamp, smoothstep } from "../core/math";
import { BAR_SECONDS } from "./composition";
import type { LayerId } from "./progress";

/**
 * The midnight concert: a 32-bar (~83 s) arrangement of the procedural
 * score. Everything — layer levels, the emissive accents, beams and sky —
 * is a function of the position on this one musical timeline, which the
 * audio layer schedules against the AudioContext clock.
 */

export const CONCERT = {
  bars: 32,
  /** Caption shown when the arrangement ends. */
  finalLine: "TRANSMISSION RECEIVED. SOURCE UNKNOWN.",
} as const;

export const CONCERT_SECONDS = CONCERT.bars * BAR_SECONDS;

export interface ConcertSection {
  id: "signal" | "groove" | "expand" | "melody" | "release";
  label: string;
  startBar: number;
}

export const CONCERT_SECTIONS: readonly ConcertSection[] = [
  { id: "signal", label: "Opening signal", startBar: 0 },
  { id: "groove", label: "Rhythm and bass enter", startBar: 4 },
  { id: "expand", label: "Harmony expands", startBar: 12 },
  { id: "melody", label: "Melody arrives", startBar: 20 },
  { id: "release", label: "Release", startBar: 28 },
];

export interface ConcertMix {
  reference: number;
  rhythm: number;
  bass: number;
  harmony: number;
  melody: number;
  /** Sky effect and beam strength (visuals). */
  sky: number;
  beams: number;
  /** Harmony filter opening 0..1 ("expands"). */
  bloom: number;
}

const ramp = (bar: number, from: number, to: number) => smoothstep(from, to, bar);

/** Layer levels at a (fractional) bar position. */
export function concertMix(bar: number, out: ConcertMix = createMix()): ConcertMix {
  const release = 1 - ramp(bar, 28, 31.5);
  out.reference = Math.max(
    1 - ramp(bar, 4, 6.5),
    0.45 * ramp(bar, 29, 30.5) * (1 - ramp(bar, 31, 32)),
  );
  out.rhythm = ramp(bar, 4, 4.6) * release;
  out.bass = ramp(bar, 4, 6) * release;
  out.harmony = (0.55 * ramp(bar, 12, 14) + 0.45 * ramp(bar, 16, 18)) * (1 - ramp(bar, 28, 32));
  out.melody = ramp(bar, 20, 21) * (1 - ramp(bar, 28, 30.5));
  out.bloom = ramp(bar, 12, 20) * (1 - ramp(bar, 28, 32));
  out.beams = Math.max(0.25 * ramp(bar, 0, 2), ramp(bar, 4, 8)) * (1 - ramp(bar, 29, 32));
  out.sky = (0.3 * ramp(bar, 12, 16) + 0.7 * ramp(bar, 20, 24)) * (1 - ramp(bar, 28, 32));
  return out;
}

export function createMix(): ConcertMix {
  return { reference: 0, rhythm: 0, bass: 0, harmony: 0, melody: 0, sky: 0, beams: 0, bloom: 0 };
}

export function sectionAt(bar: number): ConcertSection {
  let current = CONCERT_SECTIONS[0];
  for (const s of CONCERT_SECTIONS) if (bar >= s.startBar) current = s;
  return current;
}

export type ConcertState = "idle" | "running";

/**
 * Concert lifecycle. `position` is supplied by a clock (the audio clock
 * when sound is available, simulation time otherwise), so pausing freezes
 * the arrangement and the visuals together.
 */
export class ConcertLogic {
  state: ConcertState = "idle";
  /** Seconds into the arrangement. */
  position = 0;
  plays = 0;
  readonly mix = createMix();

  get bar(): number {
    return this.position / BAR_SECONDS;
  }

  get progress(): number {
    return clamp(this.position / CONCERT_SECONDS, 0, 1);
  }

  get section(): ConcertSection {
    return sectionAt(this.bar);
  }

  start(): boolean {
    if (this.state === "running") return false;
    this.state = "running";
    this.position = 0;
    this.plays++;
    concertMix(0, this.mix);
    return true;
  }

  /** Advance to `position` seconds. Returns true when the arrangement ends. */
  advance(position: number): boolean {
    if (this.state !== "running") return false;
    this.position = Math.max(this.position, position);
    concertMix(this.bar, this.mix);
    if (this.position >= CONCERT_SECONDS) {
      this.state = "idle";
      return true;
    }
    return false;
  }

  stop(): void {
    this.state = "idle";
    concertMix(0, this.mix);
    this.mix.reference = 0;
    this.mix.beams = 0;
  }

  layerLevel(layer: LayerId): number {
    return this.mix[layer];
  }
}
