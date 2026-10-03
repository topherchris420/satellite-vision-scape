import * as THREE from "three";
import type { PackedLayers } from "./layer-textures";
import { getNoiseTexture } from "./noise-texture";
import { getSurfaceMaskTexture, MASK_EXTENT } from "./surface-mask";
import { SCATTER_COMMON_GLSL } from "./scatter-glsl";

/**
 * Outback ground shader layered over MeshStandardMaterial, so it keeps the
 * scene's lights, shadows, fog and tone mapping.
 *
 * Six photographic layers (red sand, laterite soil, gibber gravel, clay pan,
 * quartzite cliff, rock) are blended by height maps, with weights from slope,
 * baked terrain curvature, the site surface mask and multi-scale noise. Every
 * layer is re-tinted towards an art-directed colour (texture / mean x tint) so
 * the photographs supply detail while the palette stays coherent. Tiling is
 * broken by per-region virtual offsets (two taps, blended on a smooth noise
 * index). On top: wash channels, quartzite strata and fall-line rills on the
 * ranges, spinifex footprints that match the GPU scatter, traffic dust and
 * contact occlusion near structures.
 */

/** Spinifex scatter cell, metres; ground footprints and hummocks share it. */
export const SPINIFEX_CELL = 2.2;
/** Hashed radius range of a hummock as a fraction of the cell. */
export const SPINIFEX_RADIUS: [number, number] = [0.16, 0.46];
/** Jitter of a hummock centre inside its cell: [offset, span]. */
export const SPINIFEX_JITTER: [number, number] = [0.08, 0.84];
export const SPINIFEX_SEED = 17;

const srgb = (hex: string) => new THREE.Color(hex);

/** Art-directed layer colours (sRGB), central Australian red-centre palette. */
const LAYER_TINTS = [
  srgb("#a9593c"), // red sand
  srgb("#965238"), // laterite soil with stones
  srgb("#7a4a36"), // gibber gravel with desert varnish
  srgb("#b38a72"), // clay pan, pale pink-buff
  srgb("#b06a45"), // quartzite / sandstone cliff
  srgb("#8c5038"), // weathered rock
];
/** World size of one texture repeat, metres. */
const LAYER_SCALE = [3.2, 2.4, 2.1, 5.5, 7.5, 4.2];
/** Normal map strength per layer. */
const LAYER_NORMAL = [0.9, 1.1, 1.25, 0.8, 1.35, 1.2];

export type GroundQuality = 0 | 1 | 2 | 3;

export type GroundMaterial = THREE.MeshStandardMaterial & {
  userData: { uniforms: Record<string, THREE.IUniform> };
};

export function createGroundMaterial(layers: PackedLayers, quality: GroundQuality): GroundMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
  }) as GroundMaterial;
  const uniforms: Record<string, THREE.IUniform> = {
    tAlbedo: { value: layers.albedo },
    tDetail: { value: layers.detail },
    tNoise: { value: getNoiseTexture() },
    tMask: { value: getSurfaceMaskTexture() },
    uLayerMean: { value: layers.mean },
    uLayerTint: {
      value: LAYER_TINTS.map((c) => new THREE.Vector3(c.r, c.g, c.b)),
    },
    uLayerScale: { value: LAYER_SCALE.map((s) => 1 / s) },
    uLayerNormal: { value: LAYER_NORMAL },
    uSpinFade: { value: new THREE.Vector2(70, 95) },
  };
  material.userData.uniforms = uniforms;
  material.defines = { GROUND_QUALITY: quality };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec2 aMacro;
