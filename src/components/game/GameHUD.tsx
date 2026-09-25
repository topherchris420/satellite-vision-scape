import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import {
  CarFront,
  Footprints,
  Lightbulb,
  Map as MapIcon,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Game } from "@/game/Game";
import { GameplayState } from "@/game/core/GameState";
import type { PlayStatus } from "@/hooks/use-play-session";
import { Minimap } from "@/components/site/Minimap";

const glass =
  "border border-white/10 bg-[#071014]/78 text-white shadow-[0_16px_50px_rgba(0,0,0,.28)] backdrop-blur-xl";

function Key({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.6rem] items-center justify-center rounded border border-white/15 bg-white/[.08] px-1.5 py-0.5 font-mono text-[10px] text-white/80">
      {children}
    </kbd>
  );
}

const DESKTOP_CONTROLS: { title: string; rows: [string, string][] }[] = [
  {
    title: "On foot",
    rows: [
      ["W A S D", "Move (camera-relative)"],
      ["Mouse", "Look around"],
      ["Shift", "Sprint"],
      ["C", "Toggle walk"],
      ["Space", "Jump"],
      ["E", "Enter vehicle · use barrier"],
    ],
  },
  {
    title: "Driving",
    rows: [
      ["W / S", "Accelerate · brake / reverse"],
      ["A / D", "Steer"],
      ["Space", "Handbrake"],
      ["L", "Headlights"],
      ["E", "Exit vehicle"],
    ],
  },
  {
    title: "General",
    rows: [
      ["Esc", "Pause · release mouse"],
      ["Wheel", "Camera distance"],
      ["M", "Mute"],
      ["N", "Day / dusk / night"],
      ["1 – 4", "Play · Explore · Tour · Plan"],
    ],
  },
];

const MOBILE_CONTROLS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Touch",
    rows: [
      ["Stick", "Move · drive"],
      ["Drag", "Look around"],
      ["⚡", "Sprint"],
      ["▲", "Jump · handbrake"],
      ["E", "Enter / exit vehicle"],
    ],
  },
];

