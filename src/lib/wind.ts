import * as THREE from "three";

/**
 * Prevailing wind shared by clouds, suspended dust, tyre dust and vegetation
 * so the weather reads as one coherent system. Units are roughly m/s in the
 * world XZ plane.
 */
export const WIND = { x: 1.7, z: 0.8 } as const;

const windDirection = new THREE.Vector2(WIND.x, WIND.z).normalize();

/**
 * GPU uniforms for vegetation sway. A single object is shared by every
 * swaying material, so advancing `uWindTime` once per frame animates all of
 * them without touching any instance matrices on the CPU.
 */
export const windUniforms = {
  uWindTime: { value: 0 },
  uWindDir: { value: windDirection },
};

export type WindSwayOptions = {
  /** Peak horizontal displacement in metres at the reference height. */
  amplitude: number;
  /** Local-space height at which `amplitude` is reached. */
  referenceHeight: number;
  /** Temporal frequency of the base oscillation, radians per second. */
  frequency: number;
};

/**
 * Adds wind sway to an instanced material. Displacement is applied after the
 * instance transform, in model space, which equals world space for meshes
 * mounted at the origin (terrain scatter, campus trees). Displacement grows
 * with the square of local height so bases stay planted in the ground.
 */
export function applyWindSway(material: THREE.Material, options: WindSwayOptions): THREE.Material {
  const { amplitude, referenceHeight, frequency } = options;
  const key = `wind-${amplitude}-${referenceHeight}-${frequency}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windUniforms.uWindTime;
    shader.uniforms.uWindDir = windUniforms.uWindDir;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uWindTime;
uniform vec2 uWindDir;`,
      )
      .replace(
        "#include <project_vertex>",
        `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 windOrigin = ( instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
#else
  vec3 windOrigin = vec3( 0.0 );
#endif
float windHeight = clamp( transformed.y / ${referenceHeight.toFixed(3)}, 0.0, 1.6 );
float windPhase = dot( windOrigin.xz, vec2( 0.173, 0.211 ) );
float windWave = sin( uWindTime * ${frequency.toFixed(3)} + windPhase )
  + 0.45 * sin( uWindTime * ${(frequency * 2.3).toFixed(3)} + windPhase * 1.7 );
float windGust = 0.5 + 0.5 * sin( uWindTime * 0.37 + windOrigin.x * 0.004 );
mvPosition.xz += uWindDir * ( windWave * 0.6 + windGust ) * ${amplitude.toFixed(4)} * windHeight * windHeight;
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  material.customProgramCacheKey = () => key;
  return material;
}
