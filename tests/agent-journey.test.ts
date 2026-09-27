import { expect, test } from "bun:test";
import * as THREE from "three";
import { Game } from "../src/game/Game";
import { MockProvider } from "../src/agent/providers/local";
import type { AgentIntent, WorldObservation } from "../src/agent/contract";
// Deterministic test policy, explicitly not shipped as Jev. Reads the exact same
// observation as external providers; no imports of solutions or task mutation.
function journeyPolicy() {
  let previousTerminal = "",
    previousAlignment = 0,
    direction: "up" | "down" = "down";
  let delivered = false;
  return (o: WorldObservation): AgentIntent => {
    const f = o.task.facts,
      legal = o.legal;
    const pick = (intent: AgentIntent["intent"], target?: string) =>
      legal.find((a) => a.intent === intent && (!target || ("target" in a && a.target === target)));
    const travel = (id: string) =>
      pick(o.vehicle ? "drive_to" : "navigate_to", id) ?? { intent: "wait" as const };
    if (o.actor.locomotion === "ENTERING_VEHICLE" || o.actor.locomotion === "EXITING_VEHICLE")
      return { intent: "wait" };
    if (f.terminal) {
      if (String(f.terminalStatus).includes("hold") || f.terminalStatus === "Locked")
        return { intent: "wait" };
      if (previousTerminal !== f.terminal) {
        previousTerminal = String(f.terminal);
        previousAlignment = 0;
        direction = "down";
      }
      const alignment = Number(f.terminalAlignment);
      if (
        alignment < previousAlignment ||
        Number(f.terminalDial) <= 0.005 ||
        Number(f.terminalDial) >= 0.995
      )
        direction = direction === "up" ? "down" : "up";
      previousAlignment = alignment;
      return { intent: "tune_terminal", direction };
    }
    if (o.task.stage === "coffee") {
      if (!f.carrying) return pick("interact", "coffee_cart") ?? travel("coffee_cart");
      const target = o.navigation.targets.find((t) => t.id === "technician")!;
      const distance = Math.hypot(target.x - o.actor.position[0], target.z - o.actor.position[2]);
      if (distance < 12) {
        if (o.vehicle) return { intent: "exit_vehicle" };
        return pick("interact", "technician") ?? travel("technician");
      }
      if (o.vehicle) return travel("technician");
      const car = o.navigation.targets.find((t) => t.kind === "vehicle");
      return car ? (pick("enter_vehicle", car.id) ?? travel(car.id)) : { intent: "request_human" };
    }
    if (o.task.stage === "channel") {
      delivered = true;
      if (!f.radioReach) {
        const car = o.navigation.targets.find((t) => t.kind === "vehicle");
        return car ? travel(car.id) : { intent: "request_human" };
      }
      if (!f.radioPower) return { intent: "radio_power" };
      // Receiver target is parsed ONLY after the ordinary player objective reveals it.
      const match = o.task.objective?.match(/receiver to (\d+)/);
      if (!match) {
        if (f.station !== "Numbers Station") return { intent: "radio_next_station" };
        return { intent: "wait" };
      }
      const target = Number(match[1]),
        freq = Number(f.frequency);
      return Math.abs(freq - target) < 0.3
        ? { intent: "wait" }
        : { intent: "tune_receiver", direction: freq < target ? "up" : "down" };
    }
    if (o.task.stage === "terminals") {
      const targets = o.navigation.targets
        .filter((t) => t.kind === "terminal")
        .sort(
          (a, b) =>
            Math.hypot(a.x - o.actor.position[0], a.z - o.actor.position[2]) -
            Math.hypot(b.x - o.actor.position[0], b.z - o.actor.position[2]),
        );
      const target = targets[0];
      return target ? (pick("interact", target.id) ?? travel(target.id)) : { intent: "wait" };
    }
    if (o.task.stage === "concert")
      return f.concertRunning
        ? { intent: "wait" }
        : (pick("start_concert", "listening_point") ?? travel("listening_point"));
    return { intent: "wait" };
  };
}
test("complete After Hours through runtime and ordinary physics, using a labelled mock policy", async () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000);
  const g = new Game({ visuals: false, storage: null });
  g.afterHours.start();
  g.frame(1 / 60, { simulate: true, camera, establishing: false });
  const policy = journeyPolicy();
  g.agent.runtime.setMode("agent", new MockProvider(({ observation }) => policy(observation)));
  let frame = 0;
  for (; frame < 60 * 1600 && !g.afterHours.progress.concertCompleted; frame++) {
    g.frame(1 / 60, { simulate: true, camera, establishing: false });
    await Promise.resolve();
    await Promise.resolve();
    if (g.agent.runtime.mode === "human") break;
  }
  if (!g.afterHours.progress.concertCompleted)
    console.log(
      JSON.stringify(
        {
          seconds: frame / 60,
          position: g.player.position,
          vehicle: g.interaction.driven?.physics.render,
          observation: g.agent.observe(0),
          records: g.agent.trace.records.slice(-8),
        },
        null,
        2,
      ),
    );
  expect(g.afterHours.progress.coffeeCompleted).toBe(true);
  expect(g.afterHours.progress.channelDiscovered).toBe(true);
  expect(Object.values(g.afterHours.progress.terminals).every(Boolean)).toBe(true);
  expect(g.afterHours.progress.concertCompleted).toBe(true);
  expect(g.agent.metrics.distanceDriven).toBeGreaterThan(400);
  console.log(
    "Mock journey metrics",
    JSON.stringify(g.agent.metrics.result(g.agent.task.evaluate(), true)),
  );
  g.dispose();
}, 30000);
