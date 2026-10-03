import * as THREE from "three";
import type { VehicleVariant } from "./VehicleSpec";

/**
 * Materials shared by every vehicle (trim, glass, rubber…) are created once;
 * paint, canvas, plates and lamp lenses are per vehicle because their colour
 * or emissive state differs. The library owns everything and disposes it.
 *
 * Grime: paint, canvas, trim and tyres get a shader patch that layers outback
 * dust over the base colour — heaviest toward the sills (body-frame height),
 * settled on upward faces, broken up by 3D value noise. It also kills the
 * clearcoat and raises roughness where dirty. Every patched material shares
 * one program per base material type (customProgramCacheKey), so the patch
 * costs no extra shader compiles per vehicle.
 */

const GRIME_PARS_VERTEX = /* glsl */ `
varying vec3 vGrimePos;
varying vec3 vGrimeNormal;
`;

const GRIME_PARS_FRAGMENT = /* glsl */ `
varying vec3 vGrimePos;
varying vec3 vGrimeNormal;
uniform vec3 uGrimeColor;
uniform vec4 uGrime; // x amount, y top height, z bottom height, w uniform (0 height-based, 1 everywhere)
float grimeHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float grimeNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(grimeHash(i), grimeHash(i + vec3(1, 0, 0)), f.x),
        mix(grimeHash(i + vec3(0, 1, 0)), grimeHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(grimeHash(i + vec3(0, 0, 1)), grimeHash(i + vec3(1, 0, 1)), f.x),
        mix(grimeHash(i + vec3(0, 1, 1)), grimeHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
`;

const GRIME_APPLY = /* glsl */ `
float grimeN = grimeNoise(vGrimePos * vec3(2.3, 3.1, 2.3)) * 0.55
  + grimeNoise(vGrimePos * 9.0) * 0.3
  + grimeNoise(vGrimePos * 31.0) * 0.15;
float grimeH = smoothstep(uGrime.y, uGrime.z, vGrimePos.y + (grimeN - 0.5) * 0.42);
float grimeTop = smoothstep(0.55, 0.95, vGrimeNormal.y) * 0.4;
float grime = mix(grimeH + grimeTop, 0.55 + grimeTop, uGrime.w);
grime = clamp(grime * (0.55 + grimeN * 0.9) * uGrime.x, 0.0, 1.0);
diffuseColor.rgb = mix(diffuseColor.rgb, uGrimeColor * (0.85 + grimeN * 0.3), grime);
`;

export interface GrimeOptions {
  amount: number;
  /** Height (body frame) where grime starts and where it is full. */
  top?: number;
  bottom?: number;
  /** Apply evenly instead of by height (rotating parts such as tyres). */
  uniform?: boolean;
  color?: THREE.ColorRepresentation;
}

/** Layer procedural dust over a standard/physical material (see file comment). */
export function applyGrime<T extends THREE.MeshStandardMaterial>(material: T, o: GrimeOptions): T {
  const uniforms = {
    uGrimeColor: { value: new THREE.Color(o.color ?? "#a77b55") },
    uGrime: {
      value: new THREE.Vector4(o.amount, o.top ?? 1.05, o.bottom ?? 0.42, o.uniform ? 1 : 0),
    },
  };
  const physical = (material as unknown as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${GRIME_PARS_VERTEX}`)
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvGrimePos = position;\nvGrimeNormal = normal;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GRIME_PARS_FRAGMENT}`)
      .replace("#include <map_fragment>", `#include <map_fragment>\n${GRIME_APPLY}`)
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.97, grime);",
      );
    if (physical) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <lights_physical_fragment>",
        "#include <lights_physical_fragment>\nmaterial.clearcoat *= 1.0 - smoothstep(0.1, 0.6, grime);",
      );
    }
  };
  material.customProgramCacheKey = () => (physical ? "grime-physical" : "grime-standard");
  return material;
}

/** Glass whose opacity rises toward grazing angles (Fresnel), so it reflects the sky. */
function applyFresnelGlass(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      `float glassFres = pow(1.0 - saturate(abs(dot(geometryNormal, geometryViewDir))), 3.0);
diffuseColor.a = mix(diffuseColor.a, 0.92, glassFres);
#include <opaque_fragment>`,
    );
  };
  material.customProgramCacheKey = () => "fresnel-glass";
}

