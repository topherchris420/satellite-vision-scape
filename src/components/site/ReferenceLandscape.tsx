import { useEffect, useMemo } from "react";
import { useLoader } from "@react-three/fiber";
import * as THREE from "three";
import { SURFACE_TRACES, imageToSite, traceRect } from "@/lib/reference-layout";
import { sampleFootprintGrade } from "@/lib/terrain";
import { terrainMeshHeight } from "@/lib/terrain/mesh-grid";
import { getNoiseTexture } from "@/lib/terrain/noise-texture";
import { PLANT_LAYERS } from "@/lib/terrain/layer-textures";
import { imageMean } from "@/lib/vegetation/tree-materials";

function roundedSurface(width: number, depth: number, radius: number) {
  const x = -width / 2;
  const y = -depth / 2;
  const r = Math.min(radius, width / 3, depth / 3);
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + width - r, y);
  s.quadraticCurveTo(x + width, y, x + width, y + r);
  s.lineTo(x + width, y + depth - r);
  s.quadraticCurveTo(x + width, y + depth, x + width - r, y + depth);
  s.lineTo(x + r, y + depth);
  s.quadraticCurveTo(x, y + depth, x, y + depth - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ShapeGeometry(s, 12);
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * Irrigated lawn draped on the rendered terrain. `aEdge` is the distance to
 * the traced boundary in metres; the shader frays the boundary with noise so
 * the turf thins into red dirt instead of ending on a ruled line.
 */
function lawnGeometry(bounds: [number, number, number, number]) {
  const [u0, v0, u1, v1] = bounds;
  const a = imageToSite(u0, v0);
  const b = imageToSite(u1, v0);
  const c = imageToSite(u0, v1);
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const depth = Math.hypot(c[0] - a[0], c[1] - a[1]);
  // Finer than the 4 m terrain grid so no terrain vertex pokes through.
  const g = new THREE.PlaneGeometry(1, 1, Math.ceil(width / 2), Math.ceil(depth / 2));
  const p = g.getAttribute("position");
  const uv = g.getAttribute("uv");
  const edge = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const s = uv.getX(i);
    const t = 1 - uv.getY(i);
    const [x, z] = imageToSite(u0 + s * (u1 - u0), v0 + t * (v1 - v0));
    p.setXYZ(i, x, terrainMeshHeight(x, z) + 0.04, z);
    edge[i] = Math.min(s * width, (1 - s) * width, t * depth, (1 - t) * depth);
  }
  g.setAttribute("aEdge", new THREE.BufferAttribute(edge, 1));
  // The plane's original winding maps to an upward-facing XZ surface.
  g.computeVertexNormals();
  return g;
}

function createLawnMaterial(albedo: THREE.Texture, normal: THREE.Texture, rough: THREE.Texture, mean: THREE.Vector3) {
  const material = new THREE.MeshStandardMaterial({
    map: albedo,
    normalMap: normal,
    roughnessMap: rough,
    roughness: 1,
    normalScale: new THREE.Vector2(0.9, 0.9),
  });
  const uniforms = {
    tNoise: { value: getNoiseTexture() },
    uGrassMean: { value: mean },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float aEdge;\nvarying float vEdge;\nvarying vec3 vLawnWorld;",
      )
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvEdge = aEdge;\nvLawnWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform sampler2D tNoise;\nuniform vec3 uGrassMean;\nvarying float vEdge;\nvarying vec3 vLawnWorld;",
      )
      .replace(
        "#include <map_fragment>",
        `vec2 lP = vLawnWorld.xz;
vec4 lN = texture( tNoise, lP / 37.0 + 0.2 );
vec4 lM = texture( tNoise, lP / 9.0 + 0.6 );
// Ragged edge: the turf gives out a metre or two inside the trace.
float lEdge = vEdge - ( 0.4 + 2.2 * lM.x );
if ( lEdge < 0.0 ) discard;
// Two decorrelated taps break the repeat.
vec4 lA = texture2D( map, lP / 2.3 );
vec4 lB = texture2D( map, vec2( lP.y, -lP.x ) / 3.1 + 0.37 );
vec3 lDetail = mix( lA.rgb, lB.rgb, smoothstep( 0.35, 0.65, lN.z ) ) / max( uGrassMean, vec3( 1e-3 ) );
vec3 lush = vec3( 0.13, 0.23, 0.055 );
vec3 tired = vec3( 0.3, 0.27, 0.12 );
// Dry, worn patches where sprinklers miss, and a sunburnt fringe.
float dry = smoothstep( 0.6, 0.85, lN.x + 0.25 * ( lM.y - 0.5 ) ) * 0.55 + ( 1.0 - smoothstep( 0.0, 3.5, lEdge ) ) * 0.6;
vec3 lawn = mix( lush, tired, clamp( dry, 0.0, 1.0 ) ) * ( 0.85 + 0.3 * lN.w );
diffuseColor.rgb *= mix( vec3( 1.0 ), clamp( lDetail, vec3( 0.0 ), vec3( 2.0 ) ), 0.65 ) * lawn;`,
      )
      .replace(
        "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
        "vec3 mapN = texture2D( normalMap, lP / 2.3 ).xyz * 2.0 - 1.0;\n\tmapN = vec3( mapN.xy, sqrt( saturate( 1.0 - dot( mapN.xy, mapN.xy ) ) ) );",
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "float roughnessFactor = mix( 0.75, 1.0, texture2D( roughnessMap, lP / 2.3 ).g );",
      );
  };
  material.customProgramCacheKey = () => "campus-lawn";
  return material;
}

