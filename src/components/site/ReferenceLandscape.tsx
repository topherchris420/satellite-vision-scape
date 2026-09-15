import { useMemo } from 'react';
import * as THREE from 'three';
import { SURFACE_TRACES, imageToSite, traceRect } from '@/lib/reference-layout';
import { trees } from '@/lib/site-layout';
import { terrainHeight, sampleFootprintGrade } from '@/lib/terrain';
import { getSiteTextures } from '@/lib/site-textures';

function roundedSurface(width: number, depth: number, radius: number) {
  const x = -width / 2, y = -depth / 2, r = Math.min(radius, width / 3, depth / 3);
  const s = new THREE.Shape();
  s.moveTo(x+r,y); s.lineTo(x+width-r,y); s.quadraticCurveTo(x+width,y,x+width,y+r);
  s.lineTo(x+width,y+depth-r); s.quadraticCurveTo(x+width,y+depth,x+width-r,y+depth);
  s.lineTo(x+r,y+depth); s.quadraticCurveTo(x,y+depth,x,y+depth-r);
  s.lineTo(x,y+r); s.quadraticCurveTo(x,y,x+r,y);
  const g = new THREE.ShapeGeometry(s, 12); g.rotateX(-Math.PI / 2); return g;
}

/** Gardens and basins traced from the photograph; no random campus furniture. */
export function ReferenceLandscape() {
  const tex = getSiteTextures();
  const patches = useMemo(() => SURFACE_TRACES.map(trace => {
    const rect = traceRect(trace.bounds), grade = sampleFootprintGrade(rect.pos, rect.size, rect.rotY);
    if (trace.kind === 'lawn') {
      const [u0,v0,u1,v1] = trace.bounds;
      const g = new THREE.PlaneGeometry(1,1,28,28), p = g.getAttribute('position'), uv = g.getAttribute('uv');
      for(let i=0;i<p.count;i++) {
        const [x,z] = imageToSite(u0+uv.getX(i)*(u1-u0), v0+(1-uv.getY(i))*(v1-v0));
        p.setXYZ(i,x,terrainHeight(x,z)+.035,z);
        uv.setXY(i,x/10,z/10);
      }
      // Plane's original winding maps to an upward facing XZ surface.
      g.computeVertexNormals();
      return { trace, rect, grade, geometry:g, bank:null };
    }
    const r = trace.id.startsWith('pond') ? 6 : .6;
    return { trace, rect, grade, geometry:roundedSurface(...rect.size,r), bank:roundedSurface(rect.size[0]+3,rect.size[1]+3,r+1) };
  }), []);
  const vegetation = useMemo(() => {
    const trunks: THREE.Matrix4[] = [], crowns: THREE.Matrix4[] = [], colors: THREE.Color[] = [];
    const q = new THREE.Quaternion();
    trees.forEach(([x,z],i) => {
      const y = terrainHeight(x,z), h = 3.5+(i*17%11)*.24;
      trunks.push(new THREE.Matrix4().compose(new THREE.Vector3(x,y+h/2,z),q,new THREE.Vector3(.25,h,.25)));
      for(let lobe=0;lobe<3;lobe++) {
        const a = lobe*Math.PI*2/3+i, r=2+(i*7%9)*.22;
        crowns.push(new THREE.Matrix4().compose(new THREE.Vector3(x+Math.cos(a)*r*.45,y+h+(.5-lobe*.2),z+Math.sin(a)*r*.45),q,new THREE.Vector3(r,r*.8,r*.9)));
        colors.push(new THREE.Color().setHSL(.19+(i%5)*.009,.14+(i%3)*.04,.16+(i%7)*.014));
      }
    });
    return { trunks,crowns,colors };
  }, []);
  const fill = (m: THREE.InstancedMesh | null, matrices: THREE.Matrix4[], colors?: THREE.Color[]) => {
    if(!m)return;
    matrices.forEach((matrix,i) => {m.setMatrixAt(i,matrix);if(colors)m.setColorAt(i,colors[i]);});
    m.instanceMatrix.needsUpdate=true;if(m.instanceColor)m.instanceColor.needsUpdate=true;m.computeBoundingSphere();
  };
  return <group name="photo-traced-landscape">
    {patches.map(({trace,rect,grade,geometry,bank}) => trace.kind==='lawn'
      ? <mesh key={trace.id} name={trace.id} geometry={geometry} receiveShadow><meshStandardMaterial color="#d8d6b8" map={tex.grassColor} roughness={1}/></mesh>
      : <group key={trace.id} name={trace.id} position={[rect.pos[0],grade.elevation+.07,rect.pos[1]]} rotation={[0,rect.rotY,0]}>
        {bank && <mesh geometry={bank} receiveShadow><meshStandardMaterial color={trace.id==='pool'?'#d0cabb':'#927d60'} roughness={.95}/></mesh>}
        <mesh geometry={geometry} position={[0,.025,0]} receiveShadow><meshStandardMaterial color={trace.color} roughness={trace.kind==='water'?.24:.95} metalness={0} envMapIntensity={.6}/></mesh>
      </group>)}
    <instancedMesh args={[undefined,undefined,vegetation.trunks.length]} ref={m=>fill(m,vegetation.trunks)} castShadow><cylinderGeometry args={[.7,1,1,6]}/><meshStandardMaterial color="#766c55" roughness={1}/></instancedMesh>
    <instancedMesh args={[undefined,undefined,vegetation.crowns.length]} ref={m=>fill(m,vegetation.crowns,vegetation.colors)} castShadow receiveShadow><icosahedronGeometry args={[1,2]}/><meshStandardMaterial roughness={1}/></instancedMesh>
  </group>;
}
