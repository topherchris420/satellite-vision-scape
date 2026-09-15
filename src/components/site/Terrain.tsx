import { useMemo } from 'react';
import * as THREE from 'three';
import { buildings, domes, dishes, roadPath, interiorRoads, topEnclosurePath, parkingLots } from '@/lib/site-layout';
import { terrainHeight, sampleTerrainFrame } from '@/lib/terrain';
import { getSiteTextures, setRepeat } from '@/lib/site-textures';
import { siteToImage } from '@/lib/reference-layout';

function random(seed: number) { let s = seed; return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646; }
function developed(x: number, z: number) {
  const [u,v] = siteToImage(x,z);
  // The source shows maintained clear ground across the facility, with planted
  // trees restricted to the eastern garden campus (rendered separately).
  if (u>255 && u<1070 && v>30 && v<827) return true;
  if (buildings.some(b => Math.abs(x - b.pos[0]) < b.size[0] / 2 + 5 && Math.abs(z - b.pos[1]) < b.size[1] / 2 + 5)) return true;
  if (parkingLots.some(b => Math.abs(x - b.pos[0]) < b.size[0] / 2 + 5 && Math.abs(z - b.pos[1]) < b.size[1] / 2 + 5)) return true;
  if (domes.some(d => Math.hypot(x - d.pos[0], z - d.pos[1]) < d.radius * 1.5 + 4)) return true;
  if (dishes.some(d => Math.hypot(x - d.pos[0], z - d.pos[1]) < d.dishRadius * 1.6 + 4)) return true;
  for (const path of [[...roadPath, roadPath[0]], ...interiorRoads, [...topEnclosurePath, topEnclosurePath[0]]]) for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1], dx = b[0] - a[0], dz = b[1] - a[1];
    const t = THREE.MathUtils.clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz), 0, 1);
    if (Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz) < 8) return true;
  }
  return false;
}
function fill(inst: THREE.InstancedMesh | null, matrices: THREE.Matrix4[], colors: THREE.Color[]) {
  if (!inst) return; matrices.forEach((m, i) => { inst.setMatrixAt(i, m); inst.setColorAt(i, colors[i]); });
  inst.instanceMatrix.needsUpdate = true; if (inst.instanceColor) inst.instanceColor.needsUpdate = true; inst.computeBoundingSphere();
}
function tuftGeometry() {
  const r = random(211), vertices: number[] = [];
  for (let i = 0; i < 18; i++) { const a = r() * Math.PI * 2, spread = .3 + r() * .6, h = .25 + r() * .6, x = Math.cos(a), z = Math.sin(a), w = .04 + r() * .06; vertices.push(-z*w,0,x*w,z*w,0,-x*w,x*spread,h,z*spread); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); g.computeVertexNormals(); return g;
}
export function Terrain() {
  const tex = getSiteTextures();
  const map = useMemo(() => setRepeat(tex.dirtColor, 2, 2), [tex]); const normal = useMemo(() => setRepeat(tex.dirtNormal, 2, 2), [tex]);
  const ground = useMemo(() => {
    const axis: number[] = []; for (let x = -3000; x < -800; x += 40) axis.push(x); for (let x = -800; x <= 800; x += 4) axis.push(x); for (let x = 840; x <= 3000; x += 40) axis.push(x);
    const positions: number[] = [], uvs: number[] = [], colors: number[] = [], indices: number[] = [], color = new THREE.Color();
    for (const z of axis) for (const x of axis) { const h = terrainHeight(x, z); positions.push(x, h, z); uvs.push(x / 18, z / 18); const v = .94 + .09 * Math.sin(x * .017 + Math.sin(z * .025)) + .05 * Math.sin(z * .079 + x * .06); color.set('#d3b6a0').lerp(new THREE.Color('#aaa58d'), Math.min(.65, Math.max(0, h - 12) / 160)); color.multiplyScalar(v); colors.push(color.r, color.g, color.b); }
    const n = axis.length; for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i; indices.push(a, a + n, a + 1, a + 1, a + n, a + n + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); g.setIndex(indices); g.computeVertexNormals(); return g;
  }, []);
  const scatter = useMemo(() => {
    const r = random(62831), grass: THREE.Matrix4[] = [], rocks: THREE.Matrix4[] = [], grassColors: THREE.Color[] = [], rockColors: THREE.Color[] = [], up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 8500; i++) { const x = (r() - .5) * 3400, z = (r() - .5) * 3400; if (developed(x, z)) continue; const frame = sampleTerrainFrame(x, z), s = .65 + r() * 1.4, q = new THREE.Quaternion().setFromUnitVectors(up, frame.normal); q.multiply(new THREE.Quaternion().setFromAxisAngle(up, r() * Math.PI * 2)); if (r() < .82) { grass.push(new THREE.Matrix4().compose(new THREE.Vector3(x, frame.height - .03, z), q, new THREE.Vector3(s, s, s))); grassColors.push(new THREE.Color().setHSL(.13 + r() * .055, .15 + r() * .13, .25 + r() * .16)); } else { rocks.push(new THREE.Matrix4().compose(new THREE.Vector3(x, frame.height + s * .08, z), q, new THREE.Vector3(s * .9, s * .4, s * .7))); rockColors.push(new THREE.Color().setHSL(.055 + r() * .025, .19 + r() * .12, .28 + r() * .18)); } }
    return { grass, rocks, grassColors, rockColors };
  }, []);
  const tuft = useMemo(tuftGeometry, []);
  return <group name="terrain">
    <mesh geometry={ground} receiveShadow><meshStandardMaterial map={map} normalMap={normal} normalScale={new THREE.Vector2(.32, .32)} vertexColors roughness={1} /></mesh>
    <instancedMesh args={[undefined, undefined, scatter.grass.length]} geometry={tuft} ref={m => fill(m, scatter.grass, scatter.grassColors)} castShadow><meshStandardMaterial color="#fff" roughness={1} side={THREE.DoubleSide} /></instancedMesh>
    <instancedMesh args={[undefined, undefined, scatter.rocks.length]} ref={m => fill(m, scatter.rocks, scatter.rockColors)} castShadow receiveShadow><dodecahedronGeometry args={[1, 0]} /><meshStandardMaterial map={tex.rockColor} roughness={1} /></instancedMesh>
  </group>;
}
