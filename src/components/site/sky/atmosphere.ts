/**
 * Physically based clear-sky model for central Australia (Pine Gap sits at
 * roughly 650 m above sea level). Single scattering through a spherical
 * atmosphere with Rayleigh, Mie (desert aerosol) and ozone, plus a cheap
 * isotropic multiple-scattering term so twilight skies do not go black.
 *
 * Everything here is plain TypeScript with no WebGL dependency: the same
 * model feeds the sky dome (as a look-up texture), the sun's light colour,
 * the aerial-perspective haze colours and the image-based lighting, so the
 * sky, the fog and the lit ground always agree. Radiance values are per unit
 * of solar irradiance; callers scale them into scene light units.
 */

export type Vec3 = [number, number, number];

const EARTH_RADIUS = 6360e3;
const ATMOSPHERE_RADIUS = 6420e3;
/** Observer altitude above sea level (the Alice Springs basin). */
export const OBSERVER_ALTITUDE = 650;

const RAYLEIGH: Vec3 = [5.802e-6, 13.558e-6, 33.1e-6];
const RAYLEIGH_HEIGHT = 8000;
const MIE_SCATTER = 3.996e-6;
const MIE_EXTINCTION = 4.44e-6;
const MIE_HEIGHT = 1200;
const OZONE: Vec3 = [0.65e-6, 1.881e-6, 0.085e-6];

export type AtmosphereOptions = {
  /** Aerosol multiplier: 1 is a clean continental sky, 2-3 a dusty desert. */
  aerosol?: number;
  /** Mie anisotropy (forward scattering of dust around the sun). */
  mieG?: number;
  /** Strength of the approximate multiple-scattering fill. */
  multiScatter?: number;
};

function densityRayleigh(h: number) {
  return Math.exp(-h / RAYLEIGH_HEIGHT);
}
function densityMie(h: number) {
  return Math.exp(-h / MIE_HEIGHT);
}
function densityOzone(h: number) {
  return Math.max(0, 1 - Math.abs(h - 25e3) / 15e3);
}

/** Distance along a ray from radius r with cos-zenith mu to a sphere of radius R (or -1). */
function raySphere(r: number, mu: number, R: number): number {
  const b = r * mu;
  const c = r * r - R * R;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t1 = -b - s;
  const t2 = -b + s;
  if (t1 > 0) return t1;
  if (t2 > 0) return t2;
  return -1;
}

/**
 * Transmittance from altitude h towards the top of the atmosphere along a
 * direction with cos-zenith mu, tabulated for fast look-up.
 */
class TransmittanceTable {
  readonly nh = 48;
  readonly nmu = 160;
  readonly data: Float32Array;

  constructor(private readonly aerosol: number) {
    this.data = new Float32Array(this.nh * this.nmu * 3);
    for (let j = 0; j < this.nh; j++) {
      const h = this.altitude(j);
      for (let i = 0; i < this.nmu; i++) {
        const mu = this.mu(i);
        const t = this.integrate(h, mu);
        const k = (j * this.nmu + i) * 3;
        this.data[k] = t[0];
        this.data[k + 1] = t[1];
        this.data[k + 2] = t[2];
      }
    }
  }

  private altitude(j: number) {
    const u = j / (this.nh - 1);
    return u * u * (ATMOSPHERE_RADIUS - EARTH_RADIUS);
  }
  private mu(i: number) {
    // Denser near the horizon, where the sun colour changes fastest.
    const u = (i / (this.nmu - 1)) * 2 - 1;
    return Math.sign(u) * u * u;
  }

