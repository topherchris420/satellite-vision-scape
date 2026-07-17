// Selection model for the click-to-inspect feature. Structures publish one of
// these when clicked; the HUD renders it and the fly camera can focus it.

import {
  spheres,
  domes,
  tanks,
  buildings,
  type Sphere,
  type Dome,
  type Tank,
  type Building,
  type BuildingKind,
} from "./site-layout";

export type Selection = {
  kind: string; // human-readable category, e.g. "Spherical storage tank"
  name: string; // short identifier, e.g. "Sphere S-3"
  pos: [number, number]; // XZ world position (site grade is flat at y=0)
  radius: number; // footprint radius, drives the highlight ring + camera standoff
  details: string[]; // one line per fact shown in the info card
};

export const KIND_LABEL: Record<BuildingKind, string> = {
  hall: "Process hall",
  warehouse: "Warehouse",
  shed: "Service shed",
  barracks: "Barracks block",
  office: "Office / admin",
};

// One builder per structure family, shared by the 3D pick handlers and the
// site index so both always describe a structure identically.
export function sphereSelection(s: Sphere, i: number): Selection {
  return {
    kind: "Spherical storage tank",
    name: `Sphere S-${i + 1}`,
    pos: s.pos,
    radius: s.radius * 1.2,
    details: [
      `Diameter ${(s.radius * 2).toFixed(0)} m`,
      `Capacity ≈ ${Math.round((4 / 3) * Math.PI * s.radius ** 3).toLocaleString()} m³`,
      `${s.legs ?? 10} support legs, equatorial platform`,
    ],
  };
}

export function domeSelection(d: Dome, i: number): Selection {
  return {
    kind: "Radome",
    name: `Radome R-${i + 1}`,
    pos: d.pos,
    radius: d.radius * 1.25,
    details: [
      `Diameter ${(d.radius * 2).toFixed(0)} m`,
      "Protective enclosure for antenna equipment",
    ],
  };
}

export function tankSelection(t: Tank, i: number): Selection {
  return {
    kind: "Cylindrical storage tank",
    name: `Tank T-${i + 1}`,
    pos: t.pos,
    radius: t.radius * 1.4,
    details: [
      `Diameter ${(t.radius * 2).toFixed(0)} m · height ${t.height} m`,
      `Capacity ≈ ${Math.round(Math.PI * t.radius ** 2 * t.height).toLocaleString()} m³`,
    ],
  };
}

export function buildingSelection(b: Building, i: number): Selection {
  return {
    kind: KIND_LABEL[b.kind ?? "warehouse"],
    name: `Building B-${i + 1}`,
    pos: b.pos,
    radius: Math.hypot(b.size[0], b.size[1]) / 2 + 1,
    details: [
      `Footprint ${b.size[0]} × ${b.size[1]} m`,
      `Height ${b.height} m`,
      b.roof === "gable" ? "Gable roof" : "Flat roof",
    ],
  };
}

// Every inspectable structure, grouped for the HUD's site index panel.
export type SiteIndexGroup = { label: string; items: Selection[] };

export const siteIndex: SiteIndexGroup[] = [
  { label: "Radomes", items: domes.map(domeSelection) },
  { label: "Storage spheres", items: spheres.map(sphereSelection) },
  { label: "Process tanks", items: tanks.map(tankSelection) },
  { label: "Buildings", items: buildings.map(buildingSelection) },
];
