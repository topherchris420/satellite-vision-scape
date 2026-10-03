import * as THREE from "three";

/**
 * Small toolkit for extending three's built-in PBR materials with procedural
 * surface detail. Every structure material keeps the stock lighting, shadow,
 * fog and environment code paths, so the extensions stay physically
 * consistent with the rest of the scene under any lighting setup.
 */

/**
 * Phones and other coarse-pointer devices get half the noise octaves in
 * every structure shader (same look at a glance, roughly half the ALU).
 */
const LOW_DETAIL =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

/** Shared GLSL: hashes, value noise and fbm used by the structure shaders. */
export const NOISE_GLSL = /* glsl */ `
float sHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float sNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = sHash12(i);
  float b = sHash12(i + vec2(1.0, 0.0));
  float c = sHash12(i + vec2(0.0, 1.0));
  float d = sHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
#ifndef S_OCTAVES
#define S_OCTAVES 4
#endif
float sFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < S_OCTAVES; i++) {
    v += a * sNoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}
// Height-gradient bump: perturbs the shading normal by the screen-space
// derivative of a procedural height, like three's bump map but for any
// function evaluated in the fragment shader.
vec3 sBump(vec3 surfPos, vec3 surfNorm, float height, float scale) {
  vec3 dpdx = dFdx(surfPos);
  vec3 dpdy = dFdy(surfPos);
  vec3 r1 = cross(dpdy, surfNorm);
  vec3 r2 = cross(surfNorm, dpdx);
  float det = dot(dpdx, r1);
  float dhx = dFdx(height) * scale;
  float dhy = dFdy(height) * scale;
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * surfNorm - grad);
}
// Cotangent frame from screen-space derivatives (as three's normal maps use
// without tangents), for normal maps sampled with procedural coordinates.
mat3 sTangentFrame(vec3 eyePos, vec3 surfNorm, vec2 uv) {
  vec3 q0 = dFdx(eyePos);
  vec3 q1 = dFdy(eyePos);
  vec2 st0 = dFdx(uv);
  vec2 st1 = dFdy(uv);
  vec3 q1perp = cross(q1, surfNorm);
  vec3 q0perp = cross(surfNorm, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = det == 0.0 ? 0.0 : inversesqrt(det);
  return mat3(T * scale, B * scale, surfNorm);
}
`;

/** Varyings every structure material receives: world, object and uv. */
export const COMMON_VERTEX_HEADER = /* glsl */ `
varying vec3 vSWorld;
varying vec3 vSObj;
varying vec2 vSUv;
varying vec3 vSNrmW;
`;
export const COMMON_FRAGMENT_HEADER = COMMON_VERTEX_HEADER;

export const COMMON_VERTEX_MAIN: Inject = {
  after: "#include <begin_vertex>",
  code: /* glsl */ `
  vSUv = uv;
  vSObj = position;
  vec4 sWorld4 = vec4(transformed, 1.0);
  vec3 sNrm = objectNormal;
  #ifdef USE_INSTANCING
    sWorld4 = instanceMatrix * sWorld4;
    sNrm = mat3(instanceMatrix) * sNrm;
  #endif
  vSWorld = (modelMatrix * sWorld4).xyz;
  vSNrmW = normalize(mat3(modelMatrix) * sNrm);
`,
};

type Inject = { after?: string; before?: string; replace?: string; code: string };

export type MaterialPatch = {
  /** Unique key: materials with the same key share one compiled program. */
  key: string;
  uniforms?: Record<string, THREE.IUniform>;
  defines?: Record<string, string | number | boolean>;
  vertexHeader?: string;
  fragmentHeader?: string;
  vertex?: Inject[];
  fragment?: Inject[];
};

function inject(source: string, edits: Inject[] | undefined): string {
  if (!edits) return source;
  for (const e of edits) {
    const anchor = e.after ?? e.before ?? e.replace;
    if (!anchor) continue;
    if (!source.includes(anchor)) {
      throw new Error(`structure shader anchor not found: ${anchor}`);
    }
    if (e.replace) source = source.replace(anchor, e.code);
    else if (e.after) source = source.replace(anchor, `${anchor}\n${e.code}`);
    else source = source.replace(anchor, `${e.code}\n${anchor}`);
  }
  return source;
}

/**
 * Splice GLSL into a stock material at named chunk anchors. Uniform objects
 * are shared by reference, so a single uniform (e.g. the night factor) can
 * drive every material that was patched with it.
 */
export function patchMaterial<M extends THREE.Material>(material: M, patch: MaterialPatch): M {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, patch.uniforms ?? {});
    shader.defines = { ...(shader.defines ?? {}), S_OCTAVES: LOW_DETAIL ? 2 : 4, ...(patch.defines ?? {}) };
    shader.vertexShader = inject(
      shader.vertexShader.replace(
        "#include <common>",
        `#include <common>\n${COMMON_VERTEX_HEADER}\n${patch.vertexHeader ?? ""}`,
      ),
      [COMMON_VERTEX_MAIN, ...(patch.vertex ?? [])],
    );
    shader.fragmentShader = inject(
      shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>\n${COMMON_FRAGMENT_HEADER}\n${NOISE_GLSL}\n${patch.fragmentHeader ?? ""}`,
      ),
      patch.fragment,
    );
  };
  material.customProgramCacheKey = () => `${patch.key}-${LOW_DETAIL ? 2 : 4}`;
  return material;
}
