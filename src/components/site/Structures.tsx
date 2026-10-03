import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Detailed } from "@react-three/drei";
import {
  domes,
  dishes,
  tanks,
  buildings,
  spheres,
  RADOME,
  RADOME_SHELL_SIN,
  RADOME_SHELL_LIFT,
  type BuildingKind,
} from "@/lib/site-layout";
import { sampleFootprintGrade } from "@/lib/terrain";
import { createGroundApron } from "@/lib/site-geometry";
import { createBuildingWalls, createGeodesicShell } from "./structures/geometry";
import {
  darkSteelMat,
  doorMat,
  galvanisedMat,
  lampLensMat,
  makeConcrete,
  makeGravel,
  makeRoof,
  makeWall,
  radomeShellMat,
  rollerDoorMat,
  withGround,
} from "./structures/materials";
import { setFixtureTime } from "./structures/environment";
import {
  RADOME_FLOODLIGHT_ANGLES,
  RADOME_FLOODLIGHT_OFFSET,
  radomeHost,
  radomeVestibuleYaw,
} from "@/game/world/buildSiteWorld";
import { RadomeAntenna } from "./RadomeAntenna";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";
import {
  type Selection,
  sphereSelection,
  domeSelection,
  dishSelection,
  tankSelection,
  buildingSelection,
} from "@/lib/selection";
import type { TimeOfDay } from "./Lighting";

