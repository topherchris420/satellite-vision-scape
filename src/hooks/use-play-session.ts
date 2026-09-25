import { useCallback, useEffect, useRef, useState } from "react";
import type { Game } from "@/game/Game";
import { DomInputBinding } from "@/game/core/DomInput";

/**
 * briefing — first visit: controls card over an establishing shot
 * running  — gameplay has input authority (pointer locked when available)
 * paused   — Esc, focus loss or another camera mode; the world is frozen
 */
export type PlayStatus = "briefing" | "running" | "paused";

/**
 * Session lifecycle around pointer lock. Pointer lock is requested from the
 * user's click; if the browser refuses (embedded frames, touch devices) play
 * continues with click-drag / touch-drag look instead. Losing the lock (Esc)
 * pauses, as does blurring the window while unlocked.
 */
export function usePlaySession(
  game: Game | null,
  canvas: HTMLCanvasElement | null,
  enabled: boolean,
) {
  const [status, setStatus] = useState<PlayStatus>("briefing");
  const statusRef = useRef<PlayStatus>("briefing");
  const lockedRef = useRef(false);
  const bindingRef = useRef<DomInputBinding | null>(null);

  const update = useCallback((next: PlayStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  // One DOM input binding per game/canvas pair.
  useEffect(() => {
    if (!game || !canvas) return;
    const binding = new DomInputBinding(game.input, canvas);
    binding.attach();
    bindingRef.current = binding;
    return () => {
      binding.detach();
      bindingRef.current = null;
    };
  }, [game, canvas]);

  const running = enabled && status === "running";
  useEffect(() => {
    bindingRef.current?.setEnabled(running);
    game?.setPaused(!running);
  }, [running, game]);

  const start = useCallback(() => {
    if (!game) return;
    game.unlockAudio();
    // A focused HUD button would otherwise "click" again on Space.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    update("running");
    if (canvas && typeof canvas.requestPointerLock === "function") {
      try {
        const request = canvas.requestPointerLock() as unknown;
        if (request instanceof Promise) request.catch(() => undefined);
      } catch {
        // Pointer lock unavailable: drag-to-look fallback stays active.
      }
    }
  }, [game, canvas, update]);

  const pause = useCallback(() => {
    if (statusRef.current !== "running") return;
    update("paused");
    if (document.pointerLockElement) document.exitPointerLock();
  }, [update]);

  useEffect(() => {
    const onLockChange = () => {
      const locked = canvas !== null && document.pointerLockElement === canvas;
      if (lockedRef.current && !locked && statusRef.current === "running") update("paused");
      lockedRef.current = locked;
    };
    const onKey = (e: KeyboardEvent) => {
      // With pointer lock the browser consumes Esc; this covers unlocked play.
      if (e.code === "Escape" && statusRef.current === "running" && !lockedRef.current) pause();
    };
    const onBlur = () => {
      if (statusRef.current === "running") pause();
    };
    document.addEventListener("pointerlockchange", onLockChange);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [canvas, pause, update]);

  // Leaving play mode pauses and releases the mouse.
  useEffect(() => {
    if (!enabled) pause();
  }, [enabled, pause]);

  return { status, start, pause };
}
