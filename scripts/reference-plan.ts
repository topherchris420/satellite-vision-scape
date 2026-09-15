import { writeFileSync, mkdirSync } from 'node:fs';
import { buildings, domes, dishes, roadPath, interiorRoads, perimeterPath, trees } from '../src/lib/site-layout';
import { siteToImage, SURFACE_TRACES, REFERENCE_ANCHORS, imageToSite } from '../src/lib/reference-layout';

const footprint = (b: typeof buildings[number]) => {
  const [w,d]=b.size, a=b.rotY??0;
  return [[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2]].map(([x,z])=>siteToImage(b.pos[0]+x*Math.cos(a)+z*Math.sin(a),b.pos[1]-x*Math.sin(a)+z*Math.cos(a)));
};
const data={
  buildings: buildings.map(b=>({id:b.id,points:footprint(b),height:b.height})),
  antennas:[...domes.map(d=>({id:d.sourceId,pos:siteToImage(...d.pos),radius:d.radius/1.11})),...dishes.map(d=>({id:d.sourceId,pos:siteToImage(...d.pos),radius:d.dishRadius/1.11}))],
  roads:[roadPath,...interiorRoads].map(p=>p.map(v=>siteToImage(...v))),
  fence:perimeterPath.map(p=>siteToImage(...p)), trees:trees.map(p=>siteToImage(...p)), surfaces:SURFACE_TRACES,
  residuals:REFERENCE_ANCHORS.map(a=>{const d=domes.find(d=>d.sourceId===a.id)!;const p=imageToSite(...a.pixel);return {id:a.id,metres:Math.hypot(d.pos[0]-p[0],d.pos[1]-p[1])};}),
};
const points=(p:number[][])=>p.map(v=>v.map(x=>x.toFixed(2)).join(',')).join(' ');
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="200 0 940 852" role="img" aria-label="Image-traced facility plan">
<rect x="200" width="940" height="852" fill="#ac7754"/>
${data.surfaces.map(s=>`<rect x="${s.bounds[0]}" y="${s.bounds[1]}" width="${s.bounds[2]-s.bounds[0]}" height="${s.bounds[3]-s.bounds[1]}" fill="${s.color}"/>`).join('')}
${data.roads.map(p=>`<polyline points="${points(p)}" fill="none" stroke="#555552" stroke-width="5"/>`).join('')}
<polygon points="${points(data.fence)}" fill="none" stroke="#ddd0b9" stroke-width="1"/>
${data.buildings.map(b=>`<polygon points="${points(b.points)}" fill="#eeeadd" stroke="#817665" stroke-width=".6"><title>${b.id}</title></polygon>`).join('')}
${data.trees.map(p=>`<circle cx="${p[0]}" cy="${p[1]}" r="3.8" fill="#4e5940"/>`).join('')}
${data.antennas.map(d=>`<circle cx="${d.pos[0]}" cy="${d.pos[1]}" r="${d.radius}" fill="#f6f5ef" stroke="#b4b8b5" stroke-width="1"><title>${d.id}</title></circle>`).join('')}
</svg>`;
mkdirSync('docs',{recursive:true});
writeFileSync('docs/reference-plan.svg',svg);
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(data,null,2));
console.log(JSON.stringify({buildings:buildings.length,trees:trees.length,anchorResiduals:data.residuals}));
