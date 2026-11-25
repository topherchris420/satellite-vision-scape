import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { Game } from "../src/game/Game";
import type { KeyValueStorage } from "../src/game/afterhours/progress";
import { CASE_STORAGE_KEY, parseCase } from "../src/game/hidden/caseFile";
import { HiddenCase, routePose } from "../src/game/hidden/HiddenCase";
import { BEARING_SETTLE, FLAGGED_VEHICLE, POSTS, SONDE, VAN_STAND } from "../src/game/hidden/story";

const FRAME = 1 / 60;

class MemoryStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

function run(game: Game, camera: THREE.PerspectiveCamera, seconds: number) {
  for (let t = 0; t < seconds; t += FRAME) game.frame(FRAME, { simulate: true, camera, establishing: false });
}

/** The interaction the case offers at a point (what E would do there). */
function offerAt(game: Game, x: number, z: number) {
  for (const provide of game.interaction.providers) {
    const offer = provide(x, game.ground.heightAt(x, z), z);
    if (offer?.id?.startsWith("case:")) return offer;
  }
  return null;
}

describe("hidden case: a whole playthrough (headless)", () => {
  const game = new Game({ visuals: false });
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 9000);
  const storage = new MemoryStorage();
  const hidden = new HiddenCase(game, storage, false);
  const snap = () => hidden.hud.getSnapshot();
  const file = () => parseCase(storage.getItem(CASE_STORAGE_KEY));

  test("accepting starts at the van with the title card, and saves that it was found", () => {
    hidden.start();
    expect(snap().active).toBe(true);
    expect(snap().title).toBe(true);
    expect(file().found).toBe(true);
    const p = game.player.position;
    expect(Math.hypot(p.x - VAN_STAND.x, p.z - VAN_STAND.z)).toBeLessThan(1.5);
  });

  test("the title card ends and the investigation opens", () => {
    run(game, camera, 7);
    expect(snap().title).toBe(false);
    expect(snap().stage).toBe("investigating");
    expect(file().stage).toBe("investigating");
  });

  test("Mara's account goes on the board", () => {
    hidden.openDialog("mara");
    expect(snap().panel?.kind).toBe("dialog");
    hidden.choose("where");
    hidden.choose("leave");
    expect(snap().panel).toBeNull();
    expect(file().collected).toContain("witness");
  });

  test("a bearing needs the player to stand still at the post", () => {
    for (const id of ["a", "b"] as const) {
      const post = POSTS[id];
      game.resetForScenario({ x: post.x + 0.6, z: post.z, yaw: 0 });
      run(game, camera, 0.2);
      const p = game.player.position;
      const offer = offerAt(game, p.x, p.z);
      expect(offer?.id).toBe(`case:post-${id}`);
      offer!.act();
      run(game, camera, BEARING_SETTLE + 1);
      expect(file().bearings).toContain(id);
    }
    expect(file().collected).toContain("bearings");
    expect(snap().crossingDistance).not.toBeNull();
  });

  test("the sonde sits where the bearings cross, and can be examined", () => {
    const offer = offerAt(game, SONDE.x + 1, SONDE.z);
    expect(offer?.id).toBe("case:sonde");
    offer!.act();
    expect(file().collected).toContain("sonde");
  });

  test("the flagged truck's logger is read at its tailgate", () => {
    const truck = game.vehicles.vehicles[FLAGGED_VEHICLE];
    const { x, z, yaw } = truck.physics;
    const offer = offerAt(game, x - Math.sin(yaw) * 2.7, z - Math.cos(yaw) * 2.7);
    expect(offer?.id).toBe("case:logger");
    offer!.act();
    expect(file().collected).toContain("logger");
  });

  test("the vendor's re-run is on the board but not weighed by default", () => {
    hidden.openDialog("tobin");
    hidden.choose("rerun");
    hidden.choose("leave");
    expect(file().collected).toContain("rerun");
    expect(file().weighed).not.toContain("rerun");
  });

  test("handing in a well-founded rejection ends the case quietly, and the ending is saved", () => {
    hidden.openBoard();
    expect(snap().panel?.kind).toBe("board");
    expect(snap().board.map((c) => c.id).sort()).toEqual(["bearings", "logger", "rerun", "sonde", "witness"]);
    hidden.submit("reject", 80);
    expect(snap().panel?.kind).toBe("ending");
    expect(snap().ending).toBe("quiet-correction");
    expect(file().stage).toBe("closed");
    expect(file().endingsSeen).toContain("quiet-correction");
  });

  test("leaving and coming back resumes from the file", () => {
    hidden.closePanel();
    hidden.stop();
    expect(snap().active).toBe(false);
    expect(game.interaction.providers.some((p) => p(VAN_STAND.x, 0, VAN_STAND.z)?.id?.startsWith("case:"))).toBe(
      false,
    );
    const again = new HiddenCase(game, storage, false);
    again.start();
    expect(again.hud.getSnapshot().title).toBe(false);
    expect(again.hud.getSnapshot().stage).toBe("closed");
    again.replay();
    expect(again.hud.getSnapshot().title).toBe(true);
    expect(parseCase(storage.getItem(CASE_STORAGE_KEY)).endingsSeen).toContain("quiet-correction");
    again.dispose();
  });

  test("Mara's route is deterministic", () => {
    const a = routePose(123.4, { x: 0, z: 0, yaw: 0, speed: 0 });
    const b = routePose(123.4, { x: 0, z: 0, yaw: 0, speed: 0 });
    expect(a).toEqual(b);
    const later = routePose(123.4 + 10_000, { x: 0, z: 0, yaw: 0, speed: 0 });
    expect(Number.isFinite(later.x) && Number.isFinite(later.z)).toBe(true);
  });

  test("the case changes nothing in the simulation after it stops", () => {
    hidden.dispose();
    game.resetForScenario({ x: -61, z: 175, yaw: 0 });
    run(game, camera, 0.5);
    expect(offerAt(game, VAN_STAND.x, VAN_STAND.z)).toBeNull();
  });
});
