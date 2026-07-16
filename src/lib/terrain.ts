// Shared terrain height field. Keeps the ground mesh, tree placement and the
// walking camera all agreeing on the elevation at any (x, z).
//
// The developed compound is kept flat (grade ~0). The land rises into hills to
// the east (positive X, right of the image) and dips gently to drainage in the
// far south, matching the reference imagery.

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function smooth(x: number, y: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const fx = x - ix,
    fy = y - iy;
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
}
function fbm(x: number, y: number) {
  let v = 0,
    amp = 0.5,
    freq = 1;
  for (let i = 0; i < 6; i++) {
    v += amp * smooth(x * freq, y * freq);
    freq *= 2;
    amp *= 0.5;
  }
  return v;
}

// Smoothstep helper
function ss(edge0: number, edge1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const FENCE_EAST = 135; // compound edge; hills start beyond this

export function terrainHeight(x: number, z: number): number {
  // Flat pad across the fenced compound.
  const eastFactor = ss(FENCE_EAST, FENCE_EAST + 90, x);
  const hills = fbm(x * 0.012 + 10, z * 0.012 + 4) * 38 * eastFactor;
  // gentle ridge line
  const ridge = Math.max(0, Math.sin((z + 200) * 0.004)) * 10 * eastFactor;
  // very slight roll on the western scrub so it is not perfectly flat
  const westRoll = fbm(x * 0.01, z * 0.01) * 2.8 * ss(-90, -160, x);
  // micro-undulation everywhere for realism (eliminates perfectly flat patches)
  const micro = fbm(x * 0.04 + 3, z * 0.04 + 7) * 0.4;
  return hills + ridge + westRoll + micro;
}
