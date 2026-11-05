import { useEffect, useId, useRef } from "react";
import { SiteShapes } from "@/components/site/Minimap";
import type { Game } from "@/game/Game";
import { RESPONSE_UNIT } from "@/game/freeroam/fleet";
import { useFreeRoam } from "@/hooks/use-free-roam";
import { areaName } from "@/lib/radar";

/**
 * Free Roam's radar: a round, zoomed map centred on the player that turns
 * with the camera, so "up" is always where the camera looks. On it: the
 * objective (pinned to the rim with an arrow when it is out of range), the
 * vehicles, any response unit on a call (flashing), guards the player can see
 * or who are hunting them, the service points, the signal shards and a race
 * ghost. The rim carries the attention level and pulses during a pursuit.
 *
 * Presentation only. It reads the world a few dozen times a second and writes
 * straight into the SVG, so play never re-renders React for it. It shows only
 * what the player could see or has been told (the existing minimap's rule).
 */

const NS = "http://www.w3.org/2000/svg";
/** Radar radius in SVG units (the viewBox is 200 across). */
const R = 92;
/** Metres from centre to rim on foot, and at speed in a vehicle. */
const RANGE_FOOT = 115;
const RANGE_FAST = 230;
const MAX_VEHICLES = 28;
const MAX_GUARDS = 16;
const MAX_SHARDS = 32;

const ATTENTION_COLOURS = ["#34d399", "#bef264", "#fde047", "#fb923c", "#ef4444"];

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Arc path on the rim from angle a0 to a1 (radians, 0 = up, clockwise). */
function arc(r: number, a0: number, a1: number): string {
  const p = (a: number) => `${(Math.sin(a) * r).toFixed(2)},${(-Math.cos(a) * r).toFixed(2)}`;
  return `M${p(a0)} A${r},${r} 0 0 1 ${p(a1)}`;
}

