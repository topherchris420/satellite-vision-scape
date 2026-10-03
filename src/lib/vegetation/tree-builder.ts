import * as THREE from "three";
import { atlasRect, ATLAS_CELLS } from "./foliage-atlas";

/**
 * Procedural central-Australian trees. A species is a small set of growth
 * rules; `buildTree` grows a branching skeleton from them and meshes it twice:
 * a detailed version (tubular limbs to the twigs, many foliage cards) and a
 * distant version from the same skeleton (main limbs only, fewer and larger
 * cards), so the hand-off between them keeps the silhouette.
 *
 * Wood vertex colours carry the species' bark colour times occlusion, foliage
 * vertex colours the leaf colour times crown occlusion; bark and leaf
 * textures only add detail. Foliage normals point out of the crown so cards
 * light as one soft volume.
 */

export type Species = "desertOak" | "mulga" | "ghostGum" | "redGum" | "gardenGum";

type Rules = {
  height: number;
  /** Trunk base radius, metres. */
  radius: number;
  /** Fraction of the height where the trunk first divides. */
  fork: number;
  /** Leaders created where the trunk divides. */
  leaders: [number, number];
  /** Spread of the leaders from vertical, radians. */
  leaderAngle: number;
  /** Children per branch for levels 1..n. */
  children: number[];
  /** Branching angle per level, radians. */
  angle: number[];
  /** Child length relative to parent per level. */
  lengthRatio: number[];
  /** Upward (+) or downward (-) pull per level while growing. */
  tropism: number[];
  /** Random bend per segment. */
  wiggle: number;
  /** Trunk lean from vertical, radians. */
  lean: number;
  /** Multi-stemmed from the base (mulga). */
  stems?: [number, number];
  leafCell: number;
  /** Card size range, metres. */
  leafSize: [number, number];
  /** Cards per metre of terminal branch. */
  leafDensity: number;
  /** Cards hang from their attachment (true) or rise from it (false). */
  pendulous: boolean;
  bark: THREE.Color;
  barkMap: 0 | 1;
  leaf: THREE.Color;
};

const c = (hex: string) => new THREE.Color(hex);

export const SPECIES: Record<Species, Rules> = {
  // Allocasuarina decaisneana: straight corky trunk, a few heavy limbs and a
  // weeping, open crown of dark grey-green branchlets.
  desertOak: {
    height: 10.5, radius: 0.32, fork: 0.5, leaders: [3, 5], leaderAngle: 0.62,
    children: [4, 4], angle: [0.75, 0.9], lengthRatio: [0.55, 0.5], tropism: [0.05, -0.1],
    wiggle: 0.22, lean: 0.06, leafCell: ATLAS_CELLS.desertOak, leafSize: [1.6, 2.6],
    leafDensity: 1.5, pendulous: true, bark: c("#4b4038"), barkMap: 0, leaf: c("#76836a"),
  },
  // Acacia aneura: several stems from the base in a vase, dense silvery crown.
  mulga: {
    height: 5.2, radius: 0.09, fork: 0.12, leaders: [3, 5], leaderAngle: 0.42,
    children: [3, 3], angle: [0.55, 0.6], lengthRatio: [0.55, 0.45], tropism: [0.18, 0.1],
    wiggle: 0.18, lean: 0.03, stems: [3, 5], leafCell: ATLAS_CELLS.mulga, leafSize: [1.1, 1.7],
    leafDensity: 2.6, pendulous: false, bark: c("#3b3530"), barkMap: 0, leaf: c("#9aa184"),
  },
  // Corymbia aparrerinja: powder-white, often leaning trunk, open crown of
  // bright drooping leaves; clings to rocky hillsides.
  ghostGum: {
    height: 11, radius: 0.24, fork: 0.42, leaders: [2, 3], leaderAngle: 0.5,
    children: [4, 4], angle: [0.7, 0.8], lengthRatio: [0.6, 0.5], tropism: [0.1, -0.05],
    wiggle: 0.3, lean: 0.16, leafCell: ATLAS_CELLS.eucalypt, leafSize: [1.4, 2.1],
    leafDensity: 1.6, pendulous: true, bark: c("#efebe2"), barkMap: 1, leaf: c("#8fa45e"),
  },
  // Eucalyptus camaldulensis: massive mottled trunk and wide, gnarled limbs
  // lining the dry creek beds.
  redGum: {
    height: 17, radius: 0.55, fork: 0.32, leaders: [2, 4], leaderAngle: 0.7,
    children: [4, 4], angle: [0.75, 0.85], lengthRatio: [0.62, 0.5], tropism: [0.0, -0.08],
    wiggle: 0.34, lean: 0.1, leafCell: ATLAS_CELLS.eucalypt, leafSize: [1.8, 2.8],
    leafDensity: 1.5, pendulous: true, bark: c("#bdb3a4"), barkMap: 1, leaf: c("#7b8a5c"),
  },
  // Planted campus gums: white-trunked, fuller crowns from irrigation.
  gardenGum: {
    height: 10, radius: 0.27, fork: 0.38, leaders: [2, 4], leaderAngle: 0.5,
    children: [4, 5], angle: [0.65, 0.8], lengthRatio: [0.62, 0.52], tropism: [0.12, -0.04],
    wiggle: 0.24, lean: 0.07, leafCell: ATLAS_CELLS.eucalypt, leafSize: [1.5, 2.2],
    leafDensity: 2.3, pendulous: true, bark: c("#e2dccf"), barkMap: 1, leaf: c("#82995a"),
  },
};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

