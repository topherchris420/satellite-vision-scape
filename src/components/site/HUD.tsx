import { useEffect, useState } from "react";
import type { RefObject } from "react";
import type { ControlMode } from "./Controls";
import type { TimeOfDay } from "./Lighting";
import type { Selection } from "@/lib/selection";
import { objectSummary } from "@/lib/site-layout";
import { Minimap } from "./Minimap";

const MODES: { id: ControlMode; label: string; key: string; mobileHidden?: boolean }[] = [
  { id: "fly", label: "Free-fly", key: "1" },
  { id: "fps", label: "First-person", key: "2", mobileHidden: true },
  { id: "cinematic", label: "Cinematic", key: "3" },
];

const SHORTCUTS: [string, string][] = [
  ["1 / 2 / 3", "Free-fly · First-person · Cinematic"],
  ["W A S D", "Move"],
  ["Q / E", "Down / up (free-fly)"],
  ["[ / ]", "Lens FOV (free-fly)"],
  ["Shift", "Boost / run"],
  ["N", "Toggle day / night"],
  ["Click", "Inspect a structure"],
  ["Esc", "Close inspector / release mouse"],
  ["H", "Toggle this help"],
];

function ModeButton({
  active,
  label,
  shortcut,
  onClick,
  showShortcut,
}: {
  active: boolean;
  label: string;
  shortcut: string;
  onClick: () => void;
  showShortcut: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition ${
        active ? "bg-white text-black" : "bg-black/60 text-white hover:bg-black/80"
      }`}
    >
      {label}
      {showShortcut && (
        <kbd
          className={`rounded px-1 text-[10px] ${active ? "bg-black/10 text-black/60" : "bg-white/10 text-white/50"}`}
        >
          {shortcut}
        </kbd>
      )}
    </button>
  );
}

export function HUD({
  mode,
  onModeChange,
  time,
  onTimeChange,
  selected,
  onClearSelected,
  onFlyTo,
  showHelp,
  onToggleHelp,
  markerRef,
  isMobile,
}: {
  mode: ControlMode;
  onModeChange: (m: ControlMode) => void;
  time: TimeOfDay;
  onTimeChange: (t: TimeOfDay) => void;
  selected: Selection | null;
  onClearSelected: () => void;
  onFlyTo: () => void;
  showHelp: boolean;
  onToggleHelp: () => void;
  markerRef: RefObject<SVGGElement | null>;
  isMobile: boolean;
}) {
  const [infoOpen, setInfoOpen] = useState(true);

  // Phone screens are too small for an always-open info card.
  useEffect(() => {
    if (isMobile) setInfoOpen(false);
  }, [isMobile]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-4 text-sm">
      {/* ---------- top row ---------- */}
      <div className="flex items-start justify-between gap-4">
        {/* title card (collapsible) */}
        <div className="pointer-events-auto">
          {infoOpen ? (
            <div className="max-w-xs rounded-lg bg-black/60 px-4 py-3 text-white backdrop-blur-sm">
              <div className="flex items-start justify-between gap-3">
                <h1 className="text-base font-semibold">PINE VEIL — Australia’s “Area 51”</h1>
                <button
                  onClick={() => setInfoOpen(false)}
                  aria-label="Collapse info panel"
                  className="rounded p-0.5 text-white/50 transition hover:bg-white/10 hover:text-white"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 15l-6-6-6 6" />
                  </svg>
                </button>
              </div>
              <p className="mt-1 text-xs text-white/70">
                A compound in the Red Centre that never made the maps — radomes, tank
                farms and bunkers the government won’t confirm exist. Rebuilt in living 3D
                from orbital passes. Drop below the clouds and{" "}
                {isMobile ? "tap any structure to crack open its file." : "click any structure to crack open its file."}
              </p>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/60">
                <span>{objectSummary.spheres} spheres</span>
                <span>{objectSummary.tanks} tanks</span>
                <span>{objectSummary.domes} radomes</span>
                <span>{objectSummary.buildings} buildings</span>
                <span>{objectSummary.pipeRacks} pipe racks</span>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setInfoOpen(true)}
              aria-label="Expand info panel"
              className="rounded-lg bg-black/60 px-3 py-2 text-xs font-medium text-white backdrop-blur-sm transition hover:bg-black/80"
            >
              Site info
            </button>
          )}
        </div>

        {/* mode + environment buttons */}
        <div className="pointer-events-auto flex flex-col items-end gap-2">
          <div className="flex gap-2">
            {MODES.filter((m) => !(isMobile && m.mobileHidden)).map((m) => (
              <ModeButton
                key={m.id}
                active={mode === m.id}
                label={m.label}
                shortcut={m.key}
                showShortcut={!isMobile}
                onClick={() => onModeChange(m.id)}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onTimeChange("day")}
              className={`rounded-md px-3 py-2 text-xs font-medium transition ${
                time === "day" ? "bg-amber-300 text-black" : "bg-black/60 text-white hover:bg-black/80"
              }`}
            >
              ☀ Day
            </button>
            <button
              onClick={() => onTimeChange("night")}
              className={`rounded-md px-3 py-2 text-xs font-medium transition ${
                time === "night" ? "bg-indigo-300 text-black" : "bg-black/60 text-white hover:bg-black/80"
              }`}
            >
              ☾ Night
            </button>
            {!isMobile && (
              <button
                onClick={onToggleHelp}
                aria-label="Keyboard shortcuts"
                className={`rounded-md px-3 py-2 text-xs font-medium transition ${
                  showHelp ? "bg-white text-black" : "bg-black/60 text-white hover:bg-black/80"
                }`}
              >
                ?
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ---------- help overlay ---------- */}
      {showHelp && (
        <div className="pointer-events-auto absolute left-1/2 top-1/2 w-72 -translate-x-1/2 -translate-y-1/2 rounded-xl bg-black/80 p-5 text-white shadow-2xl backdrop-blur-md">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
            <button
              onClick={onToggleHelp}
              aria-label="Close help"
              className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white"
            >
              ✕
            </button>
          </div>
          <dl className="mt-3 space-y-1.5">
            {SHORTCUTS.map(([keys, desc]) => (
              <div key={keys} className="flex items-baseline justify-between gap-4 text-xs">
                <dt className="shrink-0">
                  <kbd className="whitespace-nowrap rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-white/90">
                    {keys}
                  </kbd>
                </dt>
                <dd className="text-right text-white/70">{desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* ---------- FPS crosshair ---------- */}
      {mode === "fps" && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="h-1.5 w-1.5 rounded-full bg-white/80 shadow-[0_0_4px_rgba(0,0,0,0.8)]" />
        </div>
      )}

      {/* ---------- bottom row ---------- */}
      <div className="flex items-end justify-between gap-4">
        {/* controls hint */}
        <div className="pointer-events-auto rounded-lg bg-black/60 px-4 py-3 text-xs text-white backdrop-blur-sm">
          {mode === "fly" && (
            <>
              <div className="font-semibold">Free-fly controls</div>
              <div className="mt-1 text-white/80">
                {isMobile
                  ? "Drag to orbit · pinch to zoom · two-finger drag to pan"
                  : "Drag to orbit · Scroll to zoom · WASD to pan · Q/E up/down · Shift to boost"}
              </div>
            </>
          )}
          {mode === "fps" && (
            <>
              <div className="font-semibold">First-person controls</div>
              <div className="mt-1 text-white/80">
                Click scene to lock mouse · WASD to walk · Shift to run · Esc to release
              </div>
            </>
          )}
          {mode === "cinematic" && (
            <>
              <div className="font-semibold">Cinematic fly-through</div>
              <div className="mt-1 text-white/80">
                Automated camera orbit of the site · switch to Free-fly to take control
              </div>
            </>
          )}
        </div>

        {/* selection card + minimap */}
        <div className="pointer-events-auto flex flex-col items-end gap-2">
          {selected && (
            <div className="w-64 rounded-lg bg-black/70 p-3 text-white backdrop-blur-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wider text-amber-300">
                    {selected.kind}
                  </div>
                  <div className="text-sm font-semibold">{selected.name}</div>
                </div>
                <button
                  onClick={onClearSelected}
                  aria-label="Close inspector"
                  className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white"
                >
                  ✕
                </button>
              </div>
              <ul className="mt-2 space-y-0.5 text-xs text-white/80">
                {selected.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
              <button
                onClick={onFlyTo}
                className="mt-3 w-full rounded-md bg-amber-300 py-1.5 text-xs font-semibold text-black transition hover:bg-amber-200"
              >
                Fly to structure
              </button>
            </div>
          )}
          {!isMobile && <Minimap markerRef={markerRef} />}
        </div>
      </div>
    </div>
  );
}
