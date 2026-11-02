/**
 * How much rendering this device can afford, decided once.
 *
 * A quality tier decides trees, ground cover and shadow maps, so changing one
 * rebuilds them and stalls for seconds; doing that during play is the worst
 * time. So the tier is chosen before the world is built (from what the GPU
 * says it is, or from how the last visit went), and frame rate during play is
 * managed with render resolution, which costs nothing to change.
 */

export type QualityTier = "low" | "medium" | "high" | "ultra";

const TIER_ORDER: QualityTier[] = ["low", "medium", "high", "ultra"];

/** A best guess from the WebGL renderer string; the frame rate corrects it. */
export function tierForRenderer(renderer: string | null | undefined): QualityTier {
  const r = (renderer ?? "").toLowerCase();
  if (!r) return "medium";
  // Software rendering, then GPUs that share memory with a laptop or phone CPU.
  if (/swiftshader|llvmpipe|softpipe|software|microsoft basic/.test(r)) return "low";
  if (/adreno|mali|powervr|videocore|intel|vega \d\b|radeon\(tm\) graphics|radeon graphics/.test(r)) return "low";
  if (/apple m\d+ (pro|max|ultra)/.test(r)) return "high";
  if (/apple/.test(r)) return "medium";
  if (/nvidia|geforce|quadro|radeon rx|radeon pro|\brx \d/.test(r)) return "high";
  return "medium";
}

/** Render resolution steps, as a share of the tier's full resolution. */
export const RESOLUTION_STEPS = [1, 0.85, 0.72, 0.6] as const;

/**
 * Frame rates that move the resolution: below `lower` it drops a step, above
 * `upper` it comes back up. A gap keeps it from hunting. The floor is the
 * frame rate that still drives well, not a display's refresh rate, because a
 * laptop at a steady 40 is fine and should keep its sharpness.
 */
export const FPS_BOUNDS: [lower: number, upper: number] = [32, 54];

export type RenderBudget = { tier: QualityTier; step: number };

/** Lowers the budget one step: resolution first, then (where allowed) the tier. */
export function stepDown(budget: RenderBudget, canChangeTier: boolean): RenderBudget {
  if (budget.step < RESOLUTION_STEPS.length - 1) return { ...budget, step: budget.step + 1 };
  const i = TIER_ORDER.indexOf(budget.tier);
  if (canChangeTier && i > 0) return { tier: TIER_ORDER[i - 1], step: 0 };
  return budget;
}

/** Raises the resolution one step. Never raises the tier: that is the person's choice to make. */
export function stepUp(budget: RenderBudget): RenderBudget {
  return budget.step > 0 ? { ...budget, step: budget.step - 1 } : budget;
}

const STORAGE_KEY = "svs.render-budget.v1";

type Stored = RenderBudget & { renderer: string; manual?: boolean };

function parseStored(text: string | null): Stored | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<Stored>;
    if (typeof v.renderer !== "string" || !TIER_ORDER.includes(v.tier as QualityTier)) return null;
    const step = typeof v.step === "number" && RESOLUTION_STEPS[v.step] !== undefined ? v.step : 0;
    return { renderer: v.renderer, tier: v.tier as QualityTier, step, manual: v.manual === true };
  } catch {
    return null;
  }
}

/** Asks the browser what GPU this is, on a throwaway context. Only used on a first visit. */
function probeRenderer(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? (gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as string) : (gl.getParameter(gl.RENDERER) as string);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Where to start on this device. A stored decision wins when it is from the same GPU. */
export function initialBudget(storedText: string | null, probe: () => string | null): RenderBudget & { renderer: string; manual: boolean } {
  const stored = parseStored(storedText);
  if (stored) return { tier: stored.tier, step: stored.step, renderer: stored.renderer, manual: stored.manual ?? false };
  const renderer = probe() ?? "";
  return { tier: tierForRenderer(renderer), step: 0, renderer, manual: false };
}

export function loadBudget(): RenderBudget & { renderer: string; manual: boolean } {
  return initialBudget(read(STORAGE_KEY), probeRenderer);
}

export function saveBudget(budget: RenderBudget, renderer: string, manual: boolean): void {
  try {
    const stored: Stored = { tier: budget.tier, step: budget.step, renderer, manual };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Private windows and blocked storage: the next visit decides again.
  }
}
