import * as THREE from "three";
import { patchMaterial } from "./shader";
import { structureMaps as M } from "./textures";
import { fixtureUniforms as F } from "./environment";

/**
 * Shared PBR materials for every built structure. Each one extends a stock
 * MeshStandardMaterial with world-space scanned detail plus procedural wear
 * (red dust, rain streaks, seams, markings) so the stock lighting, shadows,
 * fog and image-based reflections all still apply.
 *
 * Materials that weather from the ground up read a per-vertex `aGround`
 * attribute: height above the surrounding ground, in metres.
 */

/** Linear-space red desert dust shared by every weathering effect. */
const DUST = { value: new THREE.Color().setRGB(0.46, 0.15, 0.062) };

const GROUND_VERTEX = {
  header: /* glsl */ `attribute float aGround;\nvarying float vSGround;`,
  main: { after: "#include <begin_vertex>", code: "vSGround = aGround;" },
};

/** Fragment helpers: box projection and scanned normal application. */
const HELPERS = /* glsl */ `
uniform vec3 uDust;
vec2 sBoxUv(vec3 p, vec3 n) {
  vec3 a = abs(n);
  return a.y > max(a.x, a.z) ? p.xz : (a.x > a.z ? vec2(p.z, p.y) : vec2(p.x, p.y));
}
vec3 sApplyNormal(vec3 n, sampler2D map, vec2 uv, float strength) {
  vec3 t = texture2D(map, uv).xyz * 2.0 - 1.0;
  t.xy *= strength;
  mat3 tbn = sTangentFrame(-vViewPosition, n, uv);
  return normalize(tbn * t);
}
float sGroundDust(float h, vec2 xz, float reach) {
  float n = sFbm(xz * 0.7);
  float d = 1.0 - smoothstep(0.0, reach, h + (n - 0.5) * reach * 0.9);
  return d * d;
}
`;

