import type { MouseEvent, RefObject } from "react";
import {
  roadPath,
  topEnclosurePath,
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
// every frame without triggering React re-renders. Clicking the map converts
// back through the same mapping, so `onNavigate` receives world XZ metres.
export function Minimap({
  markerRef,
  onNavigate,
}: {
  markerRef: RefObject<SVGGElement | null>;
  onNavigate?: (x: number, z: number) => void;
}) {
  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (!onNavigate) return;
    const ctm = e.currentTarget.getScreenCTM();
    if (!ctm) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    onNavigate(p.x, p.y);
  };

  return (
    <svg
      viewBox="-155 -185 405 385"
      className={`w-40 rounded-lg border border-white/10 bg-black/60 backdrop-blur-sm ${
        onNavigate ? "cursor-crosshair" : ""
      }`}
      role={onNavigate ? "button" : "img"}
      aria-label={onNavigate ? "Site minimap — click to fly the camera there" : "Site minimap"}
      onClick={handleClick}
    >
      {onNavigate && <title>Click to fly the camera there</title>}
      {/* northern antenna enclosure */}
      <polygon
        points={topEnclosurePath.map((p) => p.join(",")).join(" ")}
        fill="#1c2333"
        fillOpacity={0.4}
        stroke="#6b675e"
        strokeWidth={4}
      />
      {/* main perimeter boundary */}
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
        <circle
          key={`t-${i}`}
          cx={t.pos[0]}
          cy={t.pos[1]}
          r={Math.max(4, t.radius)}
          fill="#d8d2c6"
        />
      ))}
      {/* spheres + radomes */}
      {spheres.map((s, i) => (
        <circle
          key={`s-${i}`}
          cx={s.pos[0]}
          cy={s.pos[1]}
          r={Math.max(5, s.radius)}
          fill="#f5f2ea"
        />
      ))}
      {domes.map((d, i) => (
        <circle
          key={`d-${i}`}
          cx={d.pos[0]}
          cy={d.pos[1]}
          r={Math.max(5, d.radius)}
          fill="#f5f2ea"
        />
      ))}
      {/* north arrow (map "up" is −z = grid north) */}
      <g fill="#ffffff" fillOpacity={0.55}>
        <path d="M228,-146 l9,20 -9,-6 -9,6 Z" />
        <text x={228} y={-100} fontSize={26} textAnchor="middle" fontFamily="monospace">
          N
        </text>
      </g>
      {/* 100 m scale bar */}
      <g stroke="#ffffff" strokeOpacity={0.55} strokeWidth={3}>
        <line x1={-140} y1={186} x2={-40} y2={186} />
        <line x1={-140} y1={179} x2={-140} y2={193} />
        <line x1={-40} y1={179} x2={-40} y2={193} />
      </g>
      <text
        x={-90}
        y={176}
        fontSize={24}
        textAnchor="middle"
        fontFamily="monospace"
        fill="#ffffff"
        fillOpacity={0.55}
      >
        100 m
      </text>
      {/* camera marker — transform driven imperatively by CameraTracker */}
      <g ref={markerRef}>
        <path
          d="M0,-22 L14,18 L0,9 L-14,18 Z"
          fill="#fbbf24"
          stroke="#000"
          strokeOpacity={0.4}
          strokeWidth={2}
        />
      </g>
    </svg>
  );
}
