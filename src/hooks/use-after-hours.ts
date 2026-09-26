import { useSyncExternalStore } from "react";
import type { Game } from "@/game/Game";
import type { AfterHoursSnapshot } from "@/game/afterhours/AfterHoursHud";

/** After Hours' discrete HUD state; re-renders only when it changes. */
export function useAfterHours(game: Game): AfterHoursSnapshot {
  const hud = game.afterHours.hud;
  return useSyncExternalStore(hud.subscribe, hud.getSnapshot, hud.getSnapshot);
}
