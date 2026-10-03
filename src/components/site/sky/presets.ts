import {
  luminance,
  solveSky,
  SKY_LUT_HEIGHT,
  SKY_LUT_WIDTH,
  type AtmosphereOptions,
  type SkySolution,
  type Vec3,
} from "./atmosphere";

export type TimeOfDay = "day" | "dusk" | "night";

/** Unit vector towards a body at a compass azimuth (deg, from grid north) and elevation (deg). */
export function bodyDirection(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  // World axes: +x east, -z north, +y up.
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

export type GradeSettings = {
  /** Linear exposure multiplier applied before tone mapping. */
  exposure: number;
  /** White balance as a linear RGB gain (applied before tone mapping). */
  balance: Vec3;
  /** Log-space contrast around middle grey (1 = neutral). */
  contrast: number;
  saturation: number;
  /** Saturation of the darkest tones (scotopic desaturation at night). */
  darkSaturation?: number;
  /** Display-space split toning: shadows and highlights tints (added). */
  shadowTint: Vec3;
  highlightTint: Vec3;
  vignette: number;
};

export type SkyPreset = {
  /** Key light: the sun by day and dusk, the moon at night. */
  source: Vec3;
  /** Key light illuminance in scene light units, before atmospheric loss. */
  illuminance: number;
  /** Sky radiance scale relative to the key light (the night sky is drawn dark). */
  skyScale: number;
  /** Image-based light strength relative to the physical sky. */
  envIntensity: number;
  atmosphere: AtmosphereOptions;
  /**
   * Art direction of the low sky: hue shifts (luminance preserved) towards
   * and away from the sun, fading out above `height` radians of elevation.
   */
  skyTint?: { toward: Vec3; away: Vec3; height: number };
  /** Tint multiplied into the key light (moonlight reads cool). */
  keyTint: Vec3;
  fog: {
    /** Extinction per metre at the base height. */
    density: number;
    /** Exponential height falloff, 1/m. */
    falloff: number;
    /** Relative RGB extinction (blue scatters most). */
    extinction: Vec3;
    /** Forward-scattering glow around the sun. */
    mie: number;
  };
  clouds: {
    /** 0..1 fraction of sky covered by the cumulus layer. */
    coverage: number;
    /** Opacity and self-shadowing of the cumulus. */
    density: number;
    /** Strength of the high cirrus layer. */
    cirrus: number;
    /** How much the cumulus darkens the ground below (0 disables). */
    shadow: number;
  };
  /** 0 by day, 1 at night: stars, Milky Way, moon disc, site lights. */
  night: number;
  /** Floodlight and lamp output (0 = off). */
  siteLights: number;
  grade: GradeSettings;
};

export const SKY_PRESETS: Record<TimeOfDay, SkyPreset> = {
  // Late-morning winter sun high in the north-north-west: crisp shadows that
  // model the radomes from the viewer's usual north-easterly vantage.
  day: {
    source: bodyDirection(328, 47),
    illuminance: 3.6,
    skyScale: 1,
    envIntensity: 1.25,
    atmosphere: { aerosol: 1.7, mieG: 0.78, multiScatter: 0.55 },
    skyTint: { toward: [1.05, 1.0, 0.92], away: [0.98, 1.0, 1.04], height: 0.2 },
    keyTint: [1, 0.985, 0.96],
    fog: { density: 0.8e-4, falloff: 1 / 1500, extinction: [0.62, 0.8, 1.08], mie: 0.18 },
    clouds: { coverage: 0.4, density: 1, cirrus: 0.35, shadow: 0.72 },
    night: 0,
    siteLights: 0,
    grade: {
      exposure: 1.05,
      balance: [1, 1, 1],
      contrast: 1.06,
      saturation: 1.06,
      shadowTint: [-0.003, 0.0, 0.006],
      highlightTint: [0.012, 0.006, -0.008],
      vignette: 0.16,
    },
  },
  // Golden hour: the sun a few degrees above the western ranges, long
  // shadows across the plain, warm key against a cool sky fill.
  dusk: {
    source: bodyDirection(296, 10.5),
    illuminance: 4.4,
    skyScale: 1,
    envIntensity: 1.15,
    atmosphere: { aerosol: 2.2, mieG: 0.8, multiScatter: 0.6 },
    // Golden glow under the sun, a rose-lavender band opposite it.
    skyTint: { toward: [1.18, 0.95, 0.66], away: [1.28, 0.86, 1.1], height: 0.3 },
    keyTint: [1, 0.9, 0.74],
    fog: { density: 1.5e-4, falloff: 1 / 1300, extinction: [0.55, 0.78, 1.12], mie: 0.32 },
    clouds: { coverage: 0.27, density: 0.9, cirrus: 0.75, shadow: 0.6 },
    night: 0,
    siteLights: 0.35,
    grade: {
      exposure: 1.45,
      balance: [1.04, 1, 0.94],
      contrast: 1.1,
      saturation: 1.08,
      shadowTint: [-0.004, 0.0, 0.009],
      highlightTint: [0.024, 0.01, -0.014],
      vignette: 0.22,
    },
  },
  // A waxing moon in the north-west, a famously dark outback sky: the
  // Milky Way overhead, site floodlights pooling warm on the red earth.
  night: {
    source: bodyDirection(300, 41),
    illuminance: 0.42,
    skyScale: 0.07,
    envIntensity: 2.4,
    atmosphere: { aerosol: 1.2, mieG: 0.8, multiScatter: 0.5 },
    keyTint: [0.62, 0.76, 1],
    fog: { density: 0.9e-4, falloff: 1 / 1500, extinction: [0.7, 0.85, 1.05], mie: 0.05 },
    clouds: { coverage: 0, density: 0, cirrus: 0.08, shadow: 0 },
    night: 1,
    siteLights: 1,
    grade: {
      exposure: 3.1,
      balance: [0.9, 1, 1.12],
      contrast: 1.08,
      saturation: 0.95,
      darkSaturation: 0.55,
      shadowTint: [-0.004, 0.002, 0.018],
      highlightTint: [0.016, 0.008, -0.006],
      vignette: 0.3,
    },
  },
};

/** Solved sky and the derived light colours for one time of day (cached). */
export type SkyState = {
  preset: SkyPreset;
  solution: SkySolution;
  /** Normalised direction to the key light. */
  sourceDir: Vec3;
  /** Key light colour (linear) and intensity after the atmosphere. */
  keyColor: Vec3;
  keyIntensity: number;
  /** Multiplier from LUT radiance to scene radiance. */
  radianceScale: number;
  /** Radiance of the ground seen from afar (for the sky's lower hemisphere). */
  groundRadiance: Vec3;
};

const cache = new Map<TimeOfDay, SkyState>();

function tintColor(c: Vec3, tint: Vec3, w: number): Vec3 {
  const l = luminance(c);
  const t: Vec3 = [1 + (tint[0] - 1) * w, 1 + (tint[1] - 1) * w, 1 + (tint[2] - 1) * w];
  const out: Vec3 = [c[0] * t[0], c[1] * t[1], c[2] * t[2]];
  const k = l / Math.max(1e-9, luminance(out));
  return [out[0] * k, out[1] * k, out[2] * k];
}

/** Applies a preset's low-sky tint to the LUT and the horizon colours (in place). */
function tintSky(solution: SkySolution, tint: NonNullable<SkyPreset["skyTint"]>) {
  const weight = (cosAz: number, elevation: number) => {
    const fade = Math.exp(-elevation / tint.height);
    return { toward: ((1 + cosAz) / 2) ** 4 * fade, away: ((1 - cosAz) / 2) ** 1.5 * fade };
  };
  const apply = (c: Vec3, cosAz: number, elevation: number): Vec3 => {
    const w = weight(cosAz, elevation);
    return tintColor(tintColor(c, tint.toward, w.toward), tint.away, w.away);
  };
  const lut = solution.lut;
  for (let y = 0; y < SKY_LUT_HEIGHT; y++) {
    const v = (y + 0.5) / SKY_LUT_HEIGHT;
    const elevation = v * v * (Math.PI / 2);
    for (let x = 0; x < SKY_LUT_WIDTH; x++) {
      const cosAz = Math.cos(((x + 0.5) / SKY_LUT_WIDTH) * Math.PI);
      const k = (y * SKY_LUT_WIDTH + x) * 4;
      const c = apply([lut[k], lut[k + 1], lut[k + 2]], cosAz, elevation);
      lut[k] = c[0];
      lut[k + 1] = c[1];
      lut[k + 2] = c[2];
    }
  }
  solution.horizonToward = apply(solution.horizonToward, 1, 0.03);
  solution.horizonSide = apply(solution.horizonSide, 0, 0.03);
  solution.horizonAway = apply(solution.horizonAway, -1, 0.03);
}

/** Linear albedo of the red Arenosol plains, used for sky-dome ground bounce. */
const GROUND_ALBEDO: Vec3 = [0.34, 0.15, 0.08];

export function getSkyState(time: TimeOfDay): SkyState {
  const hit = cache.get(time);
  if (hit) return hit;
  const preset = SKY_PRESETS[time];
  const s = preset.source;
  const len = Math.hypot(s[0], s[1], s[2]);
  const sourceDir: Vec3 = [s[0] / len, s[1] / len, s[2] / len];
  const solution = solveSky(Math.asin(sourceDir[1]), preset.atmosphere);
  if (preset.skyTint) tintSky(solution, preset.skyTint);
  const t = solution.sunTransmittance;
  const lum = Math.max(1e-4, luminance(t));
  const keyColor: Vec3 = [
    (t[0] / lum) * preset.keyTint[0],
    (t[1] / lum) * preset.keyTint[1],
    (t[2] / lum) * preset.keyTint[2],
  ];
  const keyLum = Math.max(1e-4, luminance(keyColor));
  for (let c = 0; c < 3; c++) keyColor[c] /= keyLum;
  const keyIntensity = preset.illuminance * lum;
  const radianceScale = preset.illuminance * preset.skyScale;
  const sunOnGround = Math.max(0, sourceDir[1]) * keyIntensity;
  const groundRadiance = [0, 1, 2].map(
    (c) =>
      (GROUND_ALBEDO[c] * (sunOnGround * keyColor[c] + solution.skyIrradiance[c] * radianceScale)) / Math.PI,
  ) as Vec3;
  const state: SkyState = { preset, solution, sourceDir, keyColor, keyIntensity, radianceScale, groundRadiance };
  cache.set(time, state);
  return state;
}
