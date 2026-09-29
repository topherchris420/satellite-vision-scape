/**
 * Local route planning and on-foot steering.
 *
 * The planner answers "how do I get there?" for a destination the agent has
 * already chosen; it never chooses one. It searches a coarse grid with A*,
 * using only a caller-supplied `clear` query (the environment's collision
 * geometry), then pulls the path taut. It is bounded in nodes and area, and
 * it allocates only per plan — never per frame.
 */

export interface Point {
  x: number;
  z: number;
}

/** True when a body of `radius` can travel straight from `a` to `b`. */
export type ClearSegment = (a: Point, b: Point, radius: number) => boolean;

export interface RouteOptions {
  /** Clearance radius of the travelling body (metres). */
  radius: number;
  /** Grid spacing (metres). */
  cell: number;
  /** Expansion budget; the plan fails (or falls back) beyond it. */
  maxNodes?: number;
  /** Accept the nearest reachable point within this distance of the goal. */
  tolerance?: number;
  /** Search half-extent around the midpoint of start and goal (metres). */
  extent?: number;
  /**
   * Cost multiplier (≥ 1) for stepping onto (x, z): 1 is free-flowing, larger
   * discourages the step. Lets a driver prefer the road without forbidding
   * the desert. Never below 1, so the straight-line heuristic stays admissible.
   */
  stepCost?: (x: number, z: number) => number;
}

const NEIGHBOURS: readonly [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/** Minimal binary heap keyed by f-score. */
class Heap {
  private readonly ids: number[] = [];
  private readonly scores: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, score: number): void {
    const ids = this.ids;
    const scores = this.scores;
    let i = ids.length;
    ids.push(id);
    scores.push(score);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (scores[parent] <= score) break;
      ids[i] = ids[parent];
      scores[i] = scores[parent];
      i = parent;
    }
    ids[i] = id;
    scores[i] = score;
  }

  pop(): number {
    const ids = this.ids;
    const scores = this.scores;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastScore = scores.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && scores[r] < scores[l] ? r : l;
        if (scores[c] >= lastScore) break;
        ids[i] = ids[c];
        scores[i] = scores[c];
        i = c;
      }
      ids[i] = lastId;
      scores[i] = lastScore;
    }
    return top;
  }
}

/**
 * Plan a route from `start` to `goal`. Returns the waypoints after `start`
 * (the last is the goal, or the nearest reachable point within `tolerance`),
 * or an empty list when no route was found within budget.
 */
