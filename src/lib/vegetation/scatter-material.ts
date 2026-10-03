import * as THREE from "three";
import { getNoiseTexture } from "@/lib/terrain/noise-texture";
import { getSurfaceMaskTexture } from "@/lib/terrain/surface-mask";
import {
  getHeightTexture,
  SCATTER_COMMON_GLSL,
  SCATTER_HEIGHT_GLSL,
} from "@/lib/terrain/scatter-glsl";
import { windUniforms } from "@/lib/wind";

/**
 * Camera-centred GPU scatter. A fixed grid of instances is laid over the
 * world cells around the viewer every frame; each instance derives its plant
 * entirely from its world cell's hash (presence, jitter, size, yaw, tint), so
 * plants never move as the grid slides, and the CPU does no per-frame work
 * beyond one uniform. Heights come from the exact rendered terrain triangles.
 */

export type ScatterSpec = {
  /** Program cache key and debug name. */
  name: string;
  /** Hash seed; layers sharing a seed and cell describe the same plants. */
  seed: number;
  /** World cell size, metres. */
  cell: number;
  /** Centre jitter inside the cell as [offset, span] (default [0.2, 0.6]). */
  jitter?: [number, number];
  /** Footprint radius range, metres. */
  radius: [number, number];
  /** Height scale range relative to the footprint radius. */
  heightScale: [number, number];
  /** [innerStart, innerEnd, outerStart, outerEnd] distance fades, metres. */
  fade: [number, number, number, number];
  /** GLSL float expression of `p` (vec2 world XZ) and `slope`. */
  density: string;
  /** GLSL vec3 expression of `h` (vec4 hash) and `p`: linear base colour. */
  tint: string;
  /** 0 = grows straight up, 1 = perpendicular to the ground. */
  align: number;
  /** Sink into the ground as a fraction of the radius. */
  sink: number;
  /** Peak wind displacement at the top of the mesh, metres per metre of height. */
  wind: number;
  /** Widen `aSide` blades so they stay about a pixel wide at distance. */
  widen: boolean;
};

export const scatterShared = {
  uViewer: { value: new THREE.Vector3() },
  /** Vertical view angle of one pixel, radians. */
  uPixelAngle: { value: 0.002 },
};

const f = (v: number) => v.toFixed(4);

function parsGLSL(spec: ScatterSpec) {
  return /* glsl */ `
uniform vec3 uViewer;
uniform float uPixelAngle;
uniform int uGridN;
uniform float uWindTime;
uniform vec2 uWindDir;
attribute vec3 aSide;
varying vec3 vScatterTint;
${SCATTER_COMMON_GLSL}
${SCATTER_HEIGHT_GLSL}
float scatterDensity(vec2 p, float slope) { return ${spec.density}; }
vec3 scatterTint(vec4 h, vec2 p) { return ${spec.tint}; }
mat3 sRot;
vec3 sPos;
vec3 sScale;
float sDist;
void scatterSetup() {
  int id = gl_InstanceID;
  vec2 g = vec2(float(id % uGridN), float(id / uGridN)) - float(uGridN / 2);
  vec2 cell = floor(uViewer.xz / ${f(spec.cell)}) + g;
  vec4 h = cellHash(cell, ${spec.seed});
  vec4 h2 = cellHash(cell, ${spec.seed + 7});
  vec2 ctr = (cell + ${f(spec.jitter?.[0] ?? 0.2)} + ${f(spec.jitter?.[1] ?? 0.6)} * h.xy) * ${f(spec.cell)};
  vec3 n;
  float gy = groundHeight(ctr, n);
  float slope = 1.0 - n.y;
  float keep = step(h.z, scatterDensity(ctr, slope));
  float r = mix(${f(spec.radius[0])}, ${f(spec.radius[1])}, h.w);
  vec3 base = vec3(ctr.x, gy, ctr.y);
  sDist = distance(base, uViewer);
  // Hashed hand-off distance so LOD changes never line up into a visible ring.
  float d = sDist + (h2.z - 0.5) * 6.0;
  float fade = smoothstep(${f(spec.fade[0])}, ${f(spec.fade[1])}, d)
    * (1.0 - smoothstep(${f(spec.fade[2])}, ${f(spec.fade[3])}, d));
  float s = r * keep * fade;
  float yaw = h2.x * 6.2831853;
  vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), n, ${f(spec.align)}));
  vec3 fwd = vec3(cos(yaw), 0.0, sin(yaw));
  vec3 right = normalize(cross(up, fwd));
  fwd = cross(right, up);
  sRot = mat3(right, up, fwd);
  sScale = vec3(s, s * mix(${f(spec.heightScale[0])}, ${f(spec.heightScale[1])}, h2.y), s);
  sPos = base - up * ${f(spec.sink)} * s;
  vScatterTint = scatterTint(h2, ctr);
}
`;
}