  private integrate(h: number, mu: number): Vec3 {
    const r = EARTH_RADIUS + h;
    if (raySphere(r, mu, EARTH_RADIUS) > 0) return [0, 0, 0];
    const len = raySphere(r, mu, ATMOSPHERE_RADIUS);
    if (len <= 0) return [1, 1, 1];
    const steps = 48;
    let odR = 0;
    let odM = 0;
    let odO = 0;
    let prev = 0;
    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      const t = len * u * u;
      const tm = (t + prev) * 0.5;
      const ds = t - prev;
      prev = t;
      const rr = Math.sqrt(r * r + tm * tm + 2 * r * tm * mu);
      const hh = Math.max(0, rr - EARTH_RADIUS);
      odR += densityRayleigh(hh) * ds;
      odM += densityMie(hh) * ds;
      odO += densityOzone(hh) * ds;
    }
    const me = MIE_EXTINCTION * this.aerosol;
    return [0, 1, 2].map((c) => Math.exp(-(RAYLEIGH[c] * odR + me * odM + OZONE[c] * odO))) as Vec3;
  }

  sample(h: number, mu: number, out: Vec3): Vec3 {
    const hu = Math.sqrt(Math.min(1, Math.max(0, h / (ATMOSPHERE_RADIUS - EARTH_RADIUS))));
    const mc = Math.min(1, Math.max(-1, mu));
    const mu01 = (Math.sign(mc) * Math.sqrt(Math.abs(mc)) + 1) * 0.5;
    const fx = mu01 * (this.nmu - 1);
    const fy = hu * (this.nh - 1);
    const x0 = Math.min(this.nmu - 2, Math.floor(fx));
    const y0 = Math.min(this.nh - 2, Math.floor(fy));
    const tx = fx - x0;
    const ty = fy - y0;
    for (let c = 0; c < 3; c++) {
      const a = this.data[(y0 * this.nmu + x0) * 3 + c];
      const b = this.data[(y0 * this.nmu + x0 + 1) * 3 + c];
      const d = this.data[((y0 + 1) * this.nmu + x0) * 3 + c];
      const e = this.data[((y0 + 1) * this.nmu + x0 + 1) * 3 + c];
      out[c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
    }
    return out;
  }
}

function rayleighPhase(mu: number) {
  return (3 / (16 * Math.PI)) * (1 + mu * mu);
}
function miePhase(mu: number, g: number) {
  // Cornette-Shanks.
  const g2 = g * g;
  const k = (3 / (8 * Math.PI)) * ((1 - g2) / (2 + g2));
  return (k * (1 + mu * mu)) / Math.pow(1 + g2 - 2 * g * mu, 1.5);
}

/** Look-up texture layout: x = azimuth from the sun (0..pi), y = sqrt(elevation / (pi/2)). */
export const SKY_LUT_WIDTH = 128;
export const SKY_LUT_HEIGHT = 64;

export type SkySolution = {
  /** RGBA float radiance, SKY_LUT_WIDTH x SKY_LUT_HEIGHT, per unit solar irradiance. */
  lut: Float32Array;
  /** Fraction of sunlight reaching the observer, per channel. */
  sunTransmittance: Vec3;
  /** Horizon radiance looking towards, across and away from the sun. */
  horizonToward: Vec3;
  horizonSide: Vec3;
  horizonAway: Vec3;
  zenith: Vec3;
  /** Irradiance on a horizontal surface from the sky dome alone. */
  skyIrradiance: Vec3;
};

/** Direction for an LUT texel centre, in a frame where the sun has azimuth 0 (+z). */
function lutDirection(x: number, y: number, out: Vec3): Vec3 {
  const phi = ((x + 0.5) / SKY_LUT_WIDTH) * Math.PI;
  const v = (y + 0.5) / SKY_LUT_HEIGHT;
  const elev = v * v * (Math.PI / 2);
  const ce = Math.cos(elev);
  out[0] = ce * Math.sin(phi);
  out[1] = Math.sin(elev);
  out[2] = ce * Math.cos(phi);
  return out;
}

/**
 * Solves the sky for a light source at the given elevation (radians). The
 * result depends only on elevation, so it is cheap to cache per time of day.
 */
