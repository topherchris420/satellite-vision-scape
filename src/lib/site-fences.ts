import {
  fencePath,
  topEnclosurePath,
  campusBoundaryPath,
  roadPath,
  interiorRoads,
  dirtTracks,
} from "./site-layout";

/**
 * Fence runs, openings and barrier sites derived from the traced layout.
 *
 * The traced fences are closed loops, while the traced roads and tracks cross
 * them. Wherever a corridor crosses a fence steeply the fence gets an opening
 * sized to the corridor, and a boom barrier is placed there. Shallow overlaps
 * (a road running alongside a fence within the tracing tolerance) leave the
 * fence intact, so the solid geometry always matches what is drawn.
 *
 * Openings are an inference from the public overhead image (a road cannot
 * pass through a fence); they do not describe real access arrangements.
 */

export type Point2 = [number, number];

export type FenceDefinition = { id: string; path: Point2[] };

export const FENCES: FenceDefinition[] = [
  { id: "perimeter-fence", path: fencePath },
  { id: "top-enclosure-fence", path: topEnclosurePath },
  { id: "campus-boundary", path: campusBoundaryPath },
];

export type CorridorKind = "road" | "track";
export type Corridor = { path: Point2[]; halfWidth: number; kind: CorridorKind };

/** Carriageway half-widths match the ribbons drawn by the Roads component. */
export const CORRIDORS: Corridor[] = [
  { path: roadPath, halfWidth: 3, kind: "road" },
  ...interiorRoads.map((path): Corridor => ({ path, halfWidth: 2.5, kind: "road" })),
  ...dirtTracks.map((path): Corridor => ({ path, halfWidth: 2, kind: "track" })),
];

/** Crossings shallower than this are treated as a road running alongside. */
export const MIN_CROSSING_SINE = Math.sin((32 * Math.PI) / 180);
/** Clear margin on each side of the carriageway inside an opening, metres. */
export const OPENING_MARGIN = 1.7;
/** Crossings of different fences closer than this share one barrier. */
const GATE_MERGE_DISTANCE = 9;

export type FenceOpening = {
  fenceId: string;
  /** Arc-length interval along the fence loop, metres. */
  start: number;
  end: number;
};

export type FenceRun = { fenceId: string; points: Point2[] };

export type GateSite = {
  id: string;
  center: Point2;
  /** Unit vector along the fence line. */
  along: Point2;
  /** Half the carriageway width measured along the fence. */
  spanHalf: number;
  /** Half the full opening width measured along the fence. */
  openingHalf: number;
  corridor: CorridorKind;
};

export type FenceLayout = {
  openings: FenceOpening[];
  runs: FenceRun[];
  gates: GateSite[];
};

function segmentIntersection(
  a: Point2,
  b: Point2,
  c: Point2,
  d: Point2,
): { t: number; u: number } | null {
  const rx = b[0] - a[0];
  const rz = b[1] - a[1];
  const sx = d[0] - c[0];
  const sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

function loopLengths(path: Point2[]): number[] {
  const cumulative = [0];
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    const b = path[(i + 1) % path.length];
    cumulative.push(cumulative[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return cumulative;
}

function pointAtArc(path: Point2[], cumulative: number[], s: number): Point2 {
  const total = cumulative[cumulative.length - 1];
  const wrapped = ((s % total) + total) % total;
  for (let i = 0; i < path.length; i++) {
    if (wrapped <= cumulative[i + 1]) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      const len = cumulative[i + 1] - cumulative[i];
      const t = len > 0 ? (wrapped - cumulative[i]) / len : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
  }
  return path[0];
}

/** Polyline following the fence loop between two arc lengths (end > start). */
function sliceLoop(path: Point2[], cumulative: number[], start: number, end: number): Point2[] {
  const total = cumulative[cumulative.length - 1];
  const points: Point2[] = [pointAtArc(path, cumulative, start)];
  // Walk the vertices strictly inside (start, end), across the loop seam.
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < path.length; i++) {
      const s = cumulative[i] + lap * total;
      if (s > start && s < end) points.push(path[i]);
    }
  }
  points.push(pointAtArc(path, cumulative, end));
  return points;
}

function mergeIntervals(intervals: FenceOpening[]): FenceOpening[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: FenceOpening[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

export function computeFenceLayout(
  fences: FenceDefinition[] = FENCES,
  corridors: Corridor[] = CORRIDORS,
): FenceLayout {
  const openings: FenceOpening[] = [];
  const runs: FenceRun[] = [];
  const gates: GateSite[] = [];

  for (const fence of fences) {
    const { path } = fence;
    const cumulative = loopLengths(path);
    const total = cumulative[cumulative.length - 1];
    const fenceOpenings: FenceOpening[] = [];

    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      const b = path[(i + 1) % path.length];
      const fenceLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (fenceLength < 1e-6) continue;
      const fx = (b[0] - a[0]) / fenceLength;
      const fz = (b[1] - a[1]) / fenceLength;
      for (const corridor of corridors) {
        for (let k = 0; k < corridor.path.length - 1; k++) {
          const c = corridor.path[k];
          const d = corridor.path[k + 1];
          const hit = segmentIntersection(a, b, c, d);
          if (!hit) continue;
          const roadLength = Math.hypot(d[0] - c[0], d[1] - c[1]);
          const sine = Math.abs(fx * (d[1] - c[1]) - fz * (d[0] - c[0])) / roadLength;
          if (sine < MIN_CROSSING_SINE) continue;
          const spanHalf = corridor.halfWidth / sine;
          const openingHalf = spanHalf + OPENING_MARGIN;
          const s = cumulative[i] + hit.t * fenceLength;
          fenceOpenings.push({ fenceId: fence.id, start: s - openingHalf, end: s + openingHalf });
          const center: Point2 = [a[0] + (b[0] - a[0]) * hit.t, a[1] + (b[1] - a[1]) * hit.t];
          const duplicate = gates.some(
            (g) =>
              Math.hypot(g.center[0] - center[0], g.center[1] - center[1]) < GATE_MERGE_DISTANCE,
          );
          if (!duplicate) {
            gates.push({
              id: `gate-${gates.length + 1}`,
              center,
              along: [fx, fz],
              spanHalf,
              openingHalf,
              corridor: corridor.kind,
            });
          }
        }
      }
    }

    // Normalise into [0, total) and split intervals that wrap the loop seam.
    const normalised: FenceOpening[] = [];
    for (const o of fenceOpenings) {
      const start = ((o.start % total) + total) % total;
      const end = start + (o.end - o.start);
      if (end > total) {
        normalised.push({ fenceId: fence.id, start, end: total });
        normalised.push({ fenceId: fence.id, start: 0, end: end - total });
      } else {
        normalised.push({ fenceId: fence.id, start, end });
      }
    }
    const merged = mergeIntervals(normalised);
    openings.push(...merged);

    if (merged.length === 0) {
      runs.push({ fenceId: fence.id, points: [...path, path[0]] });
      continue;
    }
    // Solid runs are the gaps between consecutive openings around the loop.
    for (let k = 0; k < merged.length; k++) {
      const runStart = merged[k].end;
      const next = merged[(k + 1) % merged.length];
      const runEnd = k + 1 < merged.length ? next.start : next.start + total;
      if (runEnd - runStart > 0.5) {
        runs.push({ fenceId: fence.id, points: sliceLoop(path, cumulative, runStart, runEnd) });
      }
    }
  }

  return { openings, runs, gates };
}

let cachedLayout: FenceLayout | null = null;

export function getFenceLayout(): FenceLayout {
  if (!cachedLayout) cachedLayout = computeFenceLayout();
  return cachedLayout;
}