// ---------------------------------------------------------------------------
// Concrete: plinths, foundations, pads, vestibules, parapets
// ---------------------------------------------------------------------------
export function makeConcrete(color: THREE.ColorRepresentation, opts: { ground?: boolean; key?: string } = {}) {
  const ground = opts.ground ?? true;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
  return patchMaterial(mat, {
    key: `s-concrete-${ground}`,
    uniforms: { tConcDiff: M.concreteDiff, tConcNor: M.concreteNor, tConcArm: M.concreteArm, uDust: DUST },
    defines: ground ? { S_GROUND: 1 } : {},
    vertexHeader: ground ? GROUND_VERTEX.header : "",
    vertex: ground ? [GROUND_VERTEX.main] : [],
    fragmentHeader: /* glsl */ `
      uniform sampler2D tConcDiff; uniform sampler2D tConcNor; uniform sampler2D tConcArm;
      #ifdef S_GROUND
      varying float vSGround;
      #endif
      ${HELPERS}
      float sDustAmt; float sRoughAdd;`,
    fragment: [
      {
        after: "#include <map_fragment>",
        code: /* glsl */ `
        vec3 cN = normalize(vSNrmW);
        vec2 cUv = sBoxUv(vSWorld, cN) / 2.5;
        vec3 cTex = texture2D(tConcDiff, cUv).rgb;
        float cLum = dot(cTex, vec3(0.3, 0.59, 0.11)) / 0.13;
        float cBlot = sFbm(vSWorld.xz * 0.15 + vSWorld.y * 0.3);
        vec3 cCol = diffuseColor.rgb * mix(0.82, 1.12, clamp(cLum * 0.5, 0.0, 1.0)) * (0.92 + 0.16 * cBlot);
        // vertical rain-run streaks on walls
        float cStreak = smoothstep(0.55, 0.85, sNoise(vec2(dot(vSWorld.xz, vec2(cN.z, -cN.x)) * 2.3, vSWorld.y * 0.25)));
        cCol *= 1.0 - cStreak * 0.12 * (1.0 - abs(cN.y));
        sDustAmt = 0.0;
        #ifdef S_GROUND
          sDustAmt = sGroundDust(vSGround, vSWorld.xz, 0.9);
          cCol *= mix(1.0, 0.7, 1.0 - smoothstep(0.0, 0.18, vSGround));
        #endif
        sDustAmt = max(sDustAmt, cN.y > 0.6 ? smoothstep(0.45, 0.8, cBlot) * 0.5 : 0.0);
        diffuseColor.rgb = mix(cCol, uDust * (0.8 + 0.4 * cBlot), sDustAmt * 0.75);
        `,
      },
      {
        after: "#include <roughnessmap_fragment>",
        code: `roughnessFactor = clamp(texture2D(tConcArm, cUv).g * 1.08 + sDustAmt * 0.15, 0.4, 1.0);`,
      },
      {
        after: "#include <normal_fragment_maps>",
        code: `normal = sApplyNormal(normal, tConcNor, cUv, 0.9 * (1.0 - sDustAmt * 0.6));`,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Radome shell: FRP geodesic panels with seams, tone variation and dust
// ---------------------------------------------------------------------------
export const radomeShellMat = patchMaterial(
  new THREE.MeshStandardMaterial({ color: "#f3f3ef", roughness: 0.6, metalness: 0, envMapIntensity: 1 }),
  {
    key: "s-radome",
    uniforms: { uDust: DUST },
    vertexHeader: /* glsl */ `${GROUND_VERTEX.header}
      attribute vec3 aBary; attribute float aPanel;
      varying vec3 vSBary; varying float vSPanel;`,
    vertex: [
      { after: "#include <begin_vertex>", code: "vSGround = aGround; vSBary = aBary; vSPanel = aPanel;" },
    ],
    fragmentHeader: /* glsl */ `
      varying float vSGround; varying vec3 vSBary; varying float vSPanel;
      ${HELPERS}
      float rSeam; float rDust; float rFar; float rGrime;`,
    fragment: [
      {
        after: "#include <map_fragment>",
        code: /* glsl */ `
        float rE = min(min(vSBary.x, vSBary.y), vSBary.z);
        float rFw = max(fwidth(rE), 1e-5);
        rFar = smoothstep(0.004, 0.03, rFw);
        rSeam = (1.0 - smoothstep(0.006, 0.006 + rFw * 1.5, rE)) * (1.0 - rFar * 0.75);
        float rAng = atan(vSObj.z, vSObj.x);
        float rN = sFbm(vSWorld.xz * 0.12 + vec2(vSWorld.y * 0.15));
        // rain-run streaks, strongest below panel joints
        float rStreak = smoothstep(0.5, 0.9, sNoise(vec2(rAng * 70.0, vSObj.y * 0.06)))
                      * (0.35 + 0.65 * sNoise(vec2(rAng * 11.0, vSObj.y * 0.2)));
        rGrime = smoothstep(0.35, 0.85, rN);
        rDust = sGroundDust(vSGround, vSWorld.xz, 3.2) * (0.75 + 0.5 * rStreak);
        rDust = max(rDust, (1.0 - smoothstep(0.0, 6.0, vSGround + (rN - 0.5) * 4.0)) * 0.3 * (0.4 + rStreak));
        rDust = max(rDust, (1.0 - smoothstep(0.0, 0.25, rE)) * 0.25 * (1.0 - smoothstep(0.0, 14.0, vSGround)));
        // dust also settles faintly into the joints all the way up
        vec3 rCol = diffuseColor.rgb * (1.0 + (vSPanel - 0.5) * 0.07);
        rCol *= 1.0 - rStreak * 0.07 - rGrime * 0.05;
        rCol = mix(rCol, rCol * vec3(0.96, 0.92, 0.86), rGrime * 0.5);
        rCol = mix(rCol, uDust * 1.5, clamp(rDust, 0.0, 1.0) * 0.6);
        rCol = mix(rCol, rCol * vec3(0.72, 0.66, 0.6), rSeam * 0.65);
        diffuseColor.rgb = rCol;
        `,
      },
      {
        after: "#include <roughnessmap_fragment>",
        code: `roughnessFactor = clamp(0.5 + (vSPanel - 0.5) * 0.12 + rSeam * 0.25 + rDust * 0.35 + rGrime * 0.08, 0.3, 1.0);`,
      },
      {
        after: "#include <normal_fragment_maps>",
        code: /* glsl */ `
        float rH = smoothstep(0.0, 0.016, rE) * 0.03 * (1.0 - rFar);
        normal = sBump(-vViewPosition, normal, rH, 1.0);
        `,
      },
    ],
  },
);

// ---------------------------------------------------------------------------
// Building walls: ribbed cladding or rendered panels, windows, wear
// ---------------------------------------------------------------------------
/**
 * Wall geometry carries uv = (metres along wall, metres above slab) and
 * aWall = (wall length, wall height, door position, roller-door position);
 * a negative door position means no door on that wall.
 */
export function makeWall(color: THREE.ColorRepresentation, glazed: boolean) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2 });
  return patchMaterial(mat, {
    key: `s-wall-${glazed}`,
    uniforms: {
      tCladNor: M.cladNor,
      tCladArm: M.cladArm,
      tConcDiff: M.concreteDiff,
      tConcNor: M.concreteNor,
      uDust: DUST,
      uLamps: F.uLamps,
    },
    defines: glazed ? { S_GLAZED: 1 } : {},
    vertexHeader: /* glsl */ `attribute vec4 aWall; varying vec4 vSWall;`,
    vertex: [{ after: "#include <begin_vertex>", code: "vSWall = aWall;" }],
    fragmentHeader: /* glsl */ `
      uniform sampler2D tCladNor; uniform sampler2D tCladArm;
      uniform sampler2D tConcDiff; uniform sampler2D tConcNor;
      uniform float uLamps;
      varying vec4 vSWall;
      ${HELPERS}
      float wGlass; float wFrame; float wDust; float wPlinth; float wEdge; vec3 wEmit;`,
    fragment: [
      {
        after: "#include <map_fragment>",
        code: /* glsl */ `
        float wx = vSUv.x; float wy = vSUv.y;
        float wLen = vSWall.x; float wH = vSWall.y;
        float wSeed = fract(wLen * 0.137 + wH * 0.071);
        vec3 wCol = diffuseColor.rgb;
        // panel tone: each cladding sheet (~0.9 m) slightly different
        float wSheet = sHash12(vec2(floor(wx / 0.9), wSeed * 91.0));
        #ifdef S_GLAZED
          vec3 wTex = texture2D(tConcDiff, vec2(wx, wy) / 2.5).rgb;
          wCol *= mix(0.86, 1.08, clamp(dot(wTex, vec3(0.33)) / 0.26, 0.0, 1.0));
          // fibre-cement panel joints 1.2 m x 2.4 m
          vec2 wPj = abs(fract(vec2(wx / 1.2, (wy - 0.45) / 2.4)) - 0.5) * vec2(1.2, 2.4);
          float wJoint = 1.0 - smoothstep(0.0, 0.012 + fwidth(wx) , min(0.6 - wPj.x, 1.2 - wPj.y));
          wCol *= 1.0 - wJoint * 0.25;
        #else
          wCol *= 0.9 + wSheet * 0.16;
          float wLap = abs(fract(wx / 0.9) - 0.5) * 0.9;
          wCol *= 1.0 - (1.0 - smoothstep(0.0, 0.02 + fwidth(wx), 0.45 - wLap)) * 0.3;
        #endif
        // concrete plinth course at the base
        wPlinth = 1.0 - step(0.45, wy);
        wCol = mix(wCol, vec3(0.36, 0.33, 0.29), wPlinth);
        // rain streaks running down from the roof line
        float wTop = clamp(1.0 - (wH - wy) / max(wH, 0.1), 0.0, 1.0);
        float wStreak = smoothstep(0.45, 0.9, sNoise(vec2(wx * 1.7, wy * 0.12 + wSeed * 10.0)));
        wCol *= 1.0 - wStreak * (0.06 + 0.14 * wTop * wTop);
        // window grid
        wGlass = 0.0; wFrame = 0.0; wEmit = vec3(0.0);
        #ifdef S_GLAZED
          float wBayW = 3.0; float wWinW = 1.8; float wWinH = 1.3; float wSill = 0.95; float wStorey = 3.3;
        #else
          float wBayW = 6.0; float wWinW = 1.4; float wWinH = 1.0; float wSill = 1.2; float wStorey = 99.0;
        #endif
        float wBays = floor((wLen - 2.0) / wBayW);
        float wOff = (wLen - wBays * wBayW) * 0.5;
        float wB = floor((wx - wOff) / wBayW);
        float wLx = wx - wOff - (wB + 0.5) * wBayW;
        float wS = floor(wy / wStorey);
        float wLy = wy - wS * wStorey - wSill;
        float wFloors = max(1.0, floor((wH - 0.6) / 3.3));
        bool wOk = wB >= 0.0 && wB < wBays && wS < wFloors && abs(wx - vSWall.z) > 1.6 && abs(wx - vSWall.w) > 3.4;
        #ifndef S_GLAZED
          wOk = wOk && sHash12(vec2(wB, wSeed * 37.0)) > 0.35;
        #endif
        float wDx = wWinW * 0.5 - abs(wLx);
        float wDy = min(wLy, wWinH - wLy);
        wEdge = 0.0;
        if (wOk && wDx > -0.06 && wDy > -0.06) {
          float wIn = min(wDx, wDy);
          // aluminium frame, mullion and transom
          float wMull = min(abs(wLx), abs(wLy - wWinH * 0.62));
          wFrame = (wIn < 0.05 || wMull < 0.03) ? 1.0 : 0.0;
          wGlass = 1.0 - wFrame;
          wEdge = wIn;
          float wId = sHash12(vec2(wB + wS * 17.0, wSeed * 53.0));
          // interior blinds at random heights
          float wBlind = step(wLy, wWinH) * step(wWinH - wLy, mix(0.1, 1.1, fract(wId * 7.3)));
          vec3 wGlassCol = mix(vec3(0.2, 0.23, 0.25), vec3(0.12, 0.11, 0.1), wBlind * 0.6);
          wCol = mix(wCol, wGlassCol, wGlass);
          wCol = mix(wCol, vec3(0.32, 0.33, 0.33), wFrame);
          float wLit = step(0.42, wId) * uLamps;
          wEmit = wGlass * wLit * mix(vec3(1.0, 0.68, 0.36), vec3(0.85, 0.9, 1.0), step(0.85, wId)) * (wBlind > 0.5 ? 1.4 : 2.4);
        } else if (wOk && wDx > 0.0 && wLy < 0.0 && wLy > -0.9) {
          // grime washed down from the sill corners
          float wCorner = smoothstep(0.35, 0.0, min(abs(wLx - wWinW * 0.45), abs(wLx + wWinW * 0.45)));
          wCol *= 1.0 - 0.18 * wCorner * (1.0 + wLy / 0.9);
          if (wLy > -0.06) wCol *= 0.7; // sill
        }
        wDust = sGroundDust(wy, vSWorld.xz, 1.4) * (1.0 - wGlass);
        // splash-back above the dust line, broken up by noise
        wDust = max(wDust, smoothstep(0.55, 0.8, sNoise(vec2(wx, wy) * 6.0)) * (1.0 - smoothstep(0.3, 1.6, wy)) * 0.45 * (1.0 - wGlass));
        wCol = mix(wCol, uDust * (0.85 + 0.3 * sNoise(vSWorld.xz * 3.0)), wDust * 0.85);
        wCol *= mix(0.65, 1.0, smoothstep(0.0, 0.25, wy));
        diffuseColor.rgb = wCol;
        `,
      },
      {
        after: "#include <roughnessmap_fragment>",
        code: /* glsl */ `
        #ifdef S_GLAZED
          roughnessFactor = 0.72;
        #else
          roughnessFactor = texture2D(tCladArm, vec2(vSUv.x, vSUv.y) / 2.0).g * 0.9 + 0.08;
        #endif
        roughnessFactor = mix(roughnessFactor, 0.92, max(wPlinth, wDust));
        roughnessFactor = mix(roughnessFactor, 0.05, wGlass);
        roughnessFactor = mix(roughnessFactor, 0.35, wFrame);
        `,
      },
      {
        after: "#include <metalnessmap_fragment>",
        code: /* glsl */ `
        #ifdef S_GLAZED
          metalnessFactor = 0.0;
        #else
          metalnessFactor = 0.35;
        #endif
        metalnessFactor = mix(metalnessFactor, 0.0, max(wPlinth, wDust));
        metalnessFactor = mix(metalnessFactor, 0.85, wFrame);
        metalnessFactor = mix(metalnessFactor, 0.95, wGlass);
        `,
      },
      {
        after: "#include <normal_fragment_maps>",
        code: /* glsl */ `
        if (wPlinth > 0.5) {
          normal = sApplyNormal(normal, tConcNor, vSUv / 2.5, 0.8);
        } else if (wGlass + wFrame < 0.5) {
          #ifdef S_GLAZED
            normal = sApplyNormal(normal, tConcNor, vSUv / 2.5, 0.5);
          #else
            normal = sApplyNormal(normal, tCladNor, vSUv / 2.0, 1.0);
          #endif
        }
        // window reveal: frame edges catch the light
        normal = sBump(-vViewPosition, normal, -smoothstep(0.0, 0.06, wEdge) * 0.06, 1.0);
        `,
      },
      {
        after: "#include <emissivemap_fragment>",
        code: "totalEmissiveRadiance += wEmit;",
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Roofs: flat membrane roofs and ribbed metal gables
// ---------------------------------------------------------------------------
export function makeRoof(color: THREE.ColorRepresentation, ribbed: boolean) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: ribbed ? 0.35 : 0, side: THREE.DoubleSide });
  return patchMaterial(mat, {
    key: `s-roof-${ribbed}`,
    uniforms: { tCladNor: M.cladNor, tCladArm: M.cladArm, tConcDiff: M.concreteDiff, uDust: DUST },
    defines: ribbed ? { S_RIBBED: 1 } : {},
    fragmentHeader: /* glsl */ `
      uniform sampler2D tCladNor; uniform sampler2D tCladArm; uniform sampler2D tConcDiff;
      ${HELPERS}
      float fDust;`,
    fragment: [
      {
        after: "#include <map_fragment>",
        code: /* glsl */ `
        float fN = sFbm(vSWorld.xz * 0.08);
        float fN2 = sFbm(vSWorld.xz * 0.5 + 7.0);
        vec3 fCol = diffuseColor.rgb;
        #ifdef S_RIBBED
          vec2 fUv = vSUv * 2.0;
          fCol *= 0.92 + 0.12 * sHash12(vec2(floor(fUv.x * 1.0), 3.0));
        #else
          vec3 fTex = texture2D(tConcDiff, vSWorld.xz / 2.5).rgb;
          fCol *= mix(0.68, 0.95, clamp(dot(fTex, vec3(0.33)) / 0.26, 0.0, 1.0));
          // bitumen membrane laps every metre
          float fLap = abs(fract(vSWorld.x * 1.0) - 0.5);
          fCol *= 1.0 - smoothstep(0.46, 0.5, fLap) * 0.12;
          // ponding stains
          fCol *= 1.0 - smoothstep(0.55, 0.75, fN) * 0.25;
        #endif
        fDust = smoothstep(0.4, 0.75, fN2) * 0.55 + smoothstep(0.55, 0.85, fN) * 0.25;
        fCol = mix(fCol, uDust, fDust * 0.6);
        diffuseColor.rgb = fCol;
        `,
      },
      {
        after: "#include <roughnessmap_fragment>",
        code: /* glsl */ `
        #ifdef S_RIBBED
          roughnessFactor = clamp(texture2D(tCladArm, fUv).g * 0.9 + 0.1 + fDust * 0.4, 0.2, 1.0);
        #else
          roughnessFactor = 0.88 + fDust * 0.1;
        #endif
        `,
      },
      {
        after: "#include <normal_fragment_maps>",
        code: /* glsl */ `
        #ifdef S_RIBBED
          normal = sApplyNormal(normal, tCladNor, fUv, 1.0);
        #endif
        `,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Asphalt: roads (ribbon uv: x across 0..1, y = distance / width) and lots
// ---------------------------------------------------------------------------
export function makeAsphalt(opts: { road: boolean; width?: number; tint?: THREE.ColorRepresentation; markings?: boolean }) {
  const mat = new THREE.MeshStandardMaterial({ color: opts.tint ?? "#ffffff", roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const defines: Record<string, number> = {};
  if (opts.road) defines.S_ROAD = 1;
  if (opts.markings) defines.S_MARK = 1;
  return patchMaterial(mat, {
    key: `s-asphalt-${opts.road}-${!!opts.markings}`,
    uniforms: {
      tAsDiff: M.asphaltDiff,
      tAsNor: M.asphaltNor,
      tAsArm: M.asphaltArm,
      uWidth: { value: opts.width ?? 6 },
      uDust: DUST,
    },
    defines,
    fragmentHeader: /* glsl */ `
      uniform sampler2D tAsDiff; uniform sampler2D tAsNor; uniform sampler2D tAsArm; uniform float uWidth;
      ${HELPERS}
      float aDust; float aPaint; float aTrack; float aOil; float aCrack; vec2 aUv;`,
    fragment: [
      {
        after: "#include <map_fragment>",
        code: /* glsl */ `
        aUv = vSWorld.xz / 3.0;
        vec3 aTex = texture2D(tAsDiff, aUv).rgb;
        float aMacro = sFbm(vSWorld.xz * 0.04);
        // sun-oxidised binder: lighter, slightly warm grey
        vec3 aCol = mix(aTex, vec3(dot(aTex, vec3(0.33))), 0.65) * 1.25 * vec3(1.1, 1.0, 0.88) * (0.82 + 0.36 * aMacro);
        aCol *= diffuseColor.rgb;
        aDust = 0.0; aPaint = 0.0; aTrack = 0.0; aOil = 0.0;
        float aCn = sFbm(vSWorld.xz * 0.45 + 3.0);
        aCrack = (1.0 - smoothstep(0.0, 0.008 + fwidth(aCn) * 0.7, abs(aCn - 0.5))) * smoothstep(0.62, 0.8, sNoise(vSWorld.xz * 0.05 + 11.0)) * 0.8;
        #ifdef S_ROAD
          float aX = (vSUv.x - 0.5) * uWidth;
          float aAlong = vSUv.y * uWidth;
          float aEdge = uWidth * 0.5 - abs(aX);
          float aLane = abs(abs(aX) - uWidth * 0.25);
          aTrack = exp(-pow((aLane - 0.78) / 0.32, 2.0)) * (0.7 + 0.3 * sNoise(vec2(aAlong * 0.2, aX)));
          aCol = mix(aCol, aCol * 0.82 + vec3(0.012), aTrack * 0.5);
          aOil = smoothstep(0.58, 0.82, sFbm(vec2(aAlong * 0.35, aX * 1.5))) * exp(-pow(aLane / 0.45, 2.0));
          aCol *= 1.0 - aOil * 0.5;
          // patch repairs: darker fresh asphalt rectangles
          vec2 aPc = vec2(aAlong / 9.0, aX / 2.2 + 5.0);
          vec2 aPf = fract(aPc);
          float aPh = sHash12(floor(aPc) + 0.5);
          float aPatch = step(0.93, aPh) * step(0.12, aPf.x) * step(aPf.x, 0.88) * step(0.15, aPf.y) * step(aPf.y, 0.85);
          aCol = mix(aCol, aCol * 0.6, aPatch);
          aCrack *= 1.0 - aPatch;
          // longitudinal crack near the edge
          float aLong = 1.0 - smoothstep(0.0, 0.03 + fwidth(aX), abs(aEdge - 0.9 - (sNoise(vec2(aAlong * 0.3, 1.0)) - 0.5) * 0.6));
          aCrack = max(aCrack, aLong * smoothstep(0.4, 0.6, sNoise(vec2(aAlong * 0.05, 4.0))) * (1.0 - aPatch));
          #ifdef S_MARK
            float aFw = fwidth(aX) + 0.002;
            float aCentre = (1.0 - smoothstep(0.06, 0.06 + aFw, abs(aX))) * step(fract(aAlong / 9.0), 0.34);
            float aSide = 1.0 - smoothstep(0.06, 0.06 + aFw, abs(aEdge - 0.32));
            float aWear = smoothstep(0.3, 0.75, sFbm(vec2(aAlong * 1.1, aX * 6.0) + 2.0));
            aPaint = max(aCentre, aSide) * (1.0 - aWear * 0.85) * (1.0 - aTrack * 0.6) * (1.0 - aPatch);
          #endif
          float aDn = sFbm(vSWorld.xz * 0.35);
          aDust = 1.0 - smoothstep(0.0, 1.5, aEdge - 0.15 - (aDn - 0.5) * 1.8);
          aDust = max(aDust, smoothstep(0.62, 0.85, aDn) * 0.35 * (1.0 - aTrack));
        #else
          float aDn = sFbm(vSWorld.xz * 0.3);
          vec2 aE2 = min(vSUv, 1.0 - vSUv);
          float aEdgeUv = min(aE2.x, aE2.y);
          aDust = max(smoothstep(0.55, 0.85, aDn) * 0.5, 1.0 - smoothstep(0.0, 0.07, aEdgeUv - (aDn - 0.5) * 0.06));
          aOil = smoothstep(0.6, 0.8, sFbm(vSWorld.xz * 0.6 + 9.0)) * 0.7;
          aCol *= 1.0 - aOil * 0.45;
        #endif
        aCol *= 1.0 - aCrack * 0.65;
        aCol = mix(aCol, vec3(0.6, 0.58, 0.5), aPaint * 0.85);
        aCol = mix(aCol, uDust * (0.85 + 0.3 * sNoise(vSWorld.xz * 2.0)), clamp(aDust, 0.0, 1.0) * 0.9);
        diffuseColor.rgb = aCol;
        `,
      },
      {
        after: "#include <roughnessmap_fragment>",
        code: /* glsl */ `
        roughnessFactor = texture2D(tAsArm, aUv).g;
        roughnessFactor = roughnessFactor - aTrack * 0.15 - aOil * 0.35 - aPaint * 0.15 + aDust * 0.2 + aCrack * 0.1;
        roughnessFactor = clamp(roughnessFactor, 0.25, 1.0);
        `,
      },
      {
        after: "#include <normal_fragment_maps>",
        code: /* glsl */ `
        normal = sApplyNormal(normal, tAsNor, aUv, 1.2 * (1.0 - aPaint * 0.7) * (1.0 - clamp(aDust, 0.0, 1.0) * 0.7));
        normal = sBump(-vViewPosition, normal, -aCrack * 0.012, 1.0);
        `,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Gravel and compacted dust: road shoulders and antenna aprons. The outer
// edge breaks up with noise (alpha test) so the pad has no hard rim.
// `edgeMode` 0 = ribbon (uv.x across), 1 = radial apron (uv in metres / 6).
// ---------------------------------------------------------------------------
export function makeGravel(edgeMode: 0 | 1, radius = 1) {
  const mat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1, metalness: 0, side: THREE.DoubleSide });
  return patchMaterial(mat, {
    key: `s-gravel-${edgeMode}`,
    uniforms: { tGrDiff: M.gravelDiff, tGrNor: M.gravelNor, uDust: DUST, uRadius: { value: radius } },
    defines: { S_EDGE: edgeMode },
    fragmentHeader: /* glsl */ `
      uniform sampler2D tGrDiff; uniform sampler2D tGrNor; uniform float uRadius;
      ${HELPERS}
      float gDust; vec2 gUv;`,
    fragment: [
      {
        after: "#include <map_fragment>",
        code: /* glsl */ `
        gUv = vSWorld.xz / 2.25;
        vec3 gTex = texture2D(tGrDiff, gUv).rgb;
        float gN = sFbm(vSWorld.xz * 0.25);
        #if S_EDGE == 0
          float gEdge = 1.0 - abs(vSUv.x - 0.5) * 2.0;      // 1 centre .. 0 rim
        #else
          float gEdge = 1.0 - length(vSUv * 6.0) / uRadius;
        #endif
        float gBreak = gEdge - (sNoise(vSWorld.xz * 0.6) - 0.5) * 0.14 - (sNoise(vSWorld.xz * 3.1) - 0.5) * 0.06;
        if (gBreak < 0.015) discard;
        gDust = clamp(1.0 - smoothstep(0.015, 0.4, gBreak) + (gN - 0.5) * 0.5, 0.0, 1.0);
        float gLum = dot(gTex, vec3(0.3, 0.59, 0.11)) / 0.28;
        vec3 gCol = mix(gTex * vec3(0.72, 0.5, 0.4), uDust * (0.5 + 0.45 * gLum), 0.6 + gDust * 0.4);
        diffuseColor.rgb = gCol * diffuseColor.rgb;
        `,
      },
      {
        after: "#include <normal_fragment_maps>",
        code: `normal = sApplyNormal(normal, tGrNor, gUv, 1.0 - gDust * 0.5);`,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Parabolic dish reflector: panel seams from the lathe uv
// ---------------------------------------------------------------------------
export const dishReflectorMat = patchMaterial(
  new THREE.MeshStandardMaterial({ color: "#e6e8e4", metalness: 0.3, roughness: 0.42, side: THREE.DoubleSide }),
  {
    key: "s-dish",
    uniforms: { uDust: DUST },
    fragmentHeader: /* glsl */ `${HELPERS}\nfloat dSeam;`,
    fragment: [
      {
        after: "#include <map_fragment>",
        code: /* glsl */ `
        float dRing = vSUv.y * 5.0;
        float dRadial = vSUv.x * (vSUv.y < 0.4 ? 16.0 : 32.0);
        vec2 dF = abs(fract(vec2(dRadial, dRing)) - 0.5);
        vec2 dW = fwidth(vec2(dRadial, dRing)) * 1.2 + vec2(0.004);
        dSeam = max(1.0 - smoothstep(0.5 - dW.x * 1.5, 0.5, dF.x), 1.0 - smoothstep(0.5 - dW.y * 1.5, 0.5, dF.y));
        dSeam *= step(0.06, vSUv.y);
        float dTone = sHash12(floor(vec2(dRadial, dRing)) + 0.5);
        vec3 dCol = diffuseColor.rgb * (0.95 + dTone * 0.08);
        dCol = mix(dCol, uDust * 1.3, smoothstep(0.5, 0.85, sFbm(vSWorld.xz * 0.6 + vSWorld.y)) * 0.25);
        diffuseColor.rgb = dCol * (1.0 - dSeam * 0.4);
        `,
      },
      { after: "#include <roughnessmap_fragment>", code: "roughnessFactor = roughnessFactor + dSeam * 0.25;" },
    ],
  },
);

// ---------------------------------------------------------------------------
// Chain-link fabric: procedural 60 mm diamond mesh with distance fade
// ---------------------------------------------------------------------------
export const chainLinkMat = patchMaterial(
  new THREE.MeshStandardMaterial({
    color: "#8b908c",
    metalness: 0.7,
    roughness: 0.45,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  }),
  {
    key: "s-chainlink",
    fragmentHeader: "",
    fragment: [
      {
        after: "#include <alphatest_fragment>",
        code: /* glsl */ `
        // uv.x = distance / 3 m, uv.y = 0..1 over the fabric height
        vec2 cP = vec2(vSUv.x * 3.0, vSUv.y * 2.4) / 0.06;
        vec2 cQ = vec2(cP.x + cP.y, cP.x - cP.y) * 0.7071;
        vec2 cD = abs(fract(cQ) - 0.5);
        vec2 cFw = fwidth(cQ);
        float cLine = max(smoothstep(0.5 - 0.06 - cFw.x, 0.5 - 0.06 + cFw.x, cD.x), smoothstep(0.5 - 0.06 - cFw.y, 0.5 - 0.06 + cFw.y, cD.y));
        float cFar = smoothstep(0.15, 0.6, max(cFw.x, cFw.y));
        diffuseColor.a = mix(cLine, 0.22, cFar);
        if (diffuseColor.a < 0.02) discard;
        `,
      },
    ],
  },
);

// ---------------------------------------------------------------------------
// Simple shared metals
// ---------------------------------------------------------------------------
export const galvanisedMat = new THREE.MeshStandardMaterial({ color: "#a3a8a8", metalness: 0.8, roughness: 0.42 });
export const darkSteelMat = new THREE.MeshStandardMaterial({ color: "#3e4246", metalness: 0.6, roughness: 0.5 });

/** Door leaf: painted steel with a slight sheen. */
export const doorMat = new THREE.MeshStandardMaterial({ color: "#4e5a5c", metalness: 0.45, roughness: 0.5 });

/** Roller door: horizontal-slat shutter scan, painted. */
export const rollerDoorMat = patchMaterial(
  new THREE.MeshStandardMaterial({ color: "#a9aca4", metalness: 0.45, roughness: 0.5 }),
  {
    key: "s-roller",
    uniforms: { tShNor: M.shutterNor, tShArm: M.shutterArm, uDust: DUST },
    fragmentHeader: `uniform sampler2D tShNor; uniform sampler2D tShArm;\n${HELPERS}\nvec2 rUv; float rD;`,
    fragment: [
      {
        after: "#include <map_fragment>",
        code: /* glsl */ `
        // object space: unit box scaled per instance; map across the face
        vec3 rN = normalize(vSNrmW);
        rUv = vec2(abs(rN.x) > 0.5 ? vSWorld.z : vSWorld.x, vSWorld.y) / 2.0;
        rD = (1.0 - smoothstep(-0.5, -0.1, vSObj.y)) * (0.6 + 0.4 * sNoise(vSWorld.xz * 4.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, uDust, rD * 0.6);
        `,
      },
      { after: "#include <roughnessmap_fragment>", code: "roughnessFactor = texture2D(tShArm, rUv).g * 0.8 + 0.15 + rD * 0.3;" },
      { after: "#include <normal_fragment_maps>", code: "normal = sApplyNormal(normal, tShNor, rUv, 1.0);" },
    ],
  },
);

/** Lamp lens / fixture: emissive follows the shared lamp uniform. */
export const lampLensMat = patchMaterial(
  new THREE.MeshStandardMaterial({ color: "#d8d4c8", roughness: 0.3, metalness: 0 }),
  {
    key: "s-lens",
    uniforms: { uLamps: F.uLamps },
    fragmentHeader: "uniform float uLamps;",
    fragment: [
      {
        after: "#include <emissivemap_fragment>",
        code: "totalEmissiveRadiance += vec3(1.0, 0.78, 0.5) * uLamps * 6.0;",
      },
    ],
  },
);

/** Add an `aGround` attribute (height above `groundY` in local units). */
export function withGround<G extends THREE.BufferGeometry>(geometry: G, groundY: number, scale = 1): G {
  const pos = geometry.getAttribute("position");
  const values = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) values[i] = (pos.getY(i) - groundY) * scale;
  geometry.setAttribute("aGround", new THREE.BufferAttribute(values, 1));
  return geometry;
}

/** Worn thermoplastic stall paint: fades, chips and collects dust. */
export const stallPaintMat = patchMaterial(
  new THREE.MeshStandardMaterial({ color: "#bfb9a9", roughness: 0.7 }),
  {
    key: "s-stallpaint",
    uniforms: { uDust: DUST },
    fragmentHeader: HELPERS,
    fragment: [
      {
        after: "#include <map_fragment>",
        code: /* glsl */ `
        float pW = smoothstep(0.25, 0.65, sFbm(vSWorld.xz * 1.6));
        float pChip = step(0.72, sHash12(floor(vSWorld.xz * 14.0)));
        vec3 pBase = vec3(0.1, 0.095, 0.085);
        diffuseColor.rgb = mix(diffuseColor.rgb, pBase, clamp(pW * 0.85 + pChip * 0.5, 0.0, 0.92));
        diffuseColor.rgb = mix(diffuseColor.rgb, uDust, smoothstep(0.55, 0.85, sFbm(vSWorld.xz * 0.3)) * 0.5);
        `,
      },
    ],
  },
);

/**
 * Unlit wire strands (fence tension and barbed wire). Lines carry no
 * normals, so instead of lighting they dim with the shared lamp/night level
 * and never glow against a dark landscape.
 */
export const wireLineMat = new THREE.LineBasicMaterial({ color: "#727873", transparent: true, opacity: 0.75, depthWrite: false });
wireLineMat.onBeforeCompile = (shader) => {
  shader.uniforms.uLamps = F.uLamps;
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nuniform float uLamps;")
    .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= mix(1.0, 0.06, uLamps);");
};
wireLineMat.customProgramCacheKey = () => "s-wireline";
