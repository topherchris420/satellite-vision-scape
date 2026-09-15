import * as THREE from 'three';
import { terrainHeight } from './terrain';
import { RADOME_SHELL_LIFT } from './site-layout';
/** Clip every intersecting geodesic triangle against the foundation plane. */
export function createRadomeShell(radius:number,detail=5) {
  const source=new THREE.IcosahedronGeometry(radius,detail),p=source.attributes.position;
  const cut=-RADOME_SHELL_LIFT*radius,verts:number[]=[],normals:number[]=[],uvs:number[]=[];
  for(let i=0;i<p.count;i+=3){
    const tri=[0,1,2].map(j=>new THREE.Vector3(p.getX(i+j),p.getY(i+j),p.getZ(i+j))),clipped:THREE.Vector3[]=[];
    for(let j=0;j<3;j++){
      const a=tri[j],b=tri[(j+1)%3];
      if(a.y>=cut)clipped.push(a);
      if((a.y>=cut)!==(b.y>=cut))clipped.push(a.clone().lerp(b,(cut-a.y)/(b.y-a.y)));
    }
    for(let j=1;j<clipped.length-1;j++) {
      const triangle = [clipped[0],clipped[j],clipped[j+1]];
      const us = triangle.map(v => .5+Math.atan2(v.z,v.x)/(2*Math.PI));
      // Unwrap triangles crossing the longitude seam so their texture does not
      // smear across the full atlas. RepeatWrapping joins the two sides.
      if (Math.max(...us)-Math.min(...us) > .5) {
        for (let k=0;k<us.length;k++) if(us[k]<.5) us[k]+=1;
      }
      triangle.forEach((v,k) => {
        verts.push(v.x,v.y,v.z);const n=v.clone().normalize();normals.push(n.x,n.y,n.z);
        uvs.push(us[k],.5+Math.asin(n.y)/Math.PI);
      });
    }
  }
  source.dispose();const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));return g;
}
/** Dense draped ribbons: both edges follow ground, including the closing span. */
export function createGroundRibbon(points:[number,number][],width:number,offset=.08,closed=false){
  const pts=closed&&points.length?[...points,points[0]]:points,samples:[number,number][]=[];
  for(let i=0;i<pts.length-1;i++){
    const a=pts[i],b=pts[i+1],n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/2));
    for(let j=0;j<n;j++)samples.push([a[0]+(b[0]-a[0])*j/n,a[1]+(b[1]-a[1])*j/n]);
  }
  if(pts.length)samples.push(pts[pts.length-1]);
  const verts:number[]=[],uvs:number[]=[],indices:number[]=[];let distance=0;
  samples.forEach((p,i)=>{
    const prev=samples[i===0&&closed?samples.length-2:Math.max(0,i-1)];
    const next=samples[i===samples.length-1&&closed?1:Math.min(samples.length-1,i+1)];
    const tangent=new THREE.Vector2(next[0]-prev[0],next[1]-prev[1]).normalize();
    for(const sign of [1,-1]){const x=p[0]-tangent.y*width*.5*sign,z=p[1]+tangent.x*width*.5*sign;verts.push(x,terrainHeight(x,z)+offset,z);}
    if(i)distance+=Math.hypot(p[0]-samples[i-1][0],p[1]-samples[i-1][1]);uvs.push(0,distance/width,1,distance/width);
    if(i<samples.length-1){const a=i*2;indices.push(a,a+2,a+1,a+1,a+2,a+3);}
  });
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));g.setIndex(indices);g.computeVertexNormals();return g;
}

/** An apron follows the terrain instead of hovering at the foundation height.
 * Local coordinates allow reuse inside a translated structure group. UVs use
 * metres, so large and small pads have the same aggregate size.
 */
export function createGroundApron(center: [number, number], radius: number, elevation: number) {
  const segments = 64;
  const rings = Math.max(2, Math.ceil(radius / 1.5));
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let ring = 0; ring <= rings; ring++) {
    for (let j = 0; j <= segments; j++) {
      const angle = j / segments * Math.PI * 2;
      const x = Math.cos(angle) * radius * ring / rings;
      const z = Math.sin(angle) * radius * ring / rings;
      positions.push(x, terrainHeight(center[0] + x, center[1] + z) - elevation + 0.045, z);
      uvs.push(x / 6, z / 6);
      if (ring < rings && j < segments) {
        const a = ring * (segments + 1) + j, b = a + segments + 1;
        if (ring > 0) indices.push(a, a + 1, b);
        indices.push(a + 1, b + 1, b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Curved panel joints sit on the smooth shell, independent of render LOD. */
export function createRadomePanelLines(radius: number) {
  const source = new THREE.IcosahedronGeometry(radius, 5);
  const wire = new THREE.WireframeGeometry(source);
  const p = wire.getAttribute('position'), vertices: number[] = [];
  const cut = -RADOME_SHELL_LIFT * radius;
  for (let i = 0; i < p.count; i += 2) {
    const a = new THREE.Vector3().fromBufferAttribute(p, i);
    const b = new THREE.Vector3().fromBufferAttribute(p, i + 1);
    for (let step = 0; step < 8; step++) {
      const start = a.clone().lerp(b, step / 8).normalize().multiplyScalar(radius + .02);
      const end = a.clone().lerp(b, (step + 1) / 8).normalize().multiplyScalar(radius + .02);
      if (start.y < cut && end.y < cut) continue;
      if (start.y < cut) start.lerp(end, (cut - start.y) / (end.y - start.y));
      if (end.y < cut) end.lerp(start, (cut - end.y) / (start.y - end.y));
      vertices.push(...start.toArray(), ...end.toArray());
    }
  }
  source.dispose(); wire.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  return geometry;
}
