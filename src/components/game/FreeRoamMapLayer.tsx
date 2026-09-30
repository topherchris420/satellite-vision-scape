import { useEffect, useRef } from "react";
import type { Game } from "@/game/Game";
import { useFreeRoam } from "@/hooks/use-free-roam";

/**
 * Free Roam's markers on the minimap: the objective, the signal shards, the
 * service points, and any guard the player currently has in view. Drawn
 * straight into the SVG a few times a second so play never re-renders React
 * for them. Only what the player could see or has been told: a guard out of
 * sight is not on the map.
 */

const NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export function FreeRoamMapLayer({ game }: { game: Game }) {
  const fr = useFreeRoam(game);
  const group = useRef<SVGGElement>(null);
  const active = fr.active;

  useEffect(() => {
    const root = group.current;
    if (!root || !active) return;
    root.replaceChildren();
    const objective = el("g", { opacity: "0" });
    objective.append(
      el("circle", { r: "16", fill: "none", stroke: "#fbbf24", "stroke-width": "4" }),
      el("path", { d: "M0,-26 L9,-8 L-9,-8 Z", fill: "#fbbf24", stroke: "#000", "stroke-opacity": "0.5", "stroke-width": "2" }),
    );
    root.append(objective);
    const shards: SVGCircleElement[] = [];
    for (const c of game.freeRoam.collectibles.items) {
      const dot = el("circle", { r: c.value >= 25 ? "6" : "4.5", fill: "#5eead4", opacity: "0.9" });
      dot.setAttribute("cx", c.x.toFixed(1));
      dot.setAttribute("cy", c.z.toFixed(1));
      root.append(dot);
      shards.push(dot);
    }
    for (const loc of game.freeRoam.locations.items) {
      const color = loc.kind === "clinic" ? "#4ade80" : loc.kind === "ammo" ? "#fbbf24" : "#38bdf8";
      root.append(
        el("rect", { x: (loc.x - 6).toFixed(1), y: (loc.z - 6).toFixed(1), width: "12", height: "12", rx: "2", fill: color, stroke: "#000", "stroke-opacity": "0.5", "stroke-width": "2" }),
      );
    }
    const guards = new Map<string, SVGCircleElement>();

    const tick = () => {
      const m = game.freeRoam.objectiveMarker();
      if (m) {
        objective.setAttribute("transform", `translate(${m.x.toFixed(1)} ${m.z.toFixed(1)})`);
        objective.setAttribute("opacity", "1");
      } else objective.setAttribute("opacity", "0");
      const items = game.freeRoam.collectibles.items;
      for (let i = 0; i < shards.length; i++) shards[i].setAttribute("opacity", items[i]?.collected ? "0" : "0.9");
      const seen = new Set<string>();
      for (const g of game.freeRoam.security.live) {
        if (!g.alive || !(g.sees || g.hostile)) continue;
        seen.add(g.id);
        let dot = guards.get(g.id);
        if (!dot) {
          dot = el("circle", { r: "5.5", fill: "#f87171", stroke: "#000", "stroke-opacity": "0.5", "stroke-width": "2" });
          root.append(dot);
          guards.set(g.id, dot);
        }
        dot.setAttribute("cx", g.x.toFixed(1));
        dot.setAttribute("cy", g.z.toFixed(1));
      }
      for (const [id, dot] of guards) {
        if (!seen.has(id)) {
          dot.remove();
          guards.delete(id);
        }
      }
    };
    tick();
    const timer = setInterval(tick, 200);
    return () => {
      clearInterval(timer);
      root.replaceChildren();
    };
  }, [game, active, fr.seed, fr.challengeId]);

  return active ? <g ref={group} /> : null;
}
