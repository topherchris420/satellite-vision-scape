import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { parkingLots, channels } from "@/lib/site-layout";
import { ReferenceLandscape } from "./ReferenceLandscape";
import { terrainHeightAt, sampleFootprintGrade } from "@/lib/terrain";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";
import { FENCES, getFenceLayout, type Point2 } from "@/lib/site-fences";

// Approximate parking, boundary and drainage context; these are deliberately
// kept separate from the historical antenna manifest.
function ParkingLots() {
  const tex = getSiteTextures();
  const asphaltMap = useMemo(() => setRepeat(tex.asphaltColor, 3, 3), [tex]);
  const concreteMap = useMemo(() => setRepeat(tex.concreteColor, 2, 2), [tex]);

  const lots = useMemo(
    () => parkingLots.map((p) => ({ p, grade: sampleFootprintGrade(p.pos, p.size, p.rotY ?? 0) })),
    [],
  );

  // Every stall line of every lot is one instance of a single quad, so the
  // markings cost one draw call instead of one per painted line.
  const stallLines = useMemo(() => {
    const matrices: THREE.Matrix4[] = [];
    const lot = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const flat = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    const scale = new THREE.Matrix4();
    for (const { p, grade } of lots) {
      const rows = p.rows ?? 3;
      const stalls = Math.floor(p.size[0] / 2.6);
      const length = (p.size[1] / rows) * 0.8;
      lot.makeRotationY(p.rotY ?? 0).setPosition(p.pos[0], grade.elevation, p.pos[1]);
      for (let r = 0; r <= rows; r++) {
        for (let s = 0; s <= stalls; s++) {
          local.makeTranslation(
            -p.size[0] / 2 + (s / stalls) * p.size[0],
            0.08,
            -p.size[1] / 2 + (r / rows) * p.size[1],
          );
          scale.makeScale(0.12, length, 1);
          matrices.push(
            new THREE.Matrix4().multiplyMatrices(lot, local).multiply(flat).multiply(scale),
          );
        }
      }
    }
    return matrices;
  }, [lots]);

  return (
    <group name="parking-lots">
      {lots.map(({ p, grade }, i) => {
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
              <meshStandardMaterial map={asphaltMap} color="#d2ccc0" roughness={0.95} />
            </mesh>
          </group>
        );
      })}
      <instancedMesh
        args={[undefined, undefined, stallLines.length]}
        ref={(inst) => {
          if (!inst) return;
          stallLines.forEach((m, i) => inst.setMatrixAt(i, m));
          inst.instanceMatrix.needsUpdate = true;
          inst.computeBoundingSphere();
        }}
        receiveShadow
      >
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial color="#d8d4c6" roughness={0.9} />
      </instancedMesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Fences — terrain-conforming chain-link runs between road openings.
// ---------------------------------------------------------------------------
const FENCE_HEIGHT = 2.4;
const FENCE_SAMPLE_SPACING = 3;
const FENCE_POST_SPACING = 6;

/** Resample an open polyline at roughly `spacing`, draped on the terrain. */
function drapeRun(points: Point2[], spacing: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const count = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing));
    for (let k = 0; k < count; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / count;
      const z = a[1] + ((b[1] - a[1]) * k) / count;
      out.push([x, terrainHeightAt(x, z), z]);
    }
  }
  const last = points[points.length - 1];
  out.push([last[0], terrainHeightAt(last[0], last[1]), last[1]]);
  return out;
}

