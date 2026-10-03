import * as THREE from "three";

/**
 * Scene-wide atmosphere hooks for every built-in three.js material:
 *
 * - Aerial perspective replaces three's distance fog: exponential height fog
 *   with per-channel extinction (distant ranges turn blue and pale) and an
 *   in-scattered colour taken from the solved sky, so far terrain melts into
 *   the real horizon colour instead of a flat grey.
 * - Two-cascade sun shadows: when the scene holds exactly two shadow-casting
 *   directional lights, the first is the lit sun with a tight near cascade
 *   and the second an unlit far cascade covering the whole site. Each
 *   fragment samples the near map, blends into the far map at its edge and
 *   fades out at the far map's edge.
 * - Drifting cumulus shadows on the sunlit ground, from the same noise field
 *   the sky draws.
 *
 * All parameters live in the shared `atmosphereUniforms` (typed arrays are
 * shared by reference when three clones material uniforms, so one write per
 * frame reaches every material). Each feature is gated by a uniform that
 * defaults to zero, so materials compiled without the uniforms fall back to
 * stock behaviour.
 */
const v3 = (x = 0, y = 0, z = 0) => new Float32Array([x, y, z]);
const v4 = (x = 0, y = 0, z = 0, w = 0) => new Float32Array([x, y, z, w]);

export const atmosphereUniforms = {
  /** Direction towards the key light. */
  pgSunDir: { value: v3(0, 1, 0) },
  /** Key light irradiance colour (scene units), for the haze glow and clouds. */
  pgSunColor: { value: v3() },
  /** Horizon radiance towards, across and away from the sun (scene units). */
  pgHazeToward: { value: v3() },
  pgHazeSide: { value: v3() },
  pgHazeAway: { value: v3() },
  /** x: extinction at the base height (1/m), y: height falloff (1/m), z: base height, w: strength (0 = stock fog). */
  pgFog: { value: v4() },
  /** Relative per-channel extinction. */
  pgFogExt: { value: v3(1, 1, 1) },
  /** x: Mie glow strength, y/z: world-edge fade start/end (m from the origin), w: unused. */
  pgFogMisc: { value: v4(0, 2350, 3000, 0) },
  /** x: coverage, y: edge sharpness, z: cloud altitude (m), w: ground shadow strength. */
  pgCloud: { value: v4(0.3, 3.2, 2400, 0) },
  /** xy: wind offset (m), z: noise frequency (1/m), w: unused. */
  pgCloudWind: { value: v4(0, 0, 1 / 2600, 0) },
  /** x: start of the near-to-far cascade blend (0..1 of the near map), y: enabled. */
  pgCascade: { value: v4(0.82, 0, 0, 0) },
};

/** Cloud coverage noise shared by the sky dome and the ground shadows. */
export const CLOUD_NOISE_GLSL = /* glsl */ `
vec2 pgHash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy ) * 2.0 - 1.0;
}
float pgGradNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  float a = dot( pgHash22( i ), f );
  float b = dot( pgHash22( i + vec2( 1.0, 0.0 ) ), f - vec2( 1.0, 0.0 ) );
  float c = dot( pgHash22( i + vec2( 0.0, 1.0 ) ), f - vec2( 0.0, 1.0 ) );
  float d = dot( pgHash22( i + vec2( 1.0, 1.0 ) ), f - vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
// Cumulus coverage in 0..1 at a world XZ position. "octaves" may be
// fractional: the last octave fades in, which is how distant clouds are
// filtered to avoid shimmering.
float pgCloudCoverage( vec2 xz, float octaves ) {
  vec2 p = ( xz + pgCloudWind.xy ) * pgCloudWind.z;
  vec2 warp = vec2( pgGradNoise( p * 0.45 + vec2( 3.1, 1.7 ) ), pgGradNoise( p * 0.45 + vec2( -7.7, 4.2 ) ) );
  p += warp * 0.85;
  float f = 0.0;
  float a = 0.56;
  const mat2 m = mat2( 1.62, 1.18, -1.18, 1.62 );
  for ( int i = 0; i < 6; i ++ ) {
    float w = clamp( octaves - float( i ), 0.0, 1.0 );
    if ( w <= 0.0 ) break;
    f += a * w * pgGradNoise( p );
    p = m * p + vec2( 1.7, 9.2 );
    a *= 0.48;
  }
  return clamp( ( f + pgCloud.x - 0.5 ) * pgCloud.y, 0.0, 1.0 );
}
`;

