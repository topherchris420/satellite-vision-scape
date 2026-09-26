import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { BlendFunction, Effect } from "postprocessing";
import { Uniform } from "three";
import type { AfterHoursPresentation } from "@/game/afterhours/AfterHours";

/**
 * Altered Signal colour grade: a slow split-tone that drifts between deep
 * teal, violet and amber (one full cycle takes about half a minute). It
 * never flashes, blurs or distorts, touches only the final image, and its
 * strength follows the player's effect intensity. Reduced motion freezes
 * the drift.
 */
class SpectralGradeEffect extends Effect {
  constructor() {
    super(
      "SpectralGrade",
      /* glsl */ `
      uniform float uIntensity;
      uniform float uPhase;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = inputColor.rgb;
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        vec3 teal = vec3(0.043, 0.365, 0.388);
        vec3 violet = vec3(0.46, 0.34, 0.74);
        vec3 amber = vec3(0.96, 0.72, 0.32);
        float a = 0.5 + 0.5 * sin(uPhase * 6.2831853);
        float b = 0.5 + 0.5 * sin(uPhase * 3.1415926 + 1.3);
        vec3 shadowTint = mix(teal, violet, a);
        // Shadows lean towards teal/violet, highlights keep a warm amber edge.
        vec3 graded = mix(c * (0.55 + shadowTint), c * (0.85 + amber * 0.25), smoothstep(0.25, 0.85, l));
        graded = mix(graded, graded + shadowTint * 0.06 * (1.0 - l), b);
        outputColor = vec4(mix(c, graded, uIntensity * 0.6), inputColor.a);
      }`,
      {
        blendFunction: BlendFunction.NORMAL,
        uniforms: new Map<string, Uniform<number>>([
          ["uIntensity", new Uniform(0)],
          ["uPhase", new Uniform(0)],
        ]),
      },
    );
  }
}

export function SpectralGrade({ presentation }: { presentation: AfterHoursPresentation }) {
  const effect = useMemo(() => new SpectralGradeEffect(), []);
  useEffect(() => () => effect.dispose(), [effect]);
  useFrame(() => {
    const u = effect.uniforms;
    (u.get("uIntensity") as Uniform<number>).value = presentation.altered;
    // ~28 s per full colour cycle; `time` stops advancing under reduced motion.
    (u.get("uPhase") as Uniform<number>).value = presentation.time / 28;
  });
  return <primitive object={effect} dispose={null} />;
}