const GLAZED: Set<BuildingKind> = new Set(["office", "barracks"]);

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Gable roof geometry
const gableCache = new Map<string, THREE.BufferGeometry>();
function gableGeometry(w: number, d: number, rise: number) {
  const key = `${w}_${d}_${rise}`;
  const hit = gableCache.get(key);
  if (hit) return hit;
  const hw = w / 2;
  const hd = d / 2;
  const v = [
    [-hw, 0, hd],
    [hw, 0, hd],
    [0, rise, hd],
    [-hw, 0, -hd],
    [hw, 0, -hd],
    [0, rise, -hd],
  ];
  const tris = [
    [0, 1, 2],
    [5, 4, 3],
    [0, 2, 5],
    [0, 5, 3],
    [2, 1, 4],
    [2, 4, 5],
  ];
  const pos: number[] = [], uvs: number[] = [];
  // Separate roof and gable UV projections, in metres, avoiding stretched
  // or missing material detail on the custom roof geometry.
  for (const [face, t] of tris.entries()) for (const i of t) {
    const [x, y, z] = v[i];
    pos.push(x, y, z);
    uvs.push(face < 2 ? x / 4 : z / 4, face < 2 ? y / 4 : (y / rise) * Math.hypot(hw, rise) / 4);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.computeVertexNormals();
  gableCache.set(key, geom);
  return geom;
}

const wallCache = new Map<string, THREE.BufferGeometry>();
function wallGeometry(w: number, h: number, d: number) {
  const key = `${w}_${h}_${d}`;
  const hit = wallCache.get(key);
  if (hit) return hit;
  const { door, roller } = doorLayout(w, d);
  const geom = createBuildingWalls(w, h, d, door, roller);
  wallCache.set(key, geom);
  return geom;
}

// Truncated geodesic shell for radomes with detail level parameter for LOD
const radomeShellCache = new Map<string, THREE.BufferGeometry>();
function radomeShellGeometry(R: number, sub: number) {
  const key = `${R.toFixed(2)}_${sub}`;
  const hit = radomeShellCache.get(key);
  if (hit) return hit;
  // ~3.5 m panels on a 20 m shell, like the real bolted FRP geodesic panels
  const geom = createGeodesicShell(R, RADOME_SHELL_LIFT, R > 12 ? 5 : 3, sub);
  radomeShellCache.set(key, geom);
  return geom;
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);
/** Vestibule unit box: dust measured over its 2.1 m height. */
const vestibuleBox = withGround(new THREE.BoxGeometry(1, 1, 1), -0.5, 2.1);

/** Shared weathered-concrete materials (one compiled program each). */
const plinthConcrete = makeConcrete("#c9c2b4");
const footingConcrete = makeConcrete("#bdb6a8");
const parapetConcrete = makeConcrete("#ffffff", { ground: false });

/** Concrete cylinder whose aGround is measured from local y = groundY. */
const groundedCylCache = new Map<string, THREE.BufferGeometry>();
function groundedCylinder(rt: number, rb: number, h: number, seg: number, groundY: number) {
  const key = [rt, rb, h, seg, groundY].map((v) => v.toFixed(3)).join("_");
  let g = groundedCylCache.get(key);
  if (!g) {
    g = withGround(new THREE.CylinderGeometry(rt, rb, h, seg, 1, false), groundY);
    groundedCylCache.set(key, g);
  }
  return g;
}
const groundedBoxCache = new Map<string, THREE.BufferGeometry>();
function groundedBox(w: number, h: number, d: number, groundY: number) {
  const key = [w, h, d, groundY].map((v) => v.toFixed(3)).join("_");
  let g = groundedBoxCache.get(key);
  if (!g) {
    g = withGround(new THREE.BoxGeometry(w, h, d), groundY);
    groundedBoxCache.set(key, g);
  }
  return g;
}

/** Door and roller-door placement shared by the wall shader and the leaves. */
function doorLayout(w: number, d: number) {
  const big = w * d > 700;
  return w >= d
    ? { door: { wall: 0, along: w * 0.68 }, roller: big ? { wall: 3, along: d / 2 } : null }
    : { door: { wall: 1, along: d * 0.32 }, roller: big ? { wall: 2, along: w / 2 } : null };
}

const wallMatCache = new Map<string, THREE.Material>();
function wallMaterial(color: string, glazed: boolean) {
  const key = `${color}_${glazed}`;
  let m = wallMatCache.get(key);
  if (!m) wallMatCache.set(key, (m = makeWall(color, glazed)));
  return m;
}
const roofMatCache = new Map<string, THREE.Material>();
function roofMaterial(color: string, ribbed: boolean) {
  const key = `${color}_${ribbed}`;
  let m = roofMatCache.get(key);
  if (!m) roofMatCache.set(key, (m = makeRoof(color, ribbed)));
  return m;
}

// Rooftop equipment (HVAC + Vents) accurately placed on level building roofs
function useRooftopEquipment() {
  return useMemo(() => {
    const r = rng(31007);
    const acs: THREE.Matrix4[] = [];
    const vents: THREE.Matrix4[] = [];
    const fans: THREE.Matrix4[] = [];
    const curbs: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const axisY = new THREE.Vector3(0, 1, 0);
    for (const b of buildings) {
      if (b.roof === "gable" || b.rooftopEquipment === false) continue;
      const grade = sampleFootprintGrade(b.pos, b.size, b.rotY ?? 0);
      const [w, d] = b.size;
      const rot = b.rotY ?? 0;
      const area = w * d;
      const nAc = Math.min(6, Math.max(1, Math.round(area / 140)));
      const nVent = Math.min(8, Math.max(1, Math.round(area / 90)));
      const place = (out: THREE.Matrix4[], sx: number, sy: number, sz: number) => {
        const lx = (r() - 0.5) * (w - 4);
        const lz = (r() - 0.5) * (d - 4);
        const wx = b.pos[0] + lx * Math.cos(rot) + lz * Math.sin(rot);
        const wz = b.pos[1] - lx * Math.sin(rot) + lz * Math.cos(rot);
        const m = new THREE.Matrix4();
        q.setFromAxisAngle(axisY, rot + (r() < 0.5 ? 0 : Math.PI / 2));
        m.compose(
          new THREE.Vector3(wx, grade.elevation + b.height + sy / 2 + 0.05, wz),
          q,
          new THREE.Vector3(sx, sy, sz)
        );
        out.push(m);
        if (out === acs) {
          // fan shroud on top and a raised curb underneath each condenser
          fans.push(new THREE.Matrix4().compose(
            new THREE.Vector3(wx, grade.elevation + b.height + sy + 0.09, wz), q,
            new THREE.Vector3(Math.min(sx, sz) * 0.36, 0.08, Math.min(sx, sz) * 0.36)));
          curbs.push(new THREE.Matrix4().compose(
            new THREE.Vector3(wx, grade.elevation + b.height + 0.06, wz), q,
            new THREE.Vector3(sx + 0.3, 0.12, sz + 0.3)));
        }
      };
      for (let i = 0; i < nAc; i++) place(acs, 1.4 + r() * 1.2, 0.8 + r() * 0.5, 1.1 + r() * 0.8);
      for (let i = 0; i < nVent; i++) place(vents, 0.5 + r() * 0.3, 0.9 + r() * 0.8, 0.5 + r() * 0.3);
    }
    return { acs, vents, fans, curbs };
  }, []);
}

function fillInstances(inst: THREE.InstancedMesh | null, matrices: THREE.Matrix4[], colors?: THREE.Color[]) {
  if (!inst) return;
  matrices.forEach((m, i) => {
    inst.setMatrixAt(i, m);
    if (colors) inst.setColorAt(i, colors[i]);
  });
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.computeBoundingSphere();
}

/** Composes parent · local transforms without per-call allocation. */
class MatrixStack {
  private readonly scratch = new THREE.Matrix4();
  private readonly euler = new THREE.Euler();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  local(
    position: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0],
    scale: [number, number, number] = [1, 1, 1],
  ): THREE.Matrix4 {
    this.euler.set(...rotation);
    return this.scratch.compose(this.pos.set(...position), this.quat.setFromEuler(this.euler), this.scl.set(...scale));
  }
}

