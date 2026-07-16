import type { RefObject } from "react";
import {
  roadPath,
  interiorRoads,
  dirtTracks,
  buildings,
  spheres,
  domes,
  tanks,
  parkingLots,
} from "@/lib/site-layout";

// Top-down schematic of the site, generated straight from the layout data so
// it always matches the 3D scene. The SVG viewBox is in world metres (x right,
// z down), which means the camera marker can be positioned with a plain
// translate(x z) — the CameraTracker inside the Canvas updates `markerRef`
// every frame without triggering React re-renders.
export function Minimap({ markerRef }: { markerRef: RefObject<SVGGElement | null> }) {
  return (
    <svg
      viewBox="-155 -180 405 375"
      className="w-40 rounded-lg border border-white/10 bg-black/60 backdrop-blur-sm"
      aria-label="Site minimap"
    >
      {/* perimeter access loop */}
      <polygon
        points={roadPath.map((p) => p.join(",")).join(" ")}
        fill="#1c2333"
        fillOpacity={0.55}
        stroke="#6b675e"
        strokeWidth={5}
      />
      {/* interior roads */}
      {interiorRoads.map((path, i) => (
        <polyline
          key={`ir-${i}`}
          points={path.map((p) => p.join(",")).join(" ")}
          fill="none"
          stroke="#6b675e"
          strokeWidth={4}
        />
      ))}
      {/* dirt tracks */}
      {dirtTracks.map((path, i) => (
        <polyline
          key={`dt-${i}`}
          points={path.map((p) => p.join(",")).join(" ")}
          fill="none"
          stroke="#8a7654"
          strokeWidth={3}
          strokeDasharray="8 6"
        />
      ))}
      {/* parking aprons */}
      {parkingLots.map((p, i) => (
        <rect
          key={`pk-${i}`}
          x={p.pos[0] - p.size[0] / 2}
          y={p.pos[1] - p.size[1] / 2}
          width={p.size[0]}
          height={p.size[1]}
          fill="#3f3f46"
        />
      ))}
      {/* buildings */}
      {buildings.map((b, i) => (
        <rect
          key={`b-${i}`}
          x={b.pos[0] - b.size[0] / 2}
          y={b.pos[1] - b.size[1] / 2}
          width={b.size[0]}
          height={b.size[1]}
          fill="#b9b2a3"
        />
      ))}
      {/* cylindrical tanks */}
      {tanks.map((t, i) => (
        <circle key={`t-${i}`} cx={t.pos[0]} cy={t.pos[1]} r={Math.max(4, t.radius)} fill="#d8d2c6" />
      ))}
      {/* spheres + radomes */}
      {spheres.map((s, i) => (
        <circle key={`s-${i}`} cx={s.pos[0]} cy={s.pos[1]} r={Math.max(5, s.radius)} fill="#f5f2ea" />
      ))}
      {domes.map((d, i) => (
        <circle key={`d-${i}`} cx={d.pos[0]} cy={d.pos[1]} r={Math.max(5, d.radius)} fill="#f5f2ea" />
      ))}
      {/* camera marker — transform driven imperatively by CameraTracker */}
      <g ref={markerRef}>
        <path d="M0,-22 L14,18 L0,9 L-14,18 Z" fill="#fbbf24" stroke="#000" strokeOpacity={0.4} strokeWidth={2} />
      </g>
    </svg>
  );
}