type Branch = {
  pts: THREE.Vector3[];
  radii: number[];
  level: number;
};

type Cluster = { pos: THREE.Vector3; size: number; yaw: number };

type Skeleton = {
  branches: Branch[];
  clusters: Cluster[];
  crownCentre: THREE.Vector3;
  crownRadius: number;
};

const UP = new THREE.Vector3(0, 1, 0);

function perpendicular(dir: THREE.Vector3, azimuth: number, out: THREE.Vector3) {
  const a = Math.abs(dir.y) < 0.95 ? UP : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(dir, a).normalize();
  const v = new THREE.Vector3().crossVectors(dir, u).normalize();
  return out.copy(u).multiplyScalar(Math.cos(azimuth)).addScaledVector(v, Math.sin(azimuth));
}

function growSkeleton(rules: Rules, seed: number): Skeleton {
  const r = rng(seed);
  const branches: Branch[] = [];
  const clusters: Cluster[] = [];
  const height = rules.height * (0.85 + r() * 0.3);
  // Levels: 0 trunk, 1 leaders, then one level per `children` entry.
  const maxLevel = rules.children.length + 2;

  const grow = (start: THREE.Vector3, dir: THREE.Vector3, length: number, radius: number, level: number) => {
    const segs = level === 0 ? 7 : level === 1 ? 6 : level === 2 ? 4 : 3;
    const pts = [start.clone()];
    const radii = [radius];
    const d = dir.clone();
    const p = start.clone();
    const tip = level >= maxLevel - 1 ? 0.25 : 0.55;
    for (let s = 1; s <= segs; s++) {
      d.x += (r() - 0.5) * rules.wiggle;
      d.z += (r() - 0.5) * rules.wiggle;
      d.y += (r() - 0.5) * rules.wiggle * 0.5 + (level === 0 ? 0.04 : rules.tropism[Math.min(level - 1, rules.tropism.length - 1)]);
      d.normalize();
      p.addScaledVector(d, length / segs);
      pts.push(p.clone());
      radii.push(radius * (1 - (1 - tip) * (s / segs)));
    }
    const branch: Branch = { pts, radii, level };
    branches.push(branch);

    if (level >= 1 && level >= maxLevel - 2) {
      // Foliage along the outer branches, densest towards the tips.
      const count = Math.max(1, Math.round(length * rules.leafDensity * (level === maxLevel - 1 ? 1 : 0.35)));
      for (let k = 0; k < count; k++) {
        const t = 0.35 + 0.65 * Math.pow((k + r()) / count, 0.7);
        const idx = Math.min(segs - 1, Math.floor(t * segs));
        const q = pts[idx].clone().lerp(pts[idx + 1], t * segs - idx);
        clusters.push({
          pos: q,
          size: rules.leafSize[0] + r() * (rules.leafSize[1] - rules.leafSize[0]),
          yaw: r() * Math.PI * 2,
        });
      }
    }
    if (level >= maxLevel - 1) return;

    const kids =
      level === 0
        ? rules.leaders[0] + Math.floor(r() * (rules.leaders[1] - rules.leaders[0] + 1))
        : rules.children[level - 1];
    const perp = new THREE.Vector3();
    for (let k = 0; k < kids; k++) {
      const azimuth = k * 2.399 + r() * 0.6;
      let t: number;
      let childDir: THREE.Vector3;
      let childLen: number;
      if (level === 0) {
        // Leaders spring from the fork and spread from vertical.
        t = 1;
        perpendicular(UP, azimuth, perp);
        const spread = rules.leaderAngle * (0.7 + r() * 0.6);
        childDir = UP.clone().multiplyScalar(Math.cos(spread)).addScaledVector(perp, Math.sin(spread)).normalize();
        childLen = height * (1 - rules.fork) * (0.65 + r() * 0.35);
      } else {
        t = 0.35 + 0.6 * ((k + r() * 0.5) / kids);
        const ang = rules.angle[level - 1] * (0.75 + r() * 0.5);
        const idx = Math.min(segs - 1, Math.floor(t * segs));
        const bdir = pts[idx + 1].clone().sub(pts[idx]).normalize();
        perpendicular(bdir, azimuth, perp);
        childDir = bdir.multiplyScalar(Math.cos(ang)).addScaledVector(perp, Math.sin(ang)).normalize();
        childLen = length * rules.lengthRatio[level - 1] * (1 - t * 0.35) * (0.8 + r() * 0.4);
      }
      const idx = Math.min(segs - 1, Math.floor(t * segs));
      const from = t >= 1 ? pts[segs].clone() : pts[idx].clone().lerp(pts[idx + 1], t * segs - idx);
      const fromR = t >= 1 ? radii[segs] : radii[idx] + (radii[idx + 1] - radii[idx]) * (t * segs - idx);
      grow(from, childDir, childLen, fromR * (level === 0 ? 0.78 : 0.62), level + 1);
    }
  };

  const leanDir = perpendicular(UP, r() * Math.PI * 2, new THREE.Vector3());
  const stems = rules.stems ? rules.stems[0] + Math.floor(r() * (rules.stems[1] - rules.stems[0] + 1)) : 1;
  for (let s = 0; s < stems; s++) {
    const az = (s / stems) * Math.PI * 2 + r();
    const tilt = stems > 1 ? 0.2 + r() * 0.25 : rules.lean * (0.4 + r());
    const dir = UP.clone()
      .multiplyScalar(Math.cos(tilt))
      .addScaledVector(stems > 1 ? perpendicular(UP, az, new THREE.Vector3()) : leanDir, Math.sin(tilt))
      .normalize();
    const base = new THREE.Vector3(stems > 1 ? Math.cos(az) * 0.08 : 0, -0.15, stems > 1 ? Math.sin(az) * 0.08 : 0);
    grow(base, dir, height * rules.fork + 0.15, rules.radius * (stems > 1 ? 0.75 : 1), 0);
  }

  const box = new THREE.Box3();
  for (const cl of clusters) box.expandByPoint(cl.pos);
  const crownCentre = box.getCenter(new THREE.Vector3());
  const crownRadius = Math.max(1, box.getSize(new THREE.Vector3()).length() * 0.45);
  return { branches, clusters, crownCentre, crownRadius };
}