const BEGIN_VERTEX = (spec: ScatterSpec) => /* glsl */ `
#ifndef SCATTER_READY
scatterSetup();
#endif
vec3 sLocal = position + aSide;
${
  spec.widen
    ? `float sNeed = sDist * uPixelAngle * 0.6;
float sHave = length(aSide) * sScale.x + 1e-5;
sLocal += aSide * clamp(sNeed / sHave - 1.0, 0.0, 3.0);`
    : ""
}
vec3 transformed = sRot * (sLocal * sScale) + sPos;
float sH = max(sLocal.y, 0.0);
float sPhase = dot(sPos.xz, vec2(0.173, 0.211));
float sWave = sin(uWindTime * 2.1 + sPhase) + 0.45 * sin(uWindTime * 4.83 + sPhase * 1.7);
float sGust = 0.5 + 0.5 * sin(uWindTime * 0.37 + sPos.x * 0.004);
transformed.xz += uWindDir * (sWave * 0.6 + sGust) * ${f(spec.wind)} * sH * sH * sScale.y;
`;

function uniformsFor(gridN: number) {
  return {
    tNoise: { value: getNoiseTexture() },
    tMask: { value: getSurfaceMaskTexture() },
    tHeight: { value: getHeightTexture() },
    uViewer: scatterShared.uViewer,
    uPixelAngle: scatterShared.uPixelAngle,
    uWindTime: windUniforms.uWindTime,
    uWindDir: windUniforms.uWindDir,
    uGridN: { value: gridN },
  };
}

export function createScatterMaterials(
  spec: ScatterSpec,
  gridN: number,
  base: THREE.MeshStandardMaterialParameters,
) {
  const uniforms = uniformsFor(gridN);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, ...base });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${parsGLSL(spec)}`)
      .replace(
        "#include <beginnormal_vertex>",
        `scatterSetup();
#define SCATTER_READY
vec3 objectNormal = sRot * vec3( normal );`,
      )
      .replace("#include <begin_vertex>", BEGIN_VERTEX(spec));
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vScatterTint;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= vScatterTint;")
      // Foliage keeps its bent dome normal on both faces of a blade, so the
      // far side of a needle is not lit as if it faced away from the sun.
      .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\nnormal = normalize( vNormal );");
  };
  material.customProgramCacheKey = () => `scatter-${spec.name}`;

  const depth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: base.side ?? THREE.FrontSide,
    // Alpha-tested cards cast leaf-shaped shadows.
    map: base.map ?? null,
    alphaTest: base.alphaTest ?? 0,
  });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${parsGLSL(spec)}`)
      .replace("#include <begin_vertex>", BEGIN_VERTEX(spec));
  };
  depth.customProgramCacheKey = () => `scatter-depth-${spec.name}`;
  return { material, depth, uniforms };
}

/** Instanced geometry sharing the base mesh's attributes, one instance per cell. */
export function scatterGeometry(source: THREE.BufferGeometry, gridN: number) {
  const g = new THREE.InstancedBufferGeometry();
  for (const [name, attr] of Object.entries(source.attributes)) g.setAttribute(name, attr);
  if (source.index) g.setIndex(source.index);
  g.instanceCount = gridN * gridN;
  return g;
}

/** Odd grid width covering a viewer-centred square of the given radius. */
export function gridSize(range: number, cell: number) {
  return Math.ceil(range / cell) * 2 + 1;
}

export const glsl = { f };