function Fence({ runs, name }: { runs: Point2[][]; name: string }) {
  const draped = useMemo(() => runs.map((r) => drapeRun(r, FENCE_SAMPLE_SPACING)), [runs]);

  const { curtain, wires, posts, terminals } = useMemo(() => {
    const curtainVerts: number[] = [];
    const curtainUvs: number[] = [];
    const curtainIdx: number[] = [];
    const wireVerts: number[] = [];
    const postPositions: [number, number, number][] = [];
    const terminalPositions: [number, number, number][] = [];
    const add = (a: [number, number, number], b: [number, number, number]) => {
      wireVerts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    };

    for (const run of draped) {
      // Faint curtain that catches the sun between strands.
      const base = curtainVerts.length / 3;
      let distance = 0;
      run.forEach(([x, y, z], i) => {
        if (i > 0) distance += Math.hypot(x - run[i - 1][0], z - run[i - 1][2]);
        curtainVerts.push(x, y, z, x, y + FENCE_HEIGHT, z);
        curtainUvs.push(distance / 3, 0, distance / 3, 1);
        if (i < run.length - 1) {
          const a = base + i * 2;
          curtainIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      });

      // A real wire lattice keeps the boundary legible in silhouette: rails and
      // chain-link diamonds give the characteristic read from the air.
      for (let i = 0; i < run.length - 1; i++) {
        const a = run[i];
        const b = run[i + 1];
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

      // Line posts at a regular spacing, heavier terminal posts at run ends.
      for (const p of drapeRun(
        run.map(([x, , z]): Point2 => [x, z]),
        FENCE_POST_SPACING,
      ).slice(1, -1)) {
        postPositions.push(p);
      }
      terminalPositions.push(run[0], run[run.length - 1]);
    }

    const curtainGeom = new THREE.BufferGeometry();
    curtainGeom.setAttribute("position", new THREE.Float32BufferAttribute(curtainVerts, 3));
    curtainGeom.setAttribute("uv", new THREE.Float32BufferAttribute(curtainUvs, 2));
    curtainGeom.setIndex(curtainIdx);
    curtainGeom.computeVertexNormals();
    const wireGeom = new THREE.BufferGeometry();
    wireGeom.setAttribute("position", new THREE.Float32BufferAttribute(wireVerts, 3));
    return {
      curtain: curtainGeom,
      wires: wireGeom,
      posts: postPositions,
      terminals: terminalPositions,
    };
  }, [draped]);

  useEffect(
    () => () => {
      curtain.dispose();
      wires.dispose();
    },
    [curtain, wires],
  );

  const placePosts =
    (positions: [number, number, number][], lift: number) => (inst: THREE.InstancedMesh | null) => {
      if (!inst) return;
      const m = new THREE.Matrix4();
      positions.forEach(([x, y, z], i) => {
        m.makeTranslation(x, y + lift, z);
        inst.setMatrixAt(i, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
    };

  return (
    <group name={name}>
      <mesh geometry={curtain}>
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
      <lineSegments geometry={wires}>
        <lineBasicMaterial color="#5d6866" transparent opacity={0.62} depthWrite={false} />
      </lineSegments>
      <instancedMesh
        args={[undefined, undefined, posts.length]}
        castShadow
        ref={placePosts(posts, FENCE_HEIGHT / 2)}
      >
        <cylinderGeometry args={[0.08, 0.08, FENCE_HEIGHT, 6]} />
        <meshStandardMaterial color="#8a8880" metalness={0.65} roughness={0.45} />
      </instancedMesh>
      <instancedMesh
        args={[undefined, undefined, terminals.length]}
        castShadow
        ref={placePosts(terminals, (FENCE_HEIGHT + 0.2) / 2)}
      >
        <cylinderGeometry args={[0.11, 0.12, FENCE_HEIGHT + 0.2, 8]} />
        <meshStandardMaterial color="#7d7b73" metalness={0.65} roughness={0.45} />
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

export function SiteFeatures() {
  const fenceRuns = useMemo(() => {
    const { runs } = getFenceLayout();
    return FENCES.map((fence) => ({
      id: fence.id,
      runs: runs.filter((r) => r.fenceId === fence.id).map((r) => r.points),
    }));
  }, []);

  return (
    <group name="site-features">
      <ParkingLots />
      {fenceRuns.map((f) => (
        <Fence key={f.id} name={f.id} runs={f.runs} />
      ))}
      <ReferenceLandscape />
      <DrainageChannels />
    </group>
  );
}
