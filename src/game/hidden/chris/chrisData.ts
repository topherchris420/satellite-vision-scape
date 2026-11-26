/**
 * Christopher Woodyard's figure for the hidden case, as exported by
 * `gta-sa-99-9-percent-sure/tools/character/export_web.py` from the mod's own
 * procedural model on the repository's synthetic skeleton (no game files).
 *
 * Plain data and decoding only, so it can be checked headless.
 */

export interface ChrisBone {
  name: string;
  /** Index of the parent bone, -1 for the root. */
  parent: number;
  /** Bind position in the figure's frame (metres, +X left, +Y up, +Z forward). */
  position: [number, number, number];
}

export interface ChrisMaterial {
  name: string;
  transparent: boolean;
}

export interface ChrisGroup {
  material: string;
  start: number;
  count: number;
}

/** The exported file (`chrisw-mesh.json`). */
export interface ChrisFile {
  format: string;
  scale: number;
  vertexCount: number;
  triangleCount: number;
  bones: ChrisBone[];
  materials: ChrisMaterial[];
  groups: ChrisGroup[];
  position: string;
  normal: string;
  uv0: string;
  index: string;
  skinIndex: string;
  skinWeight: string;
}

export interface ChrisMesh {
  bones: ChrisBone[];
  materials: ChrisMaterial[];
  groups: ChrisGroup[];
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  index: Uint16Array;
  skinIndex: Uint8Array;
  skinWeight: Float32Array;
}

export const CHRIS_FORMAT = "chrisw-web-1";

function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Little-endian typed views; the export writes little-endian, as every browser reads. */
function view<T extends Float32Array | Uint16Array>(
  b64: string,
  make: (buffer: ArrayBuffer) => T,
  length: number,
  what: string,
): T {
  const raw = bytes(b64);
  const copy = new ArrayBuffer(raw.byteLength);
  new Uint8Array(copy).set(raw);
  const out = make(copy);
  if (out.length !== length) throw new Error(`chrisw: ${what} has ${out.length} values, expected ${length}`);
  return out;
}

/** Decode and check the exported file; throws on anything inconsistent. */
export function decodeChris(file: ChrisFile): ChrisMesh {
  if (file.format !== CHRIS_FORMAT) throw new Error(`chrisw: unknown format ${String(file.format)}`);
  const n = file.vertexCount;
  const t = file.triangleCount;
  const skinIndex = bytes(file.skinIndex);
  if (skinIndex.length !== n * 4) throw new Error("chrisw: skin indices do not match the vertices");
  const mesh: ChrisMesh = {
    bones: file.bones,
    materials: file.materials,
    groups: file.groups,
    position: view(file.position, (b) => new Float32Array(b), n * 3, "position"),
    normal: view(file.normal, (b) => new Float32Array(b), n * 3, "normal"),
    uv: view(file.uv0, (b) => new Float32Array(b), n * 2, "uv"),
    index: view(file.index, (b) => new Uint16Array(b), t * 3, "index"),
    skinIndex,
    skinWeight: view(file.skinWeight, (b) => new Float32Array(b), n * 4, "skinWeight"),
  };
  for (const i of mesh.index) if (i >= n) throw new Error("chrisw: triangle index out of range");
  for (const b of skinIndex) if (b >= file.bones.length) throw new Error("chrisw: skin bone out of range");
  return mesh;
}
