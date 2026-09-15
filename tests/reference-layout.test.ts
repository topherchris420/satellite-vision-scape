import { expect, test } from 'bun:test';
import { buildings, domes, parkingLots } from '../src/lib/site-layout';
import { imageToSite, siteToImage, REFERENCE_ANCHORS, BUILDING_TRACES } from '../src/lib/reference-layout';

test('image calibration fits independently published radome positions within five metres',()=>{
  for(const a of REFERENCE_ANCHORS){
    const p=imageToSite(...a.pixel), d=domes.find(d=>d.sourceId===a.id)!;
    expect(Math.hypot(p[0]-d.pos[0],p[1]-d.pos[1])).toBeLessThan(5);
  }
});
test('image transform round trips corners, gardens and western compound',()=>{
  for(const p of [[0,0],[1424,852],[900,420],[330,700]]){
    const out=siteToImage(...imageToSite(p[0],p[1]));
    expect(out[0]).toBeCloseTo(p[0],6);expect(out[1]).toBeCloseTo(p[1],6);
  }
});
test('all traced buildings retain their image centre and short-axis gable ridge',()=>{
  expect(new Set(buildings.map(b=>b.id)).size).toBe(BUILDING_TRACES.length);
  for(const b of buildings){
    const trace=BUILDING_TRACES.find(t=>t.id===b.id)!, p=siteToImage(...b.pos);
    expect(p[0]).toBeCloseTo((trace.bounds[0]+trace.bounds[2])/2,5);
    expect(p[1]).toBeCloseTo((trace.bounds[1]+trace.bounds[3])/2,5);
    if(b.roof==='gable')expect(b.size[0]).toBeLessThanOrEqual(b.size[1]);
  }
});
test('eastern garden is no longer a car park and roof radome has a host',()=>{
  for(const lot of parkingLots){const [u,v]=siteToImage(...lot.pos);expect(u>860&&u<1040&&v>365&&v<465).toBe(false);}
  const d=domes.find(d=>d.roofMounted)!;
  const hosts=buildings.filter(b=>{
    const dx=d.pos[0]-b.pos[0],dz=d.pos[1]-b.pos[1],a=b.rotY??0;
    return Math.abs(dx*Math.cos(a)-dz*Math.sin(a))<b.size[0]/2 && Math.abs(dx*Math.sin(a)+dz*Math.cos(a))<b.size[1]/2;
  });
  expect(hosts.length).toBe(1);
});
