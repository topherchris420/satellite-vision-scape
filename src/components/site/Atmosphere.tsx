import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { getSiteTextures } from "@/lib/site-textures";
import { WIND, windUniforms } from "@/lib/wind";
import type { TimeOfDay } from "./Lighting";

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// ---------------------------------------------------------------------------
// Cloud deck — clusters of soft billboard sprites drifting with the wind and
// wrapping around the play area. Unlit, tinted per time of day.
// ---------------------------------------------------------------------------
const CLOUD_BOUND = 2200;
function CloudDeck({ time }: { time: TimeOfDay }) {
  const tex = getSiteTextures();
  const group = useRef<THREE.Group>(null);

  const puffs = useMemo(() => {
    const r = rng(8181);
    const out: { x: number; y: number; z: number; s: number; o: number; drift: number }[] = [];
    for (let c = 0; c < 7; c++) {
      const cx = -CLOUD_BOUND + r() * CLOUD_BOUND * 2;
      const cz = -CLOUD_BOUND + r() * CLOUD_BOUND * 2;
      const cy = 650 + r() * 200;
      const n = 2 + Math.floor(r() * 3);
      const drift = 0.5 + r() * 0.7;
      for (let i = 0; i < n; i++) {
        out.push({
          x: cx + (r() - 0.5) * 70,
          y: cy + (r() - 0.5) * 14,
          z: cz + (r() - 0.5) * 50,
          s: 220 + r() * 180,
          o: 0.07 + r() * 0.07,
          drift,
        });
      }
    }
    return out;
  }, []);

  const color = time === "day" ? "#ffffff" : time === "dusk" ? "#f0c7ad" : "#31405e";

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    for (let i = 0; i < g.children.length; i++) {
      const sp = g.children[i];
      const d = puffs[i].drift;
      sp.position.x += WIND.x * d * delta * 2.2;
      sp.position.z += WIND.z * d * delta * 2.2;
      if (sp.position.x > CLOUD_BOUND) sp.position.x = -CLOUD_BOUND;
      if (sp.position.z > CLOUD_BOUND) sp.position.z = -CLOUD_BOUND;
    }
  });

  return (
    <group ref={group} name="cloud-deck">
      {puffs.map((p, i) => (
        <sprite key={`cloud-${i}`} position={[p.x, p.y, p.z]} scale={[p.s, p.s * 0.45, 1]}>
          <spriteMaterial
            map={tex.cloudSprite}
            color={color}
            transparent
            opacity={p.o}
            depthWrite={false}
            fog={false}
          />
        </sprite>
      ))}
    </group>
  );
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
      <CloudDeck time={time} />
      <DustField time={time} />
    </group>
  );
}
