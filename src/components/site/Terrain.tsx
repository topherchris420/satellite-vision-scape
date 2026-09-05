import { useMemo } from "react";
import * as THREE from "three";
import { trees, roadPath, interiorRoads } from "@/lib/site-layout";
import { terrainHeight, sampleTerrainFrame } from "@/lib/terrain";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483646;
}

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

// Distance check to avoid scattering objects onto roads or developed pads
function isNearRoadOrCompound(x: number, z: number): boolean {
  // Check main compound developed region
  if (x > -100 && x < 120 && z > 10 && z < 140) {
    return true;
  }
  // Check road centerlines
  const allRoads = [roadPath, ...interiorRoads];
  for (const path of allRoads) {
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, az] = path[i];
      const [bx, bz] = path[i + 1];
      const l2 = (bx - ax) ** 2 + (bz - az) ** 2;
      if (l2 === 0) continue;
      let t = ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / l2;
      t = Math.max(0, Math.min(1, t));
      const projX = ax + t * (bx - ax);
      const projZ = az + t * (bz - az);
      const distSq = (x - projX) ** 2 + (z - projZ) ** 2;
      if (distSq < 64) return true; // within 8m of road
    }
  }
  return false;
}

export function Terrain() {
  const tex = getSiteTextures();

  const dirtColor = useMemo(() => setRepeat(tex.dirtColor, 40, 40), [tex]);
  const dirtRough = useMemo(() => setRepeat(tex.dirtRough, 40, 40), [tex]);
  const dirtNormal = useMemo(() => setRepeat(tex.dirtNormal, 40, 40), [tex]);
  const vegColor = useMemo(() => setRepeat(tex.vegColor, 30, 40), [tex]);
  const grassColor = useMemo(() => setRepeat(tex.grassColor, 12, 14), [tex]);
  const grassRough = useMemo(() => setRepeat(tex.grassRough, 12, 14), [tex]);

  // Displaced ground geometry
  const groundGeom = useMemo(() => {
    const size = 900;
    const segs = 200;
    const geom = new THREE.PlaneGeometry(size, size, segs, segs);
    const pos = geom.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      pos.setZ(i, terrainHeight(x, -y));
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
    return geom;
  }, []);

  // Upgraded multi-scale splat shader material
  const groundMat = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      map: dirtColor,
      roughnessMap: dirtRough,
      normalMap: dirtNormal,
      normalScale: new THREE.Vector2(0.85, 0.85),
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
            "float macro = texture2D( uNoiseMask, vWPos.xz * 0.0012 + 0.15 ).r;",
            "float meso = texture2D( uNoiseMask, vWPos.xz * 0.008 + 0.42 ).r;",
            "float micro = texture2D( uNoiseMask, vWPos.xz * 0.04 + 0.77 ).r;",
            "float slope = clamp( 1.0 - vWNormal.y, 0.0, 1.0 );",
            "float rockW = smoothstep( 0.08, 0.25, slope ) + smoothstep( 10.0, 28.0, vWPos.y ) * 0.45;",
            "rockW = clamp( rockW * ( 0.65 + meso * 0.7 ), 0.0, 1.0 );",
            "float grassW = smoothstep( 0.4, 0.7, meso ) * ( 1.0 - rockW ) * smoothstep( 0.25, 0.03, slope );",
            "vec4 blended = mix( mix( baseC, grassC, grassW * 0.85 ), rockC, rockW );",
            "blended.rgb *= 0.82 + macro * 0.35 + (micro - 0.5) * 0.08;",
            "diffuseColor *= blended;",
          ].join("\n")
        );
    };
    return mat;
  }, [dirtColor, dirtRough, dirtNormal, vegColor, tex]);

  // Natural conformance for trees using sampleTerrainFrame
  const treeData = useMemo(() => {
    const r = rng(4242);
    return trees.map(([x, z]) => {
      const frame = sampleTerrainFrame(x, z);
      const s = 0.85 + r() * 1.35;
      const hgt = 1.1 + r() * 0.7;
      const hue = r();
      const lean = (r() - 0.5) * 0.1;
      return { x, z, y: frame.height, frame, s, hgt, hue, lean };
    });
  }, []);

  const trunkMatrices = useMemo(() => {
    return treeData.map(({ x, z, y, s, hgt, lean }) => {
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, y + s * hgt * 1.4, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(lean, 0, lean * 0.7)),
        new THREE.Vector3(s * 0.45, s * hgt, s * 0.45)
      );
      return m;
    });
  }, [treeData]);

  const canopyMatrices = useMemo(() => {
    return treeData.map(({ x, z, y, s, hgt }) => {
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, y + s * hgt * 2.8 + 1, z),
        new THREE.Quaternion(),
        new THREE.Vector3(s * 1.6, s * (1.2 + hgt * 0.4), s * 1.6)
      );
      return m;
    });
  }, [treeData]);

  const canopyTopMatrices = useMemo(() => {
    const r = rng(9191);
    return treeData.map(({ x, z, y, s, hgt }) => {
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x + (r() - 0.5) * s * 0.8, y + s * hgt * 2.8 + 1 + s * 1.0, z + (r() - 0.5) * s * 0.8),
        new THREE.Quaternion(),
        new THREE.Vector3(s * 1.1, s * 0.85, s * 1.1)
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

  // Boulders with Natural Conformance (terrain normal alignment)
  const rockMatrices = useMemo(() => {
    const r = rng(777);
    const out: THREE.Matrix4[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const qNorm = new THREE.Quaternion();
    const qRot = new THREE.Quaternion();

    for (let i = 0; i < 90; i++) {
      const x = 150 + r() * 190;
      const z = -200 + r() * 400;
      const frame = sampleTerrainFrame(x, z);
      const s = 0.5 + r() * 2.4;

      qNorm.setFromUnitVectors(up, frame.normal);
      qRot.setFromEuler(new THREE.Euler(r() * 0.3, r() * Math.PI * 2, r() * 0.3));
      qNorm.multiply(qRot);

      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, frame.height + s * 0.15, z),
        qNorm,
        new THREE.Vector3(s * (0.7 + r() * 0.7), s * (0.45 + r() * 0.5), s * (0.7 + r() * 0.7))
      );
      out.push(m);
    }
    return out;
  }, []);

  // Low scrub bushes with Natural Conformance
  const scrub = useMemo(() => {
    const r = rng(2468);
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const qNorm = new THREE.Quaternion();

    const place = (x: number, z: number) => {
      const frame = sampleTerrainFrame(x, z);
      const s = 0.5 + r() * 1.1;
      qNorm.setFromUnitVectors(up, frame.normal);
      qNorm.multiply(new THREE.Quaternion().setFromAxisAngle(up, r() * Math.PI * 2));

      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, frame.height + s * 0.25, z),
        qNorm,
        new THREE.Vector3(s * (0.9 + r() * 0.5), s * 0.55, s * (0.9 + r() * 0.5))
      );
      mats.push(m);
      cols.push(new THREE.Color().setHSL(0.16 + r() * 0.08, 0.28 + r() * 0.2, 0.2 + r() * 0.1));
    };

    for (let i = 0; i < 130; i++) place(-310 + r() * 210, -230 + r() * 460);
    for (let i = 0; i < 120; i++) place(150 + r() * 190, -210 + r() * 420);
    for (let i = 0; i < 40; i++) place(-90 + r() * 190, -230 + r() * 60);

    return { mats, cols };
  }, []);

  // Deterministic seeded scatter layer (small stones & spinifex grass clusters)
  const scatter = useMemo(() => {
    const r = rng(55512);
    const stoneMats: THREE.Matrix4[] = [];
    const grassMats: THREE.Matrix4[] = [];

    for (let i = 0; i < 350; i++) {
      const x = -350 + r() * 700;
      const z = -350 + r() * 700;
      if (isNearRoadOrCompound(x, z)) continue;

      const frame = sampleTerrainFrame(x, z);
      if (frame.slopeDegrees > 30) continue; // skip cliffs

      if (r() < 0.5) {
        // Small stone
        const s = 0.15 + r() * 0.35;
        const m = new THREE.Matrix4();
        m.compose(
          new THREE.Vector3(x, frame.height + s * 0.1, z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 0.5, r() * Math.PI * 2, r() * 0.5)),
          new THREE.Vector3(s, s * 0.6, s)
        );
        stoneMats.push(m);
      } else {
        // Dry grass cluster
        const s = 0.3 + r() * 0.5;
        const m = new THREE.Matrix4();
        m.compose(
          new THREE.Vector3(x, frame.height + s * 0.2, z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r() * Math.PI * 2, 0)),
          new THREE.Vector3(s, s * 0.8, s)
        );
        grassMats.push(m);
      }
    }
    return { stoneMats, grassMats };
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
        <meshStandardMaterial map={vegColor} roughness={1} color="#a86844" transparent opacity={0.85} />
      </mesh>

      {/* Green landscaped patch in lower yard */}
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
        <dodecahedronGeometry args={[1.5, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.9} />
      </instancedMesh>

      {/* Tree canopies — offset crown blob */}
      <instancedMesh
        args={[undefined, undefined, canopyTopMatrices.length]}
        castShadow
        ref={(inst) => fillInstances(inst, canopyTopMatrices, canopyColors)}
      >
        <dodecahedronGeometry args={[1.3, 1]} />
        <meshStandardMaterial color="#f4f8ee" roughness={0.9} />
      </instancedMesh>

      {/* Boulders on eastern hills */}
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

      {/* Deterministic stones scatter */}
      <instancedMesh
        args={[undefined, undefined, scatter.stoneMats.length]}
        castShadow
        receiveShadow
        ref={(inst) => fillInstances(inst, scatter.stoneMats)}
      >
        <dodecahedronGeometry args={[0.8, 0]} />
        <meshStandardMaterial map={tex.rockColor} color="#8c7860" roughness={0.95} />
      </instancedMesh>

      {/* Deterministic dry grass scatter */}
      <instancedMesh
        args={[undefined, undefined, scatter.grassMats.length]}
        receiveShadow
        ref={(inst) => fillInstances(inst, scatter.grassMats)}
      >
        <coneGeometry args={[0.6, 1.2, 5]} />
        <meshStandardMaterial color="#a08c50" roughness={0.9} />
      </instancedMesh>
    </group>
  );
}