type Builder = { pos: number[]; nrm: number[]; uv: number[]; col: number[]; idx: number[] };
const builder = (): Builder => ({ pos: [], nrm: [], uv: [], col: [], idx: [] });

function toGeometry(b: Builder) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(b.col, 3));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  return g;
}

function meshBranch(b: Builder, br: Branch, radial: number, step: number, bark: THREE.Color, height: number) {
  const pts: THREE.Vector3[] = [];
  const radii: number[] = [];
  for (let i = 0; i < br.pts.length; i += step) {
    pts.push(br.pts[i]);
    radii.push(br.radii[i]);
  }
  if (pts[pts.length - 1] !== br.pts[br.pts.length - 1]) {
    pts.push(br.pts[br.pts.length - 1]);
    radii.push(br.radii[br.radii.length - 1]);
  }
  const base = b.pos.length / 3;
  const tangent = new THREE.Vector3();
  let normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  let along = 0;
  const repeatsU = Math.max(1, Math.round((Math.PI * 2 * radii[0]) / 0.9));
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    tangent.subVectors(next, prev).normalize();
    // Parallel transport keeps the rings from twisting along the limb.
    if (i === 0) perpendicular(tangent, 0, normal);
    else normal = normal.sub(tangent.clone().multiplyScalar(normal.dot(tangent))).normalize();
    binormal.crossVectors(tangent, normal);
    if (i > 0) along += pts[i].distanceTo(pts[i - 1]);
    // Root flare where the trunk meets the ground.
    const flare = br.level === 0 && i === 0 ? 1.35 : 1;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const n = normal.clone().multiplyScalar(Math.cos(a)).addScaledVector(binormal, Math.sin(a));
      const p = pts[i].clone().addScaledVector(n, radii[i] * flare);
      b.pos.push(p.x, p.y, p.z);
      b.nrm.push(n.x, n.y, n.z);
      b.uv.push((j / radial) * repeatsU, along / 1.1);
      // Ground occlusion at the base, a little shade inside the crown.
      const ao = THREE.MathUtils.clamp(0.55 + p.y * 0.25, 0.55, 1) * (br.level > 1 ? 0.85 : 1);
      const hk = 0.92 + 0.08 * Math.min(1, p.y / height);
      b.col.push(bark.r * ao * hk, bark.g * ao * hk, bark.b * ao * hk);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = base + i * (radial + 1) + j;
      const d = a + radial + 1;
      b.idx.push(a, d, a + 1, a + 1, d, d + 1);
    }
  }
}

