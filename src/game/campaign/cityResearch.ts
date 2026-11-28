import type { Verdict } from "./sanFierro";

export interface ResearchCase {
  id: number;
  title: string;
  unlock: string;
  claim: string;
  hyp: readonly string[];
  prior: readonly number[];
  margin: number;
  cards: readonly {
    text: string;
    source: string;
    src: number;
    w: readonly number[];
    kind: string;
  }[];
  tests: readonly {
    label: string;
    hours: number;
    result: string;
    w: readonly number[];
    informative: boolean;
  }[];
  truth: Verdict;
  news: { good: string; bad: string };
}
export type Audit = "careful" | "sloppy" | "retracted" | "cautious";

export function canResearch(c: ResearchCase, episodes: number, concluded: number) {
  return c.unlock === "five" ? concluded >= 5 : episodes >= Number(c.unlock.slice(5));
}

export function researchScores(c: ResearchCase, selected: readonly number[], trial: number | null) {
  return c.prior.map(
    (prior, axis) =>
      selected.reduce((sum, index) => sum + c.cards[index].w[axis], prior) +
      (trial === null ? 0 : c.tests[trial].w[axis]),
  );
}

export function recommend(c: ResearchCase, scores: readonly number[]): Verdict {
  const margin = scores[0] - Math.max(...scores.slice(1));
  if (margin >= c.margin) return "accept";
  if (margin <= -c.margin) return "reject";
  return "abstain";
}

export function auditResearch(
  c: ResearchCase,
  selected: readonly number[],
  trial: number | null,
  verdict: Verdict,
): Audit {
  if (verdict === "abstain" && c.truth !== "abstain") return "cautious";
  if (verdict !== c.truth) return "retracted";
  const clean =
    selected.every((i) => c.cards[i].kind === "evidence") &&
    new Set(selected.map((i) => c.cards[i].src)).size === selected.length;
  return clean &&
    trial !== null &&
    c.tests[trial].informative &&
    recommend(c, researchScores(c, selected, trial)) === verdict
    ? "careful"
    : "sloppy";
}

export const MODES = [170, 340, 442, 578, 850, 986] as const;
export const HUM = [60, 120, 180] as const;
/** Stability under a switched-off generator identifies the background hum. */
export function rigReading(hz: number, on: boolean) {
  const mode = MODES.find((f) => Math.abs(f - hz) <= 3);
  if (on && mode !== undefined) return { kind: "mode", hz: mode } as const;
  const hum = HUM.find((f) => Math.abs(f - hz) <= 3);
  if (hum !== undefined) return { kind: on ? "hum" : "control", hz: hum } as const;
  return { kind: "flat", hz } as const;
}
