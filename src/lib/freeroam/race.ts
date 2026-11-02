import type { GhostRow } from "./ghost";

/**
 * Racing a recorded run: the numbers and nothing else. A race target is derived
 * from a committed trace (`scripts/build-race-target.ts`; a test holds the two
 * together), so whatever the game says Jev did can be checked against the
 * evidence. No model is called while racing, and nothing here touches the world.
 */

export interface RaceTarget {
  id: string;
  challenge: string;
  seed: number;
  /** Who set the time, as shown to the player. */
  label: string;
  model: string | null;
  /** Calendar date of the recording (YYYY-MM-DD). */
  recordedOn: string;
  /** The committed trace this was derived from. */
  trace: string;
  elapsedS: number;
  /** Elapsed seconds at the end of each stage; the last one is the finish. */
  splitsS: number[];
  /** What each stage is called in the trace. */
  stages: string[];
  /** Other committed runs of this seed. One recording is one run, not a measure of the model. */
  alsoRecordedS: number[];
  decisions: number;
  collisions: number;
  distanceDrivenM: number;
  /** `[seconds, x, z, driving]`, four times a second. */
  rows: RaceRow[];
}

export type RaceRow = readonly [seconds: number, x: number, z: number, driving: 0 | 1];

const round = (value: number, places: number) => Number(value.toFixed(places));

/** The fields of a `svs-freeroam-trace/v1` file a race target is built from. */
export interface RaceSourceTrace {
  seed: number;
  challenge: string;
  startedAt: string;
  sampleFormat: readonly string[];
  samples: readonly (readonly unknown[])[];
  events: readonly { t: number; type: string; data?: Record<string, unknown> }[];
  decisions: readonly { model?: string }[];
  result: { status: string; elapsedS: number };
  summary: {
    title: string;
    control: { decisions: number };
    driving: { vehicleCollisions: number; worldCollisions: number; pedestrianCollisions: number };
    navigation: { distanceDrivenM: number };
  };
}

export function deriveRaceTarget(trace: RaceSourceTrace, path: string, label: string, others: readonly RaceSourceTrace[] = []): RaceTarget {
  if (trace.result.status !== "success") throw new Error("A race target must be a completed run.");
  const column = (name: string) => {
    const i = trace.sampleFormat.indexOf(name);
    if (i < 0) throw new Error(`Trace samples have no ${name} column.`);
    return i;
  };
  const [t, x, z, locomotion] = [column("t"), column("x"), column("z"), column("locomotion")];
  // Stage starts after the first are the moments the stage before them ended.
  const stageEvents = trace.events.filter((e) => e.type === "stage" && typeof e.data?.index === "number");
  const starts = stageEvents.filter((e) => (e.data?.index as number) > 0).map((e) => round(e.t / 1000, 2));
  const d = trace.summary.driving;
  return {
    id: `${trace.challenge}-${label.toLowerCase()}-${trace.startedAt.slice(0, 10)}`,
    challenge: trace.challenge,
    seed: trace.seed,
    label,
    model: trace.decisions.find((decision) => decision.model)?.model ?? null,
    recordedOn: trace.startedAt.slice(0, 10),
    trace: path,
    elapsedS: trace.result.elapsedS,
    splitsS: [...starts, trace.result.elapsedS],
    stages: stageEvents.map((e) => String(e.data?.id)),
    alsoRecordedS: others
      .filter((o) => o.seed === trace.seed && o.challenge === trace.challenge && o.result.status === "success")
      .map((o) => o.result.elapsedS),
    decisions: trace.summary.control.decisions,
    collisions: d.vehicleCollisions + d.worldCollisions + d.pedestrianCollisions,
    distanceDrivenM: trace.summary.navigation.distanceDrivenM,
    rows: trace.samples.map((row) => [
      row[t] as number,
      row[x] as number,
      row[z] as number,
      row[locomotion] === "driving" ? 1 : 0,
    ]),
  };
}

/** Rows in the form the ghost draws from. */
export function ghostRows(target: RaceTarget): readonly GhostRow[] {
  return target.rows;
}