/** Soft radial glow sprite texture for lamp halos (browser only). */
function createGlowTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.55)");
  g.addColorStop(0.5, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Australian-style number plate (fictional fleet registration). */
function createPlateTexture(text: string): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#e9e6dc";
  ctx.fillRect(0, 0, 256, 64);
  ctx.strokeStyle = "#1b1b1b";
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, 248, 56);
  ctx.fillStyle = "#151515";
  ctx.font = "bold 40px Arial, Helvetica, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 30);
  ctx.font = "bold 10px Arial, Helvetica, sans-serif";
  ctx.fillText("COMMONWEALTH · NT", 128, 54);
  // Road grime along the bottom edge.
  const grime = ctx.createLinearGradient(0, 30, 0, 64);
  grime.addColorStop(0, "rgba(140,96,60,0)");
  grime.addColorStop(1, "rgba(140,96,60,0.45)");
  ctx.fillStyle = grime;
  ctx.fillRect(0, 0, 256, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Tyre sidewall: concentric ribs, a lettering band and dusty rubber (browser only). */
function createTyreTexture(): { map: THREE.Texture; bump: THREE.Texture } | null {
  if (typeof document === "undefined") return null;
  const w = 512;
  const h = 64;
  const make = () => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  };
  const colour = make();
  const bump = make();
  const cc = colour.getContext("2d");
  const bc = bump.getContext("2d");
  if (!cc || !bc) return null;
  // v runs across the lathe profile (inner bead → tread → inner bead).
  cc.fillStyle = "#1d1c1a";
  cc.fillRect(0, 0, w, h);
  bc.fillStyle = "#808080";
  bc.fillRect(0, 0, w, h);
  for (const [y0, y1] of [
    [4, 9],
    [55, 60],
  ]) {
    bc.fillStyle = "#b0b0b0";
    bc.fillRect(0, y0, w, y1 - y0);
  }
  bc.fillStyle = "#c8c8c8";
  bc.font = "bold 6px Arial, sans-serif";
  for (let k = 0; k < 4; k++) {
    bc.fillText("ALL TERRAIN  LT 265/75 R16", k * 128 + 6, 13);
    bc.fillText("ALL TERRAIN  LT 265/75 R16", k * 128 + 6, 55);
  }
  // Dust in the grooves and on the shoulders.
  let seed = 911;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 900; i++) {
    cc.fillStyle = `rgba(150,108,72,${0.05 + rand() * 0.12})`;
    cc.fillRect(rand() * w, rand() * h, 2 + rand() * 6, 1 + rand() * 2);
  }
  const map = new THREE.CanvasTexture(colour);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  const bumpTex = new THREE.CanvasTexture(bump);
  bumpTex.wrapS = THREE.RepeatWrapping;
  return { map, bump: bumpTex };
}

export class VehicleMaterialLibrary {
  readonly trim = applyGrime(
    new THREE.MeshStandardMaterial({ color: "#232426", roughness: 0.72, metalness: 0.15 }),
    { amount: 0.55, top: 0.95, bottom: 0.35 },
  );
  readonly liner = new THREE.MeshStandardMaterial({
    color: "#1c1a18",
    roughness: 0.95,
    side: THREE.DoubleSide,
  });
  readonly metal = new THREE.MeshStandardMaterial({
    color: "#7d8083",
    roughness: 0.32,
    metalness: 0.85,
  });
  /** Polished reflector and bright-work (lamp bowls, mirror glass). */
  readonly chrome = new THREE.MeshStandardMaterial({
    color: "#d8dadc",
    roughness: 0.08,
    metalness: 1,
    envMapIntensity: 2.2,
  });
  readonly rubber: THREE.MeshStandardMaterial;
  /** Plain rubber for parts without UVs worth texturing (seals, flaps). */
  readonly seal = new THREE.MeshStandardMaterial({ color: "#151514", roughness: 0.9 });
  readonly interior = new THREE.MeshStandardMaterial({ color: "#2f2e2a", roughness: 0.88 });
  /** Seat vinyl/cloth, a little lighter than the cab trim so the seats read. */
  readonly upholstery = new THREE.MeshStandardMaterial({ color: "#45443c", roughness: 0.82 });
  readonly gauge = new THREE.MeshStandardMaterial({
    color: "#0d0f10",
    emissive: "#ffb36b",
    emissiveIntensity: 0.25,
    roughness: 0.2,
  });
  readonly glass = new THREE.MeshStandardMaterial({
    color: "#1a252b",
    roughness: 0.03,
    metalness: 0.1,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    envMapIntensity: 3,
  });
  readonly amber = new THREE.MeshPhysicalMaterial({
    color: "#c57a1a",
    emissive: "#ff9a2a",
    emissiveIntensity: 0.08,
    roughness: 0.15,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });
  readonly reverse = new THREE.MeshPhysicalMaterial({
    color: "#e4e6e6",
    roughness: 0.12,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });
  readonly rim = new THREE.MeshPhysicalMaterial({
    color: "#3e4037",
    roughness: 0.45,
    metalness: 0.5,
    clearcoat: 0.4,
    clearcoatRoughness: 0.35,
  });
  readonly glowTexture: THREE.Texture | null;
  private readonly owned: THREE.Material[] = [];
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly textures: THREE.Texture[] = [];

