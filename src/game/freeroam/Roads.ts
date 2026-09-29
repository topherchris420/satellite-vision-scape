import { interiorRoads, roadPath } from "@/lib/site-layout";
import { compassOf, wrapPi } from "@/lib/freeroam/contracts";

/**
 * The site's road network as drivable routes with lanes.
 *
 * Roads come straight from the traced layout that also builds the rendered
 * ribbons and the ground surfaces, so a lane here is a lane there. Traffic
 * keeps left (this is Australia and the vehicles are right-hand drive).
 * A route is a polyline; vehicles run along it and turn round at its ends.
 * Nothing here is a hidden shortcut for the player: it answers "where is the
 * road, and which way does it run?" for AI drivers and for the observation of
 * a driver who can see the road.
 */

export interface RoadRoute {
  id: string;
  kind: "main" | "connector";
  /** Vertices, world XZ. */
  xs: Float64Array;
  zs: Float64Array;
  /** Cumulative length at each vertex. */
  cumulative: Float64Array;
  length: number;
  /** Paved half-width (metres): the asphalt ribbon the ground query also uses. */
  halfWidth: number;
}

export interface RoadSample {
  route: number;
  segment: number;
  /** Closest point on the centre line. */
  x: number;
  z: number;
  /** Unit tangent of the segment (the route's own direction). */
  tx: number;
  tz: number;
  /** Signed distance from the centre line: positive is to the left of the tangent. */
  offset: number;
  /** Arc length along the route at the closest point. */
  s: number;
  halfWidth: number;
}

export interface LaneInfo {
  onRoad: boolean;
  /** Compass heading of the road in the direction of travel. */
  roadHeadingDeg: number;
  /** Yaw of the road in the direction of travel (game yaw). */
  roadYaw: number;
  /** Metres from the centre of the keep-left lane; positive is towards the road's centre line. */
  laneOffset: number;
  /** Signed heading error of a body facing `yaw` against the road, radians (+ road is to the left). */
  headingError: number;
  /** Turn the road makes over the next 40 m in the direction of travel, radians (+ left). */
  upcomingTurn: number;
  /** Distance to the centre line. */
  distance: number;
  halfWidth: number;
}

/** Two roads whose centre lines come this close are taken to meet. */
const JUNCTION_REACH = 14;

export interface LanePath {
  /** Waypoints in the keep-left lane, in the direction of travel. */
  points: { x: number; z: number }[];
  length: number;
}

const MAIN_HALF_WIDTH = 3;
const CONNECTOR_HALF_WIDTH = 2.5;

function buildRoute(
  id: string,
  kind: RoadRoute["kind"],
  points: readonly (readonly [number, number])[],
  halfWidth: number,
): RoadRoute {
  const n = points.length;
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  const cumulative = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i][0];
    zs[i] = points[i][1];
    if (i > 0) cumulative[i] = cumulative[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  }
  return { id, kind, xs, zs, cumulative, length: cumulative[n - 1], halfWidth };
}

export class RoadNetwork {
  readonly routes: RoadRoute[];
  private readonly scratch: RoadSample = {
    route: 0,
    segment: 0,
    x: 0,
    z: 0,
    tx: 0,
    tz: 1,
    offset: 0,
    s: 0,
    halfWidth: 0,
  };

  constructor(
    main: readonly (readonly [number, number])[] = roadPath,
    connectors: readonly (readonly (readonly [number, number])[])[] = interiorRoads,
  ) {
    this.routes = [
      buildRoute("main", "main", main, MAIN_HALF_WIDTH),
      ...connectors.map((c, i) => buildRoute(`road-${i + 1}`, "connector", c, CONNECTOR_HALF_WIDTH)),
    ];
  }

  /** Width of one lane on a route. */
  laneWidth(route: number): number {
    return this.routes[route].halfWidth;
  }

  /** Centre of the keep-left lane, metres to the left of the centre line. */
  laneCentre(route: number): number {
    return this.routes[route].halfWidth / 2;
  }