/** `1:44.5`: a tenth of a second is what a race is decided by. */
export function formatRaceTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths - minutes * 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** `-4.5 s` ahead of the target, `+1.2 s` behind it. */
export function formatDelta(seconds: number): string {
  const tenths = Math.round(Math.abs(seconds) * 10) / 10;
  if (tenths === 0) return "±0.0 s";
  return `${seconds < 0 ? "−" : "+"}${tenths.toFixed(1)} s`;
}

/** The plain sentence for a finished race. Numbers and their difference; the reader can draw the conclusion. */
export function raceVerdict(you: number, target: RaceTarget): string {
  const gap = you - target.elapsedS;
  const amount = Math.abs(gap).toFixed(1);
  if (Math.abs(gap) < 0.05) return `Dead level with ${target.label}'s recorded run.`;
  return gap < 0
    ? `${amount} s faster than ${target.label}'s recorded run.`
    : `${amount} s behind ${target.label}'s recorded run.`;
}

export interface RaceSplit {
  stage: number;
  youS: number;
  targetS: number;
  deltaS: number;
}

export function splitAt(stage: number, youS: number, target: RaceTarget): RaceSplit | null {
  const targetS = target.splitsS[stage];
  if (targetS === undefined) return null;
  return { stage, youS, targetS, deltaS: youS - targetS };
}

// --- The live gap ---------------------------------------------------------------------------------

const GAP_BEHIND = 8;
const GAP_AHEAD = 48;
const OFF_LINE_M = 30;

export interface RaceGap {
  /** Seconds behind (+) or ahead of (-) the target at this spot; null when not on its line. */
  gapS: number | null;
  /** Pass back as `hint` on the next call. */
  index: number;
}

function nearest(rows: readonly RaceRow[], from: number, to: number, x: number, z: number): { index: number; d2: number } {
  let index = from;
  let d2 = Infinity;
  for (let i = from; i <= to; i++) {
    const dx = rows[i][1] - x;
    const dz = rows[i][2] - z;
    const d = dx * dx + dz * dz;
    if (d < d2) {
      d2 = d;
      index = i;
    }
  }
  return { index, d2 };
}

/**
 * When the target was at this spot, compared with now. It looks near where the
 * player last matched, so a road the recording used twice is not mistaken for
 * its later lap, and only searches further ahead after leaving the line.
 */
export function gapAt(target: RaceTarget, x: number, z: number, tS: number, hint: number): RaceGap {
  const rows = target.rows;
  const last = rows.length - 1;
  const limit = OFF_LINE_M * OFF_LINE_M;
  let found = nearest(rows, Math.max(0, hint - GAP_BEHIND), Math.min(last, hint + GAP_AHEAD), x, z);
  if (found.d2 > limit) found = nearest(rows, Math.min(last, hint), last, x, z);
  if (found.d2 > limit) return { gapS: null, index: hint };
  return { gapS: tS - rows[found.index][0], index: found.index };
}

// --- Links ------------------------------------------------------------------------------------------

/** The longest time a shared link may claim; the challenge's own limit is 15 minutes. */
const MAX_SHARED_SECONDS = 15 * 60;

export interface RaceLink {
  /** Start on the race rather than the free-roam default. */
  race: true;
  /** A time someone else says they set. Client-reported: shown as a claim, never as a record. */
  sharedS: number | null;
}

/** Reads `?race=1&beat=91.2`. Anything malformed is ignored rather than trusted. */
export function parseRaceLink(search: string): RaceLink | null {
  const params = new URLSearchParams(search);
  if (!params.has("race")) return null;
  const beat = Number(params.get("beat"));
  const valid = params.has("beat") && Number.isFinite(beat) && beat > 0 && beat <= MAX_SHARED_SECONDS;
  return { race: true, sharedS: valid ? round(beat, 1) : null };
}

export function raceLink(origin: string, seconds: number): string {
  return `${origin}/?race=1&beat=${seconds.toFixed(1)}`;
}
