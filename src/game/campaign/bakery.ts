import type { Verdict } from "./sanFierro";

export const BAKERY_KEY = "99sure.city.bakery.v1";
export const CLAIMS = [
  {
    id: 3,
    text: "The van is carrying dangerous cargo.",
    supported: "reject",
    finding: "The driver and signed receipt identify bread for the community kitchen.",
  },
  {
    id: 4,
    text: "The delivery reached Harbor Table.",
    supported: "accept",
    finding: "You observed the arrival. The kitchen independently signed for the delivery.",
  },
] as const;

export type BakerySave =
  | { checkpoint: "briefing" | "departure" | "return" }
  | { checkpoint: "report"; cargo: Verdict | null }
  | { checkpoint: "filed"; cargo: Verdict; delivery: Verdict };
/** Committed steps, including the point between the two first-answer decisions. */
export function bakeryStep(record: BakerySave) {
  switch (record.checkpoint) {
    case "briefing":
      return 0;
    case "departure":
      return 1;
    case "return":
      return 2;
    case "report":
      return record.cargo === null ? 3 : 4;
    case "filed":
      return 5;
  }
}
const verdict = (v: unknown): v is Verdict => v === "accept" || v === "reject" || v === "abstain";

export function parseBakery(raw: string | null): BakerySave {
  try {
    const v = JSON.parse(raw ?? "null");
    if (v?.version === 1) {
      if (v.checkpoint === "filed" && verdict(v.cargo) && verdict(v.delivery))
        return { checkpoint: "filed", cargo: v.cargo, delivery: v.delivery };
      if (v.checkpoint === "report" && (v.cargo === null || verdict(v.cargo)))
        return { checkpoint: "report", cargo: v.cargo };
      if (v.checkpoint === "departure" || v.checkpoint === "return")
        return { checkpoint: v.checkpoint };
    }
  } catch {
    /* Start fresh when the record cannot be read. */
  }
  return { checkpoint: "briefing" };
}

export function fileAnswer(save: BakerySave, id: number, answer: Verdict): BakerySave {
  if (save.checkpoint !== "report" || !verdict(answer)) return save;
  if (id === 3 && save.cargo === null) return { checkpoint: "report", cargo: answer };
  if (id === 4 && save.cargo !== null)
    return { checkpoint: "filed", cargo: save.cargo, delivery: answer };
  return save;
}

export function bakeryScore(cargo: Verdict, delivery: Verdict) {
  const first = cargo === CLAIMS[0].supported ? 10 : 0;
  return Math.max(0, first + (delivery === CLAIMS[1].supported ? 10 : -5));
}

export type Tail = { reading: number; lostSeconds: number };
export const freshTail = (): Tail => ({ reading: 0, lostSeconds: 0 });

/** One simulation step. Fractional points carry across frames and short gaps. */
export function sampleDelivery(
  tail: Tail,
  dt: number,
  gap: number,
  inWagon: boolean,
  arrived: boolean,
  stopped: boolean,
) {
  tail.lostSeconds = gap > 140 ? tail.lostSeconds + dt : 0;
  const observing = inWagon && (arrived ? gap < 30 && stopped : gap >= 15 && gap <= 60);
  if (observing) tail.reading = Math.min(100, tail.reading + dt / (arrived ? 0.12 : 0.42));
  return { lost: tail.lostSeconds > 9, complete: arrived && observing && tail.reading >= 100 };
}
