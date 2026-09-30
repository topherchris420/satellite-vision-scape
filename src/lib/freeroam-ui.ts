import type { Game } from "@/game/Game";
import { probeJev } from "@/agent/providers/jev";

/**
 * Glue between Free Roam and the page: which controller a button starts,
 * whether Jev can be reached before it is asked to play, and trace files in
 * and out. Nothing here reaches world state: a run is started through the
 * session, and the controller changes through the same call the keyboard uses.
 */

export type FrController = "human" | "jev" | "assist" | "baseline";

export interface FrLaunch {
  seed: number;
  challenge: string;
  controller: FrController;
}

export interface LaunchResult {
  ok: boolean;
  detail: string;
}

/** Jev is probed (a GET that costs no model call) before it is asked to play; nothing stands in for it. */
export async function checkController(controller: FrController): Promise<LaunchResult> {
  if (controller !== "jev") return { ok: true, detail: "ready" };
  const status = await probeJev(AbortSignal.timeout(4000));
  return status.available ? { ok: true, detail: "ready" } : { ok: false, detail: status.detail };
}

/** Start the run and hand the controls to whoever was chosen. The page has already unpaused the game. */
export function beginFreeRoam(game: Game, launch: FrLaunch): void {
  game.roam.play({ seed: launch.seed, challenge: launch.challenge });
  if (launch.controller === "jev") game.roam.setController("JEV", "jev");
  else if (launch.controller === "assist") game.roam.setController("ASSIST", "jev");
  else if (launch.controller === "baseline") game.roam.setController("JEV", "baseline");
}

export function parseSeed(text: string, fallback: number): number {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 0 && n < 2 ** 32 ? n : fallback;
}

/** Save a finished run's trace (or the run so far) as JSON. */
export function downloadFreeRoamTrace(game: Game, runId?: string): boolean {
  const text = game.roam.exportTrace(runId);
  if (!text) return false;
  const run = runId ? game.roam.runs.find((r) => r.id === runId) : null;
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `svs-freeroam-${run ? `${run.challenge}-${run.controller.toLowerCase()}-${run.seed}` : `trace-${game.roam.sessionId.slice(0, 8)}`}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatValue(value: number | string | null, unit: string): string {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) < 10 ? 2 : 1);
  return unit ? `${text} ${unit}` : text;
}
