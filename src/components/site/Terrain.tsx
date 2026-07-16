import { useMemo } from "react";
import * as THREE from "three";
import { trees } from "@/lib/site-layout";
import { terrainHeight } from "@/lib/terrain";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Fills an instanced mesh from precomputed matrices (and optional colors).
function fillInstances(
  inst: THREE.InstancedMesh | null,
  matrices: THREE.Matrix4[],
  colors?: THREE.Color[]
) {
  if (!inst) return;
  matrices.forEach((m, i) => inst.setMatrixAt(i, m));
  inst.instanceMatrix.needsUpdate = true;
  if (colors) {
    colors.forEach((c, i) => inst.setColorAt(i, c));
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  }
}

export function Terrain() {
  const tex = getSiteTextures();

  const dirtColor = useMemo(() => setRepeat(tex.dirtColor, 40, 40), [tex]);
  const dirtRough = useMemo(() => setRepeat(tex.dirtRough, 40, 40), [tex]);
  const dirtNormal = useMemo(() => setRepeat(tex.dirtNormal, 40, 40), [tex]);
  const vegColor = useMemo(() => setRepeat(tex.vegColor, 30, 40), [tex]);
  const grassColor = useMemo(() => setRepeat(tex.grassColor, 12, 14), [tex]);
  const grassRough = useMemo(() => setRepeat(tex.grassRough, 12, 14), [tex]);

  // Displaced ground: sample the shared height field so the eastern hills
  // rise up while the fenced pad stays flat.
  const groundGeom = useMemo(() => {
    const size = 900;
    const segs = 300;
    const geom = new THREE.PlaneGeometry(size, size, segs, segs);
    const pos = geom.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i); // plane's local Y maps to world Z after rotation
      pos.setZ(i, terrainHeight(x, -y));
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
    return geom;
  }, []);

  // Multi-layer splat material: dirt base blended with dry grass on gentle
  // low ground and exposed rock on steep/high slopes, with a macro noise
  // wash that kills texture tiling at satellite altitudes. All layers are
  // driven by world position + surface slope inside the standard PBR shader,
  // so lights/shadows/env still apply.
  const groundMat = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      map: dirtColor,
      roughnessMap: dirtRough,
      normalMap: dirtNormal,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 1,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGrassMap = { value: vegColor };
      shader.uniforms.uRockMap = { value: tex.rockColor };
      shader.uniforms.uNoiseMask = { value: tex.noiseMask };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;"
        )
        .replace(
          "#include <beginnormal_vertex>",
          "#include <beginnormal_vertex>\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);"
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;"
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          [
            "#include <common>",
            "varying vec3 vWPos;",
            "varying vec3 vWNormal;",
            "uniform sampler2D uGrassMap;",
            "uniform sampler2D uRockMap;",
            "uniform sampler2D uNoiseMask;",
          ].join("\n")
        )
        .replace(
          "#include <map_fragment>",
          [
            "vec4 baseC = texture2D( map, vMapUv );",
            "vec4 grassC = texture2D( uGrassMap, vWPos.xz * 0.05 );",
            "vec4 rockC = texture2D( uRockMap, vWPos.xz * 0.03 );",
            "float mask = texture2D( uNoiseMask, vWPos.xz * 0.0045 ).r;",
            "float mask2 = texture2D( uNoiseMask, vWPos.xz * 0.012 + 0.37 ).r;",
            "float slope = clamp( 1.0 - vWNormal.y, 0.0, 1.0 );",
            "float rockW = smoothstep( 0.10, 0.28, slope ) + smoothstep( 12.0, 30.0, vWPos.y ) * 0.5;",
            "rockW = clamp( rockW * ( 0.7 + mask * 0.6 ), 0.0, 1.0 );",
            "float grassW = smoothstep( 0.45, 0.72, mask2 ) * ( 1.0 - rockW ) * smoothstep( 0.22, 0.04, slope );",
            "vec4 blended = mix( mix( baseC, grassC, grassW * 0.85 ), rockC, rockW );",
            "float macro = texture2D( uNoiseMask, vWPos.xz * 0.0016 + 0.61 ).r;",
            "blended.rgb *= 0.84 + macro * 0.32;",
            "diffuseColor *= blended;",
          ].join("\n")
        );
    };
    return mat;
  }, [dirtColor, dirtRough, dirtNormal, vegColor, tex]);

  // Trees: trunk + a two-blob eucalypt canopy, snapped to terrain height,
  // deterministic scale, with per-instance canopy hue variation.
  const treeData = useMemo(() => {
    const r = rng(4242);
    return trees.map(([x, z]) => {
      const y = terrainHeight(x, z);
      const s = 0.8 + r() * 1.4;
      const hgt = 1.1 + r() * 0.7;
      const hue = r();
      const lean = (r() - 0.5) * 0.12;
      return { x, z, y, s, hgt, hue, lean };
    });
  }, []);

  const trunkMatrices = useMemo(() => {
    return treeData.map(({ x, z, y, s, hgt, lean }) => {
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, y + s * hgt * 1.5, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(lean, 0, lean * 0.7)),
        new THREE.Vector3(s * 0.5, s * hgt, s * 0.5)
      );
      return m;
    });
  }, [treeData]);

  const canopyMatrices = useMemo(() => {
    return treeData.map(({ x, z, y, s, hgt }) => {
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, y + s * hgt * 3 + 1, z),
        new THREE.Quaternion(),
        new THREE.Vector3(s * 1.6, s * (1.3 + hgt * 0.45), s * 1.6)
      );
      return m;
    });
  }, [treeData]);

  const canopyTopMatrices = useMemo(() => {
    const r = rng(9191);
    return treeData.map(({ x, z, y, s, hgt }) => {
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x + (r() - 0.5) * s, y + s * hgt * 3 + 1 + s * 1.1, z + (r() - 0.5) * s),
        new THREE.Quaternion(),
        new THREE.Vector3(s * 1.0, s * 0.9, s * 1.0)
      );
      return m;
    });
  }, [treeData]);

  const canopyColors = useMemo(
    () =>
      treeData.map(({ hue }) =>
        new THREE.Color().setHSL(0.23 + hue * 0.06, 0.32 + hue * 0.18, 0.2 + hue * 0.09)
      ),
    [treeData]
  );

  // Rocks scattered over the eastern hills — irregular scale + rotation.
  const rockMatrices = useMemo(() => {
    const r = rng(777);
    const out: THREE.Matrix4[] = [];
    for (let i = 0; i < 90; i++) {
      const x = 150 + r() * 190;
      const z = -200 + r() * 400;
      const s = 0.5 + r() * 2.4;
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, terrainHeight(x, z) + s * 0.15, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 0.6, r() * Math.PI * 2, r() * 0.6)),
        new THREE.Vector3(s * (0.7 + r() * 0.7), s * (0.45 + r() * 0.5), s * (0.7 + r() * 0.7))
      );
      out.push(m);
    }
    return out;
  }, []);

  // Low scrub bushes: western plain + eastern slopes.
  const scrub = useMemo(() => {
    const r = rng(2468);
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    const place = (x: number, z: number) => {
      const s = 0.5 + r() * 1.1;
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, terrainHeight(x, z) + s * 0.3, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r() * Math.PI * 2, 0)),
        new THREE.Vector3(s * (0.9 + r() * 0.5), s * 0.55, s * (0.9 + r() * 0.5))
      );
      mats.push(m);
      cols.push(new THREE.Color().setHSL(0.16 + r() * 0.08, 0.28 + r() * 0.2, 0.2 + r() * 0.1));
    };
    for (let i = 0; i < 130; i++) place(-310 + r() * 210, -230 + r() * 460); // western scrub
    for (let i = 0; i < 120; i++) place(150 + r() * 190, -210 + r() * 420); // eastern slopes
    for (let i = 0; i < 40; i++) place(-90 + r() * 190, -230 + r() * 60); // northern fringe
    return { mats, cols };
  }, []);

  return (
    <group name="terrain">
      {/* Displaced, splat-blended ground */}
      <mesh
        geometry={groundGeom}
        material={groundMat}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      />

      {/* Western dry scrub overlay */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-190, 0.05, 0]} receiveShadow>
        <planeGeometry args={[240, 520]} />
        <meshStandardMaterial map={vegColor} roughness={1} color="#9a7a48" transparent opacity={0.85} />
      </mesh>

      {/* Green landscaped patch in the lower yard (inside the fence).
          y sits below the parking aprons (0.06) to avoid z-fighting. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-40, 0.045, 132]} receiveShadow>
        <planeGeometry args={[80, 60]} />
        <meshStandardMaterial map={grassColor} roughnessMap={grassRough} roughness={0.9} color="#5a7d3a" transparent opacity={0.9} />
      </mesh>

      {/* Tree trunks */}
      <instancedMesh
        args={[undefined, undefined, trunkMatrices.length]}
        castShadow
        receiveShadow
        ref={(inst) => fillInstances(inst, trunkMatrices)}
      >
        <cylinderGeometry args={[0.28, 0.45, 2, 6]} />
        <meshStandardMaterial color="#5a4632" roughness={1} />
      </instancedMesh>

      {/* Tree canopies — main blob */}
      <instancedMesh
        args={[undefined, undefined, canopyMatrices.length]}
        castShadow
        receiveShadow
        ref={(inst) => fillInstances(inst, canopyMatrices, canopyColors)}
      >
        <icosahedronGeometry args={[1.5, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.95} />
      </instancedMesh>

      {/* Tree canopies — offset crown blob for irregular silhouettes */}
      <instancedMesh
        args={[undefined, undefined, canopyTopMatrices.length]}
        castShadow
        ref={(inst) => fillInstances(inst, canopyTopMatrices, canopyColors)}
      >
        <icosahedronGeometry args={[1.4, 1]} />
        <meshStandardMaterial color="#f4f8ee" roughness={0.95} />
      </instancedMesh>

      {/* Boulders on the eastern hills */}
      <instancedMesh
        args={[undefined, undefined, rockMatrices.length]}
        castShadow
        receiveShadow
        ref={(inst) => fillInstances(inst, rockMatrices)}
      >
        <dodecahedronGeometry args={[1, 0]} />
        <meshStandardMaterial map={tex.rockColor} color="#a08a70" roughness={0.95} />
      </instancedMesh>

      {/* Low scrub bushes */}
      <instancedMesh
        args={[undefined, undefined, scrub.mats.length]}
        castShadow
        ref={(inst) => fillInstances(inst, scrub.mats, scrub.cols)}
      >
        <icosahedronGeometry args={[1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={1} />
      </instancedMesh>
    </group>
  );
}
