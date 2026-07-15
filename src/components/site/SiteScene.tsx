import { Suspense, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Sky, Environment } from "@react-three/drei";
import { Terrain } from "./Terrain";
import { Structures } from "./Structures";
import { Roads } from "./Roads";
import { Controls, type ControlMode } from "./Controls";
import { HUD } from "./HUD";

export function SiteScene() {
  const [mode, setMode] = useState<ControlMode>("fly");

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-900">
      <HUD mode={mode} onModeChange={setMode} />
      <Canvas
        shadows
        camera={{ fov: 55, near: 0.1, far: 2000, position: [0, 120, 180] }}
        gl={{ antialias: true }}
      >
        <Suspense fallback={null}>
          <Sky sunPosition={[100, 80, 50]} turbidity={4} rayleigh={1.5} />
          <Environment preset="sunset" />

          <ambientLight intensity={0.35} />
          <hemisphereLight args={["#cfe0ff", "#b8916a", 0.4]} />
          <directionalLight
            position={[120, 200, 80]}
            intensity={2.2}
            castShadow
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
            shadow-camera-left={-250}
            shadow-camera-right={250}
            shadow-camera-top={250}
            shadow-camera-bottom={-250}
            shadow-camera-near={1}
            shadow-camera-far={600}
          />

          <Terrain />
          <Roads />
          <Structures />

          <fog attach="fog" args={["#d9c9a8", 250, 700]} />
        </Suspense>

        <Controls mode={mode} />
      </Canvas>
    </div>
  );
}
