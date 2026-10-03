import * as THREE from "three";

/**
 * CC0 surface scans for the built structures (see
 * public/assets/structures/CREDITS.md). Each map is exposed as a shared
 * uniform whose value starts as a 1×1 neutral placeholder and is swapped for
 * the real texture once it has loaded — no shader recompiles, no black
 * flashes while the files stream in, and the scene still renders correctly
 * (procedural detail only) if a file never arrives.
 */

const BASE = `${import.meta.env?.BASE_URL ?? "/"}assets/structures/`;

function placeholder(r: number, g: number, b: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

type Kind = "diff" | "nor" | "arm" | "mask";
const NEUTRAL: Record<Kind, [number, number, number]> = {
  diff: [128, 128, 128],
  nor: [128, 128, 255],
  arm: [255, 200, 0],
  mask: [128, 128, 128],
};

const loader = typeof document !== "undefined" ? new THREE.TextureLoader() : null;

function sampler(file: string, kind: Kind): THREE.IUniform<THREE.Texture> {
  const [r, g, b] = NEUTRAL[kind];
  const uniform: THREE.IUniform<THREE.Texture> = { value: placeholder(r, g, b, kind === "diff") };
  loader?.load(
    BASE + file,
    (tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 8;
      tex.colorSpace = kind === "diff" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      uniform.value = tex;
    },
    undefined,
    () => {
      /* keep the neutral placeholder; procedural detail still renders */
    },
  );
  return uniform;
}

export const structureMaps = {
  asphaltDiff: sampler("asphalt_02_diff.webp", "diff"),
  asphaltNor: sampler("asphalt_02_nor_gl.webp", "nor"),
  asphaltArm: sampler("asphalt_02_arm.webp", "arm"),
  concreteDiff: sampler("brushed_concrete_diff.webp", "diff"),
  concreteNor: sampler("brushed_concrete_nor_gl.webp", "nor"),
  concreteArm: sampler("brushed_concrete_arm.webp", "arm"),
  gravelDiff: sampler("gravel_floor_diff.webp", "diff"),
  gravelNor: sampler("gravel_floor_nor_gl.webp", "nor"),
  cladNor: sampler("box_profile_metal_sheet_nor_gl.webp", "nor"),
  cladArm: sampler("box_profile_metal_sheet_arm.webp", "arm"),
  shutterNor: sampler("painted_metal_shutter_nor_gl.webp", "nor"),
  shutterArm: sampler("painted_metal_shutter_arm.webp", "arm"),
};