export function solveSky(sunElevation: number, options: AtmosphereOptions = {}): SkySolution {
  const aerosol = options.aerosol ?? 1.8;
  const g = options.mieG ?? 0.78;
  const msK = options.multiScatter ?? 0.25;
  const table = new TransmittanceTable(aerosol);
  const sun: Vec3 = [0, Math.sin(sunElevation), Math.cos(sunElevation)];
  const lut = new Float32Array(SKY_LUT_WIDTH * SKY_LUT_HEIGHT * 4);
  const dir: Vec3 = [0, 0, 0];
  const tSun: Vec3 = [0, 0, 0];
  const tMs: Vec3 = [0, 0, 0];
  const r0 = EARTH_RADIUS + OBSERVER_ALTITUDE;
  const ms = MIE_SCATTER * aerosol;
  const me = MIE_EXTINCTION * aerosol;
  const steps = 40;

  const radiance = (d: Vec3, out: Vec3): Vec3 => {
    const mu = d[1];
    const ground = raySphere(r0, mu, EARTH_RADIUS);
    const len = ground > 0 ? ground : raySphere(r0, mu, ATMOSPHERE_RADIUS);
    const cosSun = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2];
    const pr = rayleighPhase(cosSun);
    const pm = miePhase(cosSun, g);
    let odR = 0;
    let odM = 0;
    let odO = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let prev = 0;
    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      const t = len * u * u;
      const tm = (t + prev) * 0.5;
      const ds = t - prev;
      prev = t;
      // Sample position relative to the planet centre (observer on +y).
      const px = d[0] * tm;
      const py = r0 + d[1] * tm;
      const pz = d[2] * tm;
      const rr = Math.sqrt(px * px + py * py + pz * pz);
      const h = Math.max(0, rr - EARTH_RADIUS);
      const dR = densityRayleigh(h);
      const dM = densityMie(h);
      const dO = densityOzone(h);
      odR += dR * ds * 0.5;
      odM += dM * ds * 0.5;
      odO += dO * ds * 0.5;
      // Sun zenith cosine at the sample (the local "up" is the radial direction).
      const muS = (px * sun[0] + py * sun[1] + pz * sun[2]) / rr;
      table.sample(h, muS, tSun);
      // Multiple scattering arrives from the whole sky, along paths far
      // shorter than the grazing sun ray: feed it with a less reddened beam.
      table.sample(h, Math.max(muS, 0.3), tMs);
      for (let c = 0; c < 3; c++) {
        const tv = Math.exp(-(RAYLEIGH[c] * odR + me * odM + OZONE[c] * odO));
        const single = RAYLEIGH[c] * dR * pr + ms * dM * pm;
        // Approximate multiple scattering: isotropic, fed by the sunlight that
        // reaches this altitude (slightly widened so twilight keeps a glow).
        const multi = (RAYLEIGH[c] * dR + ms * dM) * (msK / (4 * Math.PI));
        const lit = tSun[c] * single + tMs[c] * multi * Math.min(1, Math.max(0, (muS + 0.1) * 4));
        const v = tv * lit * ds;
        if (c === 0) sr += v;
        else if (c === 1) sg += v;
        else sb += v;
      }
      odR += dR * ds * 0.5;
      odM += dM * ds * 0.5;
      odO += dO * ds * 0.5;
    }
    out[0] = sr;
    out[1] = sg;
    out[2] = sb;
    return out;
  };

  const tmp: Vec3 = [0, 0, 0];
  const irr: Vec3 = [0, 0, 0];
  for (let y = 0; y < SKY_LUT_HEIGHT; y++) {
    for (let x = 0; x < SKY_LUT_WIDTH; x++) {
      lutDirection(x, y, dir);
      radiance(dir, tmp);
      const k = (y * SKY_LUT_WIDTH + x) * 4;
      lut[k] = tmp[0];
      lut[k + 1] = tmp[1];
      lut[k + 2] = tmp[2];
      lut[k + 3] = 1;
    }
  }

  // Horizontal irradiance: integrate L cos(theta) over the upper hemisphere
  // using the LUT (both azimuth halves are mirror images).
  for (let y = 0; y < SKY_LUT_HEIGHT; y++) {
    const v0 = y / SKY_LUT_HEIGHT;
    const v1 = (y + 1) / SKY_LUT_HEIGHT;
    const e0 = v0 * v0 * (Math.PI / 2);
    const e1 = v1 * v1 * (Math.PI / 2);
    // Solid angle of the band times the mean of sin(elevation).
    const band = (Math.sin(e1) - Math.sin(e0)) * ((Math.sin(e1) + Math.sin(e0)) / 2);
    const dPhi = (2 * Math.PI) / SKY_LUT_WIDTH;
    for (let x = 0; x < SKY_LUT_WIDTH; x++) {
      const k = (y * SKY_LUT_WIDTH + x) * 4;
      for (let c = 0; c < 3; c++) irr[c] += lut[k + c] * band * dPhi;
    }
  }

  const at = (phi: number, elevation: number): Vec3 => {
    const ce = Math.cos(elevation);
    return radiance([ce * Math.sin(phi), Math.sin(elevation), ce * Math.cos(phi)], [0, 0, 0]);
  };
  const sunT = table.sample(OBSERVER_ALTITUDE, sun[1], [0, 0, 0]);
  return {
    lut,
    sunTransmittance: sunT,
    horizonToward: at(0, 0.03),
    horizonSide: at(Math.PI / 2, 0.03),
    horizonAway: at(Math.PI, 0.03),
    zenith: at(0, Math.PI / 2),
    skyIrradiance: irr,
  };
}

export function luminance(c: Vec3) {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
