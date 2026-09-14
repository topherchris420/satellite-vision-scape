// Visual terrain, metres relative to a synthetic zero; NOT a surveyed DEM.
// The unrelated Alice Springs development grid remains a provider test fixture.
function hash(x: number, y: number) {
  const s = Math.sin(x*127.1+y*311.7)*43758.5453; return s-Math.floor(s);
}
function noise(x: number, y: number) {
  const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
  const u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy);
  return (hash(ix,iy)*(1-u)+hash(ix+1,iy)*u)*(1-v)+(hash(ix,iy+1)*(1-u)+hash(ix+1,iy+1)*u)*v;
}
export function proceduralTerrainHeight(x: number, z: number): number {
  const rough=noise(x*.006,z*.006)*.65+noise(x*.02,z*.02)*.25+noise(x*.07,z*.07)*.1;
  const east=Math.exp(-(((x-680-Math.sin(z*.0018)*140)/235)**2));
  const west=Math.exp(-(((x+1090+Math.sin(z*.002)*110)/280)**2));
  const north=Math.exp(-(((z+1100+Math.sin(x*.002)*85)/220)**2));
  return .0015*x+.001*z+rough*.75+(east*145+west*115+north*95)*(.65+rough*.5);
}
export const terrainHeight=proceduralTerrainHeight;
export * from './terrain/surface';
