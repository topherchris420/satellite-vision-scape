/**
 * A ghost: where another run was at a given moment, drawn beside the run being
 * watched so two attempts at the same scenario can be seen side by side.
 * Presentation only; built from a trace's samples, and never fed back into
 * the simulation.
 */

export interface GhostTrack {
  label: string;
  /**
   * Position (metres) and heading (radians) at simulation time `tMs`. Returns
   * false outside the recording. `out.yaw` keeps its last value while the
   * recorded avatar stands still.
   */
  at(tMs: number, out: { x: number; z: number; yaw: number }): boolean;
}

/** Sample rows start `[seconds, x, z, …]`. */
export type GhostRow = readonly [number, number, number, ...unknown[]];

export function ghostFromRows(rows: readonly GhostRow[], label: string): GhostTrack {
  let hint = 0;
  return {
    label,
    at(tMs, out) {
      if (rows.length < 2) return false;
      const t = tMs / 1000;
      if (t < rows[0][0] || t > rows[rows.length - 1][0] + 0.5) return false;
      // Time runs forward frame by frame; it jumps back only when a run restarts.
      if (hint >= rows.length - 1 || rows[hint][0] > t) hint = 0;
      while (hint < rows.length - 2 && rows[hint + 1][0] <= t) hint++;
      const a = rows[hint];
      const b = rows[Math.min(hint + 1, rows.length - 1)];
      const span = b[0] - a[0];
      const k = span > 1e-6 ? Math.min(1, Math.max(0, (t - a[0]) / span)) : 0;
      out.x = a[1] + (b[1] - a[1]) * k;
      out.z = a[2] + (b[2] - a[2]) * k;
      const dx = b[1] - a[1];
      const dz = b[2] - a[2];
      if (dx * dx + dz * dz > 0.04) out.yaw = Math.atan2(dx, dz);
      return true;
    },
  };
}
