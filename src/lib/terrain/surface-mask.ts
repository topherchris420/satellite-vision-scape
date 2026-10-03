import * as THREE from "three";
import {
  buildings,
  domes,
  dishes,
  roadPath,
  interiorRoads,
  topEnclosurePath,
  parkingLots,
  dirtTracks,
  perimeterPath,
  campusBoundaryPath,
  dryWatercourse,
} from "@/lib/site-layout";
import { imageToSite, SURFACE_TRACES, traceRect } from "@/lib/reference-layout";

/**
 * Surface mask over the developed core of the map, baked once by drawing the
 * site layout into canvases and blurring it, so the transitions it encodes are
 * soft by construction:
 *
 *   R  wild ground: 1 = natural scrub, 0 = cleared (roads, pads, buildings)
 *   G  graded ground: compacted gravel inside the compound and around pads
 *   B  traffic dust: compacted, wheel-polished aprons along roads and tracks
 *   A  contact light: 1 = open sky, lower against walls and radome plinths
 *
 * The ground shader, the GPU ground-cover scatter and CPU vegetation
 * placement all read it, so nothing grows on a road and every tuft that is
 * drawn agrees with the ground painted under it.
 */
export const MASK_EXTENT = 800;
export const MASK_SIZE = 1024;
const SCALE = MASK_SIZE / (MASK_EXTENT * 2);

let maskData: Uint8Array | null = null;
let maskTexture: THREE.DataTexture | null = null;

type Ctx = CanvasRenderingContext2D;

function canvas(fill: string): [HTMLCanvasElement, Ctx] {
  const c = document.createElement("canvas");
  c.width = c.height = MASK_SIZE;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
  // Canvas pixels map 1:1 onto mask texels: x right, z down.
  ctx.setTransform(SCALE, 0, 0, SCALE, MASK_EXTENT * SCALE, MASK_EXTENT * SCALE);
  return [c, ctx];
}

function stroke(ctx: Ctx, path: [number, number][], width: number, closed = false) {
  if (path.length < 2) return;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(path[0][0], path[0][1]);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
  if (closed) ctx.closePath();
  ctx.stroke();
}

function polygon(ctx: Ctx, path: [number, number][]) {
  ctx.beginPath();
  ctx.moveTo(path[0][0], path[0][1]);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
  ctx.closePath();
  ctx.fill();
}

function rect(ctx: Ctx, pos: [number, number], size: [number, number], rotY = 0, grow = 0) {
  ctx.save();
  ctx.translate(pos[0], pos[1]);
  // A positive three.js Y rotation maps local +X towards world -Z.
  ctx.rotate(-rotY);
  ctx.fillRect(-size[0] / 2 - grow, -size[1] / 2 - grow, size[0] + grow * 2, size[1] + grow * 2);
  ctx.restore();
}

function circle(ctx: Ctx, pos: [number, number], r: number) {
  ctx.beginPath();
  ctx.arc(pos[0], pos[1], r, 0, Math.PI * 2);
  ctx.fill();
}

/** Blurs a canvas in place by `metres` (gaussian standard deviation). */
function blur(c: HTMLCanvasElement, metres: number) {
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = MASK_SIZE;
  const t = tmp.getContext("2d")!;
  t.filter = `blur(${(metres * SCALE).toFixed(2)}px)`;
  t.drawImage(c, 0, 0);
  const ctx = c.getContext("2d")!;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
}

const roadLoops = () => [
  [...roadPath, roadPath[0]],
  ...interiorRoads,
  [...topEnclosurePath, topEnclosurePath[0]],
];

