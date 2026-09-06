import { useEffect, useState, type RefObject } from "react";
import {
  Aperture,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Crosshair,
  Eye,
  Gauge,
  Layers3,
  Map,
  MoonStar,
  Navigation,
  Route,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import type { ControlMode } from "./Controls";
import type { TimeOfDay } from "./Lighting";
import type { QualityTier } from "./SiteScene";
import { siteIndex, type Selection } from "@/lib/selection";
import { objectSummary } from "@/lib/site-layout";
import { Minimap } from "./Minimap";

const MODES: { id: ControlMode; label: string; key: string; mobileHidden?: boolean }[] = [
  { id: "fly", label: "Explore", key: "1" },
  { id: "fps", label: "Ground", key: "2", mobileHidden: true },
  { id: "cinematic", label: "Tour", key: "3" },
];
const QUALITIES: QualityTier[] = ["low", "medium", "high", "ultra"];
const SHORTCUTS: [string, string][] = [
  ["1 / 2 / 3", "Explore · Ground · Tour"],
  ["W A S D", "Move"],
  ["Q / E", "Descend / ascend"],
  ["[ / ]", "Change lens FOV"],
  ["Shift", "Boost / run"],
  ["N", "Day / night"],
  ["I", "Site index"],
  ["G", "Terrain debug"],
  ["Click", "Inspect structure"],
  ["Esc", "Close / release"],
];

const glass =
  "border border-white/10 bg-[#071014]/78 text-white shadow-[0_16px_50px_rgba(0,0,0,.28)] backdrop-blur-xl";

function Key({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-white/10 bg-white/[.07] px-1.5 py-0.5 font-mono text-[9px] text-white/45">
      {children}
    </kbd>
  );
}

export function HUD({
  mode,
  onModeChange,
  time,
  onTimeChange,
  qualityTier,
  onQualityChange,
  showDebug,
  onToggleDebug,
  selected,
  onClearSelected,
  onFlyTo,
  onInspect,
  onNavigate,
  showHelp,
  onToggleHelp,
  showIndex,
  onToggleIndex,
  markerRef,
  telemetryRef,
  isMobile,
}: {
  mode: ControlMode;
  onModeChange: (m: ControlMode) => void;
  time: TimeOfDay;
  onTimeChange: (t: TimeOfDay) => void;
  qualityTier: QualityTier;
  onQualityChange: (q: QualityTier) => void;
  showDebug: boolean;
  onToggleDebug: () => void;
  selected: Selection | null;
  onClearSelected: () => void;
  onFlyTo: () => void;
  onInspect: (s: Selection) => void;
  onNavigate: (x: number, z: number) => void;
  showHelp: boolean;
  onToggleHelp: () => void;
  showIndex: boolean;
  onToggleIndex: () => void;
  markerRef: RefObject<SVGGElement | null>;
  telemetryRef: RefObject<HTMLDivElement | null>;
  isMobile: boolean;
}) {
  const [infoOpen, setInfoOpen] = useState(true);
  useEffect(() => {
    if (isMobile) setInfoOpen(false);
  }, [isMobile]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-3 font-mono text-sm sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="pointer-events-auto">
          {infoOpen ? (
            <section
              className={`${glass} w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl`}
              aria-label="Mission overview"
            >
              <div className="h-px bg-gradient-to-r from-transparent via-amber-300/80 to-transparent" />
              <div className="p-4 sm:p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="mb-3 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.24em] text-amber-300">
                      <span className="relative flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-300 opacity-50" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-300" />
                      </span>
                      Interactive reconstruction
                    </div>
                    <h1 className="font-sans text-2xl font-light tracking-[-.04em] text-white sm:text-[1.75rem]">
                      Pine Veil <span className="text-white/35">/ AU</span>
                    </h1>
                  </div>
                  <button
                    onClick={() => setInfoOpen(false)}
                    aria-label="Collapse mission overview"
                    className="rounded-lg p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white"
                  >
                    <ChevronDown size={16} />
                  </button>
                </div>
                <p className="mt-3 max-w-sm font-sans text-[12px] leading-relaxed text-white/55">
                  Explore a synthetic Red Centre intelligence site, reconstructed as a navigable
                  digital twin. Select any asset to inspect its geometry and context.
                </p>
                <div className="mt-4 grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-white/[.08] bg-white/[.08]">
                  {[
                    [objectSummary.domes, "Radomes"],
                    [objectSummary.tanks, "Tanks"],
                    [objectSummary.buildings, "Structures"],
                    [objectSummary.pipeRacks, "Pipe racks"],
                  ].map(([value, label]) => (
                    <div key={label} className="bg-[#071014]/90 px-2 py-2.5">
                      <div className="text-sm text-white/90">{value}</div>
                      <div className="mt-0.5 text-[8px] uppercase tracking-wider text-white/35">
                        {label}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : (
            <button
              onClick={() => setInfoOpen(true)}
              className={`${glass} flex items-center gap-2 rounded-xl px-3 py-2.5 text-[10px] uppercase tracking-[.18em] transition hover:bg-white/10`}
            >
              <Aperture size={14} className="text-amber-300" /> Pine Veil{" "}
              <ChevronRight size={13} className="text-white/35" />
            </button>
          )}
        </div>

        <div className="pointer-events-auto flex flex-col items-end gap-2">
          <div className={`${glass} flex rounded-xl p-1`} role="group" aria-label="Camera mode">
            {MODES.filter((m) => !(isMobile && m.mobileHidden)).map((m) => (
              <button
                key={m.id}
                onClick={() => onModeChange(m.id)}
                aria-pressed={mode === m.id}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[10px] font-bold uppercase tracking-wider transition ${mode === m.id ? "bg-amber-300 text-[#111] shadow-[0_0_20px_rgba(252,211,77,.2)]" : "text-white/50 hover:bg-white/[.07] hover:text-white"}`}
              >
                {m.id === "fly" ? (
                  <Navigation size={13} />
                ) : m.id === "fps" ? (
                  <Crosshair size={13} />
                ) : (
                  <Route size={13} />
                )}
                <span className={isMobile ? "sr-only sm:not-sr-only" : ""}>{m.label}</span>
                {!isMobile && mode !== m.id && <Key>{m.key}</Key>}
              </button>
            ))}
          </div>
          {!isMobile && (
            <div className="flex gap-2">
              <div className={`${glass} flex rounded-xl p-1`}>
                <button
                  onClick={() => onTimeChange("day")}
                  aria-label="Day lighting"
                  className={`rounded-lg p-2 transition ${time === "day" ? "bg-white/12 text-amber-300" : "text-white/35 hover:text-white"}`}
                >
                  <Sun size={15} />
                </button>
                <button
                  onClick={() => onTimeChange("night")}
                  aria-label="Night lighting"
                  className={`rounded-lg p-2 transition ${time === "night" ? "bg-white/12 text-sky-300" : "text-white/35 hover:text-white"}`}
                >
                  <MoonStar size={15} />
                </button>
              </div>
              <button
                onClick={onToggleIndex}
                className={`${glass} flex items-center gap-2 rounded-xl px-3 text-[10px] uppercase tracking-wider transition ${showIndex ? "!border-amber-300/30 !text-amber-300" : "text-white/55 hover:text-white"}`}
              >
                <Layers3 size={14} /> Assets <Key>I</Key>
              </button>
              <button
                onClick={onToggleHelp}
                aria-label="Keyboard shortcuts"
                className={`${glass} rounded-xl p-2.5 text-white/50 transition hover:text-white`}
              >
                <CircleHelp size={15} />
              </button>
            </div>
          )}

          {showIndex && (
            <section
              className={`${glass} max-h-[55vh] w-72 overflow-y-auto rounded-xl py-2`}
              aria-label="Asset index"
            >
              <div className="flex items-center justify-between border-b border-white/[.07] px-3 py-2">
                <div>
                  <div className="text-[9px] uppercase tracking-[.2em] text-amber-300">
                    Asset registry
                  </div>
                  <div className="mt-1 text-[10px] text-white/35">
                    {siteIndex.reduce((n, g) => n + g.items.length, 0)} mapped objects
                  </div>
                </div>
                <button onClick={onToggleIndex} className="p-1 text-white/35 hover:text-white">
                  <X size={14} />
                </button>
              </div>
              {siteIndex.map((group) => (
                <div key={group.label} className="pt-2">
                  <div className="px-3 py-1 text-[8px] font-bold uppercase tracking-[.2em] text-white/30">
                    {group.label}
                  </div>
                  {group.items.map((item) => (
                    <button
                      key={item.name}
                      onClick={() => onInspect(item)}
                      className={`group flex w-full items-center gap-2 px-3 py-2 text-left transition ${selected?.name === item.name ? "bg-amber-300/10 text-amber-200" : "text-white/60 hover:bg-white/[.05] hover:text-white"}`}
                    >
                      <span
                        className={`h-1 w-1 rounded-full ${selected?.name === item.name ? "bg-amber-300" : "bg-white/25"}`}
                      />
                      <span className="flex-1 font-sans text-xs">{item.name}</span>
                      <span className="text-[8px] uppercase text-white/25">{item.kind}</span>
                      <ChevronRight
                        size={11}
                        className="opacity-0 transition group-hover:opacity-60"
                      />
                    </button>
                  ))}
                </div>
              ))}
            </section>
          )}
        </div>
      </div>

      {showHelp && (
        <div
          className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[2px]"
          onClick={onToggleHelp}
        >
          <section
            className={`${glass} w-full max-w-sm rounded-2xl p-5`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[9px] uppercase tracking-[.2em] text-amber-300">
                  Field guide
                </div>
                <h2 className="mt-1 font-sans text-lg font-medium">Keyboard controls</h2>
              </div>
              <button
                onClick={onToggleHelp}
                className="rounded-lg p-2 text-white/40 hover:bg-white/10 hover:text-white"
              >
                <X size={16} />
              </button>
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3">
              {SHORTCUTS.map(([keys, desc]) => (
                <div key={keys} className="border-b border-white/[.06] pb-2">
                  <dt>
                    <Key>{keys}</Key>
                  </dt>
                  <dd className="mt-1.5 font-sans text-[11px] text-white/50">{desc}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}

      {mode === "fps" && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="h-4 w-4 rounded-full border border-white/60 before:absolute before:left-1/2 before:top-[-5px] before:h-6 before:w-px before:-translate-x-1/2 before:bg-white/35 after:absolute after:left-[-5px] after:top-1/2 after:h-px after:w-6 after:-translate-y-1/2 after:bg-white/35" />
        </div>
      )}

      {!isMobile && (
        <div
          ref={telemetryRef}
          className={`${glass} absolute bottom-5 left-1/2 -translate-x-1/2 rounded-lg px-3 py-2 text-[9px] tabular-nums tracking-[.1em] text-amber-200/80`}
        />
      )}

      <div className="flex items-end justify-between gap-3">
        {!isMobile && (
          <div
            className={`${glass} pointer-events-auto flex items-center gap-3 rounded-xl px-3 py-2.5`}
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-300/10 text-amber-300">
              {mode === "fly" ? (
                <Navigation size={14} />
              ) : mode === "fps" ? (
                <Crosshair size={14} />
              ) : (
                <Sparkles size={14} />
              )}
            </div>
            <div>
              <div className="text-[9px] font-bold uppercase tracking-[.15em] text-white/70">
                {mode === "fly" ? "Explore mode" : mode === "fps" ? "Ground mode" : "Guided tour"}
              </div>
              <div className="mt-0.5 font-sans text-[10px] text-white/35">
                {mode === "fly"
                  ? "Drag to orbit · Scroll to zoom · WASD to move"
                  : mode === "fps"
                    ? "Click to lock · WASD to walk · Shift to run"
                    : "Automated orbital survey in progress"}
              </div>
            </div>
            <button
              onClick={onToggleDebug}
              title="Terrain debug"
              className={`ml-2 rounded-lg p-2 transition ${showDebug ? "bg-emerald-300/15 text-emerald-300" : "text-white/25 hover:bg-white/[.06] hover:text-white"}`}
            >
              <Gauge size={14} />
            </button>
            <div className="group relative">
              <button
                aria-label="Render quality"
                className="rounded-lg p-2 text-white/25 transition hover:bg-white/[.06] hover:text-white"
              >
                <Eye size={14} />
              </button>
              <div className="invisible absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 rounded-lg border border-white/10 bg-[#071014]/95 p-1 opacity-0 shadow-xl transition group-hover:visible group-hover:opacity-100">
                {QUALITIES.map((q) => (
                  <button
                    key={q}
                    onClick={() => onQualityChange(q)}
                    className={`rounded px-2 py-1 text-[8px] uppercase ${qualityTier === q ? "bg-amber-300 text-black" : "text-white/40 hover:text-white"}`}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="pointer-events-auto ml-auto flex flex-col items-end gap-2">
          {selected && (
            <section
              className={`${glass} w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl p-4`}
              aria-label={`Selected asset: ${selected.name}`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-[9px] font-bold uppercase tracking-[.2em] text-amber-300">
                    {selected.kind} / selected
                  </div>
                  <h2 className="mt-1 font-sans text-xl font-medium tracking-tight">
                    {selected.name}
                  </h2>
                </div>
                <button
                  onClick={onClearSelected}
                  aria-label="Close inspector"
                  className="rounded-lg p-1.5 text-white/35 hover:bg-white/10 hover:text-white"
                >
                  <X size={15} />
                </button>
              </div>
              <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 border-y border-white/[.07] py-3 font-sans text-[11px] text-white/50">
                {selected.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
              <button
                onClick={onFlyTo}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-amber-300 py-2.5 text-[10px] font-bold uppercase tracking-wider text-[#16120a] transition hover:bg-amber-200"
              >
                <Navigation size={13} /> Fly to asset
              </button>
            </section>
          )}
          {!isMobile && (
            <div className={`${glass} overflow-hidden rounded-xl p-1`}>
              <div className="flex items-center justify-between px-2 py-1.5 text-[8px] uppercase tracking-[.16em] text-white/35">
                <span className="flex items-center gap-1.5">
                  <Map size={11} /> Site map
                </span>
                <span>Click to navigate</span>
              </div>
              <Minimap markerRef={markerRef} onNavigate={onNavigate} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
