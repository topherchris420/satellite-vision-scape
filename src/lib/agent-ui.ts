import type { Game } from "@/game/Game";
import type { AgentProvider } from "@/agent/provider";
import { JevProvider, probeJev } from "@/agent/providers/jev";
import { MockProvider, RandomProvider, ReplayProvider } from "@/agent/providers/local";
import { createAfterHoursBaseline } from "@/agent/tasks/afterHoursBaseline";
import { replayIntents } from "@/agent/trace";

/**
 * Glue between the agent runtime and the page: which provider a button or a
 * development query selects, how Jev's availability is checked, and trace
 * export / replay import. Nothing here reaches world state — a provider is
 * only ever handed to `runtime.start`.
 */

export type AgentKind = "jev" | "mock" | "random";

export interface AgentQuery {
  /** `?controller=` — human (default), jev, mock, random or replay. */
  controller: "human" | AgentKind | "replay";
  /** `?seed=` for the random baseline. */
  seed: number;
  /** `?copilot=1`: suggestions only. */
  copilot: boolean;
  /** `?agentHud=1`: show the control panel even in human play. */
  hud: boolean;
}

export function parseAgentQuery(search: string): AgentQuery {
  const params = new URLSearchParams(search);
  const c = params.get("controller");
  const controller = c === "jev" || c === "mock" || c === "random" || c === "replay" ? c : "human";
  const seed = Number(params.get("seed") ?? 42);
  const flag = (name: string) => {
    const v = params.get(name);
    return v !== null && v !== "0" && v !== "false";
  };
  return {
    controller,
    seed: Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32 ? seed : 42,
    copilot: flag("copilot"),
    hud: flag("agentHud") || controller !== "human" || flag("copilot"),
  };
}

export function providerFor(game: Game, kind: AgentKind, seed = 42): AgentProvider {
  switch (kind) {
    case "jev":
      return new JevProvider(game.agent.trace.header.session);
    case "random":
      return new RandomProvider(seed);
    case "mock":
      return new MockProvider(createAfterHoursBaseline());
  }
}

export interface LaunchResult {
  ok: boolean;
  detail: string;
}

/**
 * Start `mode` with a provider. Jev is probed first (a GET that costs no
 * model call); an unavailable Jev never starts, and nothing stands in for it.
 */
export async function launchAgent(
  game: Game,
  mode: "agent" | "copilot",
  kind: AgentKind,
  seed = 42,
): Promise<LaunchResult> {
  if (kind === "jev") {
    const status = await probeJev(AbortSignal.timeout(4000));
    if (!status.available) return { ok: false, detail: status.detail };
  }
  if (!game.afterHours.active) return { ok: false, detail: "After Hours is not running." };
  game.agent.runtime.start(mode, providerFor(game, kind, seed));
  return { ok: true, detail: "started" };
}

export function startReplay(game: Game, text: string): LaunchResult {
  let trace: unknown;
  try {
    trace = JSON.parse(text);
  } catch {
    return { ok: false, detail: "That file is not JSON." };
  }
  const intents = replayIntents(trace);
  if (!intents || intents.length === 0)
    return { ok: false, detail: "No svs-agent-trace/v1 decisions found in that file." };
  game.agent.runtime.start("agent", new ReplayProvider(intents));
  return { ok: true, detail: `${intents.length} intents` };
}

export function downloadTrace(game: Game): void {
  const blob = new Blob([game.agent.export()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `svs-agent-trace-${game.agent.trace.header.session.slice(0, 12)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
