import * as THREE from "three";
import { AERIAL_GLSL, CLOUD_NOISE_GLSL, atmosphereUniforms } from "./shaderChunks";
import { SKY_LUT_HEIGHT, SKY_LUT_WIDTH, type Vec3 } from "./atmosphere";
import { bodyDirection, type SkyState } from "./presets";

/**
 * The sky dome: a full-screen triangle behind everything, so it works at any
 * field of view and never clips against the far plane. Per pixel it reads
 * the solved atmosphere from a small look-up texture and adds the sun disc,
 * a drifting cumulus layer with self-shadowing and silver linings, high
 * cirrus, and at night a procedural star field, the Milky Way (with its
 * dark dust rifts), the moon and the faint glow of Alice Springs on the
 * north-eastern horizon.
 *
 * The same material in "env" mode renders the image-based lighting cube
 * (no sun disc or stars: the sun is the directional light).
 */

const VERTEX = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
varying vec3 vDir;
void main() {
  vec4 view = uInvProj * vec4( position.xy, 1.0, 1.0 );
  vDir = mat3( uCamWorld ) * ( view.xyz / view.w );
  gl_Position = vec4( position.xy, 0.99999, 1.0 );
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uLut;
uniform vec3 pgSunDir;
uniform vec3 pgSunColor;
uniform vec3 pgHazeToward;
uniform vec3 pgHazeSide;
uniform vec3 pgHazeAway;
uniform vec4 pgFog;
uniform vec3 pgFogExt;
uniform vec4 pgFogMisc;
uniform vec4 pgCloud;
uniform vec4 pgCloudWind;

// x: LUT radiance scale, y: night (0..1), z: time (s), w: pixel angle (rad)
uniform vec4 uSky;
uniform vec3 uSunDisc;        // sun disc radiance
uniform vec3 uGround;         // distant ground radiance
uniform vec3 uCloudSun;       // sunlight on the clouds (radiance of a fully lit cloud)
uniform vec3 uCloudAmbTop;
uniform vec3 uCloudAmbBottom;
uniform vec4 uCloudLayer;     // x: cumulus density, y: cirrus strength, z: cirrus altitude, w: unused
uniform vec3 uMwCenter;
uniform vec3 uMwPole;
uniform vec3 uCityDir;

varying vec3 vDir;

#define PI 3.141592653589793

${CLOUD_NOISE_GLSL}
${AERIAL_GLSL}

vec3 skyLut( vec3 d ) {
  float elev = asin( clamp( d.y, 0.0, 1.0 ) );
  float v = sqrt( elev / ( 0.5 * PI ) );
  vec2 h = d.xz;
  vec2 s = pgSunDir.xz;
  float hl = length( h );
  float sl = length( s );
  float c = ( hl > 1e-5 && sl > 1e-5 ) ? dot( h / hl, s / sl ) : 1.0;
  float u = acos( clamp( c, -1.0, 1.0 ) ) / PI;
  return texture2D( uLut, vec2( u, v ) ).rgb * uSky.x;
}

float hgPhase( float mu, float g ) {
  float g2 = g * g;
  return ( 1.0 - g2 ) / ( 4.0 * PI * pow( max( 1.0 + g2 - 2.0 * g * mu, 1e-4 ), 1.5 ) );
}

#ifndef SKY_ENV
vec3 pgHash33( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.xxy + p.yxx ) * p.zyx );
}
float pgValueNoise3( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float n000 = pgHash33( i ).x;
  float n100 = pgHash33( i + vec3( 1, 0, 0 ) ).x;
  float n010 = pgHash33( i + vec3( 0, 1, 0 ) ).x;
  float n110 = pgHash33( i + vec3( 1, 1, 0 ) ).x;
  float n001 = pgHash33( i + vec3( 0, 0, 1 ) ).x;
  float n101 = pgHash33( i + vec3( 1, 0, 1 ) ).x;
  float n011 = pgHash33( i + vec3( 0, 1, 1 ) ).x;
  float n111 = pgHash33( i + vec3( 1, 1, 1 ) ).x;
  return mix(
    mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
    mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ),
    f.z
  );
}
float pgFbm3( vec3 p, int octaves ) {
  float f = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 6; i ++ ) {
    if ( i >= octaves ) break;
    f += a * pgValueNoise3( p );
    p = p * 2.03 + vec3( 1.7, 9.2, 4.1 );
    a *= 0.5;
  }
  return f;
}

