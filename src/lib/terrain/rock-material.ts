import * as THREE from "three";
import type { PackedLayers } from "./layer-textures";

/**
 * Material for boulders, outcrops and termite mounds: world-space triplanar
 * projection of one of the ground layers (so a boulder's grain matches the
 * cliffs it fell from), re-tinted like the ground, with a dusting of red sand
 * settled on upward faces and a darker, damp-looking skirt where it meets the
 * soil. Works with InstancedMesh (instance colour varies the tone).
 */
export type RockMaterialOptions = {
  layer: number;
  /** sRGB tint of the body. */
  tint: string;
  /** World metres per texture repeat. */
  scale: number;
  /** Amount of sand settled on top faces, 0..1. */
  dust: number;
  normalStrength?: number;
};

export function createRockMaterial(layers: PackedLayers, o: RockMaterialOptions) {
  const tint = new THREE.Color(o.tint);
  const uniforms = {
    tAlbedo: { value: layers.albedo },
    tDetail: { value: layers.detail },
    uRockMean: { value: layers.mean[o.layer] },
    uSandMean: { value: layers.mean[0] },
    uRockTint: { value: new THREE.Vector3(tint.r, tint.g, tint.b) },
    uSandTint: { value: new THREE.Vector3().setFromColor(new THREE.Color("#a9593c")) },
  };
  const material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vRockWorld;
varying vec3 vRockNormal;
varying float vRockBase;`,
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
{
  mat4 rockModel = modelMatrix;
#ifdef USE_INSTANCING
  rockModel = modelMatrix * instanceMatrix;
#endif
  vRockWorld = ( rockModel * vec4( transformed, 1.0 ) ).xyz;
  vRockNormal = normalize( mat3( rockModel ) * objectNormal );
  vRockBase = transformed.y;
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform highp sampler2DArray tAlbedo;
uniform highp sampler2DArray tDetail;
uniform vec3 uRockMean;
uniform vec3 uSandMean;
uniform vec3 uRockTint;
uniform vec3 uSandTint;
varying vec3 vRockWorld;
varying vec3 vRockNormal;
varying float vRockBase;`,
      )
      .replace(
        "#include <map_fragment>",
        `vec3 rN = normalize( vRockNormal );
vec3 rBl = pow( abs( rN ), vec3( 4.0 ) );
rBl /= rBl.x + rBl.y + rBl.z;
vec3 rP = vRockWorld / ${o.scale.toFixed(3)};
vec3 rSign = sign( rN );
vec4 rAx = texture( tAlbedo, vec3( vec2( rP.z * rSign.x, rP.y ), ${o.layer}.0 ) );
vec4 rAy = texture( tAlbedo, vec3( rP.xz, ${o.layer}.0 ) );
vec4 rAz = texture( tAlbedo, vec3( vec2( -rP.x * rSign.z, rP.y ), ${o.layer}.0 ) );
vec4 rDx = texture( tDetail, vec3( vec2( rP.z * rSign.x, rP.y ), ${o.layer}.0 ) );
vec4 rDy = texture( tDetail, vec3( rP.xz, ${o.layer}.0 ) );
vec4 rDz = texture( tDetail, vec3( vec2( -rP.x * rSign.z, rP.y ), ${o.layer}.0 ) );
vec4 rA = rAx * rBl.x + rAy * rBl.y + rAz * rBl.z;
vec4 rD = rDx * rBl.x + rDy * rBl.y + rDz * rBl.z;
vec3 rCol = uRockTint * clamp( rA.rgb / max( uRockMean, vec3( 1e-3 ) ), vec3( 0.0 ), vec3( 3.0 ) );
// Sand settles on upward faces and in the texture's low spots.
float rDust = smoothstep( 0.45, 0.85, rN.y + ( 0.5 - rD.b ) * 0.6 ) * ${o.dust.toFixed(3)};
vec4 rSand = texture( tAlbedo, vec3( vRockWorld.xz / 3.2, 0.0 ) );
vec3 sandCol = uSandTint * clamp( rSand.rgb / max( uSandMean, vec3( 1e-3 ) ), vec3( 0.0 ), vec3( 3.0 ) );
rCol = mix( rCol, sandCol, rDust );
// Darker skirt where the stone sits in the soil.
rCol *= mix( 0.62, 1.0, smoothstep( 0.0, 0.35, vRockBase ) );
diffuseColor.rgb *= rCol;
float rRough = mix( rA.a, 0.95, rDust );`,
      )
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = clamp( mix( 0.6, 1.0, rRough ), 0.45, 1.0 );")
      .replace(
        "#include <normal_fragment_maps>",
        `{
  float ns = ${(o.normalStrength ?? 1.2).toFixed(2)} * ( 1.0 - rDust * 0.6 );
  vec2 tx = ( rDx.rg * 2.0 - 1.0 ) * ns;
  vec2 ty = ( rDy.rg * 2.0 - 1.0 ) * ns;
  vec2 tz = ( rDz.rg * 2.0 - 1.0 ) * ns;
  tx.x *= rSign.x;
  tz.x *= -rSign.z;
  vec3 wx = vec3( tx + rN.zy, rN.x );
  vec3 wy = vec3( ty + rN.xz, rN.y );
  vec3 wz = vec3( tz + rN.xy, rN.z );
  vec3 wN = normalize( wx.zyx * rBl.x + wy.xzy * rBl.y + wz.xyz * rBl.z );
  normal = normalize( ( viewMatrix * vec4( wN, 0.0 ) ).xyz );
}`,
      );
  };
  material.customProgramCacheKey = () => `rock-${o.layer}-${o.scale}-${o.dust}`;
  return material;
}