function meshCards(b: Builder, sk: Skeleton, rules: Rules, pick: (i: number) => boolean, scale: number) {
  const [u0, v0, u1, v1] = atlasRect(rules.leafCell);
  const inset = 0.004;
  const n = new THREE.Vector3();
  const right = new THREE.Vector3();
  sk.clusters.forEach((cl, i) => {
    if (!pick(i)) return;
    const size = cl.size * scale;
    const toOut = cl.pos.clone().sub(sk.crownCentre);
    const outward = THREE.MathUtils.clamp(toOut.length() / sk.crownRadius, 0, 1);
    n.copy(toOut).normalize().multiplyScalar(0.75).add(new THREE.Vector3(0, 0.45, 0)).normalize();
    const ao = (0.62 + 0.38 * outward) * (0.82 + 0.18 * THREE.MathUtils.clamp((cl.pos.y - sk.crownCentre.y) / sk.crownRadius + 0.5, 0, 1));
    const col = rules.leaf;
    // Two crossed vertical cards per cluster, slightly tipped outwards.
    for (const yaw of [cl.yaw, cl.yaw + Math.PI / 2]) {
      right.set(Math.cos(yaw), 0, Math.sin(yaw)).multiplyScalar(size * 0.5);
      const tip = new THREE.Vector3(toOut.x, 0, toOut.z).normalize().multiplyScalar(size * 0.18);
      const top = rules.pendulous ? cl.pos.clone().add(new THREE.Vector3(0, size * 0.12, 0)) : cl.pos.clone().add(new THREE.Vector3(0, size * 0.9, 0)).add(tip);
      const bottom = rules.pendulous ? cl.pos.clone().add(new THREE.Vector3(0, -size * 0.88, 0)).add(tip) : cl.pos.clone().add(new THREE.Vector3(0, -size * 0.1, 0));
      const base = b.pos.length / 3;
      const corners = [
        [bottom.clone().sub(right), u0 + inset, v0 + inset],
        [bottom.clone().add(right), u1 - inset, v0 + inset],
        [top.clone().add(right), u1 - inset, v1 - inset],
        [top.clone().sub(right), u0 + inset, v1 - inset],
      ] as const;
      for (const [p, u, v] of corners) {
        b.pos.push(p.x, p.y, p.z);
        b.nrm.push(n.x, n.y, n.z);
        b.uv.push(u, v);
        const k = ao * (p.y < cl.pos.y ? 0.9 : 1);
        b.col.push(col.r * k, col.g * k, col.b * k);
      }
      b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  });
}

export type TreeMeshes = {
  height: number;
  near: { wood: THREE.BufferGeometry; leaves: THREE.BufferGeometry };
  far: { wood: THREE.BufferGeometry; leaves: THREE.BufferGeometry };
};

export function buildTree(species: Species, seed: number): TreeMeshes {
  const rules = SPECIES[species];
  const sk = growSkeleton(rules, seed);
  const height = sk.branches.reduce((m, b) => Math.max(m, ...b.pts.map((p) => p.y)), 0);
  const barkColor = rules.bark.clone().convertSRGBToLinear();
  const leafRules = { ...rules, leaf: rules.leaf.clone().convertSRGBToLinear() };

  const nearWood = builder();
  for (const br of sk.branches) {
    const radial = br.level === 0 ? 9 : br.level === 1 ? 6 : br.level === 2 ? 4 : 3;
    meshBranch(nearWood, br, radial, 1, barkColor, height);
  }
  const nearLeaves = builder();
  meshCards(nearLeaves, sk, leafRules, () => true, 1);

  const farWood = builder();
  for (const br of sk.branches) {
    if (br.level > 1) continue;
    meshBranch(farWood, br, br.level === 0 ? 5 : 3, 2, barkColor, height);
  }
  const farLeaves = builder();
  // Every third cluster, enlarged to keep the crown's coverage.
  meshCards(farLeaves, sk, leafRules, (i) => i % 3 === 0, 1.65);

  return {
    height,
    near: { wood: toGeometry(nearWood), leaves: toGeometry(nearLeaves) },
    far: { wood: toGeometry(farWood), leaves: toGeometry(farLeaves) },
  };
}
