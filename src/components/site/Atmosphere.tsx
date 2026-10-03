import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { WIND, windUniforms } from "@/lib/wind";
import type { TimeOfDay } from "./Lighting";

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function DustField({ time }: { time: TimeOfDay }) {
  const points = useRef<THREE.Points>(null);
  const { positions, sizes } = useMemo(() => {
    const r = rng(44017);
    const pos = new Float32Array(420 * 3);
    const size = new Float32Array(420);
    for (let i = 0; i < 420; i++) {
      pos[i * 3] = (r() - 0.5) * 1800;
      pos[i * 3 + 1] = 4 + r() * 150;
      pos[i * 3 + 2] = (r() - 0.5) * 1600;
      size[i] = 0.6 + r() * 1.8;
    }
    return { positions: pos, sizes: size };
  }, []);

  useFrame(({ clock }, delta) => {
    const attr = points.current?.geometry.attributes.position as THREE.BufferAttribute | undefined;
    if (!attr) return;
    // Direct typed-array access: no per-particle accessor calls.
    const a = attr.array as Float32Array;
    const t = clock.elapsedTime * 0.35;
    for (let i = 0, k = 0; i < attr.count; i++, k += 3) {
      let x = a[k] + WIND.x * delta * (0.25 + (i % 5) * 0.05);
      if (x > 900) x = -900;
      a[k] = x;
      a[k + 1] += Math.sin(t + i) * delta * 0.08;
    }
    attr.needsUpdate = true;
  });

  const tint = time === "night" ? "#8da8c8" : time === "dusk" ? "#e6b27e" : "#f6d8ad";
  return (
    <points ref={points} name="suspended-dust">
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-size" args={[sizes, 1]} />
      </bufferGeometry>
      <pointsMaterial color={tint} size={1.15} sizeAttenuation transparent opacity={time === "night" ? 0.08 : 0.16} depthWrite={false} fog />
    </points>
  );
}

// Advances the shared vegetation-sway clock once per frame (GPU-side sway).
function WindClock() {
  useFrame(({ clock }) => {
    windUniforms.uWindTime.value = clock.elapsedTime;
  });
  return null;
}

export function Atmosphere({ time }: { time: TimeOfDay }) {
  return (
    <group name="atmosphere">
      <WindClock />
      <DustField time={time} />
    </group>
  );
}