/**
 * Repeated radome details — vents, vestibules, floodlights — and building
 * parapets as instance lists. Each list renders as one InstancedMesh instead
 * of one mesh per part (several hundred draw calls saved).
 */
function useRepeatedDetails(
  domeElevations: number[],
  buildingGrades: { elevation: number }[],
) {
  return useMemo(() => {
    const stack = new MatrixStack();
    const vents: THREE.Matrix4[] = [];
    const vestibules: THREE.Matrix4[] = [];
    const vestibuleDoors: THREE.Matrix4[] = [];
    const poles: THREE.Matrix4[] = [];
    const heads: THREE.Matrix4[] = [];
    const beacons: THREE.Matrix4[] = [];
    const plinthDoors: THREE.Matrix4[] = [];
    domes.forEach((d, i) => {
      const baseR = d.radius * RADOME_SHELL_SIN;
      const wall = RADOME.plinthHeight;
      const dome = new THREE.Matrix4().makeTranslation(d.pos[0], domeElevations[i], d.pos[1]);
      for (const a of [0.9, 2.6, 4.4]) {
        vents.push(
          dome.clone().multiply(
            stack.local([Math.cos(a) * (baseR + 0.4), wall * 0.55, Math.sin(a) * (baseR + 0.4)], [0, -a, 0], [0.3, 0.5, 0.9]),
          ),
        );
      }
      const vestibule = dome.clone().multiply(stack.local([0, 0, 0], [0, radomeVestibuleYaw(i), 0]));
      vestibules.push(vestibule.clone().multiply(stack.local([baseR + 0.7, 1.05, 0], [0, 0, 0], [1.6, 2.1, 1.5])));
      vestibuleDoors.push(vestibule.clone().multiply(stack.local([baseR + 1.53, 0.9, 0], [0, 0, 0], [0.06, 1.6, 0.9])));
      // service hatch in the plinth ring, opposite the vestibule
      if (!d.roofMounted && wall > 1.2) {
        plinthDoors.push(vestibule.clone().multiply(stack.local([-(baseR + 0.33), Math.min(wall, 2.1) / 2, 0], [0, 0, 0], [0.08, Math.min(wall - 0.15, 2.0), 0.95])));
      }
      for (const a of RADOME_FLOODLIGHT_ANGLES) {
        const fr = baseR + RADOME_FLOODLIGHT_OFFSET;
        const mast = dome.clone().multiply(stack.local([Math.cos(a) * fr, 0, Math.sin(a) * fr], [0, -a, 0]));
        poles.push(mast.clone().multiply(stack.local([0, 1.5, 0])));
        heads.push(mast.clone().multiply(stack.local([-0.28, 2.9, 0], [0, 0, 0.7])));
      }
      // Red obstruction light on the crown of the tallest free-standing shells.
      if (!d.roofMounted && d.radius >= 15) {
        const crown = wall + d.radius * RADOME_SHELL_LIFT + d.radius;
        beacons.push(dome.clone().multiply(stack.local([0, crown + 0.12, 0])));
      }
    });

    const parapets: THREE.Matrix4[] = [];
    const parapetColors: THREE.Color[] = [];
    // Street-level detail: a personnel door and wall lamp on each building's
    // long side, and a roller door on the short side of the large halls.
    // Generic exterior furniture; placement follows each traced footprint.
    const doors: THREE.Matrix4[] = [];
    const lamps: THREE.Matrix4[] = [];
    const rollerDoors: THREE.Matrix4[] = [];
    const downpipes: THREE.Matrix4[] = [];
    const gutters: THREE.Matrix4[] = [];
    const copings: THREE.Matrix4[] = [];
    const frames: THREE.Matrix4[] = [];
    buildings.forEach((b, i) => {
      const frame = new THREE.Matrix4()
        .makeRotationY(b.rotY ?? 0)
        .setPosition(b.pos[0], buildingGrades[i].elevation, b.pos[1]);
      const [w, d] = b.size;
      const doorHeight = Math.min(2.1, b.height - 0.35);
      const lampY = Math.min(doorHeight + 0.35, b.height - 0.15);
      if (w >= d) {
        doors.push(frame.clone().multiply(stack.local([w * 0.18, doorHeight / 2, d / 2 + 0.04], [0, 0, 0], [1, doorHeight, 0.08])));
        lamps.push(frame.clone().multiply(stack.local([w * 0.18, lampY, d / 2 + 0.1], [0, 0, 0], [0.3, 0.12, 0.18])));
      } else {
        doors.push(frame.clone().multiply(stack.local([w / 2 + 0.04, doorHeight / 2, d * 0.18], [0, 0, 0], [0.08, doorHeight, 1])));
        lamps.push(frame.clone().multiply(stack.local([w / 2 + 0.1, lampY, d * 0.18], [0, 0, 0], [0.18, 0.12, 0.3])));
      }
      // door frame and canopy hood above the personnel door
      if (w >= d) {
        frames.push(frame.clone().multiply(stack.local([w * 0.18, doorHeight + 0.08, d / 2 + 0.06], [0, 0, 0], [1.3, 0.12, 0.12])));
        frames.push(frame.clone().multiply(stack.local([w * 0.18, doorHeight + 0.55, d / 2 + 0.45], [0, 0, 0], [1.6, 0.06, 0.9])));
      } else {
        frames.push(frame.clone().multiply(stack.local([w / 2 + 0.06, doorHeight + 0.08, d * 0.18], [0, 0, 0], [0.12, 0.12, 1.3])));
        frames.push(frame.clone().multiply(stack.local([w / 2 + 0.45, doorHeight + 0.55, d * 0.18], [0, 0, 0], [0.9, 0.06, 1.6])));
      }
      if (w * d > 700) {
        const rollerHeight = Math.min(3.8, b.height - 0.6);
        rollerDoors.push(
          w >= d
            ? frame.clone().multiply(stack.local([-w / 2 - 0.05, rollerHeight / 2, 0], [0, 0, 0], [0.1, rollerHeight, 4.2]))
            : frame.clone().multiply(stack.local([0, rollerHeight / 2, -d / 2 - 0.05], [0, 0, 0], [4.2, rollerHeight, 0.1])),
        );
        // roller-door headbox and guide rails
        if (w >= d) {
          frames.push(frame.clone().multiply(stack.local([-w / 2 - 0.2, rollerHeight + 0.25, 0], [0, 0, 0], [0.4, 0.5, 4.6])));
          for (const s of [-1, 1]) frames.push(frame.clone().multiply(stack.local([-w / 2 - 0.1, rollerHeight / 2, s * 2.2], [0, 0, 0], [0.16, rollerHeight, 0.14])));
        } else {
          frames.push(frame.clone().multiply(stack.local([0, rollerHeight + 0.25, -d / 2 - 0.2], [0, 0, 0], [4.6, 0.5, 0.4])));
          for (const s of [-1, 1]) frames.push(frame.clone().multiply(stack.local([s * 2.2, rollerHeight / 2, -d / 2 - 0.1], [0, 0, 0], [0.14, rollerHeight, 0.16])));
        }
      }
      // downpipes at the four corners
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        downpipes.push(frame.clone().multiply(stack.local([sx * (w / 2 + 0.09), b.height / 2, sz * (d / 2 - 0.35)], [0, 0, 0], [0.11, b.height, 0.11])));
      }
      if (b.roof === "gable") {
        for (const s of [-1, 1]) gutters.push(frame.clone().multiply(stack.local([s * (w / 2 + 0.1), b.height - 0.06, 0], [0, 0, 0], [0.18, 0.16, d + 0.1])));
      }
      if (b.roof === "gable") return;
      const color = new THREE.Color(b.color ?? "#cfc9bd");
      for (const [px, pz, sx, sz] of [
        // outer faces sit 2 cm proud of the wall so there is no ledge seam
        [0, -b.size[1] / 2 + 0.13, b.size[0] + 0.04, 0.3],
        [0, b.size[1] / 2 - 0.13, b.size[0] + 0.04, 0.3],
        [-b.size[0] / 2 + 0.13, 0, 0.3, b.size[1] - 0.52],
        [b.size[0] / 2 - 0.13, 0, 0.3, b.size[1] - 0.52],
      ]) {
        parapets.push(frame.clone().multiply(stack.local([px, b.height + 0.25, pz], [0, 0, 0], [sx, 0.5, sz])));
        parapetColors.push(color);
        copings.push(frame.clone().multiply(stack.local([px, b.height + 0.52, pz], [0, 0, 0], [sx + 0.08, 0.05, sz + 0.08])));
      }
    });
    return {
      vents,
      vestibules,
      vestibuleDoors,
      poles,
      heads,
      beacons,
      parapets,
      parapetColors,
      doors,
      lamps,
      rollerDoors,
      plinthDoors,
      downpipes,
      gutters,
      copings,
      frames,
    };
  }, [domeElevations, buildingGrades]);
}