function ControlsGrid({ isMobile }: { isMobile: boolean }) {
  const groups = isMobile ? MOBILE_CONTROLS : DESKTOP_CONTROLS;
  return (
    <div className={`grid gap-4 ${isMobile ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-3"}`}>
      {groups.map((group) => (
        <div key={group.title}>
          <div className="mb-2 text-[9px] font-bold uppercase tracking-[.2em] text-amber-300/90">
            {group.title}
          </div>
          <dl className="space-y-1.5">
            {group.rows.map(([keys, label]) => (
              <div key={keys + label} className="flex items-center justify-between gap-3">
                <dt>
                  <Key>{keys}</Key>
                </dt>
                <dd className="text-right font-sans text-[11px] text-white/55">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    // The dimmer lets clicks through so the viewer HUD (mode switcher, time of
    // day) stays usable while the card is up.
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/25 p-4">
      <section
        className={`${glass} pointer-events-auto max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-2xl`}
      >
        <div className="h-px bg-gradient-to-r from-transparent via-amber-300/80 to-transparent" />
        <div className="p-5 sm:p-7">{children}</div>
      </section>
    </div>
  );
}

/**
 * Minimal military HUD for play mode plus the briefing and pause cards.
 * Discrete state comes from the game's HudModel through
 * useSyncExternalStore; speed and gear are written straight to the DOM by
 * the model at a capped rate, so driving never re-renders React per frame.
 */
export function GameHUD({
  game,
  status,
  onStart,
  onPause,
  onExplore,
  isMobile,
  markerRef,
  vehicleMarkersRef,
}: {
  game: Game;
  status: PlayStatus;
  onStart: () => void;
  onPause: () => void;
  onExplore: () => void;
  isMobile: boolean;
  markerRef: RefObject<SVGGElement | null>;
  vehicleMarkersRef: RefObject<SVGGElement | null>;
}) {
  const hud = useSyncExternalStore(game.hud.subscribe, game.hud.getSnapshot, game.hud.getSnapshot);
  const speedRef = useRef<HTMLSpanElement>(null);
  const gearRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const inVehicle =
    hud.state === GameplayState.Driving || hud.state === GameplayState.ExitingVehicle;
  const running = status === "running";

  useEffect(() => {
    game.hud.bindReadouts({
      speed: speedRef.current,
      gear: gearRef.current,
      speedBar: barRef.current,
    });
  }, [game, inVehicle, running]);

  const stateLabel =
    hud.state === GameplayState.OnFoot
      ? "On foot"
      : hud.state === GameplayState.Driving
        ? "Driving"
        : hud.state === GameplayState.EnteringVehicle
          ? "Mounting"
          : "Dismounting";

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 font-mono text-white"
      aria-live="polite"
    >
      {running && (
        <>
          {/* Status chip */}
          <div
            className={`${glass} absolute left-3 top-3 flex items-center gap-3 rounded-xl px-3 py-2 sm:left-5 sm:top-5`}
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-300/10 text-amber-300">
              {inVehicle ? <CarFront size={14} /> : <Footprints size={14} />}
            </span>
            <div>
              <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.2em] text-amber-300">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-300" /> {stateLabel}
              </div>
              <div className="mt-0.5 max-w-[16rem] truncate font-sans text-[10px] text-white/45">
                {hud.vehicleLabel ?? "Pine Gap · exterior reconstruction"}
              </div>
            </div>
          </div>

          {/* Pause / audio (touch devices get a pause button and the radar up here) */}
          <div className="absolute right-3 top-3 flex flex-col items-end gap-2 sm:right-5 sm:top-5">
            <div className="flex items-center gap-2 text-[9px] uppercase tracking-[.16em] text-white/40">
              {hud.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
              {isMobile ? (
                <button
                  onClick={onPause}
                  aria-label="Pause"
                  className={`${glass} pointer-events-auto rounded-lg p-2 text-white/70`}
                >
                  <Pause size={14} />
                </button>
              ) : (
                <span className={`${glass} rounded-lg px-2 py-1.5`}>
                  <Key>Esc</Key> <span className="ml-1">Pause</span>
                </span>
              )}
            </div>
            {isMobile && (
              <div className={`${glass} overflow-hidden rounded-xl p-1`}>
                <Minimap
                  markerRef={markerRef}
                  vehicleMarkersRef={vehicleMarkersRef}
                  vehicleCount={game.vehicles.vehicles.length}
                  className="w-24"
                />
              </div>
            )}
          </div>

          {/* Transient message */}
          {hud.message && (
            <div className="absolute left-1/2 top-20 -translate-x-1/2 animate-in fade-in rounded-lg border border-amber-300/30 bg-[#0b0f0c]/85 px-4 py-2 text-[11px] uppercase tracking-[.14em] text-amber-200">
              {hud.message}
            </div>
          )}

          {/* Interaction prompt */}
          {hud.prompt && hud.state === GameplayState.OnFoot && (
            <div className="absolute bottom-24 left-1/2 flex -translate-x-1/2 items-center gap-2.5 rounded-xl border border-white/10 bg-[#071014]/80 px-3.5 py-2 text-[11px] uppercase tracking-[.16em] text-white/85 backdrop-blur-md animate-in fade-in slide-in-from-bottom-1">
              <Key>{hud.prompt.key}</Key>
              {hud.prompt.label}
            </div>
          )}

          {/* Radar + context hints (desktop; touch keeps this corner for the stick) */}
          {!isMobile && (
            <div className="absolute bottom-5 left-5 flex flex-col gap-2">
              <div className={`${glass} rounded-lg px-3 py-2 font-sans text-[10px] text-white/45`}>
                {inVehicle ? (
                  <>W/S throttle · A/D steer · Space handbrake · L lights · E exit</>
                ) : (
                  <>WASD move · Shift sprint · Space jump · C walk · E interact</>
                )}
              </div>
              <div className={`${glass} w-fit overflow-hidden rounded-xl p-1`}>
                <div className="flex items-center gap-1.5 px-2 py-1 text-[8px] uppercase tracking-[.16em] text-white/35">
                  <MapIcon size={10} /> Grid
                </div>
                <Minimap
                  markerRef={markerRef}
                  vehicleMarkersRef={vehicleMarkersRef}
                  vehicleCount={game.vehicles.vehicles.length}
                  className="w-36"
                />
              </div>
            </div>
          )}

          {/* Vehicle instruments */}
          {inVehicle && (
            <div
              className={`${glass} absolute right-3 w-52 rounded-2xl p-4 sm:right-5 ${isMobile ? "bottom-28" : "bottom-5"}`}
            >
              <div className="flex items-end justify-between">
                <div>
                  <span
                    ref={speedRef}
                    className="text-4xl font-light tabular-nums tracking-tight text-white"
                  >
                    000
                  </span>
                  <span className="ml-1.5 text-[9px] uppercase tracking-[.2em] text-white/40">
                    km/h
                  </span>
                </div>
                <span
                  ref={gearRef}
                  className="rounded-md border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-sm font-bold tabular-nums text-amber-300"
                >
                  N
                </span>
              </div>
              <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  ref={barRef}
                  className="h-full origin-left scale-x-0 bg-gradient-to-r from-amber-300/60 to-amber-300"
                />
              </div>
              <div className="mt-3 flex items-center justify-between text-[9px] uppercase tracking-[.16em] text-white/40">
                <span className={`flex items-center gap-1 ${hud.headlights ? "text-sky-200" : ""}`}>
                  <Lightbulb size={11} /> {hud.headlights ? "Lights on" : "Lights off"}
                </span>
                <span>
                  <Key>E</Key> Exit
                </span>
              </div>
            </div>
          )}
        </>
      )}

      {status === "briefing" && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.26em] text-amber-300">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-300 opacity-50" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-300" />
                </span>
                Open-world exterior
              </div>
              <h1 className="mt-2 font-sans text-3xl font-light tracking-[-.04em]">
                Pine Gap <span className="text-white/35">/ field deployment</span>
              </h1>
              <p className="mt-2 max-w-xl font-sans text-[12px] leading-relaxed text-white/55">
                Walk the compound on foot, take one of the utility vehicles parked on site and drive
                the roads and the surrounding outback. A fictionalised interpretation built from
                publicly observable exterior features — no interiors or operational detail.
              </p>
            </div>
          </div>
          <div className="mt-6">
            <ControlsGrid isMobile={isMobile} />
          </div>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button
              onClick={onStart}
              className="flex items-center gap-2 rounded-xl bg-amber-300 px-5 py-3 text-[11px] font-bold uppercase tracking-[.18em] text-[#16120a] transition hover:bg-amber-200"
            >
              <Play size={14} /> Deploy
            </button>
            <button
              onClick={onExplore}
              className="rounded-xl border border-white/15 px-4 py-3 text-[10px] uppercase tracking-[.16em] text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              Survey the site instead
            </button>
            <span className="font-sans text-[10px] text-white/35">
              {isMobile
                ? "Drag anywhere to look around."
                : "Deploying captures the mouse · Esc releases it."}
            </span>
          </div>
        </Card>
      )}

      {status === "paused" && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.26em] text-amber-300">
                <Pause size={11} /> Paused
              </div>
              <h2 className="mt-1 font-sans text-2xl font-light tracking-tight">Standing by</h2>
            </div>
            <button
              onClick={onStart}
              className="flex items-center gap-2 rounded-xl bg-amber-300 px-5 py-3 text-[11px] font-bold uppercase tracking-[.18em] text-[#16120a] transition hover:bg-amber-200"
            >
              <Play size={14} /> Resume
            </button>
          </div>
          <div className="mt-6">
            <ControlsGrid isMobile={isMobile} />
          </div>
        </Card>
      )}
    </div>
  );
}
