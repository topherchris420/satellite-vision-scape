import { useEffect, useLayoutEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  applySkyState,
  createFullscreenTriangle,
  createSkyLutTexture,
  createSkyMaterial,
} from "./skyMaterial";
import type { SkyState } from "./presets";

const triangle = createFullscreenTriangle();

/** Keeps the dome's view-ray reconstruction in step with whichever camera draws it. */
function bindCamera(mesh: THREE.Mesh, material: THREE.ShaderMaterial) {
  mesh.onBeforeRender = (renderer, _scene, camera) => {
    const u = material.uniforms;
    (u.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    const sky = u.uSky.value as THREE.Vector4;
    // Angular size of one pixel, for star and cloud filtering.
    const persp = camera as THREE.PerspectiveCamera;
    const h = renderer.getRenderTarget()?.height ?? renderer.domElement.height;
    sky.w = persp.isPerspectiveCamera ? ((persp.fov * Math.PI) / 180 / persp.zoom) / Math.max(1, h) : 0.002;
  };
}

/** The visible sky, drawn first behind everything. */
export function SkyDome({ state, low }: { state: SkyState; low: boolean }) {
  const material = useMemo(() => createSkyMaterial("view", low), [low]);
  const lut = useMemo(() => createSkyLutTexture(state.solution.lut), [state]);
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(triangle, material);
    m.name = "sky-dome";
    m.frustumCulled = false;
    m.renderOrder = -1e6;
    m.matrixAutoUpdate = false;
    bindCamera(m, material);
    return m;
  }, [material]);
  useEffect(() => applySkyState(material, state, lut), [material, state, lut]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => lut.dispose(), [lut]);
  useFrame(({ clock }) => {
    (material.uniforms.uSky.value as THREE.Vector4).z = clock.elapsedTime;
  });
  return <primitive object={mesh} />;
}

/**
 * Image-based lighting from the same sky: rendered into a cube once per
 * time of day (clouds included, sun excluded since it is the directional
 * light), prefiltered with PMREM and installed as scene.environment. A red
 * ground hemisphere gives the warm bounce light of the desert floor.
 */
export function SkyEnvironment({ state, intensity }: { state: SkyState; intensity: number }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  // The sky shader and the prefilter are kept between times of day: compiling
  // them again would stall every change of light for a second.
  const capture = useMemo(() => {
    const material = createSkyMaterial("env", false);
    const envScene = new THREE.Scene();
    const mesh = new THREE.Mesh(triangle, material);
    mesh.frustumCulled = false;
    bindCamera(mesh, material);
    envScene.add(mesh);
    return { material, envScene, pmrem: new THREE.PMREMGenerator(gl) };
  }, [gl]);
  useEffect(
    () => () => {
      capture.material.dispose();
      capture.pmrem.dispose();
    },
    [capture],
  );
  // Before the first compile, not after it: a material compiled without an
  // environment has to be compiled again with one.
  useLayoutEffect(() => {
    const lut = createSkyLutTexture(state.solution.lut);
    applySkyState(capture.material, state, lut);
    const target = capture.pmrem.fromScene(capture.envScene, 0, 0.1, 100);
    const previous = scene.environment;
    scene.environment = target.texture;
    lut.dispose();
    return () => {
      if (scene.environment === target.texture) scene.environment = previous;
      target.dispose();
    };
  }, [capture, scene, state]);
  useEffect(() => {
    scene.environmentIntensity = intensity;
  }, [scene, intensity]);
  return null;
}
