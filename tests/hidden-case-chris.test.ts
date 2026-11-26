import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { Game } from "../src/game/Game";
import { createPose } from "../src/game/player/CharacterAnimator";
import type { PlayerVisual } from "../src/game/player/PlayerVisual";
import { HiddenCase } from "../src/game/hidden/HiddenCase";
import { CHRIS_FORMAT, decodeChris, type ChrisFile } from "../src/game/hidden/chris/chrisData";
import { ChrisVisual } from "../src/game/hidden/chris/ChrisVisual";
import { BRIEFING, SPEAKERS } from "../src/game/hidden/story";

const file = JSON.parse(
  readFileSync(new URL("../src/game/hidden/chris/chrisw-mesh.json", import.meta.url), "utf8"),
) as ChrisFile;
const mesh = decodeChris(file);
const bone = (name: string) => {
  const b = file.bones.find((x) => x.name === name);
  if (!b) throw new Error(name);
  return b.position;
};

describe("Christopher's figure (exported from the mod's own model)", () => {
  test("decodes cleanly on the 32-bone skeleton", () => {
    expect(file.format).toBe(CHRIS_FORMAT);
    expect(file.bones).toHaveLength(32);
    expect(file.bones.filter((b) => b.parent < 0)).toHaveLength(1);
    file.bones.forEach((b, i) => expect(b.parent).toBeLessThan(i));
    expect(mesh.position.length).toBe(file.vertexCount * 3);
    expect(mesh.index.length).toBe(file.triangleCount * 3);
    expect(file.vertexCount).toBeGreaterThan(1000);
  });

  test("every vertex's skin weights sum to one", () => {
    for (let v = 0; v < file.vertexCount; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += mesh.skinWeight[v * 4 + k];
      expect(Math.abs(sum - 1)).toBeLessThan(1e-4);
    }
  });

  test("stands in the browser rig's frame: feet on the ground, pelvis at 0.98 m, left at +X, toes forward", () => {
    let minY = Infinity;
    let maxY = -Infinity;
    for (let v = 0; v < file.vertexCount; v++) {
      minY = Math.min(minY, mesh.position[v * 3 + 1]);
      maxY = Math.max(maxY, mesh.position[v * 3 + 1]);
    }
    expect(Math.abs(minY)).toBeLessThan(1e-4);
    expect(maxY).toBeGreaterThan(1.7);
    expect(maxY).toBeLessThan(2.0);
    expect(bone("Pelvis")[1]).toBeCloseTo(0.98, 4);
    expect(bone("L Thigh")[0]).toBeGreaterThan(0.05);
    expect(bone("R Thigh")[0]).toBeLessThan(-0.05);
    expect(bone("L Toe0")[2]).toBeGreaterThan(bone("L Foot")[2] + 0.05);
  });

  test("faces point outward and every triangle is in a draw group, lenses last", () => {
    let agree = 0;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let t = 0; t < file.triangleCount; t++) {
      const [i, j, k] = [mesh.index[t * 3], mesh.index[t * 3 + 1], mesh.index[t * 3 + 2]];
      a.fromArray(mesh.position, i * 3);
      b.fromArray(mesh.position, j * 3).sub(a);
      c.fromArray(mesh.position, k * 3).sub(a);
      n.fromArray(mesh.normal, i * 3);
      if (b.cross(c).dot(n) > 0) agree++;
    }
    expect(agree / file.triangleCount).toBeGreaterThan(0.98);
    expect(file.groups.reduce((s, g) => s + g.count, 0)).toBe(file.triangleCount * 3);
    expect(file.groups.at(-1)?.material).toBe("chrisw_lens");
    expect(file.materials.find((m) => m.name === "chrisw_lens")?.transparent).toBe(true);
  });

  test("the animator's pose lowers his arms and swings his legs like the procedural rig", () => {
    const chris = new ChrisVisual(mesh);
    const at = (name: string) => {
      chris.root.updateMatrixWorld(true);
      return chris.bones.find((b) => b.name === name)!.getWorldPosition(new THREE.Vector3());
    };
    chris.applyPose(createPose());
    const shoulder = at("L UpperArm");
    const hand = at("L Hand");
    expect(hand.y).toBeLessThan(shoulder.y - 0.4);
    expect(hand.x).toBeGreaterThan(0);
    expect(at("R Hand").x).toBeLessThan(0);
    const foot = at("L Foot").z;
    chris.applyPose({ ...createPose(), lHip: 0.5, rElbow: 1.2 });
    expect(at("L Foot").z).toBeGreaterThan(foot + 0.2);
    // The right forearm bends forward about the hanging arm's elbow.
    expect(at("R Hand").z).toBeGreaterThan(at("R ForeArm").z + 0.1);
    chris.dispose();
  });
});

class FakeFigure implements PlayerVisual {
  readonly root = new THREE.Group();
  visible = true;
  poses = 0;
  disposed = false;
  applyPose(): void {
    this.poses++;
  }
  setCarrying(): void {}
  setSidearm(): void {}
  dispose(): void {
    this.disposed = true;
  }
}

describe("hidden case: Christopher is the player", () => {
  test("someone else waits at the van and greets him by name", () => {
    expect(Object.keys(SPEAKERS)).not.toContain("christopher");
    expect(BRIEFING[0].text).toContain("Christopher");
  });

  test("the case swaps his figure in while it runs and hands the default back after", async () => {
    const game = new Game({ visuals: false });
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 9000);
    const figure = new FakeFigure();
    let loads = 0;
    const hidden = new HiddenCase(game, null, false, async () => {
      loads++;
      return figure;
    });
    hidden.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(game.playerVisual).toBe(figure);
    expect(figure.root.parent).toBe(game.root);
    game.frame(1 / 60, { simulate: true, camera, establishing: false });
    expect(figure.poses).toBeGreaterThan(0);
    expect(figure.root.position.distanceTo(game.player.renderPosition)).toBeLessThan(1e-6);
    hidden.stop();
    expect(game.playerVisual).toBeNull();
    expect(figure.root.parent).toBeNull();
    hidden.start();
    expect(game.playerVisual).toBe(figure);
    expect(loads).toBe(1);
    hidden.dispose();
    expect(figure.disposed).toBe(true);
    game.dispose();
  });

  test("a figure that fails to load leaves the default in place", async () => {
    const game = new Game({ visuals: false });
    const warn = console.warn;
    console.warn = () => undefined;
    const hidden = new HiddenCase(game, null, false, () => Promise.reject(new Error("offline")));
    hidden.start();
    await new Promise((r) => setTimeout(r, 0));
    console.warn = warn;
    expect(game.playerVisual).toBeNull();
    expect(hidden.active).toBe(true);
    hidden.dispose();
    game.dispose();
  });
});
