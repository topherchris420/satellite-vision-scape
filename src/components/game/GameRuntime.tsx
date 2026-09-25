import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type * as THREE from "three";
import type { Game, TimeOfDay } from "@/game/Game";
import type { PlayStatus } from "@/hooks/use-play-session";
import { consumeMobileInteract, mobileInput } from "@/lib/mobile-input";

/** Field of view the other camera modes expect when control returns to them. */
const VIEWER_FOV = 55;

/**
 * Bridges the framework-agnostic Game into React Three Fiber: mounts its
 * scene graph, advances it once per rendered frame (before anything else
 * reads the camera), and hands camera authority to the game only in play
 * mode. Pointer events are disabled while playing so mouse-look does not
 * trigger a raycast against every inspectable structure on each movement.
 */
export function GameRuntime({
  game,
  playing,
  status,
  time,
}: {
  game: Game;
  playing: boolean;
  status: PlayStatus;
  time: TimeOfDay;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const setEvents = useThree((s) => s.setEvents);
  const active = playing && status === "running";
  const previousStatus = useRef<PlayStatus>(status);

  useEffect(() => {
    setEvents({ enabled: !active });
    return () => setEvents({ enabled: true });
  }, [active, setEvents]);

  useEffect(() => game.setTimeOfDay(time), [game, time]);

  // Glide into the play framing when play mode is entered or play starts.
  useEffect(() => {
    if (!playing) {
      camera.fov = VIEWER_FOV;
      camera.updateProjectionMatrix();
      return;
    }
    game.camera.beginIntro(camera);
  }, [playing, game, camera]);

  useEffect(() => {
    if (playing && status === "running" && previousStatus.current === "briefing") {
      game.camera.beginIntro(camera);
    }
    previousStatus.current = status;
  }, [playing, status, game, camera]);

  useFrame((_, delta) => {
    if (active) {
      const v = game.input.virtual;
      v.moveX = mobileInput.x;
      v.moveY = mobileInput.y;
      v.sprint = mobileInput.boost;
      v.action = mobileInput.action;
      if (consumeMobileInteract()) v.interactRequested = true;
    }
    game.frame(delta, {
      simulate: active,
      camera: playing && camera.isPerspectiveCamera ? camera : null,
      establishing: playing && status === "briefing",
    });
  }, -1);

  return <primitive object={game.root} />;
}
