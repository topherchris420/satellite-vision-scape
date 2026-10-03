import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { WIND } from "@/lib/wind";
import { installAtmosphereShaders, atmosphereUniforms } from "./sky/shaderChunks";
import { getSkyState, type SkyState, type TimeOfDay } from "./sky/presets";
import { SkyDome, SkyEnvironment } from "./sky/Sky";
import { SiteLights } from "./sky/SiteLights";
import type { QualityTier } from "./SiteScene";

export type { TimeOfDay } from "./sky/presets";

// Patch three's shader chunks before anything compiles.
installAtmosphereShaders();

/** Share of the ambient light given by the hemisphere light rather than the IBL. */
const HEMI_SHARE = 0.3;

/** Horizontal centre of the facility (the far shadow cascade rests here). */
const SITE_CENTRE = new THREE.Vector3(-84, 0, 2);

type CascadeConfig = {
  /** Two cascades (near + far) or the near one alone. */
  cascades: 1 | 2;
  nearSize: number;
  farSize: number;
  /** Near cascade half-extent while playing (m). */
  playExtent: number;
  /** Far cascade half-extent (m). */
  farExtent: number;
  /** Re-render the far map every N frames (the scene there is nearly static). */
  farInterval: number;
};

const CASCADES: Record<QualityTier, CascadeConfig> = {
  low: { cascades: 1, nearSize: 1024, farSize: 0, playExtent: 70, farExtent: 0, farInterval: 1 },
  medium: { cascades: 2, nearSize: 2048, farSize: 2048, playExtent: 55, farExtent: 1100, farInterval: 4 },
  high: { cascades: 2, nearSize: 4096, farSize: 4096, playExtent: 60, farExtent: 1500, farInterval: 3 },
  ultra: { cascades: 2, nearSize: 4096, farSize: 4096, playExtent: 60, farExtent: 1600, farInterval: 1 },
};

/** Writes the per-time-of-day atmosphere constants shared by every material. */
function writeAtmosphere(state: SkyState, fogScale: number) {
  const { preset, solution, radianceScale, keyColor, keyIntensity, sourceDir } = state;
  const u = atmosphereUniforms;
  u.pgSunDir.value.set(sourceDir);
  u.pgSunColor.value.set(keyColor.map((c) => c * keyIntensity));
  u.pgHazeToward.value.set(solution.horizonToward.map((c) => c * radianceScale));
  u.pgHazeSide.value.set(solution.horizonSide.map((c) => c * radianceScale));
  u.pgHazeAway.value.set(solution.horizonAway.map((c) => c * radianceScale));
  u.pgFog.value.set([preset.fog.density, preset.fog.falloff, 0, fogScale]);
  u.pgFogExt.value.set(preset.fog.extinction);
  u.pgFogMisc.value[0] = preset.fog.mie;
  u.pgCloud.value[0] = preset.clouds.coverage;
  u.pgCloud.value[3] = preset.clouds.shadow;
}

/** Places a directional light's orthographic shadow box, snapped to whole texels. */
function frameShadow(
  light: THREE.DirectionalLight,
  sun: THREE.Vector3,
  centre: THREE.Vector3,
  extent: number,
  mapSize: number,
  depth: number,
  scratch: { right: THREE.Vector3; up: THREE.Vector3; fwd: THREE.Vector3; snapped: THREE.Vector3 },
) {
  const { right, up, fwd, snapped } = scratch;
  fwd.copy(sun).negate();
  right.set(0, 1, 0).cross(fwd);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  right.normalize();
  up.crossVectors(fwd, right);
  const texel = (2 * extent) / mapSize;
  const a = Math.round(centre.dot(right) / texel) * texel;
  const b = Math.round(centre.dot(up) / texel) * texel;
  const c = centre.dot(fwd);
  snapped.copy(right).multiplyScalar(a).addScaledVector(up, b).addScaledVector(fwd, c);
  light.target.position.copy(snapped);
  light.target.updateMatrixWorld();
  light.position.copy(snapped).addScaledVector(sun, depth);
  const cam = light.shadow.camera;
  if (cam.right !== extent || cam.far !== depth * 2) {
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = depth * 2;
    cam.updateProjectionMatrix();
  }
}

/**
 * The sun (or moon) as two directional lights forming a two-cascade shadow
 * (see sky/shaderChunks.ts): a crisp near map around the player or the
 * viewer's focus, and a far map over the whole site and the nearby ranges.
 */