varying vec3 vTWorld;
varying vec3 vTNormal;
varying vec2 vTMacro;`,
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
vTWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vTNormal = normalize( mat3( modelMatrix ) * objectNormal );
vTMacro = aMacro;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GROUND_PARS}`)
      .replace("#include <map_fragment>", GROUND_MAIN)
      .replace(
        "#include <roughnessmap_fragment>",
        "float roughnessFactor = gRough;",
      )
      .replace(
        "#include <normal_fragment_maps>",
        "normal = normalize( ( viewMatrix * vec4( gNormal, 0.0 ) ).xyz );",
      )
      .replace(
        "#include <aomap_fragment>",
        `reflectedLight.indirectDiffuse *= gAO;
#if defined( USE_ENVMAP ) && defined( STANDARD )
reflectedLight.indirectSpecular *= computeSpecularOcclusion( saturate( dot( geometryNormal, geometryViewDir ) ), gAO, material.roughness );
#endif`,
      );
  };
  material.customProgramCacheKey = () => `pine-gap-ground-${quality}`;
  return material;
}

const GROUND_PARS = /* glsl */ `
uniform highp sampler2DArray tAlbedo;
uniform highp sampler2DArray tDetail;
uniform vec3 uLayerMean[6];
uniform vec3 uLayerTint[6];
uniform float uLayerScale[6];
uniform float uLayerNormal[6];
uniform vec2 uSpinFade;
varying vec3 vTWorld;
varying vec3 vTNormal;
varying vec2 vTMacro;
${SCATTER_COMMON_GLSL}

// Two-tap texture variation (virtual pattern offsets switched on a smooth
// index) so no repeat is ever recognisable; derivatives come from the
// un-offset coordinates so the switch never produces mip seams.
void sampleLayer(int layer, vec2 uv, vec2 dx, vec2 dy, float k, out vec4 alb, out vec4 det) {
#if GROUND_QUALITY > 0
  float l = k * 6.0;
  float ia = floor(l);
  float fr = fract(l);
  vec2 oa = sin(vec2(3.0, 7.0) * ia);
  vec2 ob = sin(vec2(3.0, 7.0) * (ia + 1.0));
  vec4 a1 = textureGrad(tAlbedo, vec3(uv + oa, float(layer)), dx, dy);
  vec4 a2 = textureGrad(tAlbedo, vec3(uv + ob, float(layer)), dx, dy);
  vec4 d1 = textureGrad(tDetail, vec3(uv + oa, float(layer)), dx, dy);
  vec4 d2 = textureGrad(tDetail, vec3(uv + ob, float(layer)), dx, dy);
  float b = smoothstep(0.2, 0.8, fr - 0.6 * (d1.b - d2.b));
  alb = mix(a1, a2, b);
  det = mix(d1, d2, b);
#else
  alb = textureGrad(tAlbedo, vec3(uv, float(layer)), dx, dy);
  det = textureGrad(tDetail, vec3(uv, float(layer)), dx, dy);
#endif
}

vec3 unpackTangent(vec4 det, float strength) {
  vec2 xy = (det.rg * 2.0 - 1.0) * strength;
  return vec3(xy, sqrt(saturate(1.0 - dot(xy, xy))));
}

// Whiteout blend of a top-projected (u = x, v = -z) tangent normal onto n.
vec3 topNormal(vec3 t, vec3 n) {
  vec3 w = vec3(vec2(t.x, -t.y) + n.xz, t.z * n.y);
  return normalize(vec3(w.x, w.z, w.y));
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

const GROUND_MAIN = /* glsl */ `
vec3 P = vTWorld;
vec3 Ng = normalize(vTNormal);
float viewDist = length(cameraPosition - P);
vec3 dPx = dFdx(P);
vec3 dPy = dFdy(P);
float pixelMetres = max(length(dPx.xz), length(dPy.xz));

vec4 msk = texture(tMask, (P.xz + ${MASK_EXTENT.toFixed(1)}) / ${(MASK_EXTENT * 2).toFixed(1)});
float wild = msk.r;
float graded = msk.g;
float traffic = msk.b;
float contactLight = msk.a;

vec4 nA = texture(tNoise, P.xz / 1400.0);
vec4 nB = texture(tNoise, P.xz / 420.0 + 0.31);
vec4 nC = texture(tNoise, P.xz / 61.0 + 0.5);
vec4 nD = texture(tNoise, P.xz / 13.0 + 0.17);
float slope = 1.0 - Ng.y;
float cav = vTMacro.x;   // + hollow, - knoll (10 m)
float cavL = vTMacro.y;  // + valley, - ridge (45 m)
float relief = smoothstep(0.03, 0.2, slope);