/** Aviation-style obstruction beacons: slow red blink, brighter after dark. */
function ObstructionBeacons({ matrices, night }: { matrices: THREE.Matrix4[]; night: boolean }) {
  const material = useMemo(() => new THREE.MeshBasicMaterial({ color: "#ff2a1a", toneMapped: false }), []);
  const phase = useRef(0);
  useFrame((_, delta) => {
    phase.current = (phase.current + delta) % 2;
    const on = phase.current < 1;
    const level = on ? (night ? 4.5 : 1.6) : night ? 0.25 : 0.35;
    material.color.setRGB(level, level * 0.1, level * 0.06);
  });
  useEffect(() => () => material.dispose(), [material]);
  return (
    <instancedMesh
      args={[undefined, material, matrices.length]}
      ref={(inst) => fillInstances(inst, matrices)}
    >
      <sphereGeometry args={[0.22, 10, 8]} />
    </instancedMesh>
  );
}

function GroundApron({ center, radius, elevation }: {
  center: [number, number]; radius: number; elevation: number;
}) {
  const geometry = useMemo(() => createGroundApron(center, radius, elevation), [center, radius, elevation]);
  const material = useMemo(() => makeGravel(1, radius), [radius]);
  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);
  return <mesh geometry={geometry} material={material} receiveShadow />;
}

