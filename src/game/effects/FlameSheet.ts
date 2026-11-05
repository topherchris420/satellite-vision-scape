import * as THREE from "three";

/**
 * A sheet of flame: one camera-facing quad (turned about the vertical only)
 * whose shader draws tongues of fire from scrolling noise, white-yellow at the
 * root, orange in the body and deep red where it breaks up. Additive, unlit,
 * outside tone mapping, so it reads as light at night and as heat haze-bright
 * fire by day. A burning wreck gets a few of these over its engine bay and
 * cab, with flame and ember particles around them.
 *
 * Presentation only.
 */

const VERTEX = /* glsl */ `
  uniform float uWidth;
  uniform float uHeight;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Cylindrical billboard: across the camera's right vector, up the world's.
    vec3 centre = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
    vec3 world = centre + right * position.x * uWidth + vec3(0.0, 1.0, 0.0) * (position.y + 0.5) * uHeight;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uHeat;
  uniform float uSeed;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = p * 2.03 + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return v;
  }
  void main() {
    float x = (vUv.x - 0.5) * 2.0;
    float y = vUv.y;
    float t = uTime;
    // Turbulence that rises: coarse tongues and fine flicker.
    float n = fbm(vec2(x * 1.9 + uSeed, y * 2.6 - t * 2.4));
    float m = fbm(vec2(x * 4.2 - uSeed * 0.7, y * 5.2 - t * 4.3));
    // Sway the whole sheet a little, more towards the tips.
    x += (n - 0.5) * 0.55 * y;
    float width = 1.0 - y * 0.82;
    float shape = 1.0 - smoothstep(0.15, 1.0, abs(x) / max(0.05, width));
    float f = shape * (1.15 - y * 1.05) + (n - 0.5) * 0.9 + (m - 0.5) * 0.45;
    f *= uHeat;
    f = clamp(f, 0.0, 1.0);
    vec3 deep = vec3(0.62, 0.07, 0.0);
    vec3 orange = vec3(1.0, 0.42, 0.04);
    vec3 core = vec3(1.0, 0.86, 0.48);
    vec3 col = mix(deep, orange, smoothstep(0.18, 0.52, f));
    col = mix(col, core, smoothstep(0.62, 0.95, f));
    float alpha = smoothstep(0.12, 0.42, f) * smoothstep(0.0, 0.08, y);
    gl_FragColor = vec4(col * alpha * 1.35, alpha);
  }
`;

export class FlameSheet {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(geometry: THREE.BufferGeometry, seed: number) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uHeat: { value: 0 },
        uSeed: { value: seed },
        uWidth: { value: 1.6 },
        uHeight: { value: 2.4 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = "flame-sheet";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  /** Place the sheet's root at (x, y, z) and size it; `heat` 0 hides it. */
  set(
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    heat: number,
    time: number,
  ): void {
    this.mesh.position.set(x, y, z);
    const u = this.material.uniforms;
    u.uWidth.value = width;
    u.uHeight.value = height;
    u.uHeat.value = heat;
    u.uTime.value = time;
    this.mesh.visible = heat > 0.01;
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