/** Aerial perspective shared by the fog chunk and the sky dome. */
export const AERIAL_GLSL = /* glsl */ `
vec3 pgHazeColor( vec3 rd ) {
  vec2 h = rd.xz;
  float hl = length( h );
  vec2 s = pgSunDir.xz;
  float sl = length( s );
  float side = ( hl > 1e-4 && sl > 1e-4 ) ? dot( h / hl, s / sl ) : 0.0;
  vec3 haze = side >= 0.0 ? mix( pgHazeSide, pgHazeToward, side * side ) : mix( pgHazeSide, pgHazeAway, side * side );
  float mu = dot( rd, pgSunDir );
  const float g = 0.76;
  float hg = ( 1.0 - g * g ) / ( 12.566371 * pow( max( 1.0 + g * g - 2.0 * g * mu, 1e-4 ), 1.5 ) );
  return haze + pgSunColor * hg * pgFogMisc.x;
}
// Transmittance along a camera ray through exponential height fog.
vec3 pgFogTransmittance( vec3 ro, vec3 rd, float dist ) {
  float b = pgFog.y;
  float k = b * rd.y * dist;
  float shape = abs( k ) > 1e-3 ? ( 1.0 - exp( - k ) ) / k : 1.0 - 0.5 * k;
  float od = pgFog.x * exp( - b * ( ro.y - pgFog.z ) ) * dist * shape * pgFog.w;
  return exp( - od * pgFogExt );
}
vec3 pgAerialPerspective( vec3 color, vec3 worldPos ) {
  vec3 ro = cameraPosition;
  vec3 rd = worldPos - ro;
  float dist = length( rd );
  rd /= max( dist, 1e-4 );
  vec3 T = pgFogTransmittance( ro, rd, dist );
  // The terrain ends a few kilometres out; melt its rim into the horizon.
  float edge = smoothstep( pgFogMisc.y, pgFogMisc.z, max( abs( worldPos.x ), abs( worldPos.z ) ) );
  T *= 1.0 - edge;
  return color * T + pgHazeColor( rd ) * ( 1.0 - T );
}
`;

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vPgFogWorld;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // World position from the view-space position (view matrices are rigid).
  vPgFogWorld = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vPgFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  #ifndef PG_SUN_DIR
  #define PG_SUN_DIR
  uniform vec3 pgSunDir;
  #endif
  uniform vec3 pgSunColor;
  uniform vec3 pgHazeToward;
  uniform vec3 pgHazeSide;
  uniform vec3 pgHazeAway;
  uniform vec4 pgFog;
  uniform vec3 pgFogExt;
  uniform vec4 pgFogMisc;
  ${AERIAL_GLSL}
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  if ( pgFog.w > 0.0 ) {
    gl_FragColor.rgb = pgAerialPerspective( gl_FragColor.rgb, vPgFogWorld );
  } else {
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  }
#endif
`;

const LIGHTS_PARS_ADDITION = /* glsl */ `
uniform vec4 pgCloud;
uniform vec4 pgCloudWind;
uniform vec4 pgCascade;
#ifndef PG_SUN_DIR
#define PG_SUN_DIR
uniform vec3 pgSunDir;
#endif
${CLOUD_NOISE_GLSL}
// Fraction of direct sunlight reaching a view-space point through the cumulus.
float pgCloudShadow( vec3 viewPos ) {
  if ( pgCloud.w <= 0.0 ) return 1.0;
  vec3 wp = ( ( vec4( viewPos, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
  float t = ( pgCloud.z - wp.y ) / max( pgSunDir.y, 0.08 );
  float d = pgCloudCoverage( wp.xz + pgSunDir.xz * t, 3.0 );
  return 1.0 - pgCloud.w * smoothstep( 0.02, 0.55, d );
}
`;

// Replaces the directional-light block of lights_fragment_begin.
const DIRECTIONAL_BLOCK = /* glsl */ `
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif

	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHTS == 2 && NUM_DIR_LIGHT_SHADOWS == 2

		// Two-cascade sun: light 0 is lit (near map), light 1 carries only the far map.
		directionalLight = directionalLights[ 0 ];
		getDirectionalLightInfo( directionalLight, directLight );
		if ( directLight.visible && receiveShadow ) {
			vec4 pgC0 = vDirectionalShadowCoord[ 0 ];
			vec3 pgP0 = pgC0.xyz / pgC0.w;
			float pgE0 = max( abs( pgP0.x - 0.5 ), abs( pgP0.y - 0.5 ) ) * 2.0;
			float pgBlend = pgP0.z > 1.0 ? 1.0 : smoothstep( pgCascade.x, 1.0, pgE0 );
			float pgShadow = 1.0;
			if ( pgBlend < 1.0 ) {
				directionalLightShadow = directionalLightShadows[ 0 ];
				pgShadow = getShadow( directionalShadowMap[ 0 ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, pgC0 );
			}
			if ( pgBlend > 0.0 ) {
				vec4 pgC1 = vDirectionalShadowCoord[ 1 ];
				vec3 pgP1 = pgC1.xyz / pgC1.w;
				float pgE1 = max( abs( pgP1.x - 0.5 ), abs( pgP1.y - 0.5 ) ) * 2.0;
				directionalLightShadow = directionalLightShadows[ 1 ];
				float pgFar = getShadow( directionalShadowMap[ 1 ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, pgC1 );
				pgFar = mix( pgFar, 1.0, smoothstep( 0.86, 1.0, pgE1 ) );
				pgShadow = mix( pgShadow, pgFar, pgBlend );
			}
			directLight.color *= pgShadow;
		}
		directLight.color *= pgCloudShadow( geometryPosition );
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	#else

		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

			directionalLight = directionalLights[ i ];

			getDirectionalLightInfo( directionalLight, directLight );

			#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
			directionalLightShadow = directionalLightShadows[ i ];
			directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
			#endif

			directLight.color *= pgCloudShadow( geometryPosition );

			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

		}
		#pragma unroll_loop_end

	#endif

#endif
`;

let installed = false;

/** Installs the chunks and shared uniforms. Idempotent; call before any material compiles. */
export function installAtmosphereShaders() {
  if (installed) return;
  installed = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  chunks.fog_pars_vertex = FOG_PARS_VERTEX;
  chunks.fog_vertex = FOG_VERTEX;
  chunks.fog_pars_fragment = FOG_PARS_FRAGMENT;
  chunks.fog_fragment = FOG_FRAGMENT;
  chunks.lights_pars_begin = chunks.lights_pars_begin + LIGHTS_PARS_ADDITION;

  const begin = chunks.lights_fragment_begin;
  const start = begin.indexOf("#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )");
  const end = begin.indexOf("#if ( NUM_RECT_AREA_LIGHTS > 0 )");
  if (start >= 0 && end > start) {
    chunks.lights_fragment_begin = begin.slice(0, start) + DIRECTIONAL_BLOCK + "\n" + begin.slice(end);
  } else if (import.meta.env?.DEV) {
    console.warn("Atmosphere: lights_fragment_begin layout changed; cascades and cloud shadows disabled.");
  }

  // Register the shared uniforms on every built-in material (and on the
  // uniform libraries custom ShaderMaterials merge from).
  const fogUniforms = {
    pgSunDir: atmosphereUniforms.pgSunDir,
    pgSunColor: atmosphereUniforms.pgSunColor,
    pgHazeToward: atmosphereUniforms.pgHazeToward,
    pgHazeSide: atmosphereUniforms.pgHazeSide,
    pgHazeAway: atmosphereUniforms.pgHazeAway,
    pgFog: atmosphereUniforms.pgFog,
    pgFogExt: atmosphereUniforms.pgFogExt,
    pgFogMisc: atmosphereUniforms.pgFogMisc,
  };
  const lightUniforms = {
    pgSunDir: atmosphereUniforms.pgSunDir,
    pgCloud: atmosphereUniforms.pgCloud,
    pgCloudWind: atmosphereUniforms.pgCloudWind,
    pgCascade: atmosphereUniforms.pgCascade,
  };
  const targets: Record<string, THREE.IUniform>[] = [
    THREE.UniformsLib.fog as unknown as Record<string, THREE.IUniform>,
    THREE.UniformsLib.lights as unknown as Record<string, THREE.IUniform>,
    ...Object.values(THREE.ShaderLib).map((s) => s.uniforms),
  ];
  for (const u of targets) {
    if ("fogColor" in u) Object.assign(u, fogUniforms);
    if ("directionalLights" in u) Object.assign(u, lightUniforms);
  }
}
