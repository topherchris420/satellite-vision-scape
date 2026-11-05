import { useEffect, useRef, useState } from "react";
import type { Game } from "@/game/Game";
import { useFreeRoam } from "@/hooks/use-free-roam";
import { screenAngle } from "@/lib/radar";

/**
 * What a fight feels like on screen: a hit marker on the crosshair when a shot
 * lands (amber for a head, red when it drops someone), a red arc on the edge
 * of vision pointing to whoever just shot you, a vignette that tightens as
 * health runs low, and a grey, slowed-down screen while you are down.
 *
 * Presentation only: it listens to Free Roam's events and the HUD snapshot,
 * and writes to nothing but the DOM.
 */

type Mark = "hit" | "head" | "kill";

interface Arc {
  id: number;
  /** Screen angle, radians clockwise from straight up. */
  angle: number;
  born: number;
}

const ARC_LIFE_MS = 1400;
const MARK_LIFE_MS = 260;

const MARK_COLOUR: Record<Mark, string> = { hit: "#f8fafc", head: "#fcd34d", kill: "#f87171" };

export function CombatFeedback({ game }: { game: Game }) {
  const fr = useFreeRoam(game);
  const [mark, setMark] = useState<{ kind: Mark; key: number } | null>(null);
  const [arcs, setArcs] = useState<Arc[]>([]);
  const markTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const counter = useRef(0);
  const active = fr.active;

  useEffect(() => {
    if (!active) return;
    const roam = game.freeRoam;
    const offHit = roam.events.on("personHit", (e) => {
      if (e.by.kind !== "player") return;
      const kind: Mark = e.killed ? "kill" : e.zone === "head" ? "head" : "hit";
      setMark({ kind, key: ++counter.current });
      if (markTimer.current) clearTimeout(markTimer.current);
      markTimer.current = setTimeout(() => setMark(null), MARK_LIFE_MS);
    });
    const offDamage = roam.events.on("playerDamaged", (e) => {
      const shooter = roam.security.guards.find((g) => g.id === e.by);
      if (!shooter) return;
      const p = roam.playerPosition();
      const angle = screenAngle(p.x, p.z, shooter.x, shooter.z, game.camera.yaw);
      const now = performance.now();
      setArcs((list) => [
        ...list.filter((a) => now - a.born < ARC_LIFE_MS).slice(-3),
        { id: ++counter.current, angle, born: now },
      ]);
    });
    const offReset = roam.events.on("reset", () => setArcs([]));
    return () => {
      offHit();
      offDamage();
      offReset();
      if (markTimer.current) clearTimeout(markTimer.current);
    };
  }, [game, active]);

  // Arcs fade on their own; drop them once they have.
  useEffect(() => {
    if (arcs.length === 0) return;
    const timer = setTimeout(
      () => setArcs((list) => list.filter((a) => performance.now() - a.born < ARC_LIFE_MS)),
      ARC_LIFE_MS,
    );
    return () => clearTimeout(timer);
  }, [arcs]);

  if (!active) return null;
  const hurt = fr.alive ? Math.max(0, Math.min(1, (35 - fr.health) / 35)) : 0;

  return (
    <>
      {hurt > 0 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-pulse"
          style={{
            background: `radial-gradient(ellipse at center, transparent ${62 - hurt * 22}%, rgba(127,10,10,${0.25 + hurt * 0.4}) 100%)`,
          }}
        />
      )}
      <svg
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[min(70vh,34rem)] w-[min(70vh,34rem)] -translate-x-1/2 -translate-y-1/2 overflow-visible"
        viewBox="-100 -100 200 200"
      >
        {arcs.map((a) => (
          <path
            key={a.id}
            d="M-26,-86 A90,90 0 0 1 26,-86"
            transform={`rotate(${((a.angle * 180) / Math.PI).toFixed(1)})`}
            fill="none"
            stroke="#ef4444"
            strokeWidth={5}
            strokeLinecap="round"
            className="damage-arc"
            style={{ animationDuration: `${ARC_LIFE_MS}ms` }}
          />
        ))}
      </svg>
      {mark && (
        <svg
          key={mark.key}
          aria-hidden
          className="hit-marker pointer-events-none absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2"
          viewBox="-12 -12 24 24"
        >
          {[45, 135, 225, 315].map((deg) => (
            <line
              key={deg}
              x1={0}
              y1={-4.5}
              x2={0}
              y2={mark.kind === "hit" ? -9 : -10.5}
              transform={`rotate(${deg})`}
              stroke={MARK_COLOUR[mark.kind]}
              strokeWidth={mark.kind === "kill" ? 2.4 : 1.8}
              strokeLinecap="round"
            />
          ))}
        </svg>
      )}
      {!fr.alive && (
        <div className="pointer-events-none absolute inset-0 z-[25] flex flex-col items-center justify-center bg-black/30 backdrop-grayscale animate-in fade-in duration-700">
          <div className="font-sans text-4xl font-extralight uppercase tracking-[.5em] text-rose-100/90 drop-shadow-[0_4px_24px_rgba(0,0,0,.8)] sm:text-6xl">
            Down
          </div>
          <div className="mt-3 font-mono text-[10px] uppercase tracking-[.3em] text-white/60">
            Back on your feet at the field clinic
          </div>
        </div>
      )}
    </>
  );
}
