/**
 * Manual traces from the user-supplied 1424 × 852 Bing overhead image.
 * Pixels refer to that original image, not a resized display. The annotated
 * November 2015 image identifies antennas; the oblique Skyring photo informs
 * roof form and low-rise massing. Heights are visual estimates, not a survey.
 */
export type ImagePoint = [number, number];
export type ImageBounds = [number, number, number, number];
export const REFERENCE_IMAGE = {
  file: 'CROP-Pine_Gap_Bing3-copy-1503072465(1).jpg', width: 1424, height: 852,
  // Least-squares affine fit of six identified antenna centres to the public
  // survey's local east/south metre frame. Residuals are approximately 0–4 m.
  east: [1.0895519565, -0.0028217508, -788.2003095],
  south: [0.0437086454, 1.1260929692, -504.2111994],
} as const;
export const REFERENCE_ANCHORS = [
  { id: '10-A', pixel: [673, 203] }, { id: '68-A', pixel: [657, 410] },
  { id: '68-B', pixel: [657, 501] }, { id: '90-B', pixel: [747, 203] },
  { id: '98-A', pixel: [329, 622] }, { id: '13-B', pixel: [329, 759] },
] as const;
export function imageToSite(u: number, v: number): [number, number] {
  const { east: e, south: s } = REFERENCE_IMAGE;
  return [e[0] * u + e[1] * v + e[2], s[0] * u + s[1] * v + s[2]];
}
export function siteToImage(x: number, z: number): [number, number] {
  const { east: e, south: s } = REFERENCE_IMAGE;
  const d = e[0] * s[1] - e[1] * s[0], a = x - e[2], b = z - s[2];
  return [(a * s[1] - b * e[1]) / d, (b * e[0] - a * s[0]) / d];
}
export function tracePath(points: ImagePoint[]): [number, number][] {
  return points.map(([u, v]) => imageToSite(u, v));
}
export function traceRect(bounds: ImageBounds) {
  const [x0, y0, x1, y1] = bounds;
  return {
    pos: imageToSite((x0 + x1) / 2, (y0 + y1) / 2),
    size: [(x1 - x0) * Math.hypot(REFERENCE_IMAGE.east[0], REFERENCE_IMAGE.south[0]),
      (y1 - y0) * Math.hypot(REFERENCE_IMAGE.east[1], REFERENCE_IMAGE.south[1])] as [number, number],
    rotY: -Math.atan2(REFERENCE_IMAGE.south[0], REFERENCE_IMAGE.east[0]),
  };
}
export type BuildingTrace = {
  id: string; bounds: ImageBounds; height: number; roof?: 'flat' | 'gable'; roofColor?: string;
};
export const BUILDING_TRACES: BuildingTrace[] = [
  { id: 'central-north', bounds: [675,364,737,396], height: 7 },
  { id: 'central-hall', bounds: [674,400,737,488], height: 8 },
  { id: 'central-south', bounds: [674,489,737,525], height: 6.5, roofColor: '#bbbeb8' },
  { id: 'central-east-wing', bounds: [745,391,772,491], height: 6 },
  { id: 'central-link', bounds: [737,440,745,488], height: 5.5 },
  { id: 'south-hall', bounds: [687,555,744,629], height: 6, roofColor: '#c9bf9f' },
  { id: 'south-west-annex', bounds: [658,604,681,637], height: 4 },
  { id: 'south-spine', bounds: [768,521,789,574], height: 4, roof: 'gable' },
  { id: 'south-spine-lower', bounds: [772,606,789,680], height: 4, roof: 'gable' },
  { id: 'west-service-1', bounds: [620,549,638,570], height: 3 },
  { id: 'west-service-2', bounds: [620,597,633,614], height: 3 },
  { id: 'west-service-3', bounds: [622,621,634,634], height: 3 },
  { id: 'north-antenna-hut', bounds: [740,95,758,110], height: 3 },
  { id: 'north-middle-hut', bounds: [708,260,727,286], height: 3.5 },
  { id: 'north-small-hut', bounds: [709,327,719,343], height: 2.5 },
  { id: 'north-long-hut', bounds: [725,311,735,349], height: 3 },
  // Six parallel roof strips and two long buildings north of the garden.
  ...[375,392,409,426,443,461].map((y, i): BuildingTrace => ({ id: `east-north-row-${i+1}`, bounds: [809,y,850,y+9], height: 3, roof: 'gable' })),
  { id: 'east-north-covered-walk', bounds: [856,374,863,465], height: 2.4 },
  { id: 'east-north-long-1', bounds: [870,397,884,460], height: 3.5, roof: 'gable' },
  { id: 'east-north-long-2', bounds: [891,397,905,460], height: 3.5, roof: 'gable' },
  { id: 'east-middle-1', bounds: [814,522,857,537], height: 3.5 },
  { id: 'east-middle-annex', bounds: [826,510,845,522], height: 3.5 },
  { id: 'east-middle-2', bounds: [884,519,908,534], height: 3.5 },
  { id: 'east-middle-3', bounds: [869,496,897,506], height: 3 },
  { id: 'east-middle-4', bounds: [807,495,825,503], height: 2.5 },
  ...[820,845,871,895].map((x, i): BuildingTrace => ({ id: `east-south-row-${i+1}`, bounds: [x,561,x+13,623], height: 3.5, roof: 'gable' })),
  { id: 'east-south-east', bounds: [944,563,991,582], height: 4, roof: 'gable' },
  { id: 'east-south-shed', bounds: [937,617,949,636], height: 3 },
  { id: 'east-bottom-long', bounds: [866,651,997,680], height: 4, roof: 'gable' },
  { id: 'western-hall', bounds: [458,622,538,660], height: 5.5, roofColor: '#847d69' },
  { id: 'western-annex', bounds: [466,660,511,678], height: 3, roofColor: '#9f9681' },
  { id: 'western-shed', bounds: [374,650,383,672], height: 3 },
  { id: 'western-north-hut', bounds: [416,562,434,579], height: 3 },
  { id: 'western-north-small', bounds: [397,566,407,578], height: 2.5 },
  { id: 'southwest-hut', bounds: [371,734,387,751], height: 3 },
];

