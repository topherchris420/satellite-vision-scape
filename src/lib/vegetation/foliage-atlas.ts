import * as THREE from "three";

/**
 * Painted foliage atlas, 2 x 2 cells with alpha:
 *
 *   0  eucalypt sprigs: pendulous lanceolate leaves on fine twigs
 *   1  desert oak: weeping, jointed needle-like branchlets
 *   2  mulga: narrow, upward silvery phyllodes
 *   3  saltbush: dense small rounded leaves
 *
 * Leaves are painted mid-light and slightly desaturated; species colour is
 * applied through vertex colours so one material serves every tree.
 */
export const ATLAS_CELLS = { eucalypt: 0, desertOak: 1, mulga: 2, saltbush: 3 } as const;
export type AtlasCell = (typeof ATLAS_CELLS)[keyof typeof ATLAS_CELLS];

const SIZE = 1024;
const CELL = SIZE / 2;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

type Ctx = CanvasRenderingContext2D;

function shade(base: [number, number, number], k: number, r: () => number, spread = 0.12) {
  const j = 1 + (r() - 0.5) * spread;
  return `rgb(${Math.min(255, base[0] * k * j) | 0},${Math.min(255, base[1] * k * j) | 0},${Math.min(255, base[2] * k * (1 + (r() - 0.5) * spread)) | 0})`;
}

/** Lanceolate leaf from (x, y) along `angle`, with a paler midrib. */
function leaf(ctx: Ctx, x: number, y: number, angle: number, len: number, wid: number, fill: string, rib: string, curl = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(len * 0.25, -wid, len * 0.7, -wid * 0.8 + curl, len, curl * 1.6);
  ctx.bezierCurveTo(len * 0.7, wid * 0.8 + curl, len * 0.25, wid, 0, 0);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = rib;
  ctx.lineWidth = Math.max(0.8, wid * 0.12);
  ctx.beginPath();
  ctx.moveTo(len * 0.04, 0);
  ctx.quadraticCurveTo(len * 0.5, curl * 0.6, len * 0.92, curl * 1.4);
  ctx.stroke();
  ctx.restore();
}