const base = `${import.meta.env.BASE_URL ?? "/"}assets/terrain/`;

/** Gardens and basins traced from the photograph; no random campus furniture.
 * The campus trees themselves are grown by the vegetation system. */
export function ReferenceLandscape() {
  const grassId = PLANT_LAYERS[2];
  const [albedo, normal, rough] = useLoader(THREE.TextureLoader, [
    `${base}${grassId}_albedo.webp`,
    `${base}${grassId}_nh.jpg`,
    `${base}${grassId}_rough.jpg`,
  ]);
  const lawnMaterial = useMemo(() => {
    albedo.colorSpace = THREE.SRGBColorSpace;
    for (const t of [albedo, normal, rough]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
    }
    return createLawnMaterial(albedo, normal, rough, imageMean(albedo.image as CanvasImageSource));
  }, [albedo, normal, rough]);
  useEffect(() => () => lawnMaterial.dispose(), [lawnMaterial]);

  const patches = useMemo(
    () =>
      SURFACE_TRACES.map((trace) => {
        const rect = traceRect(trace.bounds);
        const grade = sampleFootprintGrade(rect.pos, rect.size, rect.rotY);
        if (trace.kind === "lawn") {
          return { trace, rect, grade, geometry: lawnGeometry(trace.bounds), bank: null };
        }
        const r = trace.id.startsWith("pond") ? 6 : 0.6;
        return {
          trace,
          rect,
          grade,
          geometry: roundedSurface(...rect.size, r),
          bank: roundedSurface(rect.size[0] + 3, rect.size[1] + 3, r + 1),
        };
      }),
    [],
  );
  useEffect(
    () => () =>
      patches.forEach((p) => {
        p.geometry.dispose();
        p.bank?.dispose();
      }),
    [patches],
  );

  return (
    <group name="photo-traced-landscape">
      {patches.map(({ trace, rect, grade, geometry, bank }) =>
        trace.kind === "lawn" ? (
          <mesh key={trace.id} name={trace.id} geometry={geometry} material={lawnMaterial} receiveShadow />
        ) : (
          <group
            key={trace.id}
            name={trace.id}
            position={[rect.pos[0], grade.elevation + 0.07, rect.pos[1]]}
            rotation={[0, rect.rotY, 0]}
          >
            {bank && (
              <mesh geometry={bank} receiveShadow>
                <meshStandardMaterial color={trace.id === "pool" ? "#d0cabb" : "#8a6a52"} roughness={0.95} />
              </mesh>
            )}
            <mesh geometry={geometry} position={[0, 0.025, 0]} receiveShadow>
              {trace.kind === "water" ? (
                // Still, silty water: dark body, sharp sky reflection.
                <meshStandardMaterial
                  color={trace.color}
                  roughness={trace.id === "pool" ? 0.05 : 0.12}
                  metalness={0}
                  envMapIntensity={1.4}
                />
              ) : (
                <meshStandardMaterial color={trace.color} roughness={0.92} metalness={0} />
              )}
            </mesh>
          </group>
        ),
      )}
    </group>
  );
}
