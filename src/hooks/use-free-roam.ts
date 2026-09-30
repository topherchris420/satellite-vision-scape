import { useSyncExternalStore } from "react";
import type { Game } from "@/game/Game";
import type { FreeRoamSnapshot } from "@/game/freeroam/FreeRoamHud";
import type { JevHudSnapshot } from "@/agent/freeroam/hud";
import type { RunEntry } from "@/agent/freeroam/session";

/** Free Roam's discrete HUD state; re-renders only when it changes. */
export function useFreeRoam(game: Game): FreeRoamSnapshot {
  const hud = game.freeRoam.hud;
  return useSyncExternalStore(hud.subscribe, hud.getSnapshot, hud.getSnapshot);
}

/** The JEV CONTROL panel's state: who is playing, what was decided, how it is going. */
export function useJevControl(game: Game): JevHudSnapshot {
  const hud = game.roam.hud;
  return useSyncExternalStore(hud.subscribe, hud.getSnapshot, hud.getSnapshot);
}

/** Finished runs of this visit, newest first (without their traces). */
export function useRuns(game: Game): readonly RunEntry[] {
  return useSyncExternalStore(game.roam.subscribeRuns, game.roam.getRuns, game.roam.getRuns);
}

/** Whether the game holds the mouse (pointer lock). */
export function usePointerLocked(): boolean {
  return useSyncExternalStore(
    (notify) => {
      document.addEventListener("pointerlockchange", notify);
      return () => document.removeEventListener("pointerlockchange", notify);
    },
    () => document.pointerLockElement !== null,
    () => false,
  );
}
