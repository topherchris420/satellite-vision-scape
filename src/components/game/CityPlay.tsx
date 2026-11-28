import type { ReactNode } from "react";
import * as THREE from "three";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { GameRuntime } from "./GameRuntime";
import { Game } from "@/game/Game";
import { DomInputBinding } from "@/game/core/DomInput";
import { CharacterVisual } from "@/game/player/CharacterVisual";
import { CharacterAnimator } from "@/game/player/CharacterAnimator";
import type { PlayerVisual } from "@/game/player/PlayerVisual";
import { browserStorage, type KeyValueStorage } from "@/game/afterhours/progress";
import { CITY_DISTRICT, LAB, SHELTER } from "@/game/world/buildCityWorld";
import { cityCourtyard } from "@/game/world/CityCourtyard";
import { cityScenery } from "@/game/world/CityScenery";
import { makePuffSprite } from "@/lib/site-textures";
import { resetMobileInput } from "@/lib/mobile-input";
import "./city-story.css";

type Mission = { dispose(): void };
type CityPlayProps<T extends Mission> = {
  label: string;
  makeMission: (game: Game, storage: KeyValueStorage | null) => T;
  modal: (mission: T) => boolean;
  onStorage: (mission: T, key: string | null) => void;
  bakery?: (mission: T) => boolean;
  waypoint?: (mission: T) => { x: number; z: number } | null;
  courtyard?: (mission: T) => boolean;
  subject?: (mission: T) => { x: number; z: number } | null;
  renderHUD: (props: {
    mission: T;
    figure: string;
    paused: boolean;
    setPaused: (value: boolean) => void;
    refresh: () => void;
  }) => ReactNode;
};
function createSession<T extends Mission>({
  makeMission,
  bakery,
  waypoint,
  courtyard,
  subject,
}: CityPlayProps<T>) {
  const storage = browserStorage();
  const dustSprite = makePuffSprite(5309, 4);
  const game = new Game({ visuals: true, district: CITY_DISTRICT, storage, dustSprite });
  const mission = makeMission(game, storage);
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
    shadow: scenery.contactShadow(3.4, v === game.vehicles.vehicles[0] ? 5.6 : 7.1),
  }));
  const footShadow = scenery.contactShadow(1.25, 1.1);
  const npcShadows = places.map((place) => {
    const s = scenery.contactShadow(1.2, 1);
    s.position.x = place.x;
    s.position.z = place.z;
    return s;
  });
  const torch = new THREE.Mesh(
    new THREE.RingGeometry(1.35, 1.62, 32),
    new THREE.MeshBasicMaterial({
      color: "#ffd45e",
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
    }),
  );
  torch.rotation.x = -Math.PI / 2;
  torch.visible = false;
  game.root.add(torch);
  const practice = courtyard ? cityCourtyard() : null;
  if (practice) game.root.add(practice.root);
  const subjectModel = new CharacterVisual({ variant: "technician", palette: "staff" });
  subjectModel.visible = false;
  game.root.add(subjectModel.root);
  const remove = game.addLayer({
    present(dt) {
      npcs[1].visible = bakery?.(mission) ?? false;
      npcShadows[1].visible = npcs[1].visible;
      const mark = waypoint?.(mission);
      torch.visible = !!mark;
      if (practice) {
        practice.root.visible = courtyard!(mission);
        practice.update(dt);
      }
      const subjectPoint = subject?.(mission);
      subjectModel.visible = !!subjectPoint;
      if (subjectPoint) subjectModel.root.position.set(subjectPoint.x, 0, subjectPoint.z);
      if (mark) torch.position.set(mark.x, 0.09, mark.z);
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
  const { x, z } = game.player.position;
  const yaw = game.player.yaw;
  const initialCamera = {
    position: [x - 5.8 * Math.sin(yaw), 3.3, z - 5.8 * Math.cos(yaw)] as [number, number, number],
    rotation: [0, Math.PI + yaw, 0] as [number, number, number],
    fov: 59,
    near: 0.1,
    far: 460,
  };
  return {
    game,
    initialCamera,
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
      subjectModel.dispose();
      practice?.dispose();
      torch.geometry.dispose();
      torch.material.dispose();
      torch.removeFromParent();
      scenery.dispose();
      mission.dispose();
      game.dispose();
      dustSprite.dispose();
      resetMobileInput();
    },
  };
}

export function CityPlay<T extends Mission>(props: CityPlayProps<T>) {
  const [session, setSession] = useState<ReturnType<typeof createSession<T>> | null>(null);
  const [paused, setPaused] = useState(false);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const binding = useMemo(
    () =>
      session && canvas
        ? new DomInputBinding(session.game.input, canvas, () => session.game.audio?.unlock())
        : null,
    [session, canvas],
  );
  useLayoutEffect(() => {
    binding?.attach();
    return () => binding?.detach();
  }, [binding]);
  const [, redraw] = useState(0);
  useEffect(() => {
    const s = createSession(props);
    if (import.meta.env.DEV && !props.bakery) {
      (window as unknown as { __cityCampaign?: typeof s }).__cityCampaign = s;
    }
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
    const sync = (e: StorageEvent) => {
      props.onStorage(s.mission, e.key);
    };
    window.addEventListener("storage", sync);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", escape);
    return () => {
      clearInterval(timer);
      window.removeEventListener("storage", sync);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", escape);
      if (import.meta.env.DEV)
        delete (window as unknown as { __cityCampaign?: typeof s }).__cityCampaign;
      s.dispose();
    };
    // The mission is owned by this mount, including its storage listeners and actors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const active = !paused && (!session || !props.modal(session.mission));
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
    <main className="city-story" aria-label={props.label}>
      <Canvas
        dpr={[1, 1.35]}
        gl={{ antialias: true }}
        onCreated={({ gl }) => setCanvas(gl.domElement)}
        camera={session.initialCamera}
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
      {props.renderHUD({
        mission: session.mission,
        figure: session.figure,
        paused,
        setPaused,
        refresh: () => redraw((n) => n + 1),
      })}
    </main>
  );
}
