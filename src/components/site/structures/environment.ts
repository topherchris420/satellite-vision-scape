import * as THREE from "three";
import type { TimeOfDay } from "../Lighting";

/**
 * Time-of-day state shared by every structure material. Uniform objects are
 * shared by reference, so one write here retunes every emissive window,
 * fixture lens and light pool on site without touching the materials.
 */
export const fixtureUniforms = {
  /** 0 by day, 1 at night: lamps, lit windows, floodlight washes. */
  uLamps: { value: 0 } as THREE.IUniform<number>,
  /** Overall night factor for subtle effects (darker glass, cooler tint). */
  uNight: { value: 0 } as THREE.IUniform<number>,
};

const LAMP_LEVEL: Record<TimeOfDay, number> = { day: 0, dusk: 0.45, night: 1 };

export function setFixtureTime(time: TimeOfDay): void {
  fixtureUniforms.uLamps.value = LAMP_LEVEL[time];
  fixtureUniforms.uNight.value = time === "night" ? 1 : 0;
}

export type StructureQuality = "low" | "medium" | "high" | "ultra";

/** Fine clutter (barbed wire, rooftop plant, pipework) is skipped on phones. */
export const detailed = (q: StructureQuality) => q !== "low";
