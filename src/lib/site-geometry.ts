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
    for(let j=1;j<clipped.length-1;j++)for(const v of [clipped[0],clipped[j],clipped[j+1]]){
      verts.push(v.x,v.y,v.z);const n=v.clone().normalize();normals.push(n.x,n.y,n.z);
      uvs.push(.5+Math.atan2(v.z,v.x)/(2*Math.PI),.5+Math.asin(n.y)/Math.PI);
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
