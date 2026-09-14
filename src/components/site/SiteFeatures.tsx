import { useMemo } from "react";
import * as THREE from "three";
import {
  parkingLots,
  channels,
  fencePath,
  topEnclosurePath,
} from "@/lib/site-layout";
import { terrainHeightAt, sampleFootprintGrade } from "@/lib/terrain";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";

// Approximate parking, boundary and drainage context; these are deliberately
// kept separate from the historical antenna manifest.
function ParkingLots() {
  const tex = getSiteTextures();
  const asphaltMap = useMemo(() => setRepeat(tex.asphaltColor, 3, 3), [tex]);
  const concreteMap = useMemo(() => setRepeat(tex.concreteColor, 2, 2), [tex]);

  const lots = useMemo(() => {
    return parkingLots.map((p) => {
      const grade = sampleFootprintGrade(p.pos, p.size, p.rotY ?? 0);
      return { p, grade };
    });
  }, []);

  return (
    <group name="parking-lots">
      {lots.map(({ p, grade }, i) => {
        const rows = p.rows ?? 3;
        const stalls = Math.floor(p.size[0] / 2.6);
        const skirtDepth = Math.max(0.2, grade.elevation - grade.minTerrain + 0.2);

        return (
          <group
            key={`lot-${i}`}
            name={`parking-${i}`}
            position={[p.pos[0], grade.elevation, p.pos[1]]}
            rotation={[0, p.rotY ?? 0, 0]}
          >
            {/* Concrete base pad */}
            <mesh position={[0, -skirtDepth / 2 + 0.02, 0]} receiveShadow>
              <boxGeometry args={[p.size[0] + 0.4, skirtDepth, p.size[1] + 0.4]} />
              <meshStandardMaterial map={concreteMap} roughness={0.9} />
            </mesh>

            {/* Asphalt surface */}
            <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
              <planeGeometry args={[p.size[0], p.size[1]]} />
              <meshStandardMaterial map={asphaltMap} color="#3c3c3e" roughness={0.95} />
            </mesh>

            {/* Stall lines */}
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
// Perimeter fence — terrain-conforming chain-link ribbon with alphaTest.
// ---------------------------------------------------------------------------
function Fence({ path = fencePath, name = "perimeter-fence" }: { path?: [number, number][]; name?: string }) {
  // Dense resampling along fence polyline (~3 m spacing)
  const resampledPath = useMemo(() => {
    const pts: [number, number, number][] = [];
    const n = path.length;
    for (let i = 0; i < n; i++) {
      const a = path[i];
      const b = path[(i + 1) % n];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const count = Math.max(1, Math.round(seg / 3));
      for (let k = 0; k < count; k++) {
        const t = k / count;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        const y = terrainHeightAt(x, z);
        pts.push([x, y, z]);
      }
    }
    return pts;
  }, [path]);

  const postPositions = useMemo(() => {
    const pts: [number, number, number][] = [];
    const n = path.length;
    for (let i = 0; i < n; i++) {
      const a = path[i];
      const b = path[(i + 1) % n];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const count = Math.max(1, Math.round(seg / 6));
      for (let k = 0; k < count; k++) {
        const t = k / count;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        const y = terrainHeightAt(x, z);
        pts.push([x, y, z]);
      }
    }
    return pts;
  }, [path]);

  const fenceGeom = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const verts: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    const n = resampledPath.length;
    const h = 2.4;

    let totalDist = 0;
    for (let i = 0; i < n; i++) {
      const [x, y0, z] = resampledPath[i];
      if (i > 0) {
        const prev = resampledPath[i - 1];
        totalDist += Math.hypot(x - prev[0], z - prev[2]);
      }
      verts.push(x, y0, z, x, y0 + h, z);
      const u = totalDist / 3; // texture repeat along fence line
      uvs.push(u, 0, u, 1);
    }

    for (let i = 0; i < n; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = ((i + 1) % n) * 2;
      const d = ((i + 1) % n) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }

    geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(idx);
    geom.computeVertexNormals();
    return geom;
  }, [resampledPath]);

  // A real wire lattice keeps the boundary legible in silhouette. The faint
  // curtain below still catches the sun between strands, while these rails and
  // diamonds provide the characteristic chain-link read from the air.
  const fenceWireGeom = useMemo(() => {
    const verts: number[] = [];
    const add = (a: [number, number, number], b: [number, number, number]) => {
      verts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    };
    const n = resampledPath.length;
    for (let i = 0; i < n; i++) {
      const a = resampledPath[i];
      const b = resampledPath[(i + 1) % n];
      const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const cells = Math.max(1, Math.ceil(length / 0.9));
      for (const level of [0.18, 1.18, 2.32]) {
        add([a[0], a[1] + level, a[2]], [b[0], b[1] + level, b[2]]);
      }
      for (let j = 0; j < cells; j++) {
        const t0 = j / cells;
        const t1 = (j + 1) / cells;
        const x0 = a[0] + (b[0] - a[0]) * t0;
        const z0 = a[2] + (b[2] - a[2]) * t0;
        const y0 = a[1] + (b[1] - a[1]) * t0;
        const x1 = a[0] + (b[0] - a[0]) * t1;
        const z1 = a[2] + (b[2] - a[2]) * t1;
        const y1 = a[1] + (b[1] - a[1]) * t1;
        add([x0, y0 + 0.24, z0], [x1, y1 + 1.1, z1]);
        add([x0, y0 + 1.1, z0], [x1, y1 + 0.24, z1]);
        add([x0, y0 + 1.32, z0], [x1, y1 + 2.18, z1]);
        add([x0, y0 + 2.18, z0], [x1, y1 + 1.32, z1]);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    return geom;
  }, [resampledPath]);

  return (
    <group name={name}>
      <mesh geometry={fenceGeom}>
        <meshStandardMaterial
          color="#68716e"
          metalness={0.45}
          roughness={0.72}
          side={THREE.DoubleSide}
          transparent
          depthWrite={false}
          opacity={0.09}
        />
      </mesh>
      <lineSegments geometry={fenceWireGeom}>
        <lineBasicMaterial color="#5d6866" transparent opacity={0.62} depthWrite={false} />
      </lineSegments>
      <instancedMesh
        args={[undefined, undefined, postPositions.length]}
        castShadow
        ref={(inst) => {
          if (!inst) return;
          const m = new THREE.Matrix4();
          postPositions.forEach(([x, y, z], i) => {
            m.makeTranslation(x, y + 1.2, z);
            inst.setMatrixAt(i, m);
          });
          inst.instanceMatrix.needsUpdate = true;
        }}
      >
        <cylinderGeometry args={[0.08, 0.08, 2.4, 6]} />
        <meshStandardMaterial color="#8a8880" metalness={0.65} roughness={0.45} />
      </instancedMesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Drainage channels — terrain-conforming ditches.
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
        const terY = terrainHeightAt(x, z);

        verts.push(x + nrm.x * w, terY + 0.05, z + nrm.y * w);
        verts.push(x + nrm.x * w * 0.4, terY + depth, z + nrm.y * w * 0.4);
        verts.push(x - nrm.x * w * 0.4, terY + depth, z - nrm.y * w * 0.4);
        verts.push(x - nrm.x * w, terY + 0.05, z - nrm.y * w);
      }

      for (let i = 0; i < pts.length - 1; i++) {
        const b = i * 4;
        const nb = (i + 1) * 4;
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

// ---------------------------------------------------------------------------
// Standing water in channels — reflective terrain-following ribbon.
// ---------------------------------------------------------------------------
export function SiteFeatures() {
  return (
    <group name="site-features">
      <ParkingLots />
      <Fence />
      <Fence path={topEnclosurePath} name="top-enclosure-fence" />
      <DrainageChannels />
    </group>
  );
}
