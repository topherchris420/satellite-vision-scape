import type { ControlMode } from "./Controls";
import type { TimeOfDay } from "./Lighting";
import { objectSummary } from "@/lib/site-layout";

const MODES: { id: ControlMode; label: string }[] = [
  { id: "fly", label: "Free-fly" },
  { id: "fps", label: "First-person" },
  { id: "cinematic", label: "Cinematic" },
];

export function HUD({
  mode,
  onModeChange,
  time,
  onTimeChange,
}: {
  mode: ControlMode;
  onModeChange: (m: ControlMode) => void;
  time: TimeOfDay;
  onTimeChange: (t: TimeOfDay) => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-4 text-sm">
      <div className="pointer-events-auto flex items-start justify-between gap-4">
        <div className="rounded-lg bg-black/60 px-4 py-3 text-white backdrop-blur-sm">
          <h1 className="text-base font-semibold">Industrial Site — Digital Twin</h1>
          <p className="mt-1 max-w-xs text-xs text-white/70">
            Explorable 3D reconstruction from overhead imagery. PBR materials,
            LOD meshes, walk-collision, and a cinematic fly-through.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/60">
            <span>{objectSummary.spheres} spheres</span>
            <span>{objectSummary.tanks} tanks</span>
            <span>{objectSummary.domes} radomes</span>
            <span>{objectSummary.buildings} buildings</span>
            <span>{objectSummary.pipeRacks} pipe racks</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => onModeChange(m.id)}
                className={`rounded-md px-3 py-2 text-xs font-medium transition ${
                  mode === m.id
                    ? "bg-white text-black"
                    : "bg-black/60 text-white hover:bg-black/80"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onTimeChange("day")}
              className={`rounded-md px-3 py-2 text-xs font-medium transition ${
                time === "day"
                  ? "bg-amber-300 text-black"
                  : "bg-black/60 text-white hover:bg-black/80"
              }`}
            >
              ☀ Day
            </button>
            <button
              onClick={() => onTimeChange("night")}
              className={`rounded-md px-3 py-2 text-xs font-medium transition ${
                time === "night"
                  ? "bg-indigo-300 text-black"
                  : "bg-black/60 text-white hover:bg-black/80"
              }`}
            >
              ☾ Night
            </button>
          </div>
        </div>
      </div>

      <div className="pointer-events-auto self-start rounded-lg bg-black/60 px-4 py-3 text-xs text-white backdrop-blur-sm">
        {mode === "fly" && (
          <>
            <div className="font-semibold">Free-fly controls</div>
            <div className="mt-1 text-white/80">
              Drag to orbit · Scroll to zoom · WASD to pan · Q/E up/down · Shift to boost
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
    </div>
  );
}
