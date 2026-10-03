import * as THREE from "three";

/**
 * Procedural meshes for the GPU ground-cover scatter. Every mesh is built at
 * unit footprint radius with its base at y = 0; the scatter scales it per
 * instance. Vertex colours carry baked occlusion only (the hue comes from the
 * per-instance tint), and normals are bent towards a soft dome so a hummock of
 * hundreds of needles lights as one volume instead of glittering.
 *
 * `aSide` holds each blade vertex's half-width offset so the vertex shader can
 * widen blades with distance and keep them at least a pixel wide (thin
 * geometry would otherwise shimmer under post-process anti-aliasing).
 */

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  sides: number[] = [];
  vertex(p: THREE.Vector3, n: THREE.Vector3, ao: number, side?: THREE.Vector3) {
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.colors.push(ao, ao, ao);
    this.sides.push(side?.x ?? 0, side?.y ?? 0, side?.z ?? 0);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    g.setAttribute("aSide", new THREE.Float32BufferAttribute(this.sides, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Soft dome normal used for foliage-like lighting. */
function domeNormal(p: THREE.Vector3, centreY: number, out: THREE.Vector3) {
  return out.set(p.x, (p.y - centreY) * 1.6 + 0.35, p.z).normalize();
}

function addDome(b: MeshBuilder, r: () => number, radius: number, height: number, segs: number, rings: number, aoBase: number, aoTop: number) {
  const pts: THREE.Vector3[][] = [];
  for (let j = 0; j <= rings; j++) {
    const row: THREE.Vector3[] = [];
    const phi = (j / rings) * Math.PI * 0.5;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const wobble = 1 + (r() - 0.5) * 0.18;
      const rr = Math.cos(phi) * radius * wobble;
      row.push(new THREE.Vector3(Math.cos(a) * rr, Math.sin(phi) * height * wobble - 0.04, Math.sin(a) * rr));
    }
    pts.push(row);
  }
  const n = new THREE.Vector3();
  const tri = (p: THREE.Vector3) => {
    domeNormal(p, 0, n);
    const t = THREE.MathUtils.clamp(p.y / height, 0, 1);
    b.vertex(p, n, aoBase + (aoTop - aoBase) * t);
  };
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const a = pts[j][i];
      const c = pts[j][(i + 1) % segs];
      const d = pts[j + 1][i];
      const e = pts[j + 1][(i + 1) % segs];
      tri(a); tri(d); tri(c);
      if (j < rings - 1) { tri(c); tri(d); tri(e); }
    }
  }
}

/** A single tapering needle from `base` along `dir`. */
function addBlade(b: MeshBuilder, base: THREE.Vector3, dir: THREE.Vector3, length: number, width: number, aoBase: number, aoTip: number, centreY: number) {
  const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
  if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
  side.normalize().multiplyScalar(width * 0.5);
  const tip = base.clone().addScaledVector(dir, length);
  const n = new THREE.Vector3();
  domeNormal(base, centreY, n);
  b.vertex(base, n, aoBase, side);
  b.vertex(base, n, aoBase, side.clone().negate());
  domeNormal(tip, centreY, n);
  b.vertex(tip, n, aoTip);
}

/**
 * Spinifex (Triodia) hummock: a dense dark core bristling with stiff,
 * pale-tipped needles, flatter than it is wide.
 */
export function spinifexGeometry(detail: "near" | "far") {
  const r = rng(detail === "near" ? 4111 : 4112);
  const b = new MeshBuilder();
  const height = 0.62;
  // A small, dark core: the needles, not the core, carry the silhouette.
  addDome(b, r, 0.52, height * 0.46, detail === "near" ? 12 : 7, detail === "near" ? 4 : 2, 0.12, 0.3);
  const blades = detail === "near" ? 380 : 64;
  const dir = new THREE.Vector3();
  for (let i = 0; i < blades; i++) {
    const a = r() * Math.PI * 2;
    // Bias emergence points towards the rim so the outline bristles.
    const phi = Math.pow(r(), 0.7) * Math.PI * 0.46;
    const rr = Math.cos(phi) * 0.5 * (0.6 + r() * 0.4);
    const base = new THREE.Vector3(Math.cos(a) * rr, Math.sin(phi) * height * 0.42, Math.sin(a) * rr);
    dir.set(Math.cos(a) * Math.cos(phi), Math.sin(phi) + 0.35, Math.sin(a) * Math.cos(phi));
    dir.x += (r() - 0.5) * 0.5;
    dir.z += (r() - 0.5) * 0.5;
    dir.y += r() * 0.4;
    dir.normalize();
    const len = (detail === "near" ? 0.3 : 0.4) + r() * 0.36;
    const width = detail === "near" ? 0.026 : 0.09;
    addBlade(b, base, dir, len, width, 0.35, 1.0, 0.05);
  }
  return b.build();
}

/**
 * Tussock grass (buffel / woollybutt): a fountain of arching leaves and a few
 * upright seed stalks from a tight crown.
 */
