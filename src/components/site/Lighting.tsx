import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { Sky, Stars } from "@react-three/drei";
import * as THREE from "three";
import { buildings, domes, spheres } from "@/lib/site-layout";

export type TimeOfDay = "day" | "night";

// Procedural equirectangular gradient environment, baked to an IBL map through
// PMREM. Fully offline (no CDN HDR fetch) so it works in a sandboxed runtime.
function makeGradientEquirect(isDay: boolean) {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  if (isDay) {
    g.addColorStop(0.0, "#4a7ab8"); // zenith
    g.addColorStop(0.45, "#c4b89e");
    g.addColorStop(0.5, "#e8d5b0"); // horizon haze
    g.addColorStop(0.55, "#d49a62");
    g.addColorStop(1.0, "#9c5636"); // red-earth ground bounce
  } else {
    g.addColorStop(0.0, "#0a1226");
    g.addColorStop(0.48, "#141d33");
    g.addColorStop(0.5, "#26304a");
    g.addColorStop(0.55, "#161c2c");
    g.addColorStop(1.0, "#05070d");
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // warm sun disc smear near the horizon for day
  if (isDay) {
    const sun = ctx.createRadialGradient(w * 0.72, h * 0.42, 2, w * 0.72, h * 0.42, 90);
    sun.addColorStop(0, "rgba(255,244,214,0.9)");
    sun.addColorStop(1, "rgba(255,244,214,0)");
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, w, h);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function ProceduralEnvironment({ isDay }: { isDay: boolean }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const envTex = useMemo(() => makeGradientEquirect(isDay), [isDay]);

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    pmrem.compileEquirectangularShader();
    const rt = pmrem.fromEquirectangular(envTex);
    scene.environment = rt.texture;
    return () => {
      scene.environment = null;
      rt.dispose();
      pmrem.dispose();
      envTex.dispose();
    };
  }, [gl, scene, envTex]);

  return null;
}

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

      <ProceduralEnvironment isDay={isDay} />

      {isDay ? (
        <>
          <ambientLight intensity={0.35} color="#ffe8c4" />
          <hemisphereLight args={["#cfe0ff", "#c9a26e", 0.65]} />
          {/* Sun */}
          <directionalLight
            position={[140, 220, 90]}
            intensity={2.8}
            color="#fff2d6"
            castShadow
            shadow-mapSize-width={4096}
            shadow-mapSize-height={4096}
            shadow-bias={-0.0004}
            shadow-normalBias={0.02}
            shadow-radius={4}
            shadow-camera-left={-250}
            shadow-camera-right={250}
            shadow-camera-top={250}
            shadow-camera-bottom={-250}
            shadow-camera-near={1}
            shadow-camera-far={700}
          />
          {/* Cool sky-bounce fill from the shadow side, keeps shade readable */}
          <directionalLight position={[-120, 90, -80]} intensity={0.35} color="#bcd0f0" />
        </>
      ) : (
        <>
          <Stars radius={800} depth={120} count={4000} factor={6} saturation={0.1} fade speed={0.4} />
          <ambientLight intensity={0.08} color="#1b2540" />
          <hemisphereLight args={["#1e2a4a", "#050810", 0.35]} />
          {/* Moonlight */}
          <directionalLight
            position={[-80, 180, -60]}
            intensity={0.55}
            color="#9db8ff"
            castShadow
            shadow-mapSize-width={4096}
            shadow-mapSize-height={4096}
            shadow-bias={-0.0004}
            shadow-normalBias={0.02}
            shadow-radius={4}
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
            />
          ))}
          {/* Tank-farm accent lights */}
          {[...domes.slice(0, 4), ...spheres.slice(0, 4).map((s) => ({ pos: s.pos, radius: s.radius }))].map((d, i) => (
            <pointLight
              key={`accent-${i}`}
              position={[d.pos[0], d.radius + 2, d.pos[1]]}
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