export function findRoute(
  start: Point,
  goal: Point,
  clear: ClearSegment,
  options: RouteOptions,
): Point[] {
  const { radius, cell } = options;
  const maxNodes = options.maxNodes ?? 6000;
  const tolerance = options.tolerance ?? 0;
  if (clear(start, goal, radius)) return [{ x: goal.x, z: goal.z }];

  // The body is already standing here, but pressed against something (a
  // vehicle parked at the player's elbow): with the clearance margin the
  // start itself reads as blocked, so every segment from it would fail and
  // no route could ever be found. Step out to the nearest clear point first,
  // as a person would; the physics still decides whether that step works.
  // (Found by the decision-latency experiment: 211 route_blocked in a row.)
  if (!clear(start, start, radius)) {
    const escape = nearestClearPoint(start, clear, radius);
    if (!escape) return [];
    const rest = findRoute(escape, goal, clear, options);
    return rest.length > 0 ? [escape, ...rest] : [];
  }

  const span = Math.hypot(goal.x - start.x, goal.z - start.z);
  const extent = options.extent ?? Math.max(120, span * 0.75 + 80);
  const cx = (start.x + goal.x) / 2;
  const cz = (start.z + goal.z) / 2;
  const half = Math.ceil(extent / cell);
  const width = half * 2 + 1;
  const toIndex = (ix: number, iz: number) => (iz + half) * width + (ix + half);
  const fromIndex = (id: number): Point => {
    const iz = Math.floor(id / width) - half;
    const ix = (id % width) - half;
    return { x: cx + ix * cell, z: cz + iz * cell };
  };

  // The start is not a grid node: connect it to the clear nodes around it.
  const cost = new Map<number, number>();
  const parent = new Map<number, number>();
  const closed = new Set<number>();
  const open = new Heap();
  const h = (p: Point) => Math.hypot(goal.x - p.x, goal.z - p.z);
  const six = Math.round((start.x - cx) / cell);
  const siz = Math.round((start.z - cz) / cell);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ix = six + dx;
      const iz = siz + dz;
      if (Math.abs(ix) > half || Math.abs(iz) > half) continue;
      const id = toIndex(ix, iz);
      const p = fromIndex(id);
      if (!clear(start, p, radius)) continue;
      const g = Math.hypot(p.x - start.x, p.z - start.z);
      cost.set(id, g);
      parent.set(id, -1);
      open.push(id, g + h(p));
    }
  }

  let found = -1;
  let nearest = -1;
  let nearestDistance = Infinity;
  let expanded = 0;
  while (open.size > 0 && expanded < maxNodes) {
    const id = open.pop();
    if (closed.has(id)) continue;
    closed.add(id);
    expanded++;
    const p = fromIndex(id);
    const remaining = h(p);
    if (remaining < nearestDistance) {
      nearestDistance = remaining;
      nearest = id;
    }
    if (remaining <= cell * 1.5 && clear(p, goal, radius)) {
      found = id;
      break;
    }
    const ix = Math.round((p.x - cx) / cell);
    const iz = Math.round((p.z - cz) / cell);
    const g0 = cost.get(id)!;
    for (const [dx, dz, step] of NEIGHBOURS) {
      const nx = ix + dx;
      const nz = iz + dz;
      if (Math.abs(nx) > half || Math.abs(nz) > half) continue;
      const nid = toIndex(nx, nz);
      if (closed.has(nid)) continue;
      const q = fromIndex(nid);
      const g = g0 + step * cell * Math.max(1, options.stepCost ? options.stepCost(q.x, q.z) : 1);
      if (g >= (cost.get(nid) ?? Infinity)) continue;
      if (!clear(p, q, radius)) continue;
      cost.set(nid, g);
      parent.set(nid, id);
      open.push(nid, g + h(q));
    }
  }

  let end = found;
  let reachesGoal = found >= 0;
  if (end < 0) {
    if (nearest < 0 || nearestDistance > tolerance) return [];
    end = nearest;
    reachesGoal = false;
  }
  const raw: Point[] = [];
  for (let id = end; id >= 0; id = parent.get(id) ?? -1) raw.push(fromIndex(id));
  raw.reverse();
  if (reachesGoal) raw.push({ x: goal.x, z: goal.z });
  return smooth([start, ...raw], clear, radius).slice(1);
}

/** The nearest clear point on small rings around `p`, or null. */
function nearestClearPoint(p: Point, clear: ClearSegment, radius: number): Point | null {
  for (const r of [0.5, 1, 1.5, 2.5]) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const q = { x: p.x + Math.sin(a) * r, z: p.z + Math.cos(a) * r };
      if (clear(q, q, radius)) return q;
    }
  }
  return null;
}

/** Pull a polyline taut: skip every waypoint the body can bypass in a straight line. */
function smooth(points: Point[], clear: ClearSegment, radius: number): Point[] {
  const out: Point[] = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    while (j > i + 1 && !clear(points[i], points[j], radius)) j--;
    out.push(points[j]);
    i = j;
  }
  return out;
}

export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** World heading (radians, 0 = +Z, like the game's yaw) from `a` towards `b`. */
export function headingTo(a: Point, b: Point): number {
  return Math.atan2(b.x - a.x, b.z - a.z);
}

export interface FootCommand {
  /** Camera-relative stick, as a player's movement keys produce. */
  moveX: number;
  moveY: number;
  /** Camera rotation to apply this frame (radians, + turns towards +yaw). */
  turn: number;
  sprint: boolean;
}

/**
 * On-foot steering towards a waypoint, the way a player does it: turn the
 * camera towards the direction of travel (at a bounded rate, like a mouse)
 * and push the stick camera-relative. Slows near the destination.
 */
export function footControl(
  from: Point,
  cameraYaw: number,
  to: Point,
  distanceToGoal: number,
  dt: number,
  options: { careful: boolean; final: boolean },
  out: FootCommand,
): FootCommand {
  const travel = headingTo(from, to);
  const relative = wrapAngle(travel - cameraYaw);
  // Mouse-like camera turn: proportional, capped at ~200°/s.
  const maxTurn = 3.5 * dt;
  out.turn = Math.max(-maxTurn, Math.min(maxTurn, relative * Math.min(1, 6 * dt)));
  const speed = options.final ? Math.max(0.3, Math.min(1, distanceToGoal / 3)) : 1;
  out.moveX = -Math.sin(relative) * speed;
  out.moveY = Math.cos(relative) * speed;
  out.sprint = !options.careful && distanceToGoal > 18;
  return out;
}
