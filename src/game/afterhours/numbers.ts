/**
 * The fictional Numbers Station. Each transmission is a list of spoken
 * cues rendered as captions (the visual equivalent) and as pip patterns
 * (four pips for "four", a long tone for "zero", a chirp for words). The
 * script changes with progression, so the station is where Frequency 420
 * is first heard.
 */

export type NumbersScript = "idle" | "clue" | "found" | "after";

const SCRIPTS: Record<NumbersScript, readonly string[]> = {
  idle: [
    "Attention.",
    "Seven.",
    "Three.",
    "Nine.",
    "Seven.",
    "Three.",
    "Nine.",
    "Coffee.",
    "End of transmission.",
  ],
  clue: [
    "Attention.",
    "Four.",
    "Two.",
    "Zero.",
    "Four.",
    "Two.",
    "Zero.",
    "Hold the dial.",
    "End of transmission.",
  ],
  found: [
    "Attention.",
    "Four terminals.",
    "Four layers.",
    "Follow the signal.",
    "End of transmission.",
  ],
  after: ["Attention.", "Transmission received.", "Source unknown.", "End of transmission."],
};

export const NUMBERS = {
  /** Seconds between cues, and the pause before a transmission repeats. */
  cueSpacing: 1.35,
  gap: 4.5,
} as const;

const DIGITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

/** Pips for a cue: a digit's count (0 → one long tone), or null for a chirp. */
export function pipsFor(cue: string): number | null {
  const word = cue.toLowerCase().replace(/[^a-z]/g, "");
  return word in DIGITS ? DIGITS[word] : null;
}

export interface NumbersCue {
  text: string;
  /** Accumulated caption for the current transmission. */
  line: string;
  pips: number | null;
  index: number;
}

export class NumbersStation {
  script: NumbersScript = "idle";
  private time = 0;
  private index = -1;
  private line = "";

  get cues(): readonly string[] {
    return SCRIPTS[this.script];
  }

  get period(): number {
    return this.cues.length * NUMBERS.cueSpacing + NUMBERS.gap;
  }

  setScript(script: NumbersScript): void {
    if (script === this.script) return;
    this.script = script;
    this.restart();
  }

  restart(): void {
    this.time = 0;
    this.index = -1;
    this.line = "";
  }

  /** Advance while tuned in; returns a cue when one is spoken this step. */
  update(dt: number): NumbersCue | null {
    this.time += dt;
    if (this.time >= this.period) {
      this.time -= this.period;
      this.index = -1;
      this.line = "";
    }
    const next = this.index + 1;
    if (next >= this.cues.length || this.time < next * NUMBERS.cueSpacing) return null;
    this.index = next;
    const text = this.cues[next];
    this.line = next === 0 ? text : `${this.line} ${text}`;
    return { text, line: this.line, pips: pipsFor(text), index: next };
  }
}