function buildMaskData(): Uint8Array {
  // R: wild vegetation allowed.
  const [wild, w] = canvas("#fff");
  // The traced facility envelope is kept clear; a faint grey lets a few hardy
  // tussocks survive between the fences, as on the aerial photograph.
  w.fillStyle = "#262626";
  polygon(w, [
    imageToSite(255, 30),
    imageToSite(1070, 30),
    imageToSite(1070, 827),
    imageToSite(255, 827),
  ]);
  w.fillStyle = "#000";
  w.strokeStyle = "#000";
  for (const b of buildings) rect(w, b.pos, b.size, b.rotY ?? 0, 6);
  for (const p of parkingLots) rect(w, p.pos, p.size, p.rotY ?? 0, 5);
  for (const d of domes) circle(w, d.pos, d.radius * 1.5 + 5);
  for (const d of dishes) circle(w, d.pos, d.dishRadius * 1.6 + 5);
  for (const path of roadLoops()) stroke(w, path, 18);
  for (const path of dirtTracks) stroke(w, path, 9);
  stroke(w, [...perimeterPath, perimeterPath[0]], 14);
  stroke(w, dryWatercourse, 14);
  for (const s of SURFACE_TRACES) {
    const r = traceRect(s.bounds);
    rect(w, r.pos, r.size, r.rotY, 3);
  }
  blur(wild, 3.5);

  // G: graded compound ground.
  const [graded, g] = canvas("#000");
  g.fillStyle = "#b0b0b0";
  polygon(g, perimeterPath);
  polygon(g, topEnclosurePath);
  polygon(g, campusBoundaryPath);
  g.fillStyle = "#fff";
  for (const b of buildings) rect(g, b.pos, b.size, b.rotY ?? 0, 9);
  for (const p of parkingLots) rect(g, p.pos, p.size, p.rotY ?? 0, 6);
  for (const d of domes) circle(g, d.pos, d.radius * 1.35 + 8);
  for (const d of dishes) circle(g, d.pos, d.dishRadius * 1.5 + 6);
  blur(graded, 6);

  // B: traffic dust along roads and tracks.
  const [dust, d] = canvas("#000");
  d.strokeStyle = "#fff";
  for (const path of roadLoops()) stroke(d, path, 15);
  d.strokeStyle = "#c8c8c8";
  for (const path of dirtTracks) stroke(d, path, 8);
  d.strokeStyle = "#8a8a8a";
  stroke(d, [...perimeterPath, perimeterPath[0]], 7);
  blur(dust, 3);

  // A: contact light against structures.
  const [contact, c] = canvas("#fff");
  c.fillStyle = "#000";
  for (const b of buildings) rect(c, b.pos, b.size, b.rotY ?? 0, 0.5);
  for (const dm of domes) circle(c, dm.pos, dm.radius * 1.02 + 0.5);
  for (const dish of dishes) circle(c, dish.pos, dish.dishRadius * 0.45);
  blur(contact, 2.2);

  const out = new Uint8Array(MASK_SIZE * MASK_SIZE * 4);
  const read = (cv: HTMLCanvasElement) =>
    cv.getContext("2d")!.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data;
  const channels = [read(wild), read(graded), read(dust), read(contact)];
  for (let i = 0; i < MASK_SIZE * MASK_SIZE; i++) {
    out[i * 4] = channels[0][i * 4];
    out[i * 4 + 1] = channels[1][i * 4];
    out[i * 4 + 2] = channels[2][i * 4];
    out[i * 4 + 3] = channels[3][i * 4];
  }
  return out;
}

export function getSurfaceMaskData(): Uint8Array {
  if (!maskData) maskData = buildMaskData();
  return maskData;
}

export function getSurfaceMaskTexture(): THREE.DataTexture {
  if (maskTexture) return maskTexture;
  const tex = new THREE.DataTexture(getSurfaceMaskData(), MASK_SIZE, MASK_SIZE, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  maskTexture = tex;
  return tex;
}

/** CPU read of the mask (bilinear), 0..1 per channel; outside the core the land is wild. */
export function sampleSurfaceMask(x: number, z: number, channel: number): number {
  const u = (x + MASK_EXTENT) * SCALE - 0.5;
  const v = (z + MASK_EXTENT) * SCALE - 0.5;
  if (u < 0 || v < 0 || u >= MASK_SIZE - 1 || v >= MASK_SIZE - 1) return channel === 0 || channel === 3 ? 1 : 0;
  const data = getSurfaceMaskData();
  const ix = Math.floor(u);
  const iy = Math.floor(v);
  const fx = u - ix;
  const fy = v - iy;
  const at = (i: number, j: number) => data[(j * MASK_SIZE + i) * 4 + channel];
  const a = at(ix, iy);
  const b = at(ix + 1, iy);
  const c = at(ix, iy + 1);
  const d = at(ix + 1, iy + 1);
  return (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) / 255;
}
