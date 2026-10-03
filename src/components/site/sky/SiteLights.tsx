import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { buildings, domes, RADOME_SHELL_SIN } from "@/lib/site-layout";
import { sampleFootprintGrade } from "@/lib/terrain";
import { RADOME_FLOODLIGHT_ANGLES, RADOME_FLOODLIGHT_OFFSET } from "@/game/world/buildSiteWorld";
import { AERIAL_GLSL, atmosphereUniforms } from "./shaderChunks";
import type { QualityTier } from "../SiteScene";

/**
 * After-dark site lighting: every radome floodlight and building wall lamp
 * gets a glowing lamp head (HDR, so bloom turns it into a soft flare) and a
 * pool of light on the ground. The most important fixtures also get a real
 * point light that lights the radome shells, walls, vehicles and people;
 * how many depends on the quality tier (none on phones, where the pools and
 * glows carry the look on their own).
 */

type Fixture = {
  /** Lamp head position. */
  head: THREE.Vector3;
  /** Where a real light for this fixture sits (slightly off the lamp, for a broader wash). */
  light: THREE.Vector3;
  /** Ground pool centre and radius. */
  pool: THREE.Vector3;
  poolRadius: number;
  color: THREE.Color;
  /** Point light intensity (candela) and range. */
  intensity: number;
  range: number;
  /** Lower is more important (gets a real light first). */
  priority: number;
  glowSize: number;
};

const FLOOD_COLOR = new THREE.Color(1, 0.74, 0.46);
const LAMP_COLOR = new THREE.Color(1, 0.68, 0.4);

function buildFixtures(): Fixture[] {
  const out: Fixture[] = [];
  domes.forEach((d) => {
    if (d.roofMounted) return;
    const elevation = sampleFootprintGrade(d.pos, d.radius).elevation;
    const baseR = d.radius * RADOME_SHELL_SIN;
    const big = d.radius >= 15;
    const mid = d.radius >= 7;
    RADOME_FLOODLIGHT_ANGLES.forEach((a, k) => {
      const c = Math.cos(a);
      const s = Math.sin(a);
      const fr = baseR + RADOME_FLOODLIGHT_OFFSET - 0.28;
      const head = new THREE.Vector3(d.pos[0] + c * fr, elevation + 2.95, d.pos[1] + s * fr);
      const out1 = fr + 1.6;
      // The south-west floodlight faces the usual viewpoints; it is lit first.
      const rank = a === 2.3 ? 0 : a === 5.5 ? 1 : 2 + k;
      out.push({
        head,
        light: new THREE.Vector3(d.pos[0] + c * out1, elevation + 3.8, d.pos[1] + s * out1),
        pool: new THREE.Vector3(d.pos[0] + c * (fr - 1.5), elevation, d.pos[1] + s * (fr - 1.5)),
        poolRadius: big ? 11 : mid ? 8.5 : 6,
        color: FLOOD_COLOR,
        intensity: big ? 170 : mid ? 90 : 40,
        range: big ? 55 : mid ? 40 : 26,
        priority: (big ? 0 : mid ? 10 : 30) + rank * (big ? 3 : 15),
        glowSize: 0.9,
      });
    });
  });
  buildings.forEach((b) => {
    const grade = sampleFootprintGrade(b.pos, b.size, b.rotY ?? 0);
    const [w, dd] = b.size;
    const doorHeight = Math.min(2.1, b.height - 0.35);
    const lampY = Math.min(doorHeight + 0.35, b.height - 0.15);
    const local = w >= dd ? new THREE.Vector3(w * 0.18, lampY, dd / 2 + 0.25) : new THREE.Vector3(w / 2 + 0.25, lampY, dd * 0.18);
    const outward = w >= dd ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const rot = new THREE.Matrix4().makeRotationY(b.rotY ?? 0);
    local.applyMatrix4(rot);
    outward.applyMatrix4(rot);
    const head = new THREE.Vector3(b.pos[0] + local.x, grade.elevation + local.y, b.pos[1] + local.z);
    const area = w * dd;
    out.push({
      head,
      light: head.clone().addScaledVector(outward, 1.2),
      pool: head.clone().addScaledVector(outward, 2.2).setY(grade.elevation),
      poolRadius: 6.5,
      color: LAMP_COLOR,
      intensity: 26,
      range: 20,
      priority: 20 - Math.min(14, area / 400),
      glowSize: 0.55,
    });
  });
  return out.sort((a, b) => a.priority - b.priority);
}

let fixtureCache: Fixture[] | null = null;
function fixtures() {
  fixtureCache ??= buildFixtures();
  return fixtureCache;
}

const REAL_LIGHTS: Record<QualityTier, number> = { low: 0, medium: 8, high: 16, ultra: 26 };

const GLOW_VERTEX = /* glsl */ `
uniform vec3 pgSunDir;
uniform vec3 pgSunColor;
uniform vec3 pgHazeToward;
uniform vec3 pgHazeSide;
uniform vec3 pgHazeAway;
uniform vec4 pgFog;
uniform vec3 pgFogExt;
uniform vec4 pgFogMisc;
uniform float uIntensity;
uniform float uScale;
attribute vec3 color;
attribute float size;
varying vec3 vColor;
${AERIAL_GLSL}
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vec4 mv = viewMatrix * world;
  gl_Position = projectionMatrix * mv;
  vec3 rd = world.xyz - cameraPosition;
  float dist = length( rd );
  vec3 T = pgFog.w > 0.0 ? pgFogTransmittance( cameraPosition, rd / max( dist, 1e-3 ), dist ) : vec3( 1.0 );
  vColor = color * uIntensity * T;
  // A floor of a few pixels keeps distant lamps visible as points of light.
  gl_PointSize = clamp( size * uScale / max( - mv.z, 0.1 ), 3.0, 180.0 );
}
`;

