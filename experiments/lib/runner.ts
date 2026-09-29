import * as THREE from "three";
import { Game } from "../../src/game/Game";
import type { AgentProvider } from "../../src/agent/provider";
import { JevProvider } from "../../src/agent/providers/jev";
import { MockProvider, RandomProvider } from "../../src/agent/providers/local";
import { createAfterHoursBaseline } from "../../src/agent/tasks/afterHoursBaseline";
import { parseAssists, resolveAssists } from "../../src/server/agent/assists";
import { createJevDecisionHandler } from "../../src/server/agent/handler";
import type { ConditionConfig, EpisodeGoal } from "./definition";
import { DelayedProvider, parseLatency } from "./latency";

/**
 * One episode, headless: a fresh world, After Hours started as the briefing
 * button starts it, one provider in agent mode, and the simulation stepped at
 * 60 frames a second until the episode goal's world event, a hand-back, or
 * a budget. Nothing is scored here; the trace the session recorded is the
 * result, and every metric is read from it afterwards.
 *
 * Local providers run as fast as the CPU allows (simulated latency, if any,
 * elapses on the simulation clock). A live provider is paced to the wall
 * clock, exactly as a browser's frames are, so its real latency plays out in
 * the world.
 */

const FRAME = 1 / 60;
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000);

export type Termination = "goal" | "handed_back" | "time_budget" | "call_budget" | "error";

export interface EpisodeOptions {
  config: ConditionConfig;
  seed: number;
  until: EpisodeGoal;
  maxSimSeconds: number;
  /** Live providers only. */
  maxCalls: number;
  /** Recorded latencies behind `run-b` (from live run B's trace). */
  observedLatencyMs: readonly number[];
  /** Required for `jev`: the credential stays in this process. */
  live?: { apiKey: string; model?: string };
  /** Replaces the provider (tests: failure injection). */
  providerOverride?: AgentProvider;
}

export interface EpisodeResult {
  /** The exported `svs-agent-trace/v1` JSON, or null if none could be exported. */
  trace: string | null;
  terminatedBy: Termination;
  simSeconds: number;
  wallMs: number;
  model: string | null;
  error: string | null;
}

function goalReached(game: Game, until: EpisodeGoal): boolean {
  const p = game.afterHours.progress;
  switch (until) {
    case "coffee_delivered":
      return p.coffeeCompleted;
    case "receiver_locked":
      return p.channelDiscovered;
    case "terminals_completed":
      return Object.values(p.terminals).every(Boolean);
    case "task_complete":
      return p.concertCompleted;
  }
}

export function buildProvider(options: EpisodeOptions): AgentProvider {
  if (options.providerOverride) return options.providerOverride;
  const c = options.config;
  switch (c.provider) {
    case "baseline":
      return new MockProvider(
        createAfterHoursBaseline({
          tuningAmount: (c.tuningAmount as never) ?? "graded",
          tuningDirection: (c.tuningDirection as never) ?? "trend",
        }),
      );
    case "random":
      return new RandomProvider(options.seed);
    case "jev": {
      if (!options.live?.apiKey)
        throw new Error("jev needs a live credential; live runs are opt-in");
      const assists =
        c.assists === undefined ? resolveAssists(undefined) : parseAssists(String(c.assists));
      if (!assists) throw new Error(`invalid assists ${String(c.assists)}`);
      const handler = createJevDecisionHandler({
        apiKey: options.live.apiKey,
        model: options.live.model,
        assists,
        log: () => undefined,
      });
      // The browser's same-origin request, served in-process by the real handler.
      const fetchImpl = ((url: string, init: RequestInit) =>
        handler(new Request(new URL(url, "https://experiment.local"), init), {
          clientKey: "experiment",
        })) as typeof fetch;
      const session = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      return new JevProvider(session, "/api/agent/jev/decision", fetchImpl);
    }
    case "human":
      throw new Error("human runs are recorded in the browser and imported, not executed");
  }
}

export async function runEpisode(options: EpisodeOptions): Promise<EpisodeResult> {
  const started = performance.now();
  const live = options.config.provider === "jev" && !options.providerOverride;
  let game: Game | null = null;
  let terminatedBy: Termination = "error";
  let error: string | null = null;
  let trace: string | null = null;
  let simSeconds = 0;
  try {
    game = new Game({ visuals: false, storage: null });
    game.afterHours.start();
    const g = game;
    const step = () => g.frame(FRAME, { simulate: true, camera, establishing: false });
    step();
    const runtime = g.agent.runtime;
    if (typeof options.config.reviewMs === "number") runtime.reviewMs = options.config.reviewMs;
    let provider = buildProvider(options);
    let delayed: DelayedProvider | null = null;
    const latency = options.config.latency;
    if (typeof latency === "string" && latency !== "instant") {
      delayed = new DelayedProvider(
        provider,
        parseLatency(latency, options.observedLatencyMs, options.seed),
        () => runtime.now,
      );
      provider = delayed;
    }
    // A local provider's latency is what the world waited for it, on the
    // simulation clock (0 when instant), not how long the CPU took to run a
    // script: that would make a deterministic condition look noisy.
    if (!live) runtime.latencyClock = () => runtime.now;
    runtime.start("agent", provider);

    const maxFrames = Math.round(options.maxSimSeconds / FRAME);
    const wallStart = performance.now();
    for (let frame = 0; ; frame++) {
      step();
      simSeconds += FRAME;
      delayed?.pump();
      for (let k = 0; k < 4; k++) await Promise.resolve();
      if (live) {
        // Pace to the wall clock, as requestAnimationFrame does.
        const ahead = simSeconds * 1000 - (performance.now() - wallStart);
        await new Promise((r) => setTimeout(r, Math.max(0, ahead)));
      }
      if (goalReached(g, options.until)) {
        terminatedBy = "goal";
        break;
      }
      if (runtime.mode === "human") {
        terminatedBy = "handed_back";
        break;
      }
      if (live && g.agent.metrics.requests >= options.maxCalls) {
        terminatedBy = "call_budget";
        break;
      }
      if (frame + 1 >= maxFrames) {
        terminatedBy = "time_budget";
        break;
      }
    }
    trace = g.agent.export();
  } catch (e) {
    terminatedBy = "error";
    error = e instanceof Error ? e.message : String(e);
    try {
      trace = game ? game.agent.export() : null;
    } catch {
      trace = null;
    }
  }
  const model = game?.agent.trace.header.model ?? null;
  try {
    game?.dispose();
  } catch {
    // A world that failed mid-run may not dispose cleanly; the run is already recorded.
  }
  return {
    trace,
    terminatedBy,
    simSeconds: Math.round(simSeconds * 10) / 10,
    wallMs: Math.round(performance.now() - started),
    model,
    error,
  };
}
