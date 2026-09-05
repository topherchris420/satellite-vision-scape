import { useMemo } from "react";
import * as THREE from "three";
import { validateGroundContact, type GroundValidationSummary } from "@/lib/terrain/ground-validator";

export function TerrainDebug({ showPanel = true }: { showPanel?: boolean }) {
  const summary: GroundValidationSummary = useMemo(() => validateGroundContact(), []);

  return (
    <group name="terrain-debug-overlay">
      {summary.reports.map((r, i) => {
        const color = r.status === "OK" ? "#10b981" : r.status === "WARNING" ? "#f59e0b" : "#ef4444";
        return (
          <mesh
            key={`debug-${i}`}
            position={[r.id.includes("(") ? parseFloat(r.id.split("(")[1]) : 0, r.baseElevation + 0.1, r.id.includes(",") ? parseFloat(r.id.split(",")[1]) : 0]}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <ringGeometry args={[1.5, 2.0, 16]} />
            <meshBasicMaterial color={color} side={THREE.DoubleSide} transparent opacity={0.8} />
          </mesh>
        );
      })}
    </group>
  );
}

export function TerrainDebugHUD({ onClose }: { onClose: () => void }) {
  const summary = useMemo(() => validateGroundContact(), []);

  return (
    <div className="pointer-events-auto absolute right-4 top-20 z-40 max-h-[60vh] w-80 overflow-y-auto rounded-lg bg-black/85 p-4 font-mono text-xs text-white shadow-2xl backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-white/20 pb-2">
        <span className="font-bold text-amber-300">TERRAIN GROUNDING DEBUG</span>
        <button onClick={onClose} className="text-white/50 hover:text-white">✕</button>
      </div>

      <div className="my-2 grid grid-cols-3 gap-2 text-center text-[10px]">
        <div className="rounded bg-emerald-950/60 p-1 border border-emerald-500/30">
          <div className="text-emerald-400 font-bold">{summary.okCount}</div>
          <div className="text-white/60">OK</div>
        </div>
        <div className="rounded bg-amber-950/60 p-1 border border-amber-500/30">
          <div className="text-amber-400 font-bold">{summary.warningCount}</div>
          <div className="text-white/60">WARNING</div>
        </div>
        <div className="rounded bg-rose-950/60 p-1 border border-rose-500/30">
          <div className="text-rose-400 font-bold">{summary.errorCount}</div>
          <div className="text-white/60">ERROR</div>
        </div>
      </div>

      <div className="space-y-1 text-[10px]">
        {summary.reports.slice(0, 30).map((r) => (
          <div key={r.id} className="flex justify-between border-b border-white/5 py-0.5">
            <span className="truncate text-white/80" title={r.id}>{r.id}</span>
            <span className={r.status === "OK" ? "text-emerald-400" : "text-amber-400"}>
              {r.status} ({r.baseElevation.toFixed(1)}m)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