  constructor() {
    applyFresnelGlass(this.glass);
    applyGrime(this.rim, { amount: 0.25, uniform: true });
    const tyre = createTyreTexture();
    this.rubber = applyGrime(
      new THREE.MeshStandardMaterial({
        color: tyre ? "#ffffff" : "#1d1c1a",
        map: tyre?.map ?? null,
        bumpMap: tyre?.bump ?? null,
        bumpScale: 1.4,
        roughness: 0.9,
      }),
      { amount: 0.22, uniform: true, color: "#8a6648" },
    );
    if (tyre) this.textures.push(tyre.map, tyre.bump);
    this.glowTexture = createGlowTexture();
    if (this.glowTexture) this.textures.push(this.glowTexture);
  }

  /** Geometry shared by every vehicle (e.g. wheels), built once on first use. */
  sharedGeometry(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let g = this.geometries.get(key);
    if (!g) {
      g = build();
      this.geometries.set(key, g);
    }
    return g;
  }

  /** Satin two-pack paint with a clearcoat, dusted toward the sills. */
  paint(variant: VehicleVariant): THREE.MeshPhysicalMaterial {
    return this.own(
      applyGrime(
        new THREE.MeshPhysicalMaterial({
          color: variant.paint,
          roughness: 0.48,
          metalness: 0.05,
          clearcoat: 0.55,
          clearcoatRoughness: 0.18,
        }),
        { amount: 1.0, top: 1.05, bottom: 0.5 },
      ),
    );
  }

  canvas(variant: VehicleVariant): THREE.MeshStandardMaterial {
    return this.own(
      applyGrime(new THREE.MeshStandardMaterial({ color: variant.canvas, roughness: 0.97 }), {
        amount: 0.5,
        top: 1.6,
        bottom: 0.8,
      }),
    );
  }

  plate(text: string): THREE.MeshStandardMaterial {
    const map = createPlateTexture(text);
    if (map) this.textures.push(map);
    return this.own(
      new THREE.MeshStandardMaterial({
        color: map ? "#ffffff" : "#e9e6dc",
        map,
        roughness: 0.45,
        metalness: 0.2,
      }),
    );
  }

  headlamp(): THREE.MeshPhysicalMaterial {
    return this.own(
      new THREE.MeshPhysicalMaterial({
        color: "#c9cfd4",
        emissive: "#fff3d6",
        emissiveIntensity: 0,
        roughness: 0.05,
        metalness: 0.3,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
        envMapIntensity: 2,
      }),
    );
  }

  taillamp(): THREE.MeshPhysicalMaterial {
    return this.own(
      new THREE.MeshPhysicalMaterial({
        color: "#8a1410",
        emissive: "#ff2614",
        emissiveIntensity: 0.05,
        roughness: 0.12,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
      }),
    );
  }

  /** Additive halo sprite material for a lamp (per vehicle, faded by state). */
  glow(color: THREE.ColorRepresentation): THREE.SpriteMaterial {
    return this.own(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        color,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: true,
      }),
    );
  }

  private own<T extends THREE.Material>(m: T): T {
    this.owned.push(m);
    return m;
  }

  dispose(): void {
    for (const m of [
      this.trim,
      this.liner,
      this.metal,
      this.chrome,
      this.rubber,
      this.seal,
      this.interior,
      this.upholstery,
      this.gauge,
      this.glass,
      this.amber,
      this.reverse,
      this.rim,
      ...this.owned,
    ]) {
      m.dispose();
    }
    this.owned.length = 0;
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
    for (const g of this.geometries.values()) g.dispose();
    this.geometries.clear();
  }
}