function twig(ctx: Ctx, pts: [number, number][], width: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

/** Eucalypt: several twigs fanning down from the top, leaves hanging. */
function paintEucalypt(ctx: Ctx, ox: number, oy: number) {
  const r = rng(51);
  const base: [number, number, number] = [150, 160, 112];
  for (let t = 0; t < 9; t++) {
    const a = Math.PI * (0.15 + 0.7 * (t / 8)) + (r() - 0.5) * 0.25;
    const len = CELL * (0.32 + r() * 0.16);
    let x = ox + CELL * 0.5 + (r() - 0.5) * 30;
    let y = oy + CELL * 0.1 + r() * 20;
    const pts: [number, number][] = [[x, y]];
    const steps = 7;
    for (let s = 0; s < steps; s++) {
      const droop = s / steps;
      x += (Math.cos(a) * len) / steps;
      y += ((Math.sin(a) + droop * 0.9) * len) / steps;
      pts.push([x, y]);
    }
    twig(ctx, pts, 2.6, "rgb(118,92,70)");
    for (let s = 1; s < pts.length; s++) {
      for (const side of [-1, 1]) {
        if (r() < 0.15) continue;
        const [px, py] = pts[s];
        // Eucalypt leaves hang edge-on, so most point downwards.
        const ang = Math.PI / 2 + side * (0.25 + r() * 0.5) + (r() - 0.5) * 0.3;
        const k = 0.72 + r() * 0.5;
        leaf(ctx, px, py, ang, 46 + r() * 34, 7 + r() * 5, shade(base, k, r), shade(base, k * 1.25, r, 0.05), (r() - 0.5) * 10);
      }
    }
    // Terminal cluster.
    const [ex, ey] = pts[pts.length - 1];
    for (let k = 0; k < 4; k++) {
      leaf(ctx, ex, ey, Math.PI / 2 + (r() - 0.5) * 1.2, 40 + r() * 30, 6 + r() * 4, shade(base, 0.8 + r() * 0.4, r), shade(base, 1.1, r, 0.05));
    }
  }
}

/** Desert oak: dense curtains of fine jointed branchlets that weep. */
function paintDesertOak(ctx: Ctx, ox: number, oy: number) {
  const r = rng(77);
  const base: [number, number, number] = [118, 130, 102];
  for (let i = 0; i < 230; i++) {
    let x = ox + CELL * (0.1 + r() * 0.8);
    let y = oy + CELL * (0.04 + r() * 0.3);
    const len = CELL * (0.35 + r() * 0.45);
    const sway = (r() - 0.5) * 0.8;
    const k = 0.6 + r() * 0.6;
    ctx.strokeStyle = shade(base, k, r);
    ctx.lineWidth = 1.4 + r() * 1.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    const steps = 10;
    for (let s = 0; s < steps; s++) {
      x += sway * 4 + (r() - 0.5) * 2;
      y += len / steps;
      if (y > oy + CELL - 4) break;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Joint rings (the "cladodes" read as tiny beads at a distance).
    ctx.fillStyle = shade(base, k * 0.8, r);
    for (let s = 0; s < 3; s++) ctx.fillRect(x - 1, y - len * (0.2 + s * 0.25), 2.4, 1.6);
  }
}

/** Mulga: upward fans of narrow silvery phyllodes. */
function paintMulga(ctx: Ctx, ox: number, oy: number) {
  const r = rng(91);
  const base: [number, number, number] = [152, 158, 128];
  for (let t = 0; t < 14; t++) {
    const x0 = ox + CELL * (0.3 + r() * 0.4);
    const y0 = oy + CELL * (0.88 - r() * 0.1);
    const a = -Math.PI / 2 + (r() - 0.5) * 1.6;
    const len = CELL * (0.35 + r() * 0.3);
    const x1 = x0 + Math.cos(a) * len;
    const y1 = y0 + Math.sin(a) * len;
    twig(ctx, [[x0, y0], [x1, y1]], 2.2, "rgb(90,78,64)");
    for (let s = 0; s < 16; s++) {
      const t2 = 0.25 + (s / 16) * 0.75;
      const px = x0 + (x1 - x0) * t2;
      const py = y0 + (y1 - y0) * t2;
      const ang = a + (r() < 0.5 ? -1 : 1) * (0.25 + r() * 0.5);
      const k = 0.7 + r() * 0.5;
      leaf(ctx, px, py, ang, 34 + r() * 26, 3 + r() * 2.2, shade(base, k, r), shade(base, k * 1.15, r, 0.05));
    }
  }
}

/** Saltbush: a dense mound of small grey-blue leaves. */
function paintSaltbush(ctx: Ctx, ox: number, oy: number) {
  const r = rng(13);
  const base: [number, number, number] = [150, 162, 150];
  const cx = ox + CELL / 2;
  const cy = oy + CELL * 0.62;
  for (let i = 0; i < 1100; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r());
    const x = cx + Math.cos(a) * d * CELL * 0.44;
    const y = cy + Math.sin(a) * d * CELL * 0.34 - (1 - d) * CELL * 0.12;
    if (y > oy + CELL - 6) continue;
    const k = 0.62 + r() * 0.55 + (1 - d) * 0.1;
    leaf(ctx, x, y, r() * Math.PI * 2, 12 + r() * 9, 4.5 + r() * 3, shade(base, k, r), shade(base, k * 1.1, r, 0.04));
  }
}

let atlas: THREE.CanvasTexture | null = null;
let atlasMean = new THREE.Vector3(0.3, 0.3, 0.3);

/** Mean linear colour of the painted leaves (opaque texels only). */
export function getFoliageAtlasMean() {
  getFoliageAtlas();
  return atlasMean;
}

export function getFoliageAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, SIZE, SIZE);
  paintEucalypt(ctx, 0, 0);
  paintDesertOak(ctx, CELL, 0);
  paintMulga(ctx, 0, CELL);
  paintSaltbush(ctx, CELL, CELL);
  // Bleed leaf colour into transparent texels so mip-mapping and bilinear
  // filtering at leaf edges never pull in black.
  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  const d = img.data;
  for (let pass = 0; pass < 4; pass++) {
    for (let y = 1; y < SIZE - 1; y++) {
      for (let x = 1; x < SIZE - 1; x++) {
        const i = (y * SIZE + x) * 4;
        if (d[i + 3] > 0) continue;
        for (const o of [4, -4, SIZE * 4, -SIZE * 4]) {
          if (d[i + o + 3] > 0) {
            d[i] = d[i + o];
            d[i + 1] = d[i + o + 1];
            d[i + 2] = d[i + o + 2];
            d[i + 3] = 1;
            break;
          }
        }
      }
    }
  }
  const lin = (v: number) => ((v / 255 + 0.055) / 1.055) ** 2.4;
  const sum = new THREE.Vector3();
  let count = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 1) d[i + 3] = 0;
    else if (d[i + 3] > 200 && (i & 60) === 0) {
      sum.x += lin(d[i]);
      sum.y += lin(d[i + 1]);
      sum.z += lin(d[i + 2]);
      count++;
    }
  }
  atlasMean = sum.multiplyScalar(1 / Math.max(1, count));
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.premultiplyAlpha = false;
  atlas = tex;
  return tex;
}

/** UV rectangle [u0, v0, u1, v1] of an atlas cell (v up, three.js convention). */
export function atlasRect(cell: number): [number, number, number, number] {
  const cx = cell % 2;
  const cy = Math.floor(cell / 2);
  // Canvas rows run downwards; texture v runs upwards (flipY).
  return [cx * 0.5, 1 - (cy + 1) * 0.5, cx * 0.5 + 0.5, 1 - cy * 0.5];
}
