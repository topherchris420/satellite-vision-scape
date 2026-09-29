/**
 * Seeded randomness for the Free Roam simulation.
 *
 * Nothing that decides what happens in the world may use `Math.random` or the
 * clock: a scenario is a seed, and the same seed must build the same world
 * and, given the same controls, play out the same way. These generators use
 * only 32-bit integer arithmetic, so results are identical on every engine.
 */

/** FNV-1a 32-bit hash of a string. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Derive an independent seed for a named part of the world (pedestrians, traffic…). */
export function deriveSeed(seed: number, label: string): number {
  return (hashString(label) ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0;
}

/** mulberry32: small, fast, good enough for gameplay. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RandomStream {
  private readonly next: () => number;

  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Approximately normal (sum of uniforms), mean 0, standard deviation 1. */
  gaussian(): number {
    let s = 0;
    for (let i = 0; i < 6; i++) s += this.next();
    return (s - 3) * Math.SQRT2;
  }

  /** A new independent stream, derived from this one's seed and a label. */
  fork(label: string): RandomStream {
    return new RandomStream(deriveSeed(this.seed, label));
  }
}

/** Order-sensitive FNV-1a over a list of numbers, quantised to millimetres. */
export class StateHasher {
  private h = 0x811c9dc5;

  add(value: number): this {
    const q = Math.round(value * 1000) | 0;
    this.h = Math.imul(this.h ^ (q & 0xff), 0x01000193);
    this.h = Math.imul(this.h ^ ((q >>> 8) & 0xff), 0x01000193);
    this.h = Math.imul(this.h ^ ((q >>> 16) & 0xff), 0x01000193);
    this.h = Math.imul(this.h ^ ((q >>> 24) & 0xff), 0x01000193);
    return this;
  }

  addText(text: string): this {
    for (let i = 0; i < text.length; i++)
      this.h = Math.imul(this.h ^ text.charCodeAt(i), 0x01000193);
    return this;
  }

  hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, "0");
  }
}
