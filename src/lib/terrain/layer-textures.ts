import * as THREE from "three";

/**
 * Photographic CC0 surface sets (public/assets/terrain, see CREDITS.md),
 * packed at runtime into two texture arrays so the ground shader binds every
 * layer through just two samplers:
 *
 *   albedo array  RGB = albedo (sRGB), A = roughness
 *   detail array  RG  = tangent-space normal XY, B = height, A = unused
 *
 * Each source set ships as `<id>_albedo.webp`, `<id>_nh.jpg` (normal XY and
 * height) and `<id>_rough.jpg`, all opaque so no browser alpha
 * premultiplication can disturb the data channels.
 */
export const GROUND_LAYERS = [
  "red_sand",
  "red_laterite_soil_stones",
  "rocky_gravel",
  "dry_ground_01",
  "cliff_side",
  "rock_face",
] as const;

export const LAYER = {
  sand: 0,
  soil: 1,
  gravel: 2,
  clay: 3,
  cliff: 4,
  rock: 5,
} as const;

/** Bark and lawn sets used by vegetation and the campus gardens. */
export const PLANT_LAYERS = ["eucalyptus_bark", "bark_bluegum", "lawn_grass"] as const;

const base = `${import.meta.env.BASE_URL ?? "/"}assets/terrain/`;

export function layerUrls(ids: readonly string[]): string[] {
  return ids.flatMap((id) => [
    `${base}${id}_albedo.webp`,
    `${base}${id}_nh.jpg`,
    `${base}${id}_rough.jpg`,
  ]);
}

export type PackedLayers = {
  albedo: THREE.DataArrayTexture;
  detail: THREE.DataArrayTexture;
  /** Mean linear albedo per layer, used to re-tint detail without shifting hue. */
  mean: THREE.Vector3[];
  size: number;
};

function pixels(image: CanvasImageSource, size: number): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
}

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function arrayTexture(data: Uint8Array, size: number, layers: number, srgb: boolean) {
  const tex = new THREE.DataArrayTexture(data, size, size, layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const packed = new Map<string, PackedLayers>();

/**
 * Packs loaded images (three per layer, in `layerUrls` order) into arrays.
 * Results are cached per layer list and size; the arrays live for the page.
 */
export function packLayers(
  key: string,
  images: CanvasImageSource[],
  layerCount: number,
  size: number,
): PackedLayers {
  const cacheKey = `${key}@${size}`;
  const hit = packed.get(cacheKey);
  if (hit) return hit;
  const texels = size * size;
  const albedo = new Uint8Array(texels * 4 * layerCount);
  const detail = new Uint8Array(texels * 4 * layerCount);
  const mean: THREE.Vector3[] = [];
  for (let l = 0; l < layerCount; l++) {
    const a = pixels(images[l * 3], size);
    const nh = pixels(images[l * 3 + 1], size);
    const r = pixels(images[l * 3 + 2], size);
    const o = l * texels * 4;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let i = 0; i < texels; i++) {
      const p = i * 4;
      albedo[o + p] = a[p];
      albedo[o + p + 1] = a[p + 1];
      albedo[o + p + 2] = a[p + 2];
      albedo[o + p + 3] = r[p];
      detail[o + p] = nh[p];
      detail[o + p + 1] = nh[p + 1];
      detail[o + p + 2] = nh[p + 2];
      detail[o + p + 3] = 255;
      if ((i & 63) === 0) {
        sr += toLinear(a[p]);
        sg += toLinear(a[p + 1]);
        sb += toLinear(a[p + 2]);
      }
    }
    const n = Math.ceil(texels / 64);
    mean.push(new THREE.Vector3(sr / n, sg / n, sb / n));
  }
  const result: PackedLayers = {
    albedo: arrayTexture(albedo, size, layerCount, true),
    detail: arrayTexture(detail, size, layerCount, false),
    mean,
    size,
  };
  packed.set(cacheKey, result);
  return result;
}
