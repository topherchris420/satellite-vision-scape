import { describe, expect, test } from "bun:test";
import { luminance, solveSky, SKY_LUT_HEIGHT, SKY_LUT_WIDTH } from "../src/components/site/sky/atmosphere";
import { SKY_PRESETS, bodyDirection, getSkyState } from "../src/components/site/sky/presets";

describe("sky model", () => {
  test("high sun: blue zenith, brighter horizon, near-white sunlight", () => {
    const s = solveSky((50 * Math.PI) / 180);
    expect(s.lut.length).toBe(SKY_LUT_WIDTH * SKY_LUT_HEIGHT * 4);
    expect(s.lut.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    // Rayleigh: the zenith is clearly blue.
    expect(s.zenith[2]).toBeGreaterThan(s.zenith[0] * 2.5);
    expect(luminance(s.horizonSide)).toBeGreaterThan(luminance(s.zenith));
    expect(s.sunTransmittance[0]).toBeGreaterThan(0.8);
    expect(s.sunTransmittance[2]).toBeGreaterThan(0.6);
  });

  test("low sun reddens the light and brightens the sunward horizon", () => {
    const high = solveSky((50 * Math.PI) / 180);
    const low = solveSky((8 * Math.PI) / 180);
    const ratio = (c: number[]) => c[0] / c[2];
    expect(ratio(low.sunTransmittance)).toBeGreaterThan(ratio(high.sunTransmittance) * 2);
    expect(ratio(low.horizonToward)).toBeGreaterThan(ratio(low.horizonAway));
  });

  test("presets resolve to unit light directions and finite colours", () => {
    for (const time of Object.keys(SKY_PRESETS) as (keyof typeof SKY_PRESETS)[]) {
      const state = getSkyState(time);
      expect(Math.hypot(...state.sourceDir)).toBeCloseTo(1, 6);
      expect(state.sourceDir[1]).toBeGreaterThan(0);
      expect(state.keyIntensity).toBeGreaterThan(0);
      expect(state.keyColor.every(Number.isFinite)).toBe(true);
      expect(luminance(state.keyColor)).toBeCloseTo(1, 4);
    }
    // Compass convention: north is -z, east is +x.
    const east = bodyDirection(90, 0);
    expect(east[0]).toBeCloseTo(1, 6);
    expect(bodyDirection(0, 0)[2]).toBeCloseTo(-1, 6);
  });
});
