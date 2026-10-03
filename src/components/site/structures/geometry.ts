import * as THREE from "three";

/**
 * Geodesic radome shell. Every icosphere face at `panelDetail` is one FRP
 * panel; each panel is subdivided `sub`×`sub` and re-projected onto the
 * sphere for a smooth silhouette. Attributes for the radome material:
 *  - aBary: barycentric position inside the panel (seams at the edges)
 *  - aPanel: per-panel random value (tonal variation)
 *  - aGround: metres above the truncation plane (dust toward the base)
 * Normals lean slightly toward the flat panel normal, so the panels read as
 * very gently faceted, as real bolted FRP panels do.
 */
export function createGeodesicShell(radius: number, lift: number, panelDetail: number, sub: number) {
  const ico = new THREE.IcosahedronGeometry(radius, panelDetail);
  const p = ico.attributes.position as THREE.BufferAttribute;
  const cut = -lift * radius;
  const pos: number[] = [];
  const nrm: number[] = [];
  const bary: number[] = [];
  const panel: number[] = [];
  const ground: number[] = [];
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const C = new THREE.Vector3();
  const face = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  type V = { p: THREE.Vector3; b: [number, number, number] };
  const point = (i: number, j: number): V => {
    const b: [number, number, number] = [(sub - i - j) / sub, i / sub, j / sub];
    const v = new THREE.Vector3()
      .addScaledVector(A, b[0])
      .addScaledVector(B, b[1])
      .addScaledVector(C, b[2])
      .normalize()
      .multiplyScalar(radius);
    return { p: v, b };
  };
  const lerp = (a: V, c: V, t: number): V => ({
    p: a.p.clone().lerp(c.p, t),
    b: [a.b[0] + (c.b[0] - a.b[0]) * t, a.b[1] + (c.b[1] - a.b[1]) * t, a.b[2] + (c.b[2] - a.b[2]) * t],
  });
  let seed = 1;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const emit = (tri: V[], pv: number) => {
    // clip against the truncation plane
    const out: V[] = [];
    for (let k = 0; k < 3; k++) {
      const a = tri[k];
      const c = tri[(k + 1) % 3];
      if (a.p.y >= cut) out.push(a);
      if (a.p.y >= cut !== c.p.y >= cut) out.push(lerp(a, c, (cut - a.p.y) / (c.p.y - a.p.y)));
    }
    for (let k = 1; k < out.length - 1; k++) {
      for (const v of [out[0], out[k], out[k + 1]]) {
        pos.push(v.p.x, v.p.y, v.p.z);
        tmp.copy(v.p).normalize().multiplyScalar(0.9).addScaledVector(face, 0.1).normalize();
        nrm.push(tmp.x, tmp.y, tmp.z);
        bary.push(...v.b);
        panel.push(pv);
        ground.push(v.p.y - cut);
      }
    }
  };
  for (let f = 0; f < p.count; f += 3) {
    A.fromBufferAttribute(p, f);
    B.fromBufferAttribute(p, f + 1);
    C.fromBufferAttribute(p, f + 2);
    const pv = rand();
    if (Math.max(A.y, B.y, C.y) < cut) continue;
    face.copy(A).add(B).add(C).normalize();
    for (let i = 0; i < sub; i++) {
      for (let j = 0; j < sub - i; j++) {
        emit([point(i, j), point(i + 1, j), point(i, j + 1)], pv);
        if (i + j < sub - 1) emit([point(i + 1, j), point(i + 1, j + 1), point(i, j + 1)], pv);
      }
    }
  }
  ico.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setAttribute("aBary", new THREE.Float32BufferAttribute(bary, 3));
  g.setAttribute("aPanel", new THREE.Float32BufferAttribute(panel, 1));
  g.setAttribute("aGround", new THREE.Float32BufferAttribute(ground, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Four walls of a rectangular building, base at y = 0. uv = (metres along
 * the wall, metres above the slab); aWall = (wall length, height, door
 * position along the wall, roller-door position) with -100 for "none".
 * Walls run counter-clockwise seen from above: +z, +x, -z, -x.
 */
export function createBuildingWalls(
  w: number,
  h: number,
  d: number,
  door: { wall: number; along: number } | null,
  roller: { wall: number; along: number } | null,
) {
  const hw = w / 2;
  const hd = d / 2;
  // [start corner, end corner, outward normal]
  const walls: [[number, number], [number, number], [number, number]][] = [
    [[-hw, hd], [hw, hd], [0, 1]],
    [[hw, hd], [hw, -hd], [1, 0]],
    [[hw, -hd], [-hw, -hd], [0, -1]],
    [[-hw, -hd], [-hw, hd], [-1, 0]],
  ];
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const attr: number[] = [];
  const idx: number[] = [];
  walls.forEach(([a, b, n], k) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const base = pos.length / 3;
    const doorAlong = door && door.wall === k ? door.along : -100;
    const rollAlong = roller && roller.wall === k ? roller.along : -100;
    for (const [x, z, u] of [
      [a[0], a[1], 0],
      [b[0], b[1], len],
    ]) {
      for (const y of [0, h]) {
        pos.push(x, y, z);
        nrm.push(n[0], 0, n[1]);
        uv.push(u, y);
        attr.push(len, h, doorAlong, rollAlong);
      }
    }
    // vertices: 0 = a bottom, 1 = a top, 2 = b bottom, 3 = b top
    idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aWall", new THREE.Float32BufferAttribute(attr, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Raised concrete kerb following a ground ribbon edge: top face plus the
 * road-side face. `side` = +1 / -1 picks the left or right edge of the
 * path. Height is measured from the local terrain.
 */
export function createKerb(
  points: [number, number][],
  roadWidth: number,
  side: 1 | -1,
  heightAt: (x: number, z: number) => number,
  kerbWidth = 0.22,
  kerbHeight = 0.16,
  baseOffset = 0.06,
  suppress?: (x: number, z: number) => boolean,
) {
  const samples: [number, number][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    for (let j = 0; j < n; j++) samples.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  samples.push(points[points.length - 1]);
  const pos: number[] = [];
  const uv: number[] = [];
  const ground: number[] = [];
  const idx: number[] = [];
  let dist = 0;
  samples.forEach((p, i) => {
    const prev = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(samples.length - 1, i + 1)];
    let tx = next[0] - prev[0];
    let tz = next[1] - prev[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const nx = -tz * side;
    const nz = tx * side;
    if (i) dist += Math.hypot(p[0] - samples[i - 1][0], p[1] - samples[i - 1][1]);
    const inner = roadWidth / 2;
    const outer = inner + kerbWidth;
    const xi = p[0] + nx * inner;
    const zi = p[1] + nz * inner;
    const xo = p[0] + nx * outer;
    const zo = p[1] + nz * outer;
    const yi = heightAt(xi, zi);
    const yo = heightAt(xo, zo);
    // dropped kerb where another road crosses: sink it below the surface
    const top = suppress && (suppress(xi, zi) || suppress(xo, zo)) ? -0.12 : kerbHeight;
    // 0 inner low, 1 inner top, 2 outer top, 3 outer low
    pos.push(xi, yi + baseOffset - 0.05, zi, xi, yi + top, zi, xo, yo + top, zo, xo, yo - 0.05, zo);
    uv.push(dist, 0, dist, 0.2, dist, 0.4, dist, 0.6);
    ground.push(0, Math.max(top, 0), Math.max(top, 0), 0);
    if (i < samples.length - 1) {
      const a = i * 4;
      const b = a + 4;
      for (let k = 0; k < 3; k++) {
        if (side > 0) idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
        else idx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aGround", new THREE.Float32BufferAttribute(ground, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Distance from (x, z) to the nearest segment of a polyline. */
export function distanceToPath(path: [number, number][], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i];
    const [bx, bz] = path[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}