export function tussockGeometry() {
  const r = rng(7311);
  const b = new MeshBuilder();
  const n = new THREE.Vector3();
  const leaves = 46;
  for (let i = 0; i < leaves; i++) {
    const a = r() * Math.PI * 2;
    const lean = 0.25 + r() * 0.85;
    const len = 0.55 + r() * 0.5;
    const width = 0.028 + r() * 0.02;
    const segs = 4;
    const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new THREE.Vector3(-out.z, 0, out.x).multiplyScalar(width * 0.5);
    const start = out.clone().multiplyScalar(r() * 0.08);
    let prevP: THREE.Vector3 | null = null;
    let prevL: THREE.Vector3 | null = null;
    let prevR: THREE.Vector3 | null = null;
    let prevAo = 0.35;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      // Parabolic arc: rises, then droops outward under its own weight.
      const p = start
        .clone()
        .addScaledVector(out, lean * len * t * 0.8)
        .add(new THREE.Vector3(0, len * (t - lean * 0.45 * t * t), 0));
      const taper = 1 - t * 0.85;
      const sl = side.clone().multiplyScalar(taper);
      const sr = sl.clone().negate();
      const ao = 0.35 + 0.65 * t;
      if (prevP && prevL && prevR) {
        // Positions stay on the leaf's midline; aSide carries the half-width.
        domeNormal(prevP, 0.1, n);
        b.vertex(prevP, n, prevAo, prevL);
        b.vertex(prevP, n, prevAo, prevR);
        domeNormal(p, 0.1, n);
        b.vertex(p, n, ao, sl);
        b.vertex(p, n, ao, sl);
        domeNormal(prevP, 0.1, n);
        b.vertex(prevP, n, prevAo, prevR);
        domeNormal(p, 0.1, n);
        b.vertex(p, n, ao, sr);
      }
      prevP = p;
      prevL = sl;
      prevR = sr;
      prevAo = ao;
    }
  }
  // Seed stalks with a thicker head.
  for (let i = 0; i < 7; i++) {
    const a = r() * Math.PI * 2;
    const base = new THREE.Vector3(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05);
    const dir = new THREE.Vector3(Math.cos(a) * 0.25, 1, Math.sin(a) * 0.25).normalize();
    addBlade(b, base, dir, 0.95 + r() * 0.3, 0.02, 0.5, 1.15, 0.2);
    const head = base.clone().addScaledVector(dir, 0.75);
    addBlade(b, head, dir, 0.32, 0.06, 1.05, 1.2, 0.2);
  }
  return b.build();
}

/** Small angular stone, flattened, for pebble and gibber scatter. */
export function pebbleGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 0).toNonIndexed();
  const p = g.getAttribute("position");
  const r = rng(991);
  // Deform shared corners identically so the stone stays closed.
  const offsets = new Map<string, THREE.Vector3>();
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let o = offsets.get(key);
    if (!o) {
      o = new THREE.Vector3(0.8 + r() * 0.45, 0.8 + r() * 0.45, 0.8 + r() * 0.45);
      offsets.set(key, o);
    }
    v.multiply(o);
    v.y = v.y * 0.5 + 0.18;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const ao = THREE.MathUtils.clamp(0.55 + p.getY(i) * 0.9, 0.4, 1);
    colors.set([ao, ao, ao], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.setAttribute("aSide", new THREE.BufferAttribute(new Float32Array(p.count * 3), 3));
  return g;
}

/**
 * Saltbush / bluebush: a low mound of crossed, alpha-tested leaf cards from
 * the foliage atlas, normals bent out of the mound.
 */
export function shrubGeometry(rect: [number, number, number, number]) {
  const r = rng(5531);
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const side: number[] = [];
  const [u0, v0, u1, v1] = rect;
  const n = new THREE.Vector3();
  const cards = 9;
  for (let i = 0; i < cards; i++) {
    const a = (i / cards) * Math.PI + r() * 0.4;
    const off = new THREE.Vector3((r() - 0.5) * 0.5, 0, (r() - 0.5) * 0.5);
    const w = 0.85 + r() * 0.4;
    const h = 0.75 + r() * 0.35;
    const dx = Math.cos(a) * w;
    const dz = Math.sin(a) * w;
    const corners: [number, number, number, number, number][] = [
      [-dx, -0.06, -dz, u0, v0],
      [dx, -0.06, dz, u1, v0],
      [dx, h, dz, u1, v1],
      [-dx, h, -dz, u0, v1],
    ];
    const verts = corners.map(([x, y, z, u, v]) => ({ p: new THREE.Vector3(x, y, z).add(off), u, v }));
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const { p, u, v } = verts[k];
      n.set(p.x, p.y * 1.4 + 0.2, p.z).normalize();
      pos.push(p.x, p.y, p.z);
      nrm.push(n.x, n.y, n.z);
      uv.push(u, v);
      const ao = 0.5 + 0.5 * THREE.MathUtils.clamp(p.y / h, 0, 1);
      col.push(ao, ao, ao);
      side.push(0, 0, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("aSide", new THREE.Float32BufferAttribute(side, 3));
  g.computeBoundingSphere();
  return g;
}