// ---- Fall-line rills and gullies on the ranges --------------------------
float rill = 0.5;
vec3 Nm = Ng;
#if GROUND_QUALITY > 0
{
  vec2 down = normalize(Ng.xz + 1e-5);
  vec2 across = vec2(-down.y, down.x);
  vec2 ruv = vec2(dot(P.xz, across) / 26.0, dot(P.xz, down) / 190.0 + P.y / 520.0);
  float r0 = texture(tNoise, ruv).x;
  float r1 = texture(tNoise, ruv + vec2(0.025, 0.0)).x;
  float r2 = texture(tNoise, ruv * 2.7 + 0.4).y;
  rill = mix(r0, r2, 0.35);
  float dr = (r1 - r0) / 0.025;
  float sw = smoothstep(0.04, 0.16, slope);
  Nm = normalize(Ng + vec3(across.x, 0.0, across.y) * dr * 0.11 * sw);
}
#endif
float gully = smoothstep(0.42, 0.25, rill) * relief;   // incised channels
float spur = smoothstep(0.58, 0.78, rill) * relief;    // rocky spurs between them

// ---- Layer weights -----------------------------------------------------
float washW = wild * washMask(P.xz, slope);
float clayW = smoothstep(0.66, 0.74, clayPanField(P.xz) + cavL * 0.12 + (nD.y - 0.5) * 0.05) * (1.0 - smoothstep(0.015, 0.05, slope)) * (1.0 - graded);
float sandW = smoothstep(0.38, 0.66, nB.y + 0.25 * (nC.z - 0.5) + max(cav, 0.0) * 0.4) * (1.0 - relief);
sandW = max(sandW, washW);
float gravelW = smoothstep(0.55, 0.72, nB.z + 0.3 * (nC.w - 0.5) + slope * 0.9 + max(-cav, 0.0) * 0.6);
gravelW = max(gravelW * (1.0 - washW), graded * 0.85);
// Bedrock breaks through on steep faces, ridge crests and knolls; hollows
// and gullies keep their soil.
float cliffW = smoothstep(0.085, 0.22, slope + 0.14 * (nC.x - 0.5) + max(-cavL, 0.0) * 0.35 + max(-cav, 0.0) * 0.12 + spur * 0.15 - gully * 0.1);
float rockW = smoothstep(0.5, 0.68, nC.x + slope * 2.2 + spur * 0.4 + max(-cav, 0.0) * 0.5 - max(cav, 0.0)) * smoothstep(0.025, 0.09, slope) * (1.0 - cliffW * 0.5);

float w[6];
w[0] = sandW * (1.0 - clayW);
w[1] = 0.45;
w[2] = gravelW * (1.0 - clayW);
w[3] = clayW;
w[4] = cliffW;
w[5] = rockW;

