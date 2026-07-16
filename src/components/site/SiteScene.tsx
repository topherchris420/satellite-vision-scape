import { Suspense, useState } from "react";
import { Canvas } from "@react-three/fiber";

import * as THREE from "three";
import { Terrain } from "./Terrain";
import { Structures } from "./Structures";
import { SiteFeatures } from "./SiteFeatures";
import { Roads } from "./Roads";
import { Controls, type ControlMode } from "./Controls";
import { Lighting, type TimeOfDay } from "./Lighting";
import { HUD } from "./HUD";

export function SiteScene() {
  const [mode, setMode] = useState<ControlMode>("fly");
  const [time, setTime] = useState<TimeOfDay>("day");

  const fogColor = time === "day" ? "#d9c9a8" : "#0a1024";

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-900">
      <HUD
        mode={mode}
        onModeChange={setMode}
        time={time}
        onTimeChange={setTime}
      />
      <Canvas
        shadows
        camera={{ fov: 55, near: 0.1, far: 2000, position: [0, 120, 180] }}
        gl={{
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
      >
        <Suspense fallback={null}>
          <Lighting time={time} />
          <Terrain />
          <Roads />
          <Structures />
          <SiteFeatures />
          <fog attach="fog" args={[fogColor, 350, 1100]} />
          
        </Suspense>

        <Controls mode={mode} />
      </Canvas>
    </div>
  );
}
