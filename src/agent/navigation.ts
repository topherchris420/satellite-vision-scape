export interface Point {
  x: number;
  z: number;
}
export type ClearSegment = (a: Point, b: Point, radius: number) => boolean;
/** Bounded A*, over collision geometry only. It never selects the destination. */
export function findRoute(start: Point, goal: Point, radius: number, clear: ClearSegment): Point[] {
  if (clear(start, goal, radius)) return [{ ...goal }];
  const size = 6,
    key = (x: number, z: number) => `${x},${z}`;
  type Node = Point & { cost: number; score: number; parent: Node | null };
  const first: Node = { ...start, cost: 0, score: 0, parent: null },
    open: Node[] = [first],
    costs = new Map<string, number>();
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  let found: Node | null = null;
  for (let count = 0; open.length && count < 12000; count++) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i].score < open[best].score) best = i;
    const cur = open[best];
    open[best] = open[open.length - 1];
    open.pop();
    if (Math.hypot(cur.x - goal.x, cur.z - goal.z) < size * 2 && clear(cur, goal, radius)) {
      found = cur;
      break;
    }
    for (const [dx, dz] of dirs) {
      const x = cur.x + dx * size,
        z = cur.z + dz * size;
      if (Math.abs(x) > 950 || Math.abs(z) > 950) continue;
      const cost = cur.cost + Math.hypot(dx, dz) * size,
        k = key(x, z);
      if ((costs.get(k) ?? Infinity) <= cost || !clear(cur, { x, z }, radius)) continue;
      costs.set(k, cost);
      open.push({ x, z, cost, score: cost + Math.hypot(x - goal.x, z - goal.z), parent: cur });
    }
  }
  if (!found) return [];
  const raw: Point[] = [{ ...goal }];
  for (let n: Node | null = found; n; n = n.parent) raw.push({ x: n.x, z: n.z });
  raw.reverse();
  const route: Point[] = [];
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !clear(raw[i], raw[j], radius)) j--;
    route.push(raw[j]);
    i = j;
  }
  return route;
}