// ---- Sample the layers that matter ---------------------------------------
float k = nD.w * 0.6 + nC.y * 0.4;
vec4 alb[6];
vec4 det[6];
vec3 tn[6];
for (int i = 0; i < 6; i++) {
  alb[i] = vec4(uLayerMean[i], 0.9);
  det[i] = vec4(0.5, 0.5, 0.5, 1.0);
  tn[i] = vec3(0.0, 0.0, 1.0);
}
vec3 bl = pow(abs(Ng), vec3(4.0));
bl /= (bl.x + bl.y + bl.z);
for (int i = 0; i < 6; i++) {
  if (w[i] < 0.015) continue;
  float s = uLayerScale[i];
  vec2 uv = vec2(P.x, -P.z) * s;
  vec2 dx = vec2(dPx.x, -dPx.z) * s;
  vec2 dy = vec2(dPy.x, -dPy.z) * s;
  if (i == 4) {
    // Quartzite faces: projected on the vertical planes so strata stay level.
    vec3 axisSign = sign(Ng);
    vec2 uvX = vec2(P.z * axisSign.x, P.y) * s;
    vec2 uvZ = vec2(-P.x * axisSign.z, P.y) * s;
    vec4 aX = textureGrad(tAlbedo, vec3(uvX, 4.0), vec2(dPx.z, dPx.y) * s, vec2(dPy.z, dPy.y) * s);
    vec4 dX = textureGrad(tDetail, vec3(uvX, 4.0), vec2(dPx.z, dPx.y) * s, vec2(dPy.z, dPy.y) * s);
    vec4 aZ = textureGrad(tAlbedo, vec3(uvZ, 4.0), vec2(dPx.x, dPx.y) * s, vec2(dPy.x, dPy.y) * s);
    vec4 dZ = textureGrad(tDetail, vec3(uvZ, 4.0), vec2(dPx.x, dPx.y) * s, vec2(dPy.x, dPy.y) * s);
    vec4 aY;
    vec4 dY;
    sampleLayer(4, uv, dx, dy, k, aY, dY);
    vec3 tX = unpackTangent(dX, uLayerNormal[4]);
    vec3 tZ = unpackTangent(dZ, uLayerNormal[4]);
    vec3 tY = unpackTangent(dY, uLayerNormal[4]);
    tX.x *= axisSign.x;
    tZ.x *= -axisSign.z;
    vec3 wx = vec3(tX.xy + Ng.zy, abs(tX.z) * Ng.x);
    vec3 wz = vec3(tZ.xy + Ng.xy, abs(tZ.z) * Ng.z);
    vec3 wy = topNormal(tY, Ng);
    alb[4] = aX * bl.x + aY * bl.y + aZ * bl.z;
    det[4] = dX * bl.x + dY * bl.y + dZ * bl.z;
    // Stored as a world-space normal; flagged by z > 1 below.
    tn[4] = normalize(wx.zyx * bl.x + wy * bl.y + wz.xyz * bl.z);
  } else {
    sampleLayer(i, uv, dx, dy, k + float(i) * 0.13, alb[i], det[i]);
    tn[i] = unpackTangent(det[i], uLayerNormal[i]);
  }
}

// ---- Height-based blend ----------------------------------------------------
float hb[6];
float hmax = 0.0;
for (int i = 0; i < 6; i++) {
  hb[i] = w[i] > 0.015 ? det[i].b * 0.55 + w[i] * 1.2 : -1.0;
  hmax = max(hmax, hb[i]);
}
float wsum = 0.0;
for (int i = 0; i < 6; i++) {
  hb[i] = max(hb[i] - hmax + 0.22, 0.0);
  wsum += hb[i];
}
vec3 gAlbedo = vec3(0.0);
float gRough = 0.0;
vec3 tnBlend = vec3(0.0);
vec3 cliffN = vec3(0.0);
float cliffShare = 0.0;
for (int i = 0; i < 6; i++) {
  float wi = hb[i] / wsum;
  if (wi <= 0.0) continue;
  vec3 detailRatio = clamp(alb[i].rgb / max(uLayerMean[i], vec3(1e-3)), vec3(0.0), vec3(3.0));
  gAlbedo += uLayerTint[i] * detailRatio * wi;
  gRough += alb[i].a * wi;
  if (i == 4) { cliffN = tn[4]; cliffShare = wi; }
  else tnBlend += tn[i] * wi;
}

