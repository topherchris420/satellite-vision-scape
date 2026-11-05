import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LANDMARKS } from "../src/game/freeroam/landmarks";
import { areaName, screenAngle } from "../src/lib/radar";

/**
 * The radar and the combat feedback: where a point in the world lands on
 * screen, and what the place the player stands in is called.
 */

describe("screen angles", () => {
  // Camera yaw 0 looks along +z; its right is −x.
  test("straight ahead of the camera is up, its right is right, behind is down", () => {
    expect(screenAngle(0, 0, 0, 10, 0)).toBeCloseTo(0, 6);
    expect(screenAngle(0, 0, -10, 0, 0)).toBeCloseTo(Math.PI / 2, 6);
    expect(screenAngle(0, 0, 10, 0, 0)).toBeCloseTo(-Math.PI / 2, 6);
    expect(Math.abs(screenAngle(0, 0, 0, -10, 0))).toBeCloseTo(Math.PI, 6);
  });

  test("turning the camera turns the world the other way", () => {
    const yaw = 0.7;
    // A point straight down the camera's line of sight is up, whatever the yaw.
    expect(screenAngle(5, -3, 5 + Math.sin(yaw) * 20, -3 + Math.cos(yaw) * 20, yaw)).toBeCloseTo(
      0,
      6,
    );
    // A fixed point drifts left on screen as the camera turns right (yaw decreases).
    const before = screenAngle(0, 0, 0, 10, 0);
    const after = screenAngle(0, 0, 0, 10, -0.3);
    expect(after).toBeLessThan(before);
  });
});

describe("area names", () => {
  test("standing at a landmark names it", () => {
    for (const l of LANDMARKS) expect(areaName(l.x, l.z)).toBe(l.label);
  });

  test("far from everything is outside the fence", () => {
    expect(areaName(2500, 2500)).toBe("Outside the fence");
  });

  test("the names are the public map's, not anything operational", () => {
    const names = new Set([
      ...LANDMARKS.map((l) => l.label),
      "Antenna enclosure",
      "Main compound",
      "Outside the fence",
    ]);
    for (const n of names)
      expect(n).not.toMatch(/secret|classified|ops|operations|control room|interior/i);
  });
});

describe("the HUD only listens", () => {
  test("radar, combat feedback and title cards never write to the game", () => {
    for (const name of ["FreeRoamRadar", "CombatFeedback", "TitleCards"]) {
      const src = readFileSync(`src/components/game/${name}.tsx`, "utf8");
      expect({ name, emits: /\.emit\(/.test(src) }).toEqual({ name, emits: false });
      expect({
        name,
        writes: /\.(teleport|place|damage|setController|restart|start|stop)\s*\(/.test(src),
      }).toEqual({ name, writes: false });
      expect({ name, assigns: /\b(game|roam)\.[A-Za-z_.]+\s*=[^=]/.test(src) }).toEqual({
        name,
        assigns: false,
      });
    }
  });
});