const GLOW_FRAGMENT = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot( p, p );
  if ( r2 > 1.0 ) discard;
  float core = exp( - r2 * 34.0 );
  float halo = exp( - r2 * 5.0 ) * 0.11;
  gl_FragColor = vec4( vColor * ( core * 9.0 + halo ), 1.0 );
}
`;

const POOL_VERTEX = /* glsl */ `
uniform vec3 pgSunDir;
uniform vec3 pgSunColor;
uniform vec3 pgHazeToward;
uniform vec3 pgHazeSide;
uniform vec3 pgHazeAway;
uniform vec4 pgFog;
uniform vec3 pgFogExt;
uniform vec4 pgFogMisc;
uniform float uIntensity;
varying vec2 vUv;
varying vec3 vColor;
${AERIAL_GLSL}
void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 world = modelMatrix * instanceMatrix * vec4( position, 1.0 );
  vec3 rd = world.xyz - cameraPosition;
  float dist = length( rd );
  vec3 T = pgFog.w > 0.0 ? pgFogTransmittance( cameraPosition, rd / max( dist, 1e-3 ), dist ) : vec3( 1.0 );
  vColor = instanceColor * uIntensity * T;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const POOL_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
void main() {
  float r2 = dot( vUv, vUv );
  if ( r2 > 1.0 ) discard;
  // Inverse-square-like falloff with a soft window to zero at the rim.
  float w = ( 1.0 - r2 );
  float fall = w * w / ( 1.0 + 9.0 * r2 );
  gl_FragColor = vec4( vColor * fall, 1.0 );
}
`;

function fogUniforms() {
  return {
    pgSunDir: atmosphereUniforms.pgSunDir,
    pgSunColor: atmosphereUniforms.pgSunColor,
    pgHazeToward: atmosphereUniforms.pgHazeToward,
    pgHazeSide: atmosphereUniforms.pgHazeSide,
    pgHazeAway: atmosphereUniforms.pgHazeAway,
    pgFog: atmosphereUniforms.pgFog,
    pgFogExt: atmosphereUniforms.pgFogExt,
    pgFogMisc: atmosphereUniforms.pgFogMisc,
  };
}

export function SiteLights({ level, tier }: { level: number; tier: QualityTier }) {
  const all = fixtures();
  const realCount = level >= 0.99 ? REAL_LIGHTS[tier] : 0;
  const real = all.slice(0, realCount);

  const glow = useMemo(() => {
    const positions = new Float32Array(all.length * 3);
    const colors = new Float32Array(all.length * 3);
    const sizes = new Float32Array(all.length);
    all.forEach((f, i) => {
      positions.set([f.head.x, f.head.y, f.head.z], i * 3);
      colors.set([f.color.r, f.color.g, f.color.b], i * 3);
      sizes[i] = f.glowSize;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    geometry.computeBoundingSphere();
    const material = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      uniforms: { ...fogUniforms(), uIntensity: { value: 1 }, uScale: { value: 400 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    const points = new THREE.Points(geometry, material);
    points.name = "site-lamp-glows";
    points.renderOrder = 10;
    points.frustumCulled = false;
    points.onBeforeRender = (renderer, _scene, camera) => {
      const persp = camera as THREE.PerspectiveCamera;
      const h = renderer.getRenderTarget()?.height ?? renderer.domElement.height;
      // Converts a world-space size to pixels at unit distance.
      material.uniforms.uScale.value = persp.isPerspectiveCamera
        ? h / (2 * Math.tan((persp.fov * Math.PI) / 360))
        : 400;
    };
    return points;
  }, [all]);

  const pools = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.ShaderMaterial({
      vertexShader: POOL_VERTEX,
      fragmentShader: POOL_FRAGMENT,
      uniforms: { ...fogUniforms(), uIntensity: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: false,
      toneMapped: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, all.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    all.forEach((f, i) => {
      s.set(f.poolRadius, 1, f.poolRadius);
      m.compose(f.pool.clone().setY(f.pool.y + 0.06), q, s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, f.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = "site-light-pools";
    mesh.renderOrder = 5;
    return { mesh };
  }, [all]);

  // Fixtures with a real light skip their painted pool (it would double up).
  useEffect(() => {
    pools.mesh.count = all.length;
    const offset = realCount;
    const m = new THREE.Matrix4();
    for (let i = 0; i < all.length; i++) {
      const f = all[i];
      const scale = i < offset ? 0 : f.poolRadius;
      m.compose(f.pool.clone().setY(f.pool.y + 0.06), new THREE.Quaternion(), new THREE.Vector3(scale, 1, scale));
      pools.mesh.setMatrixAt(i, m);
    }
    pools.mesh.instanceMatrix.needsUpdate = true;
  }, [pools, all, realCount]);

  useEffect(() => {
    (glow.material as THREE.ShaderMaterial).uniforms.uIntensity.value = level;
    (pools.mesh.material as THREE.ShaderMaterial).uniforms.uIntensity.value = 0.22 * level;
  }, [glow, pools, level]);

  useEffect(
    () => () => {
      glow.geometry.dispose();
      (glow.material as THREE.Material).dispose();
      pools.mesh.geometry.dispose();
      (pools.mesh.material as THREE.Material).dispose();
    },
    [glow, pools],
  );

  if (level <= 0) return null;
  return (
    <group name="site-lights">
      <primitive object={glow} />
      {level >= 0.99 && <primitive object={pools.mesh} />}
      {real.map((f, i) => (
        <pointLight
          key={i}
          position={f.light}
          color={f.color}
          intensity={f.intensity}
          distance={f.range}
          decay={2}
        />
      ))}
    </group>
  );
}