export function FreeRoamRadar({ game, compact = false }: { game: Game; compact?: boolean }) {
  const fr = useFreeRoam(game);
  const clip = useId().replace(/:/g, "");
  const mapRef = useRef<SVGGElement>(null);
  const blipRef = useRef<SVGGElement>(null);
  const arrowRef = useRef<SVGGElement>(null);
  const northRef = useRef<SVGGElement>(null);
  const rimRef = useRef<SVGCircleElement>(null);
  const pipRef = useRef<SVGGElement>(null);
  const distanceRef = useRef<HTMLSpanElement>(null);
  const areaRef = useRef<HTMLSpanElement>(null);
  const active = fr.active;

  useEffect(() => {
    const map = mapRef.current;
    const layer = blipRef.current;
    const arrow = arrowRef.current;
    const north = northRef.current;
    const rim = rimRef.current;
    const pips = pipRef.current;
    if (!active || !map || !layer || !arrow || !north || !rim || !pips) return;
    layer.replaceChildren();
    const roam = game.freeRoam;

    // --- Blips, made once and moved every tick -------------------------------------------------
    const shards = Array.from({ length: MAX_SHARDS }, () => {
      const d = el("path", { d: "M0,-3 L3,0 L0,3 L-3,0 Z", fill: "#5eead4", opacity: 0 });
      layer.append(d);
      return d;
    });
    const places = roam.locations.items.map((loc) => {
      const color = loc.kind === "clinic" ? "#4ade80" : loc.kind === "ammo" ? "#fbbf24" : "#38bdf8";
      const g = el("g", { opacity: 0 });
      g.append(el("circle", { r: 5.2, fill: "#06121a", stroke: color, "stroke-width": 1.6 }));
      g.append(
        loc.kind === "clinic"
          ? el("path", { d: "M-2.6,0 H2.6 M0,-2.6 V2.6", stroke: color, "stroke-width": 1.8 })
          : loc.kind === "ammo"
            ? el("path", { d: "M-1.6,2.4 V-1.2 L0,-2.8 L1.6,-1.2 V2.4 Z", fill: color })
            : el("path", {
                d: "M-2.4,1.8 L1,-1.6 M0.2,-2.6 A1.6,1.6 0 1 0 2.6,-0.2",
                stroke: color,
                "stroke-width": 1.5,
                fill: "none",
              }),
      );
      layer.append(g);
      return { g, x: loc.x, z: loc.z };
    });
    const vehicles = Array.from({ length: MAX_VEHICLES }, () => {
      const r = el("rect", {
        x: -2.4,
        y: -4,
        width: 4.8,
        height: 8,
        rx: 1.4,
        fill: "#cbd5e1",
        stroke: "#020617",
        "stroke-width": 1,
        opacity: 0,
      });
      layer.append(r);
      return r;
    });
    const guards = Array.from({ length: MAX_GUARDS }, () => {
      const c = el("circle", {
        r: 3.4,
        fill: "#f87171",
        stroke: "#1f0606",
        "stroke-width": 1.2,
        opacity: 0,
      });
      layer.append(c);
      return c;
    });
    const ghost = el("circle", {
      r: 4.6,
      fill: "none",
      stroke: "#67e8f9",
      "stroke-width": 2,
      opacity: 0,
    });
    layer.append(ghost);
    const objective = el("g", { opacity: 0 });
    const objDiamond = el("path", {
      d: "M0,-6.5 L5.5,0 L0,6.5 L-5.5,0 Z",
      fill: "#fbbf24",
      stroke: "#1c1206",
      "stroke-width": 1.4,
    });
    const objChevron = el("path", {
      d: "M-6,3 L0,-5 L6,3 L0,0.5 Z",
      fill: "#fbbf24",
      stroke: "#1c1206",
      "stroke-width": 1.2,
    });
    objective.append(objDiamond, objChevron);
    layer.append(objective);

    // --- Attention pips on the rim ----------------------------------------------------------------
    pips.replaceChildren();
    const pipArcs = ATTENTION_COLOURS.map((_, i) => {
      const span = 0.2;
      const a0 = -0.55 + i * (span + 0.03);
      const p = el("path", {
        d: arc(R + 4.5, a0, a0 + span),
        fill: "none",
        stroke: "#ffffff",
        "stroke-opacity": 0.14,
        "stroke-width": 4,
        "stroke-linecap": "round",
      });
      pips.append(p);
      return p;
    });

    let range = RANGE_FOOT;
    let last = -1;
    let raf = 0;
    let lastArea = "";
    let lastDistance = "";
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 33) return;
      const dt = last < 0 ? 0 : Math.min(0.2, (now - last) / 1000);
      last = now;
      const driven = game.interaction.driven;
      const pos = roam.playerPosition();
      const heading = driven ? driven.physics.render.yaw : game.player.renderYaw;
      const yaw = game.camera.yaw;
      const speed = driven ? Math.abs(driven.physics.forwardSpeed) : game.player.speed;
      const wanted = RANGE_FOOT + (RANGE_FAST - RANGE_FOOT) * Math.min(1, speed / 26);
      range += (wanted - range) * Math.min(1, dt * 1.5);
      const k = R / range;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const deg = ((yaw - Math.PI) * 180) / Math.PI;
      map.setAttribute(
        "transform",
        `rotate(${deg.toFixed(2)}) scale(${k.toFixed(4)}) translate(${(-pos.x).toFixed(2)} ${(-pos.z).toFixed(2)})`,
      );
      arrow.setAttribute("transform", `rotate(${(((yaw - heading) * 180) / Math.PI).toFixed(1)})`);
      // World north is −z.
      north.setAttribute(
        "transform",
        `translate(${(-sy * (R - 9)).toFixed(1)} ${(cy * (R - 9)).toFixed(1)})`,
      );

      /** World point → radar point (unclamped). */
      const project = (x: number, z: number): [number, number] => {
        const dx = x - pos.x;
        const dz = z - pos.z;
        return [(-dx * cy + dz * sy) * k, (-dx * sy - dz * cy) * k];
      };
      const place = (node: SVGElement, x: number, z: number, edge = 0): boolean => {
        const [px, py] = project(x, z);
        const d = Math.hypot(px, py);
        const limit = R - 5;
        if (d > limit && !edge) {
          node.setAttribute("opacity", "0");
          return false;
        }
        const s = d > limit ? limit / d : 1;
        node.setAttribute("transform", `translate(${(px * s).toFixed(1)} ${(py * s).toFixed(1)})`);
        return true;
      };

      // Shards still to find.
      const items = roam.collectibles.items;
      for (let i = 0; i < shards.length; i++) {
        const c = items[i];
        if (!c || c.collected || !place(shards[i], c.x, c.z))
          shards[i].setAttribute("opacity", "0");
        else shards[i].setAttribute("opacity", "0.85");
      }
      for (const p of places) p.g.setAttribute("opacity", place(p.g, p.x, p.z) ? "1" : "0");

      // Vehicles (not the one being driven: the arrow is that).
      const flash = Math.floor(now / 260) % 2 === 0;
      let vi = 0;
      for (const v of game.vehicles.vehicles) {
        if (vi >= vehicles.length) break;
        if (v === driven || (v.visual && !v.visual.root.visible)) continue;
        const r = vehicles[vi++];
        if (!place(r, v.physics.x, v.physics.z)) continue;
        const responding = v.spec === RESPONSE_UNIT && roam.traffic.responding(v);
        const turn = (((yaw - v.physics.yaw) * 180) / Math.PI).toFixed(1);
        r.setAttribute("transform", `${r.getAttribute("transform")} rotate(${turn})`);
        r.setAttribute(
          "fill",
          v.health <= 0
            ? "#3f3f46"
            : responding
              ? flash
                ? "#ef4444"
                : "#3b82f6"
              : v.spec === RESPONSE_UNIT
                ? "#1e3a8a"
                : "#cbd5e1",
        );
        r.setAttribute(
          "opacity",
          v.autonomous || v.driven || v.physics.speed > 0.5 ? "0.95" : "0.6",
        );
      }
      for (; vi < vehicles.length; vi++) vehicles[vi].setAttribute("opacity", "0");

      // Guards the player can see, or who are hunting them.
      let gi = 0;
      for (const g of roam.security.live) {
        if (gi >= guards.length) break;
        if (!g.alive || !(g.sees || g.hostile)) continue;
        const c = guards[gi++];
        c.setAttribute("opacity", place(c, g.x, g.z) ? "1" : "0");
      }
      for (; gi < guards.length; gi++) guards[gi].setAttribute("opacity", "0");

      const ghostAt = roam.visuals?.ghostPosition ?? null;
      ghost.setAttribute("opacity", ghostAt && place(ghost, ghostAt.x, ghostAt.z) ? "1" : "0");

      // The objective: on the map, or pinned to the rim pointing the way.
      const m = roam.objectiveMarker();
      let distanceText = "";
      if (m) {
        place(objective, m.x, m.z, 1);
        const [px, py] = project(m.x, m.z);
        const off = Math.hypot(px, py) > R - 5;
        objDiamond.setAttribute("opacity", off ? "0" : "1");
        objChevron.setAttribute("opacity", off ? "1" : "0");
        if (off)
          objChevron.setAttribute(
            "transform",
            `rotate(${((Math.atan2(px, -py) * 180) / Math.PI).toFixed(1)})`,
          );
        objective.setAttribute("opacity", "1");
        const metres = Math.hypot(m.x - pos.x, m.z - pos.z);
        distanceText =
          metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
      } else objective.setAttribute("opacity", "0");
      if (distanceText !== lastDistance && distanceRef.current) {
        distanceRef.current.textContent = distanceText;
        lastDistance = distanceText;
      }

      // Attention on the rim.
      const a = roam.attention;
      const level = a.level;
      for (let i = 0; i < pipArcs.length; i++) {
        const on = i < level;
        pipArcs[i].setAttribute(
          "stroke",
          on ? (a.pursuing ? (flash ? "#ef4444" : "#3b82f6") : ATTENTION_COLOURS[i]) : "#ffffff",
        );
        pipArcs[i].setAttribute("stroke-opacity", on ? "1" : "0.14");
      }
      rim.setAttribute("stroke", a.pursuing ? (flash ? "#ef4444" : "#3b82f6") : "#ffffff");
      rim.setAttribute("stroke-opacity", a.pursuing ? "0.85" : "0.16");

      const area = areaName(pos.x, pos.z);
      if (area !== lastArea && areaRef.current) {
        areaRef.current.textContent = area;
        lastArea = area;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      layer.replaceChildren();
      pips.replaceChildren();
    };
  }, [game, active, fr.seed, fr.challengeId]);

  if (!active) return null;
  const size = compact ? "h-28 w-28" : "h-44 w-44";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <svg
        viewBox="-100 -100 200 200"
        className={`${size} drop-shadow-[0_10px_28px_rgba(0,0,0,.45)]`}
        role="img"
        aria-label="Radar: the area around you, turned to face where you look"
      >
        <defs>
          <clipPath id={`radar-${clip}`}>
            <circle r={R} />
          </clipPath>
          <radialGradient id={`radar-bg-${clip}`}>
            <stop offset="0%" stopColor="#0b1d26" stopOpacity={0.88} />
            <stop offset="100%" stopColor="#03080c" stopOpacity={0.92} />
          </radialGradient>
        </defs>
        <circle r={R} fill={`url(#radar-bg-${clip})`} />
        <g clipPath={`url(#radar-${clip})`}>
          <g ref={mapRef} opacity={0.82}>
            <SiteShapes />
          </g>
          <circle
            r={R * 0.5}
            fill="none"
            stroke="#ffffff"
            strokeOpacity={0.07}
            strokeDasharray="2 5"
          />
          <g ref={blipRef} />
          <g ref={arrowRef}>
            <path
              d="M0,-8 L5.6,6 L0,3 L-5.6,6 Z"
              fill="#fde68a"
              stroke="#1c1206"
              strokeWidth={1.4}
              strokeLinejoin="round"
            />
          </g>
        </g>
        <circle
          ref={rimRef}
          r={R}
          fill="none"
          stroke="#ffffff"
          strokeOpacity={0.16}
          strokeWidth={2.4}
        />
        <g ref={pipRef} />
        <g ref={northRef}>
          <circle r={6.5} fill="#03080c" stroke="#ffffff" strokeOpacity={0.35} strokeWidth={1} />
          <text
            y={3.2}
            fontSize={9}
            fontWeight={700}
            textAnchor="middle"
            fill="#ffffff"
            fillOpacity={0.8}
            fontFamily="ui-monospace, monospace"
          >
            N
          </text>
        </g>
      </svg>
      {!compact && (
        <div className="flex w-full max-w-[11rem] items-center justify-between gap-2 font-mono text-[9px] uppercase tracking-[.14em]">
          <span ref={areaRef} className="truncate text-white/60" />
          <span ref={distanceRef} className="shrink-0 tabular-nums text-amber-200" />
        </div>
      )}
    </div>
  );
}
