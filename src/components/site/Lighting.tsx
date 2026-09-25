import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Sky, Stars } from "@react-three/drei";
import * as THREE from "three";
import { buildings, domes } from "@/lib/site-layout";
import { sampleFootprintGrade } from "@/lib/terrain";

export type TimeOfDay = "day" | "dusk" | "night";
export const LIGHTING = {
  day: {
    sun: [180, 300, -160] as [number, number, number],
    color: "#fff5e5",
    intensity: 3,
    sky: "#88b3d4",
    ground: "#aa7855",
    ambient: 0.45,
    fog: "#c3ced0",
    exposure: 1,
  },
  dusk: {
    sun: [-300, 95, -180] as [number, number, number],
    color: "#ffd19a",
    intensity: 2.8,
    sky: "#8dacca",
    ground: "#996949",
    ambient: 0.35,
    fog: "#c7b4a1",
    exposure: 1.05,
  },
  // Night keeps enough moonlight and sky fill to read the ground and the
  // character at street level in play mode.
  night: {
    sun: [100, 260, -150] as [number, number, number],
    color: "#a4bde3",
    intensity: 0.5,
    sky: "#2a4468",
    ground: "#1b1f2a",
    ambient: 0.34,
    fog: "#101c2a",
    exposure: 1.15,
  },
} as const;

/**
 * Shadow framing. The viewer modes cover the whole site; play mode follows
 * the player with a tight frustum so the character, vehicles and nearby
 * structures get crisp shadows from the same map, and far geometry is culled
 * from the shadow pass entirely.
 */
const SITE_SHADOW = {
  extent: 700,
  distance: 1800,
  near: 1,
  far: 3200,
  normalBias: 0.18,
  bias: -0.00008,
};
const FOLLOW_SHADOW = {
  extent: 110,
  distance: 650,
  near: 1,
  far: 1400,
  normalBias: 0.035,
  bias: -0.00022,
};

function Environment({ time }: { time: TimeOfDay }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    const p = LIGHTING[time];
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createLinearGradient(0, 0, 0, 128);
    gradient.addColorStop(0, p.sky);
    gradient.addColorStop(0.48, p.fog);
    gradient.addColorStop(0.53, p.ground);
    gradient.addColorStop(1, p.ground);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 128);
    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(gl);
    const renderTarget = pmrem.fromEquirectangular(texture);
    const previous = scene.environment;
    scene.environment = renderTarget.texture;
    scene.environmentIntensity = time === "night" ? 0.12 : 0.45;
    gl.toneMappingExposure = p.exposure;
    return () => {
      scene.environment = previous;
      renderTarget.dispose();
      texture.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, time]);
  return null;
}

export function Lighting({
  time,
  highQuality = true,
  shadowFocus = null,
}: {
  time: TimeOfDay;
  highQuality?: boolean;
  /** When set, the sun's shadow frustum follows this (mutated) point. */
  shadowFocus?: THREE.Vector3 | null;
}) {
  const p = LIGHTING[time];
  const night = time === "night";
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const sunDirection = useMemo(() => new THREE.Vector3(...p.sun).normalize(), [p.sun]);
  const mapSize = highQuality ? 4096 : 2048;
  const scratch = useMemo(
    () => ({
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      snapped: new THREE.Vector3(),
      worldUp: new THREE.Vector3(0, 1, 0),
    }),
    [],
  );

  // Reframe the shadow camera when switching between site and follow modes.
  useEffect(() => {
    const light = sunRef.current;
    if (!light) return;
    const frame = shadowFocus ? FOLLOW_SHADOW : SITE_SHADOW;
    const cam = light.shadow.camera;
    cam.left = -frame.extent;
    cam.right = frame.extent;
    cam.top = frame.extent;
    cam.bottom = -frame.extent;
    cam.near = frame.near;
    cam.far = frame.far;
    cam.updateProjectionMatrix();
    light.shadow.normalBias = frame.normalBias;
    light.shadow.bias = frame.bias;
    if (!shadowFocus) {
      light.position.copy(sunDirection).multiplyScalar(SITE_SHADOW.distance);
      light.target.position.set(0, 0, 0);
      light.target.updateMatrixWorld();
    }
  }, [shadowFocus, sunDirection]);

  useFrame(() => {
    const light = sunRef.current;
    if (!light || !shadowFocus) return;
    // Snap the frustum centre to whole shadow-map texels in light space so
    // shadows do not crawl or shimmer as the player moves.
    const { right, up, forward, snapped, worldUp } = scratch;
    forward.copy(sunDirection).negate();
    right.crossVectors(forward, worldUp).normalize();
    up.crossVectors(right, forward);
    const texel = (2 * FOLLOW_SHADOW.extent) / mapSize;
    const a = Math.round(shadowFocus.dot(right) / texel) * texel;
    const b = Math.round(shadowFocus.dot(up) / texel) * texel;
    const c = shadowFocus.dot(forward);
    snapped.copy(right).multiplyScalar(a).addScaledVector(up, b).addScaledVector(forward, c);
    light.target.position.copy(snapped);
    light.target.updateMatrixWorld();
    light.position.copy(snapped).addScaledVector(sunDirection, FOLLOW_SHADOW.distance);
  });

  return (
    <>
      {night ? (
        <color attach="background" args={[p.fog]} />
      ) : (
        <Sky
          distance={12000}
          sunPosition={p.sun}
          turbidity={2.8}
          rayleigh={1.8}
          mieCoefficient={0.003}
          mieDirectionalG={0.82}
        />
      )}
      {night && (
        <Stars radius={4500} depth={400} count={1800} factor={3} saturation={0} fade speed={0} />
      )}
      <Environment time={time} />
      <hemisphereLight args={[p.sky, p.ground, p.ambient]} />
      <directionalLight
        ref={sunRef}
        position={sunDirection.clone().multiplyScalar(SITE_SHADOW.distance)}
        intensity={p.intensity}
        color={p.color}
        castShadow
        shadow-mapSize-width={mapSize}
        shadow-mapSize-height={mapSize}
      />
      {night && (
        <>
          {buildings.slice(0, 3).map((b, i) => (
            <pointLight
              key={`building-${i}`}
              position={[
                b.pos[0] + b.size[0] / 2 + 2,
                sampleFootprintGrade(b.pos, b.size).elevation + 5,
                b.pos[1],
              ]}
              intensity={120}
              distance={45}
              decay={2}
              color="#ffd397"
            />
          ))}
          {domes
            .filter((d) => d.radius >= 15)
            .map((d) => (
              <pointLight
                key={d.sourceId}
                position={[
                  d.pos[0] + d.radius * 0.8,
                  sampleFootprintGrade(d.pos, d.radius).elevation + 2,
                  d.pos[1] + d.radius * 0.8,
                ]}
                intensity={110}
                distance={60}
                decay={2}
                color="#ffd5a2"
              />
            ))}
        </>
      )}
    </>
  );
}
