/**
 * Headless CPU cost of one gameplay frame (`Game.frame`): input, 120 Hz
 * physics, collision, animation, camera and HUD. Run with
 * `bun scripts/perf-gameplay.ts [--after-hours]`. Rendering is not included.
 */
import * as THREE from "three";
import { Game } from "../src/game/Game";

const FRAME = 1 / 60;
const afterHours = process.argv.includes("--after-hours");

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function measure(label: string, game: Game, camera: THREE.PerspectiveCamera, frames: number) {
  const times: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now();
    game.frame(FRAME, { simulate: true, camera, establishing: false });
    times.push(performance.now() - t0);
  }
  console.log(
    `${label.padEnd(26)} median ${percentile(times, 0.5).toFixed(3)} ms · p95 ${percentile(times, 0.95).toFixed(3)} ms · max ${Math.max(...times).toFixed(3)} ms`,
  );
}

const game = new Game({ visuals: false });
const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 9000);
if (afterHours) game.afterHours.start();

for (let i = 0; i < 120; i++) game.frame(FRAME, { simulate: true, camera, establishing: false });
measure("idle on foot", game, camera, 600);
game.input.keyDown("KeyW");
measure("walking", game, camera, 600);
game.input.keyUp("KeyW");

// Enter the nearest vehicle and drive.
const vehicle = game.vehicles.vehicles[0];
for (let t = 0; t < 12 && game.interaction.prompt?.label !== "Enter vehicle"; t += FRAME) {
  const p = game.player.position;
  game.camera.yaw = Math.atan2(vehicle.physics.x - p.x, vehicle.physics.z - p.z);
  game.input.keyDown("KeyW");
  game.frame(FRAME, { simulate: true, camera, establishing: false });
}
game.input.keyUp("KeyW");
game.input.keyDown("KeyE");
game.frame(FRAME, { simulate: true, camera, establishing: false });
game.input.keyUp("KeyE");
for (let t = 0; t < 6 && game.interaction.state !== "DRIVING"; t += FRAME)
  game.frame(FRAME, { simulate: true, camera, establishing: false });
game.input.keyDown("KeyW");
measure(`driving (${game.interaction.state})`, game, camera, 600);
game.input.keyUp("KeyW");
game.dispose();
