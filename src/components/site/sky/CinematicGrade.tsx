import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { BlendFunction, Effect } from "postprocessing";
import { Uniform, Vector3 } from "three";
import type { GradeSettings } from "./presets";

/**
 * Exposure, white balance, filmic tone mapping and per-time-of-day grading
 * in one pass. Works on the scene-referred HDR image (after bloom):
 *
 * 1. exposure and white balance in linear light,
 * 2. contrast pivoting on middle grey in log space, saturation,
 * 3. AgX tone mapping with a mild "punchy" look (graceful highlight
 *    roll-off: a sunset sky desaturates towards white instead of clipping),
 * 4. split toning (cool shadows, warm highlights) in display space,
 * 5. a natural lens vignette and very fine luminance grain.
 */
const FRAGMENT = /* glsl */ `
uniform float uExposure;
uniform vec3 uBalance;
uniform float uContrast;
uniform float uSaturation;
uniform float uDarkSaturation;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;

const vec3 PG_LUMA = vec3( 0.2126, 0.7152, 0.0722 );

vec3 pgAgxContrast( vec3 x ) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 pgAgx( vec3 color ) {
  const mat3 toRec2020 = mat3(
    vec3( 0.6274, 0.0691, 0.0164 ),
    vec3( 0.3293, 0.9195, 0.0880 ),
    vec3( 0.0433, 0.0113, 0.8956 )
  );
  const mat3 fromRec2020 = mat3(
    vec3( 1.6605, -0.1246, -0.0182 ),
    vec3( -0.5876, 1.1329, -0.1006 ),
    vec3( -0.0728, -0.0083, 1.1187 )
  );
  const mat3 inset = mat3(
    vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
  );
  const mat3 outset = mat3(
    vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ),
    vec3( -0.11060664309660323, 1.157823702216272, -0.11060664309660294 ),
    vec3( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 )
  );
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  color = inset * ( toRec2020 * color );
  color = clamp( ( log2( max( color, 1e-10 ) ) - minEv ) / ( maxEv - minEv ), 0.0, 1.0 );
  color = pgAgxContrast( color );
  // Look: a touch more contrast and colour than the base curve.
  color = pow( max( color, 0.0 ), vec3( 1.12 ) );
  float l = dot( color, PG_LUMA );
  color = l + 1.12 * ( color - l );
  color = outset * color;
  color = pow( max( color, 0.0 ), vec3( 2.2 ) );
  return clamp( fromRec2020 * color, 0.0, 1.0 );
}

float pgGrainHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
  vec3 c = max( inputColor.rgb, 0.0 ) * uExposure * uBalance;
  // Contrast around middle grey, in stops.
  vec3 stops = log2( max( c, 1e-7 ) / 0.18 );
  c = 0.18 * exp2( stops * uContrast );
  float l = dot( c, PG_LUMA );
  // Scotopic vision: dim tones lose their colour first (moonlit ground reads
  // blue-grey while lamp-lit surfaces keep theirs).
  float sat = mix( uDarkSaturation, uSaturation, smoothstep( 0.015, 0.25, l ) );
  c = max( l + sat * ( c - l ), 0.0 );
  c = pgAgx( c );
  float L = dot( c, PG_LUMA );
  c += uShadowTint * ( 1.0 - smoothstep( 0.0, 0.45, L ) ) + uHighlightTint * smoothstep( 0.35, 1.0, L );
  // Natural vignette (cos^4-like), slightly wider than tall.
  vec2 q = ( uv - 0.5 ) * vec2( 1.0, 0.82 );
  float v = 1.0 - uVignette * smoothstep( 0.05, 0.62, dot( q, q ) * 2.0 );
  c *= v;
  // Fine grain, strongest in the mid-tones, keeps gradients from banding.
  float g = pgGrainHash( gl_FragCoord.xy + fract( uTime * 13.7 ) * 512.0 ) - 0.5;
  c += g * uGrain * ( 0.25 + L * ( 1.0 - L ) );
  outputColor = vec4( max( c, 0.0 ), inputColor.a );
}
`;

class CinematicGradeEffect extends Effect {
  constructor() {
    super("CinematicGrade", FRAGMENT, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform<unknown>>([
        ["uExposure", new Uniform(1)],
        ["uBalance", new Uniform(new Vector3(1, 1, 1))],
        ["uContrast", new Uniform(1)],
        ["uSaturation", new Uniform(1)],
        ["uDarkSaturation", new Uniform(1)],
        ["uShadowTint", new Uniform(new Vector3())],
        ["uHighlightTint", new Uniform(new Vector3())],
        ["uVignette", new Uniform(0.2)],
        ["uGrain", new Uniform(0.012)],
        ["uTime", new Uniform(0)],
      ]),
    });
  }
}

export function CinematicGrade({ grade }: { grade: GradeSettings }) {
  const effect = useMemo(() => new CinematicGradeEffect(), []);
  useEffect(() => () => effect.dispose(), [effect]);
  useEffect(() => {
    const u = effect.uniforms;
    (u.get("uExposure") as Uniform<number>).value = grade.exposure;
    (u.get("uBalance") as Uniform<Vector3>).value.set(...grade.balance);
    (u.get("uContrast") as Uniform<number>).value = grade.contrast;
    (u.get("uSaturation") as Uniform<number>).value = grade.saturation;
    (u.get("uDarkSaturation") as Uniform<number>).value = grade.darkSaturation ?? grade.saturation;
    (u.get("uShadowTint") as Uniform<Vector3>).value.set(...grade.shadowTint);
    (u.get("uHighlightTint") as Uniform<Vector3>).value.set(...grade.highlightTint);
    (u.get("uVignette") as Uniform<number>).value = grade.vignette;
  }, [effect, grade]);
  useFrame(({ clock }) => {
    (effect.uniforms.get("uTime") as Uniform<number>).value = clock.elapsedTime;
  });
  return <primitive object={effect} dispose={null} />;
}