// Trace only visible boundaries; the photograph does not establish their role.
export const BOUNDARY_TRACE: ImagePoint[] = [[590,39],[799,39],[799,533],[799,707],[446,707],[446,822],[266,822],[266,533],[590,533]];
export const SOUTHWEST_TRACE: ImagePoint[] = [[277,717],[440,717],[440,813],[277,813]];
export const CAMPUS_TRACE: ImagePoint[] = [[798,359],[1034,359],[1050,367],[1058,384],[1058,704],[798,704]];
export const ROAD_TRACE: ImagePoint[] = [[598,49],[789,49],[789,544],[280,544],[280,806],[432,806],[432,710],[788,710],[788,362],[1030,362],[1044,367],[1051,378],[1051,701],[790,701]];
export const CONNECTOR_TRACES: ImagePoint[][] = [
  [[788,475],[855,475],[1049,475]], [[788,546],[1049,546]], [[788,640],[1049,640]],
  [[855,369],[855,466]], [[810,551],[810,640]], [[922,551],[922,641]],
  [[598,49],[598,533]], [[633,539],[641,506],[641,349],[678,347]],
  [[351,711],[351,755]], [[432,711],[432,651],[449,615],[481,605],[526,606],[550,625],[608,625],[647,630],[651,546]],
  [[1051,701],[1062,851]], [[1051,701],[800,709]],
];
export const TRACK_TRACES: ImagePoint[][] = [
  [[595,20],[580,370],[542,523],[247,523],[247,841]],
  [[805,24],[817,337],[1043,345],[1093,341],[1116,317]],
  [[1083,390],[1108,443],[1085,528],[1080,677],[1093,750],[1105,852]],
  [[60,373],[346,373],[578,371]], [[79,94],[199,61],[307,14]],
  [[284,822],[582,803],[801,805],[1025,795]],
];
export type SurfaceTrace = { id: string; bounds: ImageBounds; kind: 'lawn' | 'water' | 'court'; color: string };
export const SURFACE_TRACES: SurfaceTrace[] = [
  { id: 'north-garden', bounds: [862,369,1036,464], kind: 'lawn', color: '#787945' },
  { id: 'middle-garden', bounds: [803,482,1037,543], kind: 'lawn', color: '#737646' },
  { id: 'south-garden', bounds: [812,551,1035,641], kind: 'lawn', color: '#747044' },
  { id: 'pool', bounds: [946,510,969,521], kind: 'water', color: '#418c9d' },
  { id: 'court', bounds: [944,530,975,547], kind: 'court', color: '#a89b7c' },
  { id: 'pond-west', bounds: [980,43,1018,83], kind: 'water', color: '#77745a' },
  { id: 'pond-middle', bounds: [1026,43,1072,83], kind: 'water', color: '#424f36' },
  { id: 'pond-east', bounds: [1077,43,1116,83], kind: 'water', color: '#253e32' },
];
export const TREE_TRACE: ImagePoint[] = [
  [874,380],[901,382],[920,383],[940,385],[959,389],[986,392],[1014,394],
  [929,405],[946,401],[971,410],[993,410],[1017,414],[918,423],[940,428],
  [965,429],[988,428],[1014,439],[930,446],[951,452],[976,449],[996,453],
  [818,485],[842,485],[865,486],[901,484],[925,485],[981,486],[1008,485],
  [817,507],[862,513],[915,514],[986,512],[1016,522],[813,540],[907,539],
  [931,564],[1012,562],[1019,582],[992,591],[978,607],[1008,619],[1021,638],
  [934,594],[936,610],[916,639],[877,637],[843,637],[817,637],
  [1006,655],[1014,673],[1007,687],[946,688],[900,688],[840,674],
];
