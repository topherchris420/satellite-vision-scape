import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { GameRuntime } from "./GameRuntime";
import { Game } from "@/game/Game";
import { DomInputBinding } from "@/game/core/DomInput";
import { CharacterVisual } from "@/game/player/CharacterVisual";
import { CharacterAnimator } from "@/game/player/CharacterAnimator";
import type { PlayerVisual } from "@/game/player/PlayerVisual";
import { browserStorage } from "@/game/afterhours/progress";
import { CityStoryLayer } from "@/game/campaign/CityStoryLayer";
import { CITY_DISTRICT, LAB, SHELTER } from "@/game/world/buildCityWorld";
import { cityScenery } from "@/game/world/CityScenery";
import { makePuffSprite } from "@/lib/site-textures";
import { resetMobileInput } from "@/lib/mobile-input";
import { CityMissionHUD } from "./CityMissionHUD";
import "./city-story.css";

function createSession() {
  const storage = browserStorage();
  const dustSprite = makePuffSprite(5309, 4);
  const game = new Game({ visuals: true, district: CITY_DISTRICT, storage, dustSprite });
  const mission = new CityStoryLayer(game, storage);
  const scenery = cityScenery();
  game.root.add(scenery.root);
  const npcs = [
    new CharacterVisual({ variant: "technician", palette: "visitor" }),
    new CharacterVisual({ variant: "technician", palette: "staff" }),
  ];
  const places = [LAB, SHELTER];
  const animators = npcs.map(() => new CharacterAnimator());
  npcs.forEach((npc, i) => {
    npc.root.position.set(places[i].x, 0, places[i].z);
    npc.root.rotation.y = 1.2;
    game.root.add(npc.root);
  });
  const vehicleShadows = game.vehicles.vehicles.map((v) => ({
    v,
    shadow: scenery.contactShadow(3.4, v === mission.van ? 7.1 : 5.6),
  }));
  const footShadow = scenery.contactShadow(1.25, 1.1);
  const npcShadows = places.map((place) => {
    const s = scenery.contactShadow(1.2, 1);
    s.position.x = place.x;
    s.position.z = place.z;
    return s;
  });
  const remove = game.addLayer({
    present(dt) {
      npcs[1].visible = mission.arrived;
      npcShadows[1].visible = mission.arrived;
      footShadow.visible = !game.interaction.vehicle;
      footShadow.position.x = game.player.renderPosition.x;
      footShadow.position.z = game.player.renderPosition.z;
      for (const { v, shadow } of vehicleShadows) {
        shadow.position.x = v.physics.render.x;
        shadow.position.z = v.physics.render.z;
        shadow.rotation.y = v.physics.render.yaw;
      }
      for (let i = 0; i < npcs.length; i++)
        if (npcs[i].visible)
          npcs[i].applyPose(
            animators[i].update(dt, {
              grounded: true,
              airTime: 0,
              verticalVelocity: 0,
              turnRate: 0,
              seatWeight: 0,
              steer: 0,
              style: "technician",
              speed: 0,
            }),
          );
    },
  });
  let alive = true;
  let chris: PlayerVisual | null = null;
  let figure: "loading" | "ready" | "unavailable" = "loading";
  void import("@/game/hidden/chris/loadChris")
    .then((m) => m.loadChris())
    .then((v) => {
      if (!alive) {
        v.dispose();
        return;
      }
      chris = v;
      game.setPlayerVisual(v);
      figure = "ready";
    })
    .catch(() => {
      figure = "unavailable";
    });
  return {
    game,
    mission,
    running: false,
    get figure() {
      return figure;
    },
    dispose() {
      alive = false;
      remove();
      game.setPlayerVisual(null);
      chris?.dispose();
      for (const npc of npcs) npc.dispose();
      scenery.dispose();
      mission.dispose();
      game.dispose();
      dustSprite.dispose();
      resetMobileInput();
    },
  };
}

export function BakeryCity() {
  const [session, setSession] = useState<ReturnType<typeof createSession> | null>(null);
  const [paused, setPaused] = useState(false);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const binding = useMemo(
    () => (session && canvas ? new DomInputBinding(session.game.input, canvas) : null),
    [session, canvas],
  );
  useLayoutEffect(() => {
    binding?.attach();
    return () => binding?.detach();
  }, [binding]);
  const [, redraw] = useState(0);
  useEffect(() => {
    const s = createSession();
    setSession(s);
    const timer = window.setInterval(() => redraw((n) => (n + 1) % 1000), 90);
    const hide = () => {
      if (document.hidden) {
        setPaused(true);
        s.game.input.releaseAll();
        resetMobileInput();
      }
    };
    const blur = () => {
      setPaused(true);
      s.game.input.releaseAll();
      resetMobileInput();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.code === "Escape" && !e.repeat) setPaused((p) => !p);
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", escape);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", escape);
      s.dispose();
    };
  }, []);
  const phase = session?.mission.phase;
  const modal =
    phase === "briefing" ||
    phase === "receipt" ||
    phase === "report" ||
    phase === "filed" ||
    phase === "failed";
  const active = !paused && !modal;
  useLayoutEffect(() => {
    binding?.setEnabled(active);
    if (session) {
      session.running = active;
      session.game.setPaused(!active);
      if (!active) resetMobileInput();
    }
  }, [active, session, binding]);
  if (!session) return <main className="city-story">Opening the waterfront…</main>;
  return (
    <main className="city-story" aria-label="Bakery delivery mission">
      <Canvas
        dpr={[1, 1.35]}
        gl={{ antialias: true }}
        onCreated={({ gl }) => setCanvas(gl.domElement)}
        camera={{
          position: [-5.7, 3.3, -5.8],
          rotation: [0, Math.PI, 0],
          fov: 59,
          near: 0.1,
          far: 460,
        }}
        fallback={<p>WebGL is required to play this mission.</p>}
      >
        <color attach="background" args={["#e9bea0"]} />
        <fog attach="fog" args={["#e9bea0", 85, 300]} />
        <hemisphereLight args={["#ffedcc", "#9896ac", 1.8]} />
        <directionalLight position={[-80, 90, -45]} intensity={2.2} color="#ffdcaa" />
        <GameRuntime
          game={session.game}
          playing
          isRunning={() => session.running}
          status={active ? "running" : "paused"}
          time="dusk"
        />
      </Canvas>
      <CityMissionHUD
        mission={session.mission}
        figure={session.figure}
        paused={paused}
        setPaused={setPaused}
        refresh={() => redraw((n) => n + 1)}
      />
    </main>
  );
}
