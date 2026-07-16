// Selection model for the click-to-inspect feature. Structures publish one of
// these when clicked; the HUD renders it and the fly camera can focus it.

export type Selection = {
  kind: string; // human-readable category, e.g. "Spherical storage tank"
  name: string; // short identifier, e.g. "Sphere S-3"
  pos: [number, number]; // XZ world position (site grade is flat at y=0)
  radius: number; // footprint radius, drives the highlight ring + camera standoff
  details: string[]; // one line per fact shown in the info card
};