  /** Closest road centre line within `maxDistance`, or null. */
  nearest(x: number, z: number, maxDistance: number, out: RoadSample = this.scratch): RoadSample | null {
    let best = maxDistance;
    let found = false;
    for (let r = 0; r < this.routes.length; r++) {
      const route = this.routes[r];
      const { xs, zs } = route;
      for (let i = 0; i < xs.length - 1; i++) {
        const ax = xs[i];
        const az = zs[i];
        const vx = xs[i + 1] - ax;
        const vz = zs[i + 1] - az;
        const len2 = vx * vx + vz * vz;
        if (len2 < 1e-9) continue;
        let t = ((x - ax) * vx + (z - az) * vz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + vx * t;
        const cz = az + vz * t;
        const d = Math.hypot(x - cx, z - cz);
        if (d >= best) continue;
        best = d;
        found = true;
        const len = Math.sqrt(len2);
        const tx = vx / len;
        const tz = vz / len;
        out.route = r;
        out.segment = i;
        out.x = cx;
        out.z = cz;
        out.tx = tx;
        out.tz = tz;
        // Left of a tangent (tx, tz) is (tz, −tx).
        out.offset = (x - cx) * tz - (z - cz) * tx;
        out.s = route.cumulative[i] + len * t;
        out.halfWidth = route.halfWidth;
      }
    }
    return found ? out : null;
  }

  /**
   * Project a point onto one route, searching only within `window` metres of
   * the arc length `sHint` (a driver knows roughly where it is on its road).
   * Returns the arc length of the closest point and the signed offset from the
   * centre line (positive to the left of the route's own direction).
   */
  project(
    route: number,
    x: number,
    z: number,
    sHint: number,
    window: number,
    out: { s: number; offset: number },
  ): { s: number; offset: number } {
    const r = this.routes[route];
    let bestD = Infinity;
    out.s = sHint;
    out.offset = 0;
    for (let i = 0; i < r.xs.length - 1; i++) {
      if (r.cumulative[i + 1] < sHint - window || r.cumulative[i] > sHint + window) continue;
      const ax = r.xs[i];
      const az = r.zs[i];
      const vx = r.xs[i + 1] - ax;
      const vz = r.zs[i + 1] - az;
      const len2 = vx * vx + vz * vz;
      if (len2 < 1e-9) continue;
      let t = ((x - ax) * vx + (z - az) * vz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (ax + vx * t), z - (az + vz * t));
      if (d >= bestD) continue;
      bestD = d;
      const len = Math.sqrt(len2);
      out.s = r.cumulative[i] + len * t;
      out.offset = ((x - (ax + vx * t)) * vz - (z - (az + vz * t)) * vx) / len;
    }
    return out;
  }

  /** Point and tangent at arc length `s` (clamped) along a route. */
  pointAt(
    route: number,
    s: number,
    out: { x: number; z: number; tx: number; tz: number },
  ): { x: number; z: number; tx: number; tz: number } {
    const r = this.routes[route];
    const clamped = s < 0 ? 0 : s > r.length ? r.length : s;
    let i = 0;
    while (i < r.cumulative.length - 2 && r.cumulative[i + 1] < clamped) i++;
    const seg = r.cumulative[i + 1] - r.cumulative[i];
    const t = seg > 1e-9 ? (clamped - r.cumulative[i]) / seg : 0;
    const vx = r.xs[i + 1] - r.xs[i];
    const vz = r.zs[i + 1] - r.zs[i];
    const len = Math.hypot(vx, vz) || 1;
    out.x = r.xs[i] + vx * t;
    out.z = r.zs[i] + vz * t;
    out.tx = vx / len;
    out.tz = vz / len;
    return out;
  }

  /**
   * What a driver at (x, z) facing `yaw` can tell about the road under and
   * ahead of the vehicle: which way it runs, where the keep-left lane is,
   * how far off it the vehicle sits and what the road does next.
   */
  lane(x: number, z: number, yaw: number, maxDistance = 14): LaneInfo | null {
    const s = this.nearest(x, z, maxDistance);
    if (!s) return null;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    // Travel with the road or against its stored direction, whichever the vehicle faces.
    const dir = fx * s.tx + fz * s.tz >= 0 ? 1 : -1;
    const tx = s.tx * dir;
    const tz = s.tz * dir;
    // Signed offset from the centre line, positive to the left of the travel direction.
    const left = s.offset * dir;
    const laneCentre = s.halfWidth / 2;
    const roadYaw = Math.atan2(tx, tz);
    // Look 40 m further along the travel direction.
    const ahead = { x: 0, z: 0, tx: 0, tz: 0 };
    this.pointAt(s.route, s.s + dir * 40, ahead);
    const aheadYaw = Math.atan2(ahead.tx * dir, ahead.tz * dir);
    return {
      onRoad: Math.abs(s.offset) <= s.halfWidth,
      roadHeadingDeg: compassOf(roadYaw),
      roadYaw,
      // Left-hand traffic: the lane centre is `laneCentre` to the left of the centre line.
      laneOffset: -(left - laneCentre),
      headingError: wrapPi(roadYaw - yaw),
      upcomingTurn: wrapPi(aheadYaw - roadYaw),
      distance: Math.abs(s.offset),
      halfWidth: s.halfWidth,
    };
  }

  /**
   * A path along the roads, in the keep-left lane, from where a vehicle is to
   * where it is going: the road under the start, joined to the road under the
   * goal through junctions where the two meet. Null when either end is not
   * near a road, or the roads do not join. It is the line a considerate
   * driver takes, and nothing more: the legs from the vehicle onto the road
   * and off it are the caller's to plan.
   */
  lanePath(fx: number, fz: number, tx: number, tz: number, maxOff = 30): LanePath | null {
    const a = this.nearest(fx, fz, maxOff, { ...this.scratch });
    const b = this.nearest(tx, tz, maxOff, { ...this.scratch });
    if (!a || !b) return null;
    const chain = this.chainOf(a.route, b.route);
    if (!chain) return null;
    const points: { x: number; z: number }[] = [];
    let s = a.s;
    for (let i = 0; i < chain.length; i++) {
      const route = chain[i];
      const next = i + 1 < chain.length ? chain[i + 1] : -1;
      let sEnd: number;
      let nextStart = 0;
      if (next >= 0) {
        const j = this.junction(route, next);
        if (!j) return null;
        sEnd = j.sA;
        nextStart = j.sB;
      } else sEnd = b.s;
      this.laneSection(route, s, sEnd, points);
      s = nextStart;
    }
    if (points.length < 2) return null;
    let length = 0;
    for (let i = 1; i < points.length; i++)
      length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    return { points, length };
  }

  /** Shortest chain of routes from `from` to `to` that meet end to end (BFS over junctions). */
  private chainOf(from: number, to: number): number[] | null {
    if (from === to) return [from];
    const n = this.routes.length;
    const prev = new Array<number>(n).fill(-2);
    prev[from] = -1;
    const queue = [from];
    while (queue.length > 0) {
      const r = queue.shift() as number;
      for (let k = 0; k < n; k++) {
        if (prev[k] !== -2 || !this.junction(r, k)) continue;
        prev[k] = r;
        if (k === to) {
          const chain: number[] = [];
          for (let c = to; c >= 0; c = prev[c]) chain.push(c);
          return chain.reverse();
        }
        queue.push(k);
      }
    }
    return null;
  }

  private readonly junctions = new Map<number, { sA: number; sB: number } | null>();

  /** Where route `a` meets route `b` (arc lengths on each), or null if they do not meet. */
  junction(a: number, b: number): { sA: number; sB: number } | null {
    const key = a * 64 + b;
    const cached = this.junctions.get(key);
    if (cached !== undefined) return cached;
    const A = this.routes[a];
    const B = this.routes[b];
    let best = JUNCTION_REACH;
    let found: { sA: number; sB: number } | null = null;
    // The ends of one road reaching another, or the two crossing: test vertices against segments both ways.
    const test = (P: RoadRoute, Q: RoadRoute, swap: boolean) => {
      for (let i = 0; i < P.xs.length; i++) {
        for (let j = 0; j < Q.xs.length - 1; j++) {
          const vx = Q.xs[j + 1] - Q.xs[j];
          const vz = Q.zs[j + 1] - Q.zs[j];
          const len2 = vx * vx + vz * vz;
          if (len2 < 1e-9) continue;
          let t = ((P.xs[i] - Q.xs[j]) * vx + (P.zs[i] - Q.zs[j]) * vz) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(P.xs[i] - (Q.xs[j] + vx * t), P.zs[i] - (Q.zs[j] + vz * t));
          if (d >= best) continue;
          best = d;
          const sP = P.cumulative[i];
          const sQ = Q.cumulative[j] + Math.sqrt(len2) * t;
          found = swap ? { sA: sQ, sB: sP } : { sA: sP, sB: sQ };
        }
      }
    };
    test(A, B, false);
    test(B, A, true);
    this.junctions.set(key, found);
    return found;
  }

  /** Append the keep-left lane of `route` between arc lengths `s0` and `s1` (either order). */
  private laneSection(route: number, s0: number, s1: number, out: { x: number; z: number }[]): void {
    const r = this.routes[route];
    const dir = s1 >= s0 ? 1 : -1;
    const lo = Math.min(s0, s1);
    const hi = Math.max(s0, s1);
    const stations: number[] = [s0];
    // Original vertices strictly between, and a station at least every 15 m.
    const inner: number[] = [];
    for (let i = 0; i < r.cumulative.length; i++) if (r.cumulative[i] > lo + 1 && r.cumulative[i] < hi - 1) inner.push(r.cumulative[i]);
    if (dir < 0) inner.reverse();
    for (const v of inner) stations.push(v);
    stations.push(s1);
    const dense: number[] = [];
    for (let i = 0; i < stations.length; i++) {
      dense.push(stations[i]);
      if (i + 1 < stations.length) {
        const gap = Math.abs(stations[i + 1] - stations[i]);
        const extra = Math.floor(gap / 15);
        for (let k = 1; k <= extra; k++) dense.push(stations[i] + (dir * gap * k) / (extra + 1));
      }
    }
    const p = { x: 0, z: 0, tx: 0, tz: 0 };
    const centre = r.halfWidth / 2;
    for (const st of dense) {
      this.pointAt(route, st, p);
      // The tangent in the direction of travel; left of it is (tz, −tx).
      const tx = p.tx * dir;
      const tz = p.tz * dir;
      out.push({ x: p.x + tz * centre, z: p.z - tx * centre });
    }
  }

  /** A route index with at least `minLength` metres of road, chosen by `pick(count)`. */
  drivableRoutes(minLength: number): number[] {
    const out: number[] = [];
    this.routes.forEach((r, i) => {
      if (r.length >= minLength) out.push(i);
    });
    return out;
  }
}
