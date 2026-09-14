import { GeospatialTransform, type LocalTangentPlane } from './spatial/geospatial-transform';

/** Historical public exterior reference, not a live inventory or surveyed DEM. */
export const PINE_GAP_FRAME: LocalTangentPlane = {
  origin: { latitude: -23.7985, longitude: 133.737 },
  originHeight: { value: 0, unit: 'm', datum: 'LOCAL_SYNTHETIC', source: 'Illustrative relative terrain' },
  worldUnitsPerMeter: 1,
};
export const PINE_GAP_SOURCE = {
  title: 'Ball, Robinson & Tanter — antenna survey',
  url: 'https://nautilus.org/briefing-books/australian-defence-facilities/pine-gap/table-and-photokey-of-antennas-at-pine-gap/',
  epoch: 'February 2016', accessed: '2026-09-14',
};
export const pineGapTransform = new GeospatialTransform(PINE_GAP_FRAME);
export function localPosition(latitude: number, longitude: number): [number, number] {
  const p = pineGapTransform.toLocal({ latitude, longitude }, PINE_GAP_FRAME.originHeight);
  return [p.x, p.z];
}
// Factual coordinates/diameters from the public survey. IDs are the researchers'
// labels, not official identifiers. No operational roles or pointing inferred.
// 98-A: source prints 33.732769. Leading 1 restored by inference from neighbouring
// 98-B and 13-A; this correction is disclosed, not a newly measured coordinate.
export const ANTENNA_REFERENCE = [
  ['68-A', -23.798403, 133.736261, 38, 'radome'],
  ['68-B', -23.799296, 133.736276, 20, 'radome'],
  ['71-A', -23.798849, 133.736185, 15, 'radome'],
  ['77-A', -23.798071, 133.736247, 15, 'radome'],
  ['80-A', -23.798773, 133.737046, 5, 'roof-radome'],
  ['80-B', -23.799051, 133.736280, 8, 'radome'],
  ['85-A', -23.797614, 133.736466, 38, 'radome'],
  ['90-A', -23.796753, 133.737278, 9, 'radome'],
  ['90-B', -23.796316, 133.737278, 30, 'radome'],
  ['98-A', -23.800425, 133.732769, 16, 'radome'],
  ['98-B', -23.800811, 133.732769, 16, 'radome'],
  ['99-C', -23.797218, 133.736466, 30.5, 'radome'],
  ['99-D', -23.796774, 133.736462, 30.5, 'radome'],
  ['05-A', -23.799853, 133.733103, 5, 'radome'],
  ['05-B', -23.799856, 133.733361, 5, 'radome'],
  ['10-A', -23.796265, 133.736433, 38, 'radome'],
  ['12-A', -23.799822, 133.733232, 5, 'radome'],
  ['13-A', -23.800003, 133.732771, 16, 'radome'],
  ['13-B', -23.801743, 133.732762, 18, 'radome'],
  ['86-A', -23.797372, 133.737366, 8, 'dish'],
  ['87-A', -23.799438, 133.739077, 5, 'dish'],
  ['88-A', -23.799505, 133.739129, 5, 'dish'],
  ['99-A', -23.795116, 133.737281, 20, 'dish'],
  ['99-B', -23.795576, 133.737288, 20, 'dish'],
  ['01-A', -23.795250, 133.737121, 6, 'dish'],
  ['05-C', -23.796584, 133.737283, 4, 'dish'],
  ['05-D', -23.796594, 133.737190, 4, 'dish'],
  ['11-A', -23.799440, 133.735973, 12, 'dish'],
] as const;
