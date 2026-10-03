import * as THREE from "three";
import { windUniforms } from "@/lib/wind";

/**
 * Shared bark and foliage materials for every tree and shrub.
 *
 * Bark: photographic bark detail normalised by its mean and multiplied by the
 * per-vertex species colour, so one texture set serves white ghost gums and
 * near-black mulga alike. Normal maps ship as XY + height and are rebuilt.
 *
 * Foliage: alpha-tested atlas cards with coverage kept up at distance (alpha
 * boosted per mip level), normals not flipped on back faces, light
 * transmitted through backlit leaves (shadowed with the sun), and wind:
 * whole-crown sway growing with height plus per-leaf flutter.
 */

export type WindParams = { height: number; sway: number; flutter: number };

const windPars = /* glsl */ `
uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uTreeHeight;
uniform float uSway;
uniform float uFlutter;
`;

// Applied after the instance transform; `transformed` is still local.
const windVertex = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 windOrigin = ( instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
#else
  vec3 windOrigin = vec3( 0.0 );
#endif
float wH = clamp( transformed.y / uTreeHeight, 0.0, 1.4 );
float wPhase = dot( windOrigin.xz, vec2( 0.173, 0.211 ) );
float wWave = sin( uWindTime * 1.1 + wPhase ) + 0.4 * sin( uWindTime * 2.7 + wPhase * 1.7 );
float wGust = 0.55 + 0.45 * sin( uWindTime * 0.31 + windOrigin.x * 0.004 + windOrigin.z * 0.003 );
mvPosition.xz += uWindDir * ( wWave * 0.5 + wGust ) * uSway * wH * wH;
float wLeaf = dot( transformed, vec3( 3.1, 2.3, 1.7 ) ) + wPhase * 3.0;
mvPosition.xyz += vec3( sin( uWindTime * 7.3 + wLeaf ), sin( uWindTime * 9.1 + wLeaf * 1.3 ) * 0.6, cos( uWindTime * 6.7 + wLeaf ) )
  * uFlutter * wGust * wH;
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

function windUniformsFor(p: WindParams) {
  return {
    uWindTime: windUniforms.uWindTime,
    uWindDir: windUniforms.uWindDir,
    uTreeHeight: { value: p.height },
    uSway: { value: p.sway },
    uFlutter: { value: p.flutter },
  };
}

function injectWind(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: object) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${windPars}`)
    .replace("#include <project_vertex>", windVertex);
}

// Keeps leaf cards opaque as their mips average coverage away.
const alphaBoost = /* glsl */ `
#include <map_fragment>
#ifdef USE_MAP
{
  vec2 aTex = vMapUv * vec2( textureSize( map, 0 ) );
  vec2 aDx = dFdx( aTex );
  vec2 aDy = dFdy( aTex );
  float aLod = 0.5 * log2( max( dot( aDx, aDx ), dot( aDy, aDy ) ) );
  diffuseColor.a *= 1.0 + max( aLod, 0.0 ) * 0.3;
}
#endif
`;

function translucentLights() {
  let chunk = THREE.ShaderChunk.lights_fragment_begin;
  // Crowns are porous: let sun through their own shadow-map self-shadowing
  // in part, as scattering inside a real canopy does.
  const shadowLine = chunk.indexOf(
    "directLight.color *= ( directLight.visible && receiveShadow )",
    chunk.indexOf("getDirectionalLightInfo( directionalLight, directLight );"),
  );
  if (shadowLine > 0) {
    const lineEnd = chunk.indexOf(";", shadowLine);
    const expr = chunk.slice(shadowLine + "directLight.color *= ".length, lineEnd);
    chunk = `${chunk.slice(0, shadowLine)}directLight.color *= mix( ${expr}, 1.0, 0.35 )${chunk.slice(lineEnd)}`;
  }
  const dir = chunk.indexOf("getDirectionalLightInfo( directionalLight, directLight );");
  const call = chunk.indexOf("RE_Direct( directLight", dir);
  const end = chunk.indexOf(";", call) + 1;
  if (dir < 0 || call < 0) return chunk;
  return (
    chunk.slice(0, end) +
    `
		{
			// Sunlight through backlit leaves (already shadowed above).
			float tBack = pow( saturate( dot( - geometryViewDir, directLight.direction ) ), 4.0 );
			float tWrap = saturate( - dot( geometryNormal, directLight.direction ) ) * 0.35;
			reflectedLight.directDiffuse += material.diffuseColor * directLight.color * ( tBack * 0.85 + tWrap ) * 0.4;
		}` +
    chunk.slice(end)
  );
}

export function createLeafMaterials(atlas: THREE.Texture, atlasMean: THREE.Vector3, wind: WindParams) {
  const uniforms = { ...windUniformsFor(wind), uLeafMean: { value: atlasMean } };
  const material = new THREE.MeshStandardMaterial({
    map: atlas,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.72,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    injectWind(shader, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uLeafMean;")
      .replace("#include <map_fragment>", alphaBoost)
      // Painted leaves supply detail only; the species colour comes from the
      // vertex colours, so normalise the texture by its mean.
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb /= max( uLeafMean, vec3( 0.02 ) );")
      .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\nnormal = normalize( vNormal );")
      .replace("#include <lights_fragment_begin>", translucentLights());
  };
  material.customProgramCacheKey = () => "tree-leaves";

  const depth = new THREE.MeshDepthMaterial({
    map: atlas,
    alphaTest: 0.5,
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
  });
  depth.onBeforeCompile = (shader) => {
    injectWind(shader, uniforms);
    shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", alphaBoost);
  };
  depth.customProgramCacheKey = () => "tree-leaves-depth";
  return { material, depth, uniforms };
}

export function createBarkMaterials(
  albedo: THREE.Texture,
  normal: THREE.Texture,
  rough: THREE.Texture,
  mean: THREE.Vector3,
  wind: WindParams,
) {
  const uniforms = { ...windUniformsFor(wind), uBarkMean: { value: mean } };
  const material = new THREE.MeshStandardMaterial({
    map: albedo,
    normalMap: normal,
    roughnessMap: rough,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    normalScale: new THREE.Vector2(1.1, 1.1),
  });
  material.onBeforeCompile = (shader) => {
    injectWind(shader, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uBarkMean;")
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec4 barkTexel = texture2D( map, vMapUv );
  diffuseColor.rgb *= clamp( barkTexel.rgb / max( uBarkMean, vec3( 0.01 ) ), vec3( 0.0 ), vec3( 2.2 ) );
#endif`,
      )
      .replace(
        "mapN.xy *= normalScale;",
        "mapN = vec3( mapN.xy, sqrt( saturate( 1.0 - dot( mapN.xy, mapN.xy ) ) ) );\n\tmapN.xy *= normalScale;",
      );
  };
  material.customProgramCacheKey = () => "tree-bark";

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => injectWind(shader, uniforms);
  depth.customProgramCacheKey = () => "tree-bark-depth";
  return { material, depth, uniforms };
}

/** Mean linear colour of an image, for bark detail normalisation. */
export function imageMean(image: CanvasImageSource): THREE.Vector3 {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  const lin = (v: number) => ((v / 255 + 0.055) / 1.055) ** 2.4;
  const m = new THREE.Vector3();
  for (let i = 0; i < d.length; i += 4) m.add(new THREE.Vector3(lin(d[i]), lin(d[i + 1]), lin(d[i + 2])));
  return m.multiplyScalar(1 / 256);
}
