import type { LayerId } from "./progress";

/**
 * The procedural score used by the antenna puzzle, Frequency 420 and the
 * midnight concert. It is generated in-game and is not part of Green
 * Machine.
 *
 * Every layer follows one four-bar chord grid on one clock, and every note
 * is drawn from that bar's chord or from the A-minor pentatonic scale that
 * sits over all four chords, so any subset of layers sounds coherent.
 */

export const TEMPO = { bpm: 92, beatsPerBar: 4 } as const;
export const BEAT_SECONDS = 60 / TEMPO.bpm;
export const BAR_SECONDS = BEAT_SECONDS * TEMPO.beatsPerBar;

export interface Chord {
  name: string;
  /** Bass root (MIDI). */
  root: number;
  /** Fifth above the root, for the bass line (MIDI). */
  fifth: number;
  /** Pad voicing (MIDI). */
  pad: readonly number[];
}

/** i – VI – III – VII in A minor, voiced without the leading tone. */
export const CHORDS: readonly Chord[] = [
  { name: "Am7", root: 45, fifth: 52, pad: [57, 60, 64, 67] },
  { name: "Fmaj7", root: 41, fifth: 48, pad: [53, 57, 60, 64] },
  { name: "Cadd9", root: 48, fifth: 55, pad: [52, 55, 60, 62] },
  { name: "G6sus2", root: 43, fifth: 50, pad: [55, 57, 62, 64] },
];

/** A minor pentatonic pitch classes (A C D E G). */
export const PENTATONIC = [9, 0, 2, 4, 7] as const;

export type Voice = "kick" | "hat" | "rim" | "bass" | "pad" | "lead" | "click";

export interface NoteEvent {
  layer: LayerId | "reference";
  voice: Voice;
  /** Beat offset within the bar. */
  beat: number;
  /** Length in beats. */
  length: number;
  /** MIDI note (ignored by unpitched voices). */
  midi: number;
  velocity: number;
}

const RHYTHM: readonly NoteEvent[] = [
  { layer: "rhythm", voice: "kick", beat: 0, length: 0.5, midi: 0, velocity: 1 },
  { layer: "rhythm", voice: "kick", beat: 2, length: 0.5, midi: 0, velocity: 0.85 },
  { layer: "rhythm", voice: "kick", beat: 2.75, length: 0.25, midi: 0, velocity: 0.45 },
  { layer: "rhythm", voice: "rim", beat: 1, length: 0.25, midi: 0, velocity: 0.7 },
  { layer: "rhythm", voice: "rim", beat: 3, length: 0.25, midi: 0, velocity: 0.75 },
  ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map(
    (beat): NoteEvent => ({
      layer: "rhythm",
      voice: "hat",
      beat,
      length: 0.25,
      midi: 0,
      velocity: beat % 1 === 0 ? 0.55 : 0.35,
    }),
  ),
];

/** Four bars of melody (bar index, beat, length, MIDI). */
const MELODY: readonly [number, number, number, number][] = [
  [0, 0, 1.5, 76],
  [0, 1.5, 0.5, 74],
  [0, 2, 1, 72],
  [0, 3, 1, 69],
  [1, 0.5, 1, 72],
  [1, 1.5, 0.5, 69],
  [1, 2, 1, 67],
  [1, 3, 1, 69],
  [2, 0, 1, 76],
  [2, 1, 1, 79],
  [2, 2, 0.5, 76],
  [2, 2.5, 1.5, 74],
  [3, 0, 1, 74],
  [3, 1, 0.5, 76],
  [3, 1.5, 0.5, 74],
  [3, 2, 2, 69],
];

export function chordAt(bar: number): Chord {
  return CHORDS[((bar % CHORDS.length) + CHORDS.length) % CHORDS.length];
}

/** Every note a layer plays in `bar` (bar numbers run from the score's start). */
export function notesFor(layer: LayerId | "reference", bar: number): NoteEvent[] {
  const chord = chordAt(bar);
  switch (layer) {
    case "rhythm":
      return RHYTHM.slice();
    case "bass":
      return [
        { layer, voice: "bass", beat: 0, length: 1.4, midi: chord.root, velocity: 1 },
        { layer, voice: "bass", beat: 1.5, length: 0.45, midi: chord.root, velocity: 0.7 },
        { layer, voice: "bass", beat: 2.5, length: 0.9, midi: chord.fifth, velocity: 0.8 },
        { layer, voice: "bass", beat: 3.5, length: 0.45, midi: chord.root + 12, velocity: 0.6 },
      ];
    case "harmony":
      return chord.pad.map((midi) => ({
        layer,
        voice: "pad" as const,
        beat: 0,
        length: TEMPO.beatsPerBar,
        midi,
        velocity: 0.8,
      }));
    case "melody": {
      const phrase = ((bar % 4) + 4) % 4;
      return MELODY.filter(([b]) => b === phrase).map(([, beat, length, midi]) => ({
        layer,
        voice: "lead" as const,
        beat,
        length,
        midi,
        velocity: 0.8,
      }));
    }
    case "reference":
      // A steady pulse on every beat: the "opening signal" and the tuning reference.
      return [0, 1, 2, 3].map((beat) => ({
        layer,
        voice: "click" as const,
        beat,
        length: 0.2,
        midi: 81,
        velocity: beat === 0 ? 1 : 0.6,
      }));
  }
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Pitch classes that are consonant in `bar`: the chord tones plus the pentatonic scale. */
export function consonantPitchClasses(bar: number): Set<number> {
  const set = new Set<number>(PENTATONIC);
  for (const n of chordAt(bar).pad) set.add(n % 12);
  set.add(chordAt(bar).root % 12);
  return set;
}
