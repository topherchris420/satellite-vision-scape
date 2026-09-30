import { buildings, domes, parkingLots } from "@/lib/site-layout";

/**
 * Named places on the public map of the site: the halls, the car parks and
 * some of the antennas. Anyone can see them on the minimap and on the ground,
 * so they are fair to name as destinations for a person or an agent. They are
 * exterior features only (see the reference boundary in the README).
 */

export interface Landmark {
  id: string;
  label: string;
  x: number;
  z: number;
}

function building(id: string, label: string, slug: string): Landmark | null {
  const b = buildings.find((x) => x.id === id);
  return b ? { id: slug, label, x: b.pos[0], z: b.pos[1] } : null;
}

function dome(sourceId: string): Landmark | null {
  const d = domes.find((x) => x.sourceId === sourceId);
  return d
    ? {
        id: `antenna-${sourceId.toLowerCase()}`,
        label: `Antenna ${sourceId}`,
        x: d.pos[0],
        z: d.pos[1],
      }
    : null;
}

function lot(index: number, label: string, slug: string): Landmark | null {
  const p = parkingLots[index];
  return p ? { id: slug, label, x: p.pos[0], z: p.pos[1] } : null;
}

export const LANDMARKS: readonly Landmark[] = [
  building("central-hall", "Central hall", "central-hall"),
  building("south-hall", "South hall", "south-hall"),
  building("western-hall", "Western hall", "western-hall"),
  building("north-antenna-hut", "North antenna hut", "north-antenna-hut"),
  lot(2, "Compound car park", "compound-car-park"),
  lot(0, "East car park", "east-car-park"),
  lot(1, "West car park", "west-car-park"),
  dome("68-A"),
  dome("85-A"),
  dome("90-A"),
].filter((l): l is Landmark => l !== null);

export function landmarkById(id: string): Landmark | undefined {
  return LANDMARKS.find((l) => l.id === id);
}