// One layer of stars on a cube-face grid: at most one star per cell, kept
// away from cell borders so no star is ever clipped.
vec3 starLayer( vec3 d, float cells, float density, float seed, float gain ) {
  vec3 a = abs( d );
  vec2 uv;
  float face;
  float axis;
  if ( a.x >= a.y && a.x >= a.z ) { uv = d.yz / a.x; face = d.x > 0.0 ? 0.0 : 1.0; axis = a.x; }
  else if ( a.y >= a.z ) { uv = d.xz / a.y; face = d.y > 0.0 ? 2.0 : 3.0; axis = a.y; }
  else { uv = d.xy / a.z; face = d.z > 0.0 ? 4.0 : 5.0; axis = a.z; }
  vec2 g = ( uv * 0.5 + 0.5 ) * cells;
  vec2 cell = floor( g );
  vec3 h = pgHash33( vec3( cell, face * 131.0 + seed ) );
  if ( h.z > density ) return vec3( 0.0 );
  vec2 sp = cell + 0.3 + 0.4 * h.xy;
  // Angular size of a grid unit at this point of the face.
  float unitAngle = ( 2.0 / cells ) / ( 1.0 + dot( uv, uv ) );
  float ang = length( g - sp ) * unitAngle;
  float sigma = max( uSky.w * 0.62, 0.00012 );
  vec3 h2 = pgHash33( vec3( cell * 1.37, face + seed * 3.1 ) );
  // Heavy-tailed brightness: a few bright stars among many faint ones.
  float mag = 0.05 + 0.45 * pow( h2.x, 6.0 ) + 24.0 * pow( h2.x, 70.0 );
  // Spectral colour from cool red giants to hot blue stars.
  vec3 col = h2.y < 0.15 ? vec3( 1.0, 0.72, 0.48 ) : h2.y < 0.45 ? vec3( 1.0, 0.92, 0.8 ) : h2.y < 0.85 ? vec3( 0.92, 0.95, 1.0 ) : vec3( 0.7, 0.8, 1.0 );
  float twinkle = 1.0 + 0.35 * sin( uSky.z * ( 2.0 + 5.0 * h2.z ) + h2.z * 40.0 ) * step( 0.6, h2.x );
  return col * mag * twinkle * gain * exp( - ang * ang / ( 2.0 * sigma * sigma ) );
}

vec3 milkyWay( vec3 d, out float bandOut ) {
  vec3 side = normalize( cross( uMwPole, uMwCenter ) );
  float lat = asin( clamp( dot( d, uMwPole ), -1.0, 1.0 ) );
  float lon = atan( dot( d, side ), dot( d, uMwCenter ) );
  float width = 0.12 + 0.11 * exp( - lon * lon * 1.4 );
  float band = exp( - lat * lat / ( width * width ) );
  float bulge = exp( - ( lon * lon / 0.16 + lat * lat / 0.022 ) );
  #ifdef SKY_LOW
  int oct = 3;
  #else
  int oct = 5;
  #endif
  float clouds = pgFbm3( d * 7.0, oct );
  float knots = pgFbm3( d * 19.0 + 4.0, oct - 1 );
  float glow = band * ( 0.25 + 0.95 * smoothstep( 0.3, 0.75, clouds ) * ( 0.6 + 0.6 * knots ) ) + bulge * 1.6;
  // Dark dust rifts hugging the galactic plane, densest towards the core.
  float rift = smoothstep( 0.42, 0.68, pgFbm3( d * 11.0 + vec3( 7.0, 1.0, 3.0 ), oct ) );
  float riftBand = exp( - pow( ( lat + 0.02 * sin( lon * 3.0 ) ) / ( 0.045 + 0.05 * exp( - lon * lon * 2.0 ) ), 2.0 ) );
  float dust = 1.0 - 0.88 * rift * riftBand * smoothstep( 2.2, 0.3, abs( lon ) );
  dust *= 1.0 - 0.45 * smoothstep( 0.5, 0.8, pgFbm3( d * 23.0 + 2.0, oct - 1 ) ) * band;
  vec3 coolArm = vec3( 0.62, 0.72, 1.0 );
  vec3 warmCore = vec3( 1.0, 0.8, 0.58 );
  vec3 col = mix( coolArm, warmCore, clamp( bulge * 1.8 + exp( - lon * lon * 1.2 ) * 0.45, 0.0, 1.0 ) );
  bandOut = band * dust;
  return col * glow * dust;
}
#endif

