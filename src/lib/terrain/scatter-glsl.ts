import * as THREE from "three";
import {
  getTerrainGrid,
  TERRAIN_CORE_EXTENT,
  TERRAIN_CORE_SPACING,
  TERRAIN_EXTENT,
  TERRAIN_OUTER_SPACING,
} from "./mesh-grid";
import { MASK_EXTENT } from "./surface-mask";

/**
 * GLSL shared by the ground shader and the GPU ground-cover scatter. Both
 * evaluate the same hash on the same world cells and read the same mask and
 * noise textures at mip 0, so a spinifex hummock drawn as geometry near the
 * camera and the footprint painted into the ground far away are the same
 * plant: walking towards a freckle on the plain turns it into a hummock in
 * place.
 */

const outerCount = Math.round((TERRAIN_EXTENT - TERRAIN_CORE_EXTENT) / TERRAIN_OUTER_SPACING);
const coreCount = Math.round((TERRAIN_CORE_EXTENT * 2) / TERRAIN_CORE_SPACING);
const f = (v: number) => v.toFixed(4);

export const SCATTER_COMMON_GLSL = /* glsl */ `
uniform sampler2D tNoise;
uniform sampler2D tMask;

uvec3 sgPcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
// Four uniform randoms in [0, 1) for an integer world cell and a layer seed.
vec4 cellHash(vec2 cell, int seed) {
  uvec3 h = sgPcg3d(uvec3(ivec3(int(cell.x), int(cell.y), seed) + 1048576));
  return vec4(vec3(h), float(h.x ^ (h.y >> 3u))) * (1.0 / 4294967296.0);
}
vec4 maskAt(vec2 p) {
  return textureLod(tMask, (p + ${f(MASK_EXTENT)}) / ${f(MASK_EXTENT * 2)}, 0.0);
}
// Large-scale biome fields (see ground material for the painted layers).
float clayPanField(vec2 p) {
  vec4 a = textureLod(tNoise, p / 1400.0, 0.0);
  vec4 c = textureLod(tNoise, p / 61.0 + 0.5, 0.0);
  return a.w + 0.16 * (c.y - 0.5) - 0.06;
}
float washField(vec2 p) {
  vec4 b = textureLod(tNoise, p / 420.0 + 0.31, 0.0);
  float w = textureLod(tNoise, p / 900.0 + (b.xy - 0.5) * 0.12 + 0.13, 0.0).z;
  // Drainage only organises in some districts; elsewhere the field never
  // reaches the channel threshold.
  float district = smoothstep(0.42, 0.6, textureLod(tNoise, p / 1400.0 + 0.57, 0.0).y);
  return abs(w - 0.5) + (1.0 - district) * 0.05;
}
// 1 inside a dry wash channel, fading over its banks.
float washMask(vec2 p, float slope) {
  return (1.0 - smoothstep(0.004, 0.012, washField(p))) * (1.0 - smoothstep(0.04, 0.1, slope));
}
float spinifexDensity(vec2 p, float slope) {
  vec4 m = maskAt(p);
  vec4 b = textureLod(tNoise, p / 420.0 + 0.31, 0.0);
  vec4 c = textureLod(tNoise, p / 61.0 + 0.5, 0.0);
  float d = 0.34 + 0.5 * smoothstep(0.3, 0.72, b.y) + 0.3 * (c.x - 0.5);
  // Hummocks gather in drifts and leave bare runs between them.
  d *= 0.5 + 0.9 * textureLod(tNoise, p / 17.0 + 0.3, 0.0).x;
  d *= 1.0 - smoothstep(0.66, 0.72, clayPanField(p));
  d *= 1.0 - smoothstep(0.3, 0.52, slope) * 0.85;
  d *= 1.0 - 0.75 * washMask(p, slope);
  d *= m.r * (1.0 - m.b);
  return clamp(d, 0.0, 0.9);
}
`;

/** Exact rendered-mesh height lookup for vertex shaders (see mesh-grid.ts). */
export const SCATTER_HEIGHT_GLSL = /* glsl */ `
uniform highp sampler2D tHeight;
float sgAxis(float v) {
  if (v < ${f(-TERRAIN_CORE_EXTENT)}) return (v + ${f(TERRAIN_EXTENT)}) / ${f(TERRAIN_OUTER_SPACING)};
  if (v < ${f(TERRAIN_CORE_EXTENT)}) return ${f(outerCount)} + (v + ${f(TERRAIN_CORE_EXTENT)}) / ${f(TERRAIN_CORE_SPACING)};
  return ${f(outerCount + coreCount)} + (v - ${f(TERRAIN_CORE_EXTENT)}) / ${f(TERRAIN_OUTER_SPACING)};
}
float sgSpacing(float i) {
  return (i >= ${f(outerCount)} && i < ${f(outerCount + coreCount)}) ? ${f(TERRAIN_CORE_SPACING)} : ${f(TERRAIN_OUTER_SPACING)};
}
// Height of the rendered triangle under p, and its facet normal.
float groundHeight(vec2 p, out vec3 n) {
  float last = float(textureSize(tHeight, 0).x - 1);
  vec2 g = clamp(vec2(sgAxis(p.x), sgAxis(p.y)), vec2(0.0), vec2(last - 0.0001));
  vec2 i = floor(g);
  vec2 t = g - i;
  ivec2 c = ivec2(i);
  float h00 = texelFetch(tHeight, c, 0).r;
  float h10 = texelFetch(tHeight, c + ivec2(1, 0), 0).r;
  float h01 = texelFetch(tHeight, c + ivec2(0, 1), 0).r;
  float dx = sgSpacing(i.x);
  float dz = sgSpacing(i.y);
  float h;
  vec2 grad;
  if (t.x + t.y <= 1.0) {
    h = h00 + (h10 - h00) * t.x + (h01 - h00) * t.y;
    grad = vec2(h10 - h00, h01 - h00);
  } else {
    float h11 = texelFetch(tHeight, c + ivec2(1, 1), 0).r;
    h = h11 + (h01 - h11) * (1.0 - t.x) + (h10 - h11) * (1.0 - t.y);
    grad = vec2(h11 - h01, h11 - h10);
  }
  n = normalize(vec3(-grad.x / dx, 1.0, -grad.y / dz));
  return h;
}
`;

let heightTexture: THREE.DataTexture | null = null;

/** The shared terrain grid as a float texture, read with texelFetch. */
export function getHeightTexture(): THREE.DataTexture {
  if (heightTexture) return heightTexture;
  const { size, heights } = getTerrainGrid();
  const tex = new THREE.DataTexture(heights, size, size, THREE.RedFormat, THREE.FloatType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  heightTexture = tex;
  return tex;
}
