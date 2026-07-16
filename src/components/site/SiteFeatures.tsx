import { useMemo } from "react";
import * as THREE from "three";
import {
  pipeRacks,
  parkingLots,
  channels,
  fencePath,
} from "@/lib/site-layout";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";

// ---------------------------------------------------------------------------
// Pipe racks — parallel horizontal pipes on regularly spaced portal bents.
// ---------------------------------------------------------------------------
function PipeRacks() {
  const items = useMemo(() => {
    return pipeRacks.map((r) => {
      const from = new THREE.Vector3(r.from[0], 0, r.from[1]);
      const to = new THREE.Vector3(r.to[0], 0, r.to[1]);
      const dir = new THREE.Vector3().subVectors(to, from);
      const len = dir.length();
      const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
      const angle = Math.atan2(dir.x, dir.z);
      return { r, len, mid, angle };
    });
  }, []);

  return (
    <group name="pipe-racks">
      {items.map(({ r, len, mid, angle }, i) => {
        const lines = r.lines ?? 3;
        const h = r.height ?? 2.2;
        const bents = Math.max(2, Math.round(len / 8));
        const width = (lines - 1) * 0.6 + 1.2;
        return (
          <group key={`rack-${i}`} name={`pipe-rack-${i}`} position={[mid.x, 0, mid.z]} rotation={[0, angle, 0]}>
            {/* pipes run along local Z */}
            {Array.from({ length: lines }).map((_, j) => {
              const off = (j - (lines - 1) / 2) * 0.6;
              return (
                <mesh key={`p-${j}`} position={[off, h, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
                  <cylinderGeometry args={[0.18, 0.18, len, 12]} />
                  <meshStandardMaterial color={j % 2 ? "#b7b1a4" : "#9aa0a6"} metalness={0.6} roughness={0.45} />
                </mesh>
              );
            })}
            {/* portal bents (support frames) */}
            {Array.from({ length: bents }).map((_, k) => {
              const z = -len / 2 + (k / (bents - 1)) * len;
              return (
                <group key={`bent-${k}`} position={[0, 0, z]}>
                  <mesh position={[-width / 2, h / 2, 0]} castShadow>
                    <boxGeometry args={[0.22, h, 0.22]} />
                    <meshStandardMaterial color="#7c776c" metalness={0.5} roughness={0.6} />
                  </mesh>
                  <mesh position={[width / 2, h / 2, 0]} castShadow>
                    <boxGeometry args={[0.22, h, 0.22]} />
                    <meshStandardMaterial color="#7c776c" metalness={0.5} roughness={0.6} />
                  </mesh>
                  <mesh position={[0, h + 0.1, 0]} castShadow>
                    <boxGeometry args={[width + 0.3, 0.22, 0.22]} />
                    <meshStandardMaterial color="#7c776c" metalness={0.5} roughness={0.6} />
                  </mesh>
                </group>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Parking lots — asphalt apron with painted stall lines.
// ---------------------------------------------------------------------------
function ParkingLots() {
  const tex = getSiteTextures();
  const asphaltMap = useMemo(() => setRepeat(tex.asphaltColor, 3, 3), [tex]);
  const asphaltRough = useMemo(() => setRepeat(tex.asphaltRough, 3, 3), [tex]);
  const asphaltNormal = useMemo(() => setRepeat(tex.asphaltNormal, 3, 3), [tex]);

  return (
    <group name="parking-lots">
      {parkingLots.map((p, i) => {
        const rows = p.rows ?? 3;
        const stalls = Math.floor(p.size[0] / 2.6);
        return (
          <group key={`lot-${i}`} name={`parking-${i}`} position={[p.pos[0], 0, p.pos[1]]} rotation={[0, p.rotY ?? 0, 0]}>
            <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
              <planeGeometry args={[p.size[0], p.size[1]]} />
              <meshStandardMaterial
                map={asphaltMap}
                roughnessMap={asphaltRough}
                normalMap={asphaltNormal}
                color="#3c3c3e"
                roughness={0.95}
              />
            </mesh>
            {/* stall lines */}
            {Array.from({ length: rows + 1 }).map((_, r) =>
              Array.from({ length: stalls + 1 }).map((_, s) => (
                <mesh
                  key={`line-${r}-${s}`}
                  position={[
                    -p.size[0] / 2 + (s / stalls) * p.size[0],
                    0.08,
                    -p.size[1] / 2 + (r / rows) * p.size[1],
                  ]}
                  rotation={[-Math.PI / 2, 0, 0]}
                >
                  <planeGeometry args={[0.12, (p.size[1] / rows) * 0.8]} />
                  <meshStandardMaterial color="#d8d4c6" roughness={0.9} />
                </mesh>
              ))
            )}
          </group>
        );
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Perimeter fence — chain-link ribbon with regularly spaced posts.
// ---------------------------------------------------------------------------
function Fence() {
  const postPositions = useMemo(() => {
    const pts: [number, number][] = [];
    const n = fencePath.length;
    for (let i = 0; i < n; i++) {
      const a = fencePath[i];
      const b = fencePath[(i + 1) % n];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const count = Math.max(1, Math.round(seg / 8));
      for (let k = 0; k < count; k++) {
        const t = k / count;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return pts;
  }, []);

  const fenceGeom = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const verts: number[] = [];
    const idx: number[] = [];
    const n = fencePath.length;
    const y0 = 0;
    const y1 = 2.2;
    for (let i = 0; i < n; i++) {
      const [x, z] = fencePath[i];
      verts.push(x, y0, z, x, y1, z);
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = ((i + 1) % n) * 2;
      const d = ((i + 1) % n) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }
    geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geom.setIndex(idx);
    geom.computeVertexNormals();
    return geom;
  }, []);

  return (
    <group name="perimeter-fence">
      <mesh geometry={fenceGeom}>
        <meshStandardMaterial
          color="#9a988f"
          metalness={0.5}
          roughness={0.6}
          side={THREE.DoubleSide}
          transparent
          opacity={0.35}
          depthWrite={false}
        />
      </mesh>
      <instancedMesh
        args={[undefined, undefined, postPositions.length]}
        castShadow
        ref={(inst) => {
          if (!inst) return;
          const m = new THREE.Matrix4();
          postPositions.forEach((p, i) => {
            m.makeTranslation(p[0], 1.2, p[1]);
            inst.setMatrixAt(i, m);
          });
          inst.instanceMatrix.needsUpdate = true;
        }}
      >
        <cylinderGeometry args={[0.09, 0.09, 2.4, 6]} />
        <meshStandardMaterial color="#8a8880" metalness={0.6} roughness={0.5} />
      </instancedMesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Drainage channels — recessed trapezoidal ditches following a path.
// ---------------------------------------------------------------------------
function DrainageChannels() {
  const tex = getSiteTextures();
  const concreteMap = useMemo(() => setRepeat(tex.concreteColor, 2, 8), [tex]);

  const geoms = useMemo(() => {
    return channels.map((c) => {
      const geom = new THREE.BufferGeometry();
      const verts: number[] = [];
      const idx: number[] = [];
      const pts = c.path;
      const depth = -0.9;
      for (let i = 0; i < pts.length; i++) {
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        const t = new THREE.Vector2(next[0] - prev[0], next[1] - prev[1]).normalize();
        const nrm = new THREE.Vector2(-t.y, t.x);
        const w = c.width / 2;
        const [x, z] = pts[i];
        // left top, left bottom, right bottom, right top
        verts.push(x + nrm.x * w, 0.05, z + nrm.y * w);
        verts.push(x + nrm.x * w * 0.4, depth, z + nrm.y * w * 0.4);
        verts.push(x - nrm.x * w * 0.4, depth, z - nrm.y * w * 0.4);
        verts.push(x - nrm.x * w, 0.05, z - nrm.y * w);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const b = i * 4;
        const nb = (i + 1) * 4;
        // three quads: left slope, floor, right slope
        for (let k = 0; k < 3; k++) {
          const a = b + k;
          const c2 = b + k + 1;
          const d = nb + k + 1;
          const e = nb + k;
          idx.push(a, c2, e, e, c2, d);
        }
      }
      geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      geom.setIndex(idx);
      geom.computeVertexNormals();
      return geom;
    });
  }, []);

  return (
    <group name="drainage-channels">
      {geoms.map((g, i) => (
        <mesh key={`chan-${i}`} geometry={g} receiveShadow>
          <meshStandardMaterial map={concreteMap} color="#a9a396" roughness={1} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

export function SiteFeatures() {
  return (
    <group name="site-features">
      <PipeRacks />
      <ParkingLots />
      <Fence />
      <DrainageChannels />
    </group>
  );
}
