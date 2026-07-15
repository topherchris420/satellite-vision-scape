import type { ControlMode } from "./Controls";

export function HUD({
  mode,
  onModeChange,
}: {
  mode: ControlMode;
  onModeChange: (m: ControlMode) => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-4 text-sm">
      <div className="pointer-events-auto flex items-start justify-between gap-4">
        <div className="rounded-lg bg-black/60 px-4 py-3 text-white backdrop-blur-sm">
          <h1 className="text-base font-semibold">Site Digital Twin</h1>
          <p className="mt-1 text-xs text-white/70">
            Approximated 3D reconstruction from overhead imagery
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onModeChange("fly")}
            className={`rounded-md px-3 py-2 text-xs font-medium transition ${
              mode === "fly"
                ? "bg-white text-black"
                : "bg-black/60 text-white hover:bg-black/80"
            }`}
          >
            Free-fly
          </button>
          <button
            onClick={() => onModeChange("fps")}
            className={`rounded-md px-3 py-2 text-xs font-medium transition ${
              mode === "fps"
                ? "bg-white text-black"
                : "bg-black/60 text-white hover:bg-black/80"
            }`}
          >
            First-person
          </button>
        </div>
      </div>

      <div className="pointer-events-auto self-start rounded-lg bg-black/60 px-4 py-3 text-xs text-white backdrop-blur-sm">
        {mode === "fly" ? (
          <>
            <div className="font-semibold">Free-fly controls</div>
            <div className="mt-1 text-white/80">
              Drag to orbit · Scroll to zoom · WASD to pan · Q/E up/down · Shift to boost
            </div>
          </>
        ) : (
          <>
            <div className="font-semibold">First-person controls</div>
            <div className="mt-1 text-white/80">
              Click scene to lock mouse · WASD to walk · Shift to run · Esc to release
            </div>
          </>
        )}
      </div>
    </div>
  );
}
