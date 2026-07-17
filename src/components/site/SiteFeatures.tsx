import { useMemo } from "react";
import * as THREE from "three";
import {
  pipeRacks,
  parkingLots,
  channels,
  fencePath,
  topEnclosurePath,
  interiorRoads,
} from "@/lib/site-layout";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function fillInstances(
  inst: THREE.InstancedMesh | null,
  matrices: THREE.Matrix4[],
  colors?: THREE.Color[],
) {
  if (!inst) return;
  matrices.forEach((m, i) => inst.setMatrixAt(i, m));
  inst.instanceMatrix.needsUpdate = true;
  if (colors) {
    colors.forEach((c, i) => inst.setColorAt(i, c));
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  }
}

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
          <group
            key={`rack-${i}`}
            name={`pipe-rack-${i}`}
            position={[mid.x, 0, mid.z]}
            rotation={[0, angle, 0]}
          >
            {/* pipes run along local Z */}
            {Array.from({ length: lines }).map((_, j) => {
              const off = (j - (lines - 1) / 2) * 0.6;
              return (
                <mesh
                  key={`p-${j}`}
                  position={[off, h, 0]}
                  rotation={[Math.PI / 2, 0, 0]}
                  castShadow
                >
                  <cylinderGeometry args={[0.18, 0.18, len, 12]} />
                  <meshStandardMaterial
                    color={j % 2 ? "#b7b1a4" : "#9aa0a6"}
                    metalness={0.6}
                    roughness={0.45}
                  />
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
          <group
            key={`lot-${i}`}
            name={`parking-${i}`}
            position={[p.pos[0], 0, p.pos[1]]}
            rotation={[0, p.rotY ?? 0, 0]}
          >
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
              )),
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
function Fence({
  path = fencePath,
  name = "perimeter-fence",
}: {
  path?: [number, number][];
  name?: string;
}) {
  const postPositions = useMemo(() => {
    const pts: [number, number][] = [];
    const n = path.length;
    for (let i = 0; i < n; i++) {
      const a = path[i];
      const b = path[(i + 1) % n];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const count = Math.max(1, Math.round(seg / 8));
      for (let k = 0; k < count; k++) {
        const t = k / count;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return pts;
  }, [path]);

  const fenceGeom = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const verts: number[] = [];
    const idx: number[] = [];
    const n = path.length;
    const y0 = 0;
    const y1 = 2.2;
    for (let i = 0; i < n; i++) {
      const [x, z] = path[i];
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
  }, [path]);

  return (
    <group name={name}>
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
          <meshStandardMaterial
            map={concreteMap}
            color="#a9a396"
            roughness={1}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Standing water in the drainage channels — a narrow reflective ribbon laid
// just above the channel floor. Env-map reflections sell it cheaply.
// ---------------------------------------------------------------------------
function ChannelWater() {
  const geoms = useMemo(() => {
    return channels.map((c) => {
      const geom = new THREE.BufferGeometry();
      const verts: number[] = [];
      const idx: number[] = [];
      const pts = c.path;
      const y = -0.62;
      for (let i = 0; i < pts.length; i++) {
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        const t = new THREE.Vector2(next[0] - prev[0], next[1] - prev[1]).normalize();
        const nrm = new THREE.Vector2(-t.y, t.x);
        const w = c.width * 0.34;
        const [x, z] = pts[i];
        verts.push(x + nrm.x * w, y, z + nrm.y * w);
        verts.push(x - nrm.x * w, y, z - nrm.y * w);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      geom.setIndex(idx);
      geom.computeVertexNormals();
      return geom;
    });
  }, []);

  return (
    <group name="channel-water">
      {geoms.map((g, i) => (
        <mesh key={`water-${i}`} geometry={g}>
          <meshPhysicalMaterial
            color="#2e3d42"
            metalness={0.1}
            roughness={0.08}
            clearcoat={1}
            clearcoatRoughness={0.1}
            envMapIntensity={1.4}
            transparent
            opacity={0.92}
          />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Utility poles with sagging catenary conductors along the interior spine
// road. Poles + crossarms are instanced; all wire spans share one
// LineSegments geometry.
// ---------------------------------------------------------------------------
const POLE_H = 7.2;
function UtilityLines() {
  const { poleMatrices, armMatrices, wireGeom } = useMemo(() => {
    const spine = interiorRoads[0];
    // resample the polyline into pole positions every ~26 m, offset 4.5 m
    // north of the carriageway
    const poles: { x: number; z: number; dir: THREE.Vector2 }[] = [];
    for (let i = 0; i < spine.length - 1; i++) {
      const [ax, az] = spine[i];
      const [bx, bz] = spine[i + 1];
      const seg = Math.hypot(bx - ax, bz - az);
      const dir = new THREE.Vector2((bx - ax) / seg, (bz - az) / seg);
      const nrm = new THREE.Vector2(-dir.y, dir.x);
      const count = Math.max(1, Math.round(seg / 26));
      for (let k = 0; k < count; k++) {
        const t = k / count;
        poles.push({
          x: ax + (bx - ax) * t - nrm.x * 4.5,
          z: az + (bz - az) * t - nrm.y * 4.5,
          dir,
        });
      }
    }

    const poleMatrices = poles.map((p) => {
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(p.x, POLE_H / 2, p.z),
        new THREE.Quaternion(),
        new THREE.Vector3(1, 1, 1),
      );
      return m;
    });
    const armMatrices = poles.map((p) => {
      const m = new THREE.Matrix4();
      const angle = Math.atan2(p.dir.x, p.dir.y);
      m.compose(
        new THREE.Vector3(p.x, POLE_H - 0.5, p.z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle + Math.PI / 2),
        new THREE.Vector3(1, 1, 1),
      );
      return m;
    });

    // wire spans: two conductors per span, 8 segments each, catenary sag
    const verts: number[] = [];
    for (let i = 0; i < poles.length - 1; i++) {
      const a = poles[i];
      const b = poles[i + 1];
      const span = Math.hypot(b.x - a.x, b.z - a.z);
      if (span > 40) continue; // don't string wires across the resample seams
      const nrm = new THREE.Vector2(-a.dir.y, a.dir.x);
      for (const off of [-0.9, 0.9]) {
        let px = 0,
          py = 0,
          pz = 0;
        for (let k = 0; k <= 8; k++) {
          const t = k / 8;
          const x = a.x + (b.x - a.x) * t + nrm.x * off;
          const z = a.z + (b.z - a.z) * t + nrm.y * off;
          const y = POLE_H - 0.55 - Math.min(1.2, span * 0.022) * 4 * t * (1 - t);
          if (k > 0) verts.push(px, py, pz, x, y, z);
          px = x;
          py = y;
          pz = z;
        }
      }
    }
    const wireGeom = new THREE.BufferGeometry();
    wireGeom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    return { poleMatrices, armMatrices, wireGeom };
  }, []);

  return (
    <group name="utility-lines">
      <instancedMesh
        args={[undefined, undefined, poleMatrices.length]}
        castShadow
        ref={(inst) => fillInstances(inst, poleMatrices)}
      >
        <cylinderGeometry args={[0.11, 0.16, POLE_H, 6]} />
        <meshStandardMaterial color="#4f4436" roughness={0.95} />
      </instancedMesh>
      <instancedMesh
        args={[undefined, undefined, armMatrices.length]}
        castShadow
        ref={(inst) => fillInstances(inst, armMatrices)}
      >
        <boxGeometry args={[2.4, 0.14, 0.14]} />
        <meshStandardMaterial color="#5a4e3e" roughness={0.9} />
      </instancedMesh>
      <lineSegments geometry={wireGeom}>
        <lineBasicMaterial color="#1c1c1e" transparent opacity={0.75} />
      </lineSegments>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Container laydown yard — colour-tinted corrugated boxes on a gravel pad,
// some double-stacked, west of the barracks connector road.
// ---------------------------------------------------------------------------
function ContainerYard() {
  const tex = getSiteTextures();
  const gravelMap = useMemo(() => setRepeat(tex.gravelColor, 3, 4), [tex]);

  const { mats, cols } = useMemo(() => {
    const r = rng(60601);
    const palette = ["#8a3a2c", "#2c5a7a", "#3a6b46", "#b8b0a0", "#7a5c34", "#5a5e66"];
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    const place = (x: number, z: number, y: number, rot: number) => {
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot),
        new THREE.Vector3(1, 1, 1),
      );
      mats.push(m);
      cols.push(new THREE.Color(palette[Math.floor(r() * palette.length)]));
    };
    // three rows of containers aligned with the yard, slight jitter
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 5; col++) {
        if (r() < 0.18) continue; // leave gaps
        const x = -87 + col * 3.1 + (r() - 0.5) * 0.4;
        const z = 38 + row * 7.5 + (r() - 0.5) * 0.8;
        const rot = Math.PI / 2 + (r() - 0.5) * 0.06;
        place(x, z, 1.3, rot);
        if (r() < 0.4) place(x, z, 3.9, rot + (r() - 0.5) * 0.03); // stacked
      }
    }
    return { mats, cols };
  }, []);

  return (
    <group name="container-yard">
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-80, 0.055, 46]} receiveShadow>
        <planeGeometry args={[24, 30]} />
        <meshStandardMaterial map={gravelMap} color="#9c8e7a" roughness={1} />
      </mesh>
      <instancedMesh
        args={[undefined, undefined, mats.length]}
        castShadow
        receiveShadow
        ref={(inst) => fillInstances(inst, mats, cols)}
      >
        <boxGeometry args={[6.1, 2.6, 2.45]} />
        <meshStandardMaterial
          map={tex.containerColor}
          color="#ffffff"
          metalness={0.35}
          roughness={0.6}
        />
      </instancedMesh>
    </group>
  );
}

export function SiteFeatures() {
  return (
    <group name="site-features">
      <PipeRacks />
      <ParkingLots />
      <Fence />
      <Fence path={topEnclosurePath} name="top-enclosure-fence" />
      <DrainageChannels />
      <ChannelWater />
      <UtilityLines />
      <ContainerYard />
    </group>
  );
}