void main() {
  vec3 d = normalize( vDir );
  float night = uSky.y;
  vec3 col;

  // Atmosphere above the horizon; the haze colour below it matches the
  // aerial perspective applied to distant terrain, so the rim is seamless.
  vec3 haze = pgHazeColor( d );
  if ( d.y >= 0.0 ) {
    col = mix( haze, skyLut( d ), smoothstep( 0.0, 0.045, d.y ) );
  } else {
    col = mix( haze, uGround, smoothstep( -0.02, -0.35, d.y ) * 0.55 );
  }

  float mu = dot( d, pgSunDir );
  float up = max( d.y, 0.0 );

  #ifndef SKY_ENV
  if ( night > 0.0 ) {
    // Airglow and the light dome of Alice Springs, low on the horizon.
    float horizon = exp( - up * 9.0 );
    col += night * vec3( 0.0011, 0.0016, 0.0015 ) * horizon;
    float town = pow( max( dot( normalize( d.xz + 1e-5 ), uCityDir.xz ), 0.0 ), 6.0 );
    col += night * vec3( 0.006, 0.0034, 0.0016 ) * town * exp( - up * 22.0 );
    if ( d.y > -0.02 ) {
      float fade = smoothstep( -0.02, 0.12, d.y ) * night;
      float band;
      vec3 mw = milkyWay( d, band );
      vec3 stars = starLayer( d, 150.0, 0.07 + 0.1 * band, 1.0, 1.0 )
        + starLayer( d, 230.0, 0.1 + 0.35 * band, 7.0, 0.5 )
        + starLayer( d, 340.0, 0.06 + 0.5 * band, 13.0, 0.28 );
      // Extinction near the horizon dims and reddens the stars.
      vec3 ext = exp( - vec3( 0.25, 0.4, 0.7 ) / max( d.y + 0.03, 0.03 ) * 0.12 );
      col += ( mw * 0.016 + stars * 0.1 ) * ext * fade;
      // The moon: a mottled disc with a soft halo.
      float moonR = 0.0085;
      float ang = acos( clamp( mu, -1.0, 1.0 ) );
      if ( ang < moonR * 1.2 ) {
        vec3 tangent = normalize( cross( pgSunDir, vec3( 0.0, 1.0, 0.0 ) ) );
        vec3 bitangent = cross( tangent, pgSunDir );
        vec2 q = vec2( dot( d, tangent ), dot( d, bitangent ) ) / moonR;
        float r = length( q );
        float maria = pgFbm3( vec3( q * 2.2, 3.0 ), 4 );
        float disc = smoothstep( 1.0, 0.94, r );
        vec3 moon = vec3( 1.0, 0.97, 0.92 ) * ( 0.75 - 0.35 * smoothstep( 0.45, 0.7, maria ) ) * ( 0.8 + 0.2 * sqrt( max( 1.0 - r * r, 0.0 ) ) );
        col = mix( col, moon * 2.2, disc );
      }
      col += vec3( 0.55, 0.62, 0.8 ) * 0.004 * exp( - ang * 40.0 ) * night;
    }
  } else {
    // Sun disc with limb darkening (drawn larger than life so it reads on
    // screen; bloom turns it into glare).
    float sunR = 0.0095;
    float ang = acos( clamp( mu, -1.0, 1.0 ) );
    if ( ang < sunR ) {
      float r = ang / sunR;
      float limb = 1.0 - 0.55 * ( 1.0 - sqrt( max( 1.0 - r * r, 0.0 ) ) );
      col += uSunDisc * limb * smoothstep( 1.0, 0.8, r ) * smoothstep( -0.01, 0.01, d.y );
    }
  }
  #endif

  // Cumulus layer, seen from below.
  if ( d.y > 0.0 && uCloudLayer.x > 0.0 ) {
    float t = ( pgCloud.z - cameraPosition.y ) / max( d.y, 0.012 );
    vec2 xz = cameraPosition.xz + d.xz * t;
    // Pixel footprint on the layer selects how many octaves can be resolved.
    float footprint = uSky.w * t / max( d.y, 0.06 );
    float period = 1.0 / pgCloudWind.z;
    #ifdef SKY_LOW
    float octaves = clamp( log2( period / max( footprint * 3.0, 1.0 ) ), 1.0, 3.0 );
    #else
    float octaves = clamp( log2( period / max( footprint * 3.0, 1.0 ) ), 1.0, 6.0 );
    #endif
    float dens = pgCloudCoverage( xz, octaves );
    if ( dens > 0.001 ) {
      vec2 sd = pgSunDir.xz / max( length( pgSunDir.xz ), 1e-4 );
      float reach = period * 0.035 * clamp( 0.5 / max( pgSunDir.y, 0.1 ), 0.6, 3.0 );
      float od = pgCloudCoverage( xz + sd * reach, min( octaves, 3.0 ) );
      #ifndef SKY_LOW
      od += 0.7 * pgCloudCoverage( xz + sd * reach * 2.6, min( octaves, 2.0 ) );
      od += 0.5 * pgCloudCoverage( xz + sd * reach * 5.5, 2.0 );
      #endif
      float k = uCloudLayer.x;
      float sunVis = exp( - od * 0.55 * k );
      float thick = dens * k;
      // Thin edges transmit forward-scattered light (silver linings); thick
      // cores stay bright from light scattered many times inside the cloud;
      // low on the horizon we see the sunlit flanks and tops.
      float phase = 0.6 + 3.4 * hgPhase( mu, 0.62 ) + 1.1 * hgPhase( mu, -0.25 );
      float transmit = exp( - thick * 1.5 );
      float flank = 1.0 - smoothstep( 0.02, 0.3, d.y );
      float powder = 1.0 - 0.35 * exp( - dens * 6.0 );
      float sunTerm = ( 0.4 + 0.6 * sunVis ) * mix( 0.55 + 0.45 * transmit, 1.0, flank ) * phase * powder;
      vec3 amb = mix( uCloudAmbBottom, uCloudAmbTop, 0.35 + 0.45 * ( 1.0 - thick ) + 0.2 * flank );
      vec3 cloud = uCloudSun * sunTerm + amb * ( 1.7 - 0.5 * thick );
      float alpha = smoothstep( 0.0, 0.16, dens ) * clamp( 0.6 + 0.5 * k, 0.0, 1.0 );
      alpha *= smoothstep( 0.0, 0.035, d.y );
      // Aerial perspective: distant clouds sink into the horizon haze.
      float aerial = exp( - t / 26000.0 );
      cloud = mix( haze, cloud, aerial );
      col = mix( col, cloud, alpha * ( 0.35 + 0.65 * aerial ) );
    }
  }

  #ifndef SKY_LOW
  // High cirrus streaks, combed out along the wind.
  if ( d.y > 0.0 && uCloudLayer.y > 0.0 ) {
    float t = ( uCloudLayer.z - cameraPosition.y ) / max( d.y, 0.02 );
    vec2 p = cameraPosition.xz + d.xz * t + pgCloudWind.xy * 1.6;
    vec2 q = vec2( dot( p, vec2( 0.9, 0.44 ) ) / 9000.0, dot( p, vec2( -0.44, 0.9 ) ) / 2600.0 );
    q += 0.35 * vec2( pgGradNoise( q * 1.3 + 5.0 ), pgGradNoise( q * 1.3 - 3.0 ) );
    float n = 0.5 * pgGradNoise( q ) + 0.25 * pgGradNoise( q * vec2( 2.1, 3.7 ) ) + 0.125 * pgGradNoise( q * vec2( 4.3, 8.1 ) );
    float ci = smoothstep( 0.02, 0.38, n ) * uCloudLayer.y;
    ci *= smoothstep( 0.0, 0.08, d.y ) * exp( - t / 60000.0 );
    vec3 cirrus = uCloudSun * ( 0.45 + 2.2 * hgPhase( mu, 0.7 ) ) + uCloudAmbTop * 0.8;
    col = mix( col, cirrus, ci * 0.42 );
  }
  #endif

  gl_FragColor = vec4( col, 1.0 );
}
`;

export type SkyMaterialMode = "view" | "env";

/** Float LUT (RGBA) to a half-float texture with linear filtering. */
export function createSkyLutTexture(lut: Float32Array): THREE.DataTexture {
  const half = new Uint16Array(lut.length);
  for (let i = 0; i < lut.length; i++) half[i] = THREE.DataUtils.toHalfFloat(lut[i]);
  const tex = new THREE.DataTexture(half, SKY_LUT_WIDTH, SKY_LUT_HEIGHT, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const vec3 = (v: Vec3) => new THREE.Vector3(v[0], v[1], v[2]);

// The Milky Way's orientation for a mid-evening winter sky: the bright core
// low in the east-north-east, the band climbing steeply towards the zenith.
const MW_CENTER = vec3(bodyDirection(70, 24));
const MW_POLE = (() => {
  const along = vec3(bodyDirection(20, 72));
  const pole = new THREE.Vector3().crossVectors(MW_CENTER, along).normalize();
  return pole;
})();
const CITY_DIR = vec3(bodyDirection(42, 0));

export function createSkyMaterial(mode: SkyMaterialMode, low: boolean) {
  const defines: Record<string, string> = {};
  if (mode === "env") defines.SKY_ENV = "";
  if (low) defines.SKY_LOW = "";
  const material = new THREE.ShaderMaterial({
    name: mode === "env" ? "SkyEnvironment" : "SkyDome",
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    defines,
    uniforms: {
      ...atmosphereUniforms,
      uLut: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uSky: { value: new THREE.Vector4(1, 0, 0, 0.001) },
      uSunDisc: { value: new THREE.Vector3() },
      uGround: { value: new THREE.Vector3() },
      uCloudSun: { value: new THREE.Vector3() },
      uCloudAmbTop: { value: new THREE.Vector3() },
      uCloudAmbBottom: { value: new THREE.Vector3() },
      uCloudLayer: { value: new THREE.Vector4(1, 0, 9000, 0) },
      uMwCenter: { value: MW_CENTER },
      uMwPole: { value: MW_POLE },
      uCityDir: { value: CITY_DIR },
    },
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  return material;
}

/** Writes the per-time-of-day constants of a sky state into a sky material. */
export function applySkyState(material: THREE.ShaderMaterial, state: SkyState, lut: THREE.Texture) {
  const u = material.uniforms;
  const { preset, keyColor, keyIntensity, radianceScale, solution, groundRadiance } = state;
  u.uLut.value = lut;
  const sky = u.uSky.value as THREE.Vector4;
  sky.x = radianceScale;
  sky.y = preset.night;
  const sunDisc = u.uSunDisc.value as THREE.Vector3;
  sunDisc.set(keyColor[0], keyColor[1], keyColor[2]).multiplyScalar(keyIntensity * 26);
  (u.uGround.value as THREE.Vector3).set(...groundRadiance);
  // A fully sunlit cumulus top reflects most of the incident sunlight.
  (u.uCloudSun.value as THREE.Vector3)
    .set(keyColor[0], keyColor[1], keyColor[2])
    .multiplyScalar((keyIntensity * 0.85) / Math.PI);
  const irr = solution.skyIrradiance;
  const amb = new THREE.Vector3(irr[0], irr[1], irr[2]).multiplyScalar(radianceScale / Math.PI);
  (u.uCloudAmbTop.value as THREE.Vector3).copy(amb).multiplyScalar(1.15);
  // Cloud bases also see the red ground below them.
  (u.uCloudAmbBottom.value as THREE.Vector3)
    .set(...groundRadiance)
    .multiplyScalar(0.45)
    .addScaledVector(amb, 0.6);
  const layer = u.uCloudLayer.value as THREE.Vector4;
  layer.x = preset.clouds.density * (preset.clouds.coverage > 0 ? 1 : 0);
  layer.y = preset.clouds.cirrus;
  layer.z = 9000;
}

/** Full-screen triangle (clip-space positions). */
export function createFullscreenTriangle() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}
