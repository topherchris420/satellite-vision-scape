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
const CLOUD_BOUND = 750;
function CloudDeck({ time }: { time: TimeOfDay }) {
  const tex = getSiteTextures();
  const group = useRef<THREE.Group>(null);

  const puffs = useMemo(() => {
    const r = rng(8181);
    const out: { x: number; y: number; z: number; s: number; o: number; drift: number }[] = [];
    for (let c = 0; c < 13; c++) {
      const cx = -CLOUD_BOUND + r() * CLOUD_BOUND * 2;
      const cz = -CLOUD_BOUND + r() * CLOUD_BOUND * 2;
      const cy = 170 + r() * 90;
      const n = 2 + Math.floor(r() * 3);
      const drift = 0.5 + r() * 0.7;
      for (let i = 0; i < n; i++) {
        out.push({
          x: cx + (r() - 0.5) * 70,
          y: cy + (r() - 0.5) * 14,
          z: cz + (r() - 0.5) * 50,
          s: 60 + r() * 90,
          o: 0.16 + r() * 0.2,
          drift,
        });
      }
    }
    return out;
  }, []);

  const color = time === "day" ? "#ffffff" : "#31405e";

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

// ---------------------------------------------------------------------------
// A rising particle column (smoke or steam). Particle motion is a stateless
// function of time, so the update loop allocates nothing and never desyncs:
// each sprite's age loops over its lifetime with a per-particle phase offset.
// ---------------------------------------------------------------------------
function ParticleColumn({
  pos,
  count,
  life,
  rise,
  spread,
  baseSize,
  grow,
  color,
  opacity,
  seed,
}: {
  pos: [number, number, number];
  count: number;
  life: number;
  rise: number;
  spread: number;
  baseSize: number;
  grow: number;
  color: string;
  opacity: number;
  seed: number;
}) {
  const tex = getSiteTextures();
  const group = useRef<THREE.Group>(null);

  const seeds = useMemo(() => {
    const r = rng(seed);
    return Array.from({ length: count }, () => ({
      phase: r() * life,
      swayA: r() * Math.PI * 2,
      swayR: 0.4 + r() * 0.9,
      speed: 0.85 + r() * 0.3,
    }));
  }, [count, life, seed]);

  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    const t = clock.elapsedTime;
    for (let i = 0; i < g.children.length; i++) {
      const sp = g.children[i] as THREE.Sprite;
      const s = seeds[i];
      const age = (t * s.speed + s.phase) % life;
      const k = age / life;
      sp.position.set(
        pos[0] + WIND.x * age * 0.9 + Math.sin(age * 1.3 + s.swayA) * s.swayR * k * spread,
        pos[1] + age * rise,
        pos[2] + WIND.z * age * 0.9 + Math.cos(age * 1.1 + s.swayA) * s.swayR * k * spread
      );
      const size = baseSize * (0.5 + k * grow);
      sp.scale.set(size, size, 1);
      // quick fade-in, long fade-out
      const fade = Math.min(1, k * 6) * (1 - k) * (1 - k);
      (sp.material as THREE.SpriteMaterial).opacity = opacity * fade;
      (sp.material as THREE.SpriteMaterial).rotation = s.swayA + age * 0.25;
    }
  });

  return (
    <group ref={group}>
      {seeds.map((_, i) => (
        <sprite key={i} position={pos}>
          <spriteMaterial
            map={tex.smokeSprite}
            color={color}
            transparent
            opacity={0}
            depthWrite={false}
          />
        </sprite>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Industrial emissions: flue stacks rising out of the process hall roof with
// smoke plumes and aircraft-warning beacons, plus steam vents in the tank
// farm. Stack bases sit inside the hall footprint so the existing building
// collider already covers them.
// ---------------------------------------------------------------------------
const STACKS: [number, number][] = [
  [16, 44],
  [21, 58],
];
const VENTS: [number, number][] = [
  [33, 44],
  [-33, 31],
];
const HALL_ROOF = 12;

function Emissions({ time }: { time: TimeOfDay }) {
  const night = time === "night";
  const beacons = useRef<THREE.MeshStandardMaterial[]>([]);

  useFrame(({ clock }) => {
    // slow double-blink like a real obstruction light
    const p = (Math.sin(clock.elapsedTime * 2.4) + Math.sin(clock.elapsedTime * 4.8)) * 0.25 + 0.5;
    for (const m of beacons.current) {
      if (m) m.emissiveIntensity = night ? 1.5 + p * 4 : 0.4 + p * 0.8;
    }
  });

  return (
    <group name="emissions">
      {STACKS.map(([x, z], i) => (
        <group key={`stack-${i}`} position={[x, 0, z]}>
          {/* flue rising through the hall roof */}
          <mesh position={[0, (HALL_ROOF + 15) / 2, 0]} castShadow>
            <cylinderGeometry args={[0.7, 1.0, HALL_ROOF + 15, 14]} />
            <meshStandardMaterial color="#9b948a" metalness={0.4} roughness={0.6} />
          </mesh>
          {/* soot-stained crown */}
          <mesh position={[0, HALL_ROOF + 14.4, 0]} castShadow>
            <cylinderGeometry args={[0.78, 0.72, 1.6, 14]} />
            <meshStandardMaterial color="#3d3a36" metalness={0.3} roughness={0.9} />
          </mesh>
          {/* obstruction beacon */}
          <mesh position={[0, HALL_ROOF + 15.5, 0]}>
            <sphereGeometry args={[0.22, 10, 8]} />
            <meshStandardMaterial
              ref={(m) => {
                if (m) beacons.current[i] = m;
              }}
              color="#5c1410"
              emissive="#ff2a1a"
              emissiveIntensity={1}
            />
          </mesh>
          <ParticleColumn
            pos={[0, HALL_ROOF + 15.2, 0]}
            count={16}
            life={9}
            rise={2.6}
            spread={2.4}
            baseSize={5}
            grow={3.2}
            color={night ? "#232a38" : "#8d8a85"}
            opacity={night ? 0.32 : 0.4}
            seed={917 + i * 131}
          />
        </group>
      ))}

      {VENTS.map(([x, z], i) => (
        <group key={`vent-${i}`} position={[x, 0, z]}>
          <mesh position={[0, 1.9, 0]} castShadow>
            <cylinderGeometry args={[0.24, 0.28, 3.8, 10]} />
            <meshStandardMaterial color="#a9a49b" metalness={0.6} roughness={0.4} />
          </mesh>
          <mesh position={[0.5, 0.6, 0]} castShadow>
            <boxGeometry args={[1.1, 1.2, 0.9]} />
            <meshStandardMaterial color="#7d7a70" metalness={0.5} roughness={0.6} />
          </mesh>
          <ParticleColumn
            pos={[0, 3.9, 0]}
            count={10}
            life={4.5}
            rise={1.9}
            spread={1.1}
            baseSize={2.2}
            grow={2.4}
            color={night ? "#3c4660" : "#f2f2ee"}
            opacity={night ? 0.3 : 0.5}
            seed={2311 + i * 97}
          />
        </group>
      ))}
    </group>
  );
}

export function Atmosphere({ time }: { time: TimeOfDay }) {
  return (
    <group name="atmosphere">
      <CloudDeck time={time} />
      <Emissions time={time} />
    </group>
  );
}
