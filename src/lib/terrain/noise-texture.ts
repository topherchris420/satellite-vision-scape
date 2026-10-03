import * as THREE from "three";

/**
 * Tileable value-noise texture shared by the ground shader, the GPU ground
 * cover scatter and CPU vegetation placement. The four channels are
 * independent fBm fields; the CPU sampler below reads the same bytes with the
 * same bilinear filter so trees planted on the CPU line up with washes and
 * clay pans painted on the GPU.
 */
export const NOISE_SIZE = 256;

let noiseData: Uint8Array | null = null;
let noiseTexture: THREE.DataTexture | null = null;

function lattice(seed: number, period: number) {
  const values = new Float32Array(period * period);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < values.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    values[i] = s / 4294967296;
  }
  return (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const x0 = ((ix % period) + period) % period;
    const y0 = ((iy % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;
    const a = values[y0 * period + x0];
    const b = values[y0 * period + x1];
    const c = values[y1 * period + x0];
    const d = values[y1 * period + x1];
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
}

function buildNoiseData(): Uint8Array {
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);
  const seeds = [9137, 2251, 7741, 4423];
  for (let c = 0; c < 4; c++) {
    // Octave lattices whose periods divide the texture size keep it tileable.
    const octaves = [4, 8, 16, 32, 64].map((p, o) => ({
      p,
      f: lattice(seeds[c] + o * 101, p),
      a: 0.5 ** o,
    }));
    let min = Infinity;
    let max = -Infinity;
    const field = new Float32Array(NOISE_SIZE * NOISE_SIZE);
    for (let y = 0; y < NOISE_SIZE; y++) {
      for (let x = 0; x < NOISE_SIZE; x++) {
        let v = 0;
        for (const o of octaves) v += o.a * o.f((x / NOISE_SIZE) * o.p, (y / NOISE_SIZE) * o.p);
        field[y * NOISE_SIZE + x] = v;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    // Stretch to the full byte range so thresholds behave the same per channel.
    for (let i = 0; i < field.length; i++) {
      data[i * 4 + c] = Math.round(((field[i] - min) / (max - min)) * 255);
    }
  }
  return data;
}

export function getNoiseData(): Uint8Array {
  if (!noiseData) noiseData = buildNoiseData();
  return noiseData;
}

export function getNoiseTexture(): THREE.DataTexture {
  if (noiseTexture) return noiseTexture;
  const tex = new THREE.DataTexture(getNoiseData(), NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  noiseTexture = tex;
  return tex;
}

/**
 * Bilinear, wrapped read of one channel at texture coordinates (u, v), the
 * CPU twin of `texture(tNoise, uv)[channel]` at mip 0. Returns 0..1.
 */
export function sampleNoise(u: number, v: number, channel: number): number {
  const data = getNoiseData();
  const x = u * NOISE_SIZE - 0.5;
  const y = v * NOISE_SIZE - 0.5;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const m = NOISE_SIZE - 1;
  const x0 = ix & m;
  const y0 = iy & m;
  const x1 = (x0 + 1) & m;
  const y1 = (y0 + 1) & m;
  const a = data[(y0 * NOISE_SIZE + x0) * 4 + channel];
  const b = data[(y0 * NOISE_SIZE + x1) * 4 + channel];
  const c = data[(y1 * NOISE_SIZE + x0) * 4 + channel];
  const d = data[(y1 * NOISE_SIZE + x1) * 4 + channel];
  return (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) / 255;
}