export function Structures({
  onSelect,
  time = "day",
}: {
  onSelect?: (s: Selection) => void;
  time?: TimeOfDay;
}) {
  const tex = getSiteTextures();
  const night = time === "night";
  useEffect(() => setFixtureTime(time), [time]);

  const pick = (e: ThreeEvent<MouseEvent>, s: Selection) => {
    e.stopPropagation();
    onSelect?.(s);
  };
  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    document.body.style.cursor = "auto";
  };

  const steelMap = useMemo(() => setRepeat(tex.steelColor, 3, 2), [tex]);
  const steelNormal = useMemo(() => setRepeat(tex.steelNormal, 3, 2), [tex]);
  const tankMap = useMemo(() => setRepeat(tex.tankColor, 2, 1), [tex]);
  const tankRough = useMemo(() => setRepeat(tex.tankRough, 2, 1), [tex]);
  const tankNormal = useMemo(() => setRepeat(tex.tankNormal, 2, 1), [tex]);
  const metalMap = useMemo(() => setRepeat(tex.metalColor, 2, 4), [tex]);

  const rooftop = useRooftopEquipment();

  // Pre-calculate foundation grades for all rigid assets
  const sphereGrades = useMemo(() => spheres.map((s) => sampleFootprintGrade(s.pos, s.radius)), []);
  const domeGrades = useMemo(() => domes.map((d) => sampleFootprintGrade(d.pos, d.radius)), []);
  const dishGrades = useMemo(
    () => dishes.map((a) => sampleFootprintGrade(a.pos, a.dishRadius / RADOME.dishRatio)),
    []
  );
  const tankGrades = useMemo(() => tanks.map((t) => sampleFootprintGrade(t.pos, t.radius)), []);
  const buildingGrades = useMemo(
    () => buildings.map((b) => sampleFootprintGrade(b.pos, b.size, b.rotY ?? 0)),
    []
  );
  // Base elevation of every radome group (roof-mounted shells sit on their host).
  const domeElevations = useMemo(
    () =>
      domes.map((d, i) => {
        const host = d.roofMounted ? radomeHost(d.pos) : -1;
        return host >= 0 ? buildingGrades[host].elevation + buildings[host].height + 0.25 : domeGrades[i].elevation;
      }),
    [buildingGrades, domeGrades]
  );
  const details = useRepeatedDetails(domeElevations, buildingGrades);

  return (
    <group name="structures">
      {/* Spherical storage tanks */}
      <group name="spherical-tanks">
        {spheres.map((s, i) => {
          const grade = sphereGrades[i];
          const rest = s.radius * 0.62;
          const legs = s.legs ?? 10;
          const skirtDepth = Math.max(0.4, grade.elevation - grade.minTerrain + 0.3);
          return (
            <group
              key={`sphere-${i}`}
              name={`sphere-${i}`}
              position={[s.pos[0], grade.elevation, s.pos[1]]}
              onClick={(e) => pick(e, sphereSelection(s, i))}
              onPointerOver={over}
              onPointerOut={out}
            >
              <mesh
                position={[0, -skirtDepth / 2 + 0.15, 0]}
                geometry={groundedCylinder(s.radius * 1.1, s.radius * 1.15, skirtDepth, 32, skirtDepth / 2 - 0.15)}
                material={footingConcrete}
                receiveShadow
              />
              {Array.from({ length: legs }).map((_, j) => {
                const a = (j / legs) * Math.PI * 2;
                const lr = s.radius * 0.82;
                return (
                  <mesh
                    key={`leg-${j}`}
                    position={[Math.cos(a) * lr, rest * 0.55, Math.sin(a) * lr]}
                    castShadow
                  >
                    <cylinderGeometry args={[0.25, 0.25, rest * 1.15, 8]} />
                    <meshStandardMaterial color="#8a857a" metalness={0.6} roughness={0.5} />
                  </mesh>
                );
              })}
              <Detailed distances={[0, 110, 260]}>
                <mesh position={[0, rest + s.radius, 0]} castShadow receiveShadow>
                  <sphereGeometry args={[s.radius, 64, 48]} />
                  <meshPhysicalMaterial
                    map={steelMap}
                    normalMap={steelNormal}
                    color="#f0ede5"
                    metalness={0.4}
                    roughness={0.28}
                    clearcoat={0.55}
                    clearcoatRoughness={0.35}
                    envMapIntensity={1.2}
                  />
                </mesh>
                <mesh position={[0, rest + s.radius, 0]} castShadow>
                  <sphereGeometry args={[s.radius, 24, 16]} />
                  <meshStandardMaterial color="#f0ede5" metalness={0.35} roughness={0.45} />
                </mesh>
                <mesh position={[0, rest + s.radius, 0]}>
                  <sphereGeometry args={[s.radius, 12, 8]} />
                  <meshStandardMaterial color="#eeebe3" roughness={0.5} />
                </mesh>
              </Detailed>
            </group>
          );
        })}
      </group>

      {/* Radomes */}
      <group name="radomes">
        {domes.map((d, i) => {
          const onRoof = domeElevations[i] !== domeGrades[i].elevation;
          const grade = onRoof
            ? { ...domeGrades[i], elevation: domeElevations[i], minTerrain: domeElevations[i] - 0.25 }
            : domeGrades[i];
          const baseR = d.radius * RADOME_SHELL_SIN;
          const wall = RADOME.plinthHeight;
          const skirtDepth = Math.max(0.5, grade.elevation - grade.minTerrain + 0.4);
          const totalPlinthH = wall + skirtDepth;
          const plinthCenterY = wall / 2 - skirtDepth / 2;

          const shellY = wall + d.radius * RADOME_SHELL_LIFT;
          const shellNear = radomeShellGeometry(d.radius, 4);
          const shellMid = radomeShellGeometry(d.radius, 2);
          const shellFar = radomeShellGeometry(d.radius, 1);

          return (
            <group
              key={`dome-${i}`}
              name={`dome-${i}`}
              position={[d.pos[0], grade.elevation, d.pos[1]]}
              onClick={(e) => pick(e, domeSelection(d, i))}
              onPointerOver={over}
              onPointerOut={out}
            >
              {/* Gravel apron */}
              {!d.roofMounted && <GroundApron center={d.pos} radius={d.radius * 1.35} elevation={grade.elevation} />}

              {/* Engineered concrete plinth wall extending below grade */}
              <mesh
                position={[0, plinthCenterY, 0]}
                geometry={groundedCylinder(baseR + 0.3, baseR + 0.55, totalPlinthH, 64, -plinthCenterY)}
                material={plinthConcrete}
                receiveShadow
                castShadow
              />
              {/* galvanised flashing ring where the shell bolts to the plinth */}
              <mesh position={[0, wall + 0.06, 0]} material={galvanisedMat} castShadow>
                <cylinderGeometry args={[baseR + 0.36, baseR + 0.36, 0.16, 64, 1, true]} />
              </mesh>

              {/* Geodesic FRP shell LODs: panels, seams, weathering in one material */}
              <Detailed distances={[0, 280, 700]}>
                <mesh geometry={shellNear} material={radomeShellMat} position={[0, shellY, 0]} castShadow receiveShadow />
                <mesh geometry={shellMid} material={radomeShellMat} position={[0, shellY, 0]} castShadow receiveShadow />
                <mesh geometry={shellFar} material={radomeShellMat} position={[0, shellY, 0]} castShadow receiveShadow />
              </Detailed>
            </group>
          );
        })}
      </group>

      {/* Uncovered open dish antennas */}
      <group name="dish-antennas">
        {dishes.map((a, i) => {
          const grade = dishGrades[i];
          const R = a.dishRadius / RADOME.dishRatio;
          const skirtDepth = Math.max(0.4, grade.elevation - grade.minTerrain + 0.3);

          return (
            <group
              key={`dish-${i}`}
              name={`dish-${i}`}
              position={[a.pos[0], grade.elevation, a.pos[1]]}
              onClick={(e) => pick(e, dishSelection(a, i))}
              onPointerOver={over}
              onPointerOut={out}
            >
              <GroundApron center={a.pos} radius={R * 0.7} elevation={grade.elevation} />
              <mesh
                position={[0, -skirtDepth / 2 + 0.2, 0]}
                geometry={groundedCylinder(R * 0.42, R * 0.48, skirtDepth + 0.4, 48, -(-skirtDepth / 2 + 0.2))}
                material={footingConcrete}
                receiveShadow
                castShadow
              />
              <group position={[0, 0.4, 0]}>
                <RadomeAntenna radius={R} index={domes.length + i} enclosed={false} />
              </group>
            </group>
          );
        })}
      </group>

      {/* Cylindrical Storage Tanks */}
      <group name="tanks">
        {tanks.map((t, i) => {
          const grade = tankGrades[i];
          const skirtDepth = Math.max(0.3, grade.elevation - grade.minTerrain + 0.3);

          return (
            <group
              key={`tank-${i}`}
              name={`tank-${i}`}
              position={[t.pos[0], grade.elevation, t.pos[1]]}
              onClick={(e) => pick(e, tankSelection(t, i))}
              onPointerOver={over}
              onPointerOut={out}
            >
              <mesh
                position={[0, -skirtDepth / 2 + 0.1, 0]}
                geometry={groundedCylinder(t.radius * 1.12, t.radius * 1.18, skirtDepth + 0.2, 32, skirtDepth / 2 - 0.1)}
                material={footingConcrete}
                receiveShadow
                castShadow
              />
              <mesh position={[0, t.height / 2, 0]} castShadow receiveShadow>
                <cylinderGeometry args={[t.radius, t.radius, t.height, 32]} />
                <meshStandardMaterial
                  map={tankMap}
                  roughnessMap={tankRough}
                  normalMap={tankNormal}
                  normalScale={new THREE.Vector2(0.6, 0.6)}
                  metalness={0.55}
                  roughness={0.4}
                  envMapIntensity={0.9}
                />
              </mesh>
              <mesh position={[0, t.height, 0]} castShadow>
                <sphereGeometry args={[t.radius, 32, 12, 0, Math.PI * 2, 0, Math.PI * 0.28]} />
                <meshStandardMaterial color="#cfc9be" metalness={0.5} roughness={0.5} />
              </mesh>
              <mesh position={[0, t.height + 0.5, 0]}>
                <torusGeometry args={[t.radius * 0.98, 0.03, 6, 36]} />
                <meshStandardMaterial color="#8a8172" metalness={0.7} roughness={0.4} />
              </mesh>
            </group>
          );
        })}
      </group>

      {/* Buildings */}
      <group name="buildings">
        {buildings.map((b, i) => {
          const grade = buildingGrades[i];
          const gable = b.roof === "gable";
          const glazed = GLAZED.has(b.kind ?? "warehouse");
          const skirtDepth = Math.max(0.4, grade.elevation - grade.minTerrain + 0.3);

          return (
            <group
              key={`bldg-${i}`}
              name={`building-${i}`}
              position={[b.pos[0], grade.elevation, b.pos[1]]}
              rotation={[0, b.rotY ?? 0, 0]}
              onClick={(e) => pick(e, buildingSelection(b, i))}
              onPointerOver={over}
              onPointerOut={out}
            >
              {/* Foundation slab skirt */}
              <mesh
                position={[0, -skirtDepth / 2 + 0.05, 0]}
                geometry={groundedBox(b.size[0] + 0.16, skirtDepth, b.size[1] + 0.16, -(-skirtDepth / 2 + 0.05))}
                material={footingConcrete}
                receiveShadow
                castShadow
              />

              <mesh
                geometry={wallGeometry(b.size[0], b.height, b.size[1])}
                material={wallMaterial(b.color ?? "#cfc9bd", glazed)}
                castShadow
                receiveShadow
              />

              {gable ? (
                <mesh
                  position={[0, b.height, 0]}
                  geometry={gableGeometry(b.size[0], b.size[1], b.roofRise ?? b.size[0] * 0.28)}
                  material={roofMaterial(b.roofColor ?? "#8f8878", true)}
                  castShadow
                  receiveShadow
                />
              ) : (
                <mesh
                  position={[0, b.height + 0.05, 0]}
                  rotation={[-Math.PI / 2, 0, 0]}
                  material={roofMaterial(b.roofColor ?? "#6f6a5e", false)}
                  receiveShadow
                >
                  <planeGeometry args={[b.size[0], b.size[1]]} />
                </mesh>
              )}
            </group>
          );
        })}
      </group>

      {/* Repeated radome details and parapets, instanced */}
      <group name="instanced-details">
        <instancedMesh
          args={[undefined, undefined, details.vents.length]}
          castShadow
          ref={(inst) => fillInstances(inst, details.vents)}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#565b60" metalness={0.6} roughness={0.5} />
        </instancedMesh>
        <instancedMesh
          args={[undefined, undefined, details.vestibules.length]}
          castShadow
          receiveShadow
          ref={(inst) => fillInstances(inst, details.vestibules)}
          geometry={vestibuleBox}
          material={plinthConcrete}
        />
        <instancedMesh
          args={[undefined, undefined, details.vestibuleDoors.length]}
          ref={(inst) => fillInstances(inst, details.vestibuleDoors)}
          geometry={unitBox}
          material={doorMat}
        />
        <instancedMesh
          args={[undefined, undefined, details.plinthDoors.length]}
          ref={(inst) => fillInstances(inst, details.plinthDoors)}
          geometry={unitBox}
          material={doorMat}
        />
        <instancedMesh
          args={[undefined, undefined, details.poles.length]}
          castShadow
          ref={(inst) => fillInstances(inst, details.poles)}
        >
          <cylinderGeometry args={[0.08, 0.1, 3, 8]} />
          <meshStandardMaterial color="#3b3f44" metalness={0.6} roughness={0.5} />
        </instancedMesh>
        <instancedMesh
          args={[undefined, undefined, details.heads.length]}
          ref={(inst) => fillInstances(inst, details.heads)}
        >
          <boxGeometry args={[0.5, 0.2, 0.34]} />
          <meshStandardMaterial
            color="#2b2f33"
            emissive="#ffb257"
            emissiveIntensity={night ? 6 : 0}
            metalness={0.5}
            roughness={0.5}
          />
        </instancedMesh>
        <instancedMesh
          args={[undefined, undefined, details.parapets.length]}
          castShadow
          ref={(inst) => fillInstances(inst, details.parapets, details.parapetColors)}
          geometry={unitBox}
          material={parapetConcrete}
        />
        <instancedMesh
          args={[undefined, undefined, details.copings.length]}
          castShadow
          ref={(inst) => fillInstances(inst, details.copings)}
          geometry={unitBox}
          material={galvanisedMat}
        />
        <instancedMesh
          args={[undefined, undefined, details.downpipes.length]}
          castShadow
          ref={(inst) => fillInstances(inst, details.downpipes)}
          geometry={unitBox}
          material={galvanisedMat}
        />
        <instancedMesh
          args={[undefined, undefined, details.gutters.length]}
          castShadow
          ref={(inst) => fillInstances(inst, details.gutters)}
          geometry={unitBox}
          material={galvanisedMat}
        />
        <instancedMesh
          args={[undefined, undefined, details.frames.length]}
          castShadow
          ref={(inst) => fillInstances(inst, details.frames)}
          geometry={unitBox}
          material={darkSteelMat}
        />
        <instancedMesh
          args={[undefined, undefined, details.doors.length]}
          receiveShadow
          ref={(inst) => fillInstances(inst, details.doors)}
          geometry={unitBox}
          material={doorMat}
        />
        <instancedMesh
          args={[undefined, undefined, details.rollerDoors.length]}
          receiveShadow
          ref={(inst) => fillInstances(inst, details.rollerDoors)}
          geometry={unitBox}
          material={rollerDoorMat}
        />
        <instancedMesh
          args={[undefined, undefined, details.lamps.length]}
          ref={(inst) => fillInstances(inst, details.lamps)}
          geometry={unitBox}
          material={lampLensMat}
        />
        <ObstructionBeacons matrices={details.beacons} night={night} />
      </group>

      {/* Rooftop equipment */}
      <instancedMesh
        args={[undefined, undefined, rooftop.acs.length]}
        castShadow
        ref={(inst) => fillInstances(inst, rooftop.acs)}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial map={metalMap} color="#c4c2ba" metalness={0.55} roughness={0.5} />
      </instancedMesh>
      <instancedMesh
        args={[undefined, undefined, rooftop.fans.length]}
        ref={(inst) => fillInstances(inst, rooftop.fans)}
        material={darkSteelMat}
      >
        <cylinderGeometry args={[1, 1, 1, 16]} />
      </instancedMesh>
      <instancedMesh
        args={[undefined, undefined, rooftop.curbs.length]}
        receiveShadow
        ref={(inst) => fillInstances(inst, rooftop.curbs)}
        geometry={unitBox}
        material={parapetConcrete}
      />
      <instancedMesh
        args={[undefined, undefined, rooftop.vents.length]}
        castShadow
        ref={(inst) => fillInstances(inst, rooftop.vents)}
      >
        <cylinderGeometry args={[0.5, 0.5, 1, 10]} />
        <meshStandardMaterial color="#8d887c" metalness={0.65} roughness={0.45} />
      </instancedMesh>
    </group>
  );
}