// ---- Macro colour: iron oxide variation, hue drift, brightness ----------
vec3 ochre = vec3(1.08, 0.94, 0.86);
vec3 rust = vec3(1.02, 0.86, 0.8);
vec3 macro = mix(rust, ochre, smoothstep(0.3, 0.7, nA.x));
macro *= 0.92 + 0.14 * nB.x + 0.1 * (nC.y - 0.5);
gAlbedo *= macro;
// Mid-scale mottling (0.5-5 m): scuffed crust, darker organic litter and
// paler wind-sorted sand, on rotated coordinates so it never lines up with
// the other noise taps or the texture repeats.
{
  vec2 rp = mat2(0.8, -0.6, 0.6, 0.8) * P.xz;
  vec4 m1 = texture(tNoise, rp / 7.3 + 0.71);
  vec4 m2 = texture(tNoise, rp.yx / 23.0 + 0.37);
  float mott = (m1.y - 0.5) * 0.2 + (nD.x - 0.5) * 0.16 + (m2.z - 0.5) * 0.14;
  gAlbedo *= 1.0 + mott * (1.0 - traffic * 0.5);
  // Iron-rich darker crust in some patches.
  gAlbedo = mix(gAlbedo, gAlbedo * vec3(0.86, 0.8, 0.78), smoothstep(0.6, 0.8, m2.x) * 0.5);
}

// Quartzite strata: pale and dark bands dipping across the ranges, with
// shadowed ledges at their boundaries; averaged out once sub-pixel.
float strataCoord = P.y * 0.17 + dot(P.xz, vec2(0.012, 0.031)) + (nB.x - 0.5) * 3.0 + (nC.z - 0.5) * 0.6;
float strataBlur = clamp(fwidth(strataCoord) * 1.5, 0.0, 1.0);
float band = fract(strataCoord);
float bandHash = fract(sin(floor(strataCoord) * 91.731) * 4375.85);
vec3 bandTint = mix(vec3(1.18, 1.06, 0.96), vec3(0.76, 0.7, 0.68), step(0.5, bandHash));
float ledge = mix(smoothstep(0.0, 0.07, band) * (1.0 - 0.5 * smoothstep(0.75, 1.0, band)), 0.8, strataBlur);
bandTint = mix(bandTint, vec3(0.97, 0.88, 0.82), strataBlur) * mix(0.72, 1.0, ledge);
float rockShare = clamp(cliffShare + (hb[5] / wsum) * 0.6, 0.0, 1.0);
gAlbedo *= mix(vec3(1.0), bandTint, rockShare * smoothstep(0.05, 0.16, slope));

// Gullies hold shade and darker, vegetated soil; spurs are bleached rock.
gAlbedo *= 1.0 - gully * 0.22;
gAlbedo *= 1.0 + spur * 0.1;

// Wash channels: pale, sorted sand with darker vegetated banks.
float bank = wild * (1.0 - smoothstep(0.018, 0.04, washField(P.xz))) * (1.0 - washW) * (1.0 - relief);
gAlbedo = mix(gAlbedo, gAlbedo * vec3(1.12, 1.08, 1.04), washW * 0.8);
gAlbedo *= 1.0 - bank * 0.18;

// Graded compound ground and traffic dust: paler, less saturated, smoother.
vec3 dustCol = vec3(luma(gAlbedo)) * vec3(1.45, 1.12, 0.9);
gAlbedo = mix(gAlbedo, mix(gAlbedo, dustCol, 0.5) * 1.12, graded * 0.55);
gAlbedo = mix(gAlbedo, dustCol * 1.25, traffic * 0.55);
gRough = mix(gRough, 0.8, traffic * 0.5);

