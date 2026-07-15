import { Sky, Environment } from "@react-three/drei";
import { buildings, domes } from "@/lib/site-layout";

export type TimeOfDay = "day" | "night";

export function Lighting({ time }: { time: TimeOfDay }) {
  const isDay = time === "day";

  return (
    <>
      {isDay ? (
        <Sky
          sunPosition={[100, 80, 50]}
          turbidity={3}
          rayleigh={1.2}
          mieCoefficient={0.005}
          mieDirectionalG={0.85}
        />
      ) : (
        <Sky
          sunPosition={[-5, -0.6, -20]}
          turbidity={12}
          rayleigh={0.4}
          mieCoefficient={0.02}
          mieDirectionalG={0.7}
        />
      )}

      <Environment preset={isDay ? "sunset" : "night"} />

      {isDay ? (
        <>
          <ambientLight intensity={0.35} color="#fff2dc" />
          <hemisphereLight args={["#dbe7ff", "#c9a26e", 0.55]} />
          <directionalLight
            position={[140, 220, 90]}
            intensity={2.6}
            color="#fff2d6"
            castShadow
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
            shadow-bias={-0.0005}
            shadow-camera-left={-250}
            shadow-camera-right={250}
            shadow-camera-top={250}
            shadow-camera-bottom={-250}
            shadow-camera-near={1}
            shadow-camera-far={700}
          />
        </>
      ) : (
        <>
          <ambientLight intensity={0.08} color="#1b2540" />
          <hemisphereLight args={["#1e2a4a", "#050810", 0.35]} />
          {/* Moonlight */}
          <directionalLight
            position={[-80, 180, -60]}
            intensity={0.55}
            color="#9db8ff"
            castShadow
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
            shadow-bias={-0.0005}
            shadow-camera-left={-250}
            shadow-camera-right={250}
            shadow-camera-top={250}
            shadow-camera-bottom={-250}
            shadow-camera-near={1}
            shadow-camera-far={700}
          />
          {/* Site sodium lamps on each building */}
          {buildings.map((b, i) => (
            <pointLight
              key={`lamp-${i}`}
              position={[b.pos[0], b.height + 3, b.pos[1]]}
              intensity={12}
              distance={45}
              decay={2}
              color="#ffb35a"
              castShadow={false}
            />
          ))}
          {/* Dome accent lights */}
          {domes.slice(0, 6).map((d, i) => (
            <pointLight
              key={`domelight-${i}`}
              position={[d.pos[0], d.radius + 1, d.pos[1]]}
              intensity={6}
              distance={30}
              decay={2}
              color="#7fb8ff"
            />
          ))}
        </>
      )}
    </>
  );
}
