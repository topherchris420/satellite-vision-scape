import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { getSiteTextures } from "@/lib/site-textures";
import type { TimeOfDay } from "./Lighting";

// Shared prevailing wind (m/s-ish, world XZ). Smoke, steam and clouds all
// drift with it so the weather reads as one coherent system.
const WIND = { x: 1.7, z: 0.8 };

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

export function Atmosphere({ time }: { time: TimeOfDay }) {
  return <group name="atmosphere"><CloudDeck time={time} /></group>;
}