// ---- Spinifex footprints (match the GPU scatter) -------------------------
// Each hummock is painted as a sun-shaded dome with a cast shadow, so the
// plain keeps its texture of thousands of plants out to the horizon.
vec3 sunW = vec3(0.0, 1.0, 0.0);
#if NUM_DIR_LIGHTS > 0
sunW = normalize((vec4(directionalLights[0].direction, 0.0) * viewMatrix).xyz);
#endif
vec2 shadowShift = -sunW.xz / max(sunW.y, 0.3) * 0.5;
// Kept inside the 3 x 3 cell search so low-sun shadows are never clipped.
shadowShift *= min(1.0, 0.75 / max(length(shadowShift), 1e-4));
float spinDens = spinifexDensity(P.xz, slope);
float farTint = smoothstep(uSpinFade.x * 0.85, uSpinFade.y, viewDist);
vec3 spinGreen = vec3(0.105, 0.11, 0.05);
vec3 spinGold = vec3(0.23, 0.18, 0.075);
float cover = 0.0;
float shadow = 0.0;
vec3 spinFar = mix(spinGreen, spinGold, 0.5) * 0.85;
float cellPx = pixelMetres / ${SPINIFEX_CELL.toFixed(2)};
float footprintLod = smoothstep(0.18, 0.45, cellPx);
#if GROUND_QUALITY > 0
if (footprintLod < 1.0 && spinDens > 0.01) {
  vec2 g = P.xz / ${SPINIFEX_CELL.toFixed(2)};
  vec2 c0 = floor(g);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = c0 + vec2(float(i), float(j));
      vec4 h = cellHash(c, ${SPINIFEX_SEED});
      if (h.z >= spinDens) continue;
      vec2 ctr = (c + ${SPINIFEX_JITTER[0].toFixed(3)} + ${SPINIFEX_JITTER[1].toFixed(3)} * h.xy) * ${SPINIFEX_CELL.toFixed(2)};
      float r = ${SPINIFEX_CELL.toFixed(2)} * mix(${SPINIFEX_RADIUS[0].toFixed(3)}, ${SPINIFEX_RADIUS[1].toFixed(3)}, h.w);
      vec2 q = (P.xz - ctr) / r;
      // Slightly elliptical, hashed orientation: no two read the same.
      float ang = h.x * 6.2831853;
      vec2 cs = vec2(cos(ang), sin(ang));
      vec2 qe = vec2(dot(q, cs), dot(q, vec2(-cs.y, cs.x)) / (0.72 + 0.28 * h.y));
      float cv = 1.0 - smoothstep(0.7, 1.0, length(qe));
      if (cv > cover) {
        cover = cv;
        vec3 domeN = normalize(vec3(q.x, max(0.0, 1.0 - dot(q, q)) * 0.9 + 0.15, q.y));
        float lit = saturate(dot(domeN, sunW));
        spinFar = mix(spinGreen, spinGold, smoothstep(0.15, 0.85, h.z)) * (0.8 + 0.4 * h.w) * (0.45 + 0.8 * lit);
      }
      shadow = max(shadow, 1.0 - smoothstep(0.55, 1.1, length(q - shadowShift)));
    }
  }
}
#endif
float avgCover = spinDens * 0.5;
cover = mix(cover, avgCover, footprintLod);
shadow = mix(shadow, spinDens * 0.3, footprintLod);
spinFar = mix(spinFar, mix(spinGreen, spinGold, 0.5) * 0.8, footprintLod);
// Near the camera the real hummocks cast real shadows; keep a soft contact.
gAlbedo *= 1.0 - shadow * mix(0.18, 0.4, farTint) * (1.0 - cover * farTint);
gAlbedo = mix(gAlbedo, spinFar, cover * farTint);
float halo = shadow;

// ---- Final normal --------------------------------------------------------
vec3 Nd = topNormal(normalize(tnBlend + vec3(0.0, 0.0, 1e-4)), Nm);
if (cliffShare > 0.0) Nd = normalize(mix(Nd, normalize(cliffN + (Nm - Ng)), cliffShare));
// Dust and graded surfaces are compacted flat.
Nd = normalize(mix(Nd, Nm, traffic * 0.6 + graded * 0.25));
vec3 gNormal = Nd;

// ---- Occlusion ------------------------------------------------------------
float gAO = 1.0;
gAO *= clamp(1.0 - max(cavL, 0.0) * 0.4 - gully * 0.25, 0.55, 1.0);
gAO *= mix(0.42, 1.0, contactLight);
gAO *= 1.0 - halo * 0.3;
gAO *= mix(0.75, 1.0, smoothstep(0.25, 0.75, mix(det[1].b, 0.5, footprintLod)));
gAlbedo *= mix(0.78, 1.0, contactLight);
gRough = clamp(mix(0.72, 1.0, gRough), 0.5, 1.0);

diffuseColor.rgb *= gAlbedo;
`;