function SunCascades({
  state,
  tier,
  focus,
}: {
  state: SkyState;
  tier: QualityTier;
  focus: THREE.Vector3 | null;
}) {
  const nearRef = useRef<THREE.DirectionalLight>(null);
  const farRef = useRef<THREE.DirectionalLight>(null);
  const cfg = CASCADES[tier];
  const sun = useMemo(() => new THREE.Vector3(...state.sourceDir), [state]);
  const color = useMemo(() => new THREE.Color(...state.keyColor), [state]);
  const scratch = useMemo(
    () => ({
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      fwd: new THREE.Vector3(),
      snapped: new THREE.Vector3(),
      centre: new THREE.Vector3(),
      look: new THREE.Vector3(),
      farCentre: new THREE.Vector3(),
    }),
    [],
  );
  const frame = useRef(0);
  const lastFar = useRef(new THREE.Vector3(Infinity, 0, 0));

  useEffect(() => {
    const far = farRef.current;
    if (!far) return;
    far.shadow.autoUpdate = cfg.farInterval <= 1;
    far.shadow.needsUpdate = true;
    lastFar.current.set(Infinity, 0, 0);
  }, [cfg, sun]);

  useFrame(({ camera }) => {
    const near = nearRef.current;
    if (!near) return;
    const { centre, look } = scratch;
    let extent: number;
    if (focus) {
      // Play: centre slightly ahead of the player along the view.
      camera.getWorldDirection(look);
      look.y = 0;
      if (look.lengthSq() > 1e-6) look.normalize();
      extent = cfg.playExtent;
      centre.copy(focus).addScaledVector(look, extent * 0.45);
    } else {
      // Viewer: cover the ground the camera is looking at, sized by height.
      camera.getWorldDirection(look);
      const height = Math.max(2, camera.position.y);
      const hit = look.y < -0.02 ? height / -look.y : Infinity;
      const reach = Math.min(hit, 120 + height * 2.2);
      extent = THREE.MathUtils.clamp(reach * 0.62 + 25, 60, 480);
      // Quantise so zooming does not make the texel grid swim.
      extent = Math.pow(1.15, Math.ceil(Math.log(extent) / Math.log(1.15)));
      const horiz = Math.hypot(look.x, look.z) || 1;
      centre.set(
        camera.position.x + (look.x / horiz) * reach * 0.72,
        Math.max(0, camera.position.y - height),
        camera.position.z + (look.z / horiz) * reach * 0.72,
      );
    }
    if (cfg.cascades === 1 && !focus) extent = Math.max(extent, 420);
    frameShadow(near, sun, centre, extent, cfg.nearSize, Math.max(900, extent * 3), scratch);

    const far = farRef.current;
    if (far) {
      // The far cascade rests on the site; it only moves if the player strays far away.
      const anchor = focus ?? camera.position;
      const fc = scratch.farCentre;
      if (Math.hypot(anchor.x - SITE_CENTRE.x, anchor.z - SITE_CENTRE.z) < cfg.farExtent * 0.55) fc.copy(SITE_CENTRE);
      else fc.set(Math.round(anchor.x / 250) * 250, 0, Math.round(anchor.z / 250) * 250);
      const moved = !fc.equals(lastFar.current);
      if (moved) {
        lastFar.current.copy(fc);
        frameShadow(far, sun, fc, cfg.farExtent, cfg.farSize, 4200, scratch);
      }
      if (!far.shadow.autoUpdate && (moved || frame.current % cfg.farInterval === 0)) far.shadow.needsUpdate = true;
    }
    frame.current++;
  });

  const nearTexel = (2 * cfg.playExtent) / cfg.nearSize;
  const farTexel = cfg.farExtent ? (2 * cfg.farExtent) / cfg.farSize : 1;
  return (
    <>
      <directionalLight
        key={`near-${cfg.nearSize}`}
        ref={nearRef}
        color={color}
        intensity={state.keyIntensity}
        castShadow
        shadow-mapSize-width={cfg.nearSize}
        shadow-mapSize-height={cfg.nearSize}
        shadow-bias={-0.00012}
        shadow-normalBias={Math.max(0.03, nearTexel * 1.4)}
        shadow-radius={2.6}
      />
      {cfg.cascades === 2 && (
        <directionalLight
          key={`far-${cfg.farSize}`}
          ref={farRef}
          color="#000000"
          intensity={0}
          castShadow
          shadow-mapSize-width={cfg.farSize}
          shadow-mapSize-height={cfg.farSize}
          shadow-bias={-0.00022}
          shadow-normalBias={farTexel * 1.6}
          shadow-radius={1.6}
        />
      )}
    </>
  );
}

/** Drifts the cumulus with the prevailing wind (higher and faster than the surface wind). */
function CloudDrift() {
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const w = atmosphereUniforms.pgCloudWind.value;
    // Seeded so that for the first quarter hour the cumulus shadows sweep the
    // surrounding plain and ranges while the facility itself stays in sun.
    w[0] = -4400 - WIND.x * 5.5 * t;
    w[1] = -1600 - WIND.z * 5.5 * t;
  });
  return null;
}

export function Lighting({
  time,
  tier = "high",
  shadowFocus = null,
  fogScale = 1,
}: {
  time: TimeOfDay;
  tier?: QualityTier;
  /** When set, the near shadow cascade follows this (mutated) point. */
  shadowFocus?: THREE.Vector3 | null;
  /** Aerial perspective strength (the top-down map view uses less). */
  fogScale?: number;
}) {
  const state = getSkyState(time);
  // Written during render so children (the environment capture) see it.
  useMemo(() => writeAtmosphere(state, fogScale), [state, fogScale]);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const previous = scene.background;
    scene.background = new THREE.Color(...state.solution.horizonSide.map((c) => c * state.radianceScale) as [number, number, number]);
    return () => {
      scene.background = previous;
    };
  }, [scene, state]);
  const { preset } = state;
  const low = tier === "low";
  // A fraction of the sky's ambient as a hemisphere light, so materials that
  // ignore scene.environment (Lambert) are not black in shade; the image-based
  // light carries the rest.
  const hemi = useMemo(() => {
    const e = state.solution.skyIrradiance.map((c) => c * state.radianceScale * HEMI_SHARE);
    const g = state.groundRadiance.map((c) => c * Math.PI * HEMI_SHARE);
    return { sky: new THREE.Color(e[0], e[1], e[2]), ground: new THREE.Color(g[0], g[1], g[2]) };
  }, [state]);

  return (
    <>
      <SkyDome state={state} low={low} />
      <SkyEnvironment state={state} intensity={preset.envIntensity * (1 - HEMI_SHARE)} />
      <hemisphereLight args={[hemi.sky, hemi.ground, 1]} />
      <CloudDrift />
      <SunCascades state={state} tier={tier} focus={shadowFocus} />
      <SiteLights level={preset.siteLights} tier={tier} />
    </>
  );
}
