import * as THREE from "three";

/**
 * Compiles a scene's shader programs without blocking the page.
 *
 * Three.js compiles a material the first time it draws it, and the draw then
 * waits for the driver. On Windows, WebGL runs on Direct3D, whose shader
 * compiler is slow enough that this project's ~100 programs froze the tab for
 * a minute on a mid-range laptop. `KHR_parallel_shader_compile` lets the
 * driver do that work on its own threads while the page keeps running, as
 * long as nothing draws with a program before it says it is ready. That is
 * what this does: it starts the compiles, polls the status without blocking,
 * and reports progress so the loading screen can tell the truth.
 *
 * Browsers without the extension report every program ready at once, and the
 * first draw compiles them as it always did, so this is never worse.
 */

export type WarmupProgress = { ready: number; total: number };

export type WarmupOptions = {
  /**
   * The output the scene will really be drawn to. Programs are specific to it:
   * a scene drawn through the effect pipeline writes linear colour, one drawn
   * straight to the canvas writes sRGB, and compiling for the wrong one wastes
   * every compile (the first draw would compile them all again).
   */
  output: "linear" | "canvas";
  onProgress?: (progress: WarmupProgress) => void;
  /** Stop waiting after this long and let the first draw finish the job. */
  timeoutMs?: number;
  signal?: { cancelled: boolean };
};

export type WarmupResult = { programs: number; timedOut: boolean };

/** The parts of three's WebGLProgram used here (it is not in the public types). */
type TrackedProgram = { isReady?: () => boolean };

const POLL_MS = 40;

/** Pure: how many of these programs have finished, given a readiness check. */
export function countReady<T>(programs: Iterable<T>, isReady: (program: T) => boolean): WarmupProgress {
  let ready = 0;
  let total = 0;
  for (const program of programs) {
    total++;
    if (isReady(program)) ready++;
  }
  return { ready, total };
}

/** Starts compiling every program the scene needs and returns them. */
export function startCompiling(
  gl: THREE.WebGLRenderer,
  scene: THREE.Object3D,
  camera: THREE.Camera,
  output: WarmupOptions["output"],
): Set<TrackedProgram> {
  const previous = gl.getRenderTarget();
  const target = output === "linear" ? new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }) : null;
  gl.setRenderTarget(target);
  let materials: Set<THREE.Material>;
  try {
    materials = gl.compile(scene, camera);
  } finally {
    gl.setRenderTarget(previous);
    target?.dispose();
  }
  const programs = new Set<TrackedProgram>();
  for (const material of materials) {
    const program = (gl.properties.get(material) as { currentProgram?: TrackedProgram }).currentProgram;
    if (program) programs.add(program);
  }
  return programs;
}

/** Resolves when every program is ready (or at the deadline); never rejects a slow driver. */
export function whenCompiled(programs: Set<TrackedProgram>, options: WarmupOptions): Promise<WarmupResult> {
  const { onProgress, timeoutMs = 120_000, signal } = options;
  const started = performance.now();
  const isReady = (program: TrackedProgram) => program.isReady?.() ?? true;
  return new Promise((resolve) => {
    const poll = () => {
      if (signal?.cancelled) {
        resolve({ programs: programs.size, timedOut: false });
        return;
      }
      const progress = countReady(programs, isReady);
      onProgress?.(progress);
      const timedOut = performance.now() - started > timeoutMs;
      if (progress.ready >= progress.total || timedOut) {
        resolve({ programs: progress.total, timedOut });
        return;
      }
      setTimeout(poll, POLL_MS);
    };
    poll();
  });
}

/** Compile everything the scene needs, without blocking, before it is first drawn. */
export function warmScene(
  gl: THREE.WebGLRenderer,
  scene: THREE.Object3D,
  camera: THREE.Camera,
  options: WarmupOptions,
): Promise<WarmupResult> {
  return whenCompiled(startCompiling(gl, scene, camera, options.output), options);
}
