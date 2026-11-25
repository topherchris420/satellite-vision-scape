/**
 * The one piece of the hidden case that ships with every visit: a glance at
 * its saved file, so the survey knows whether the signal has been found
 * before. It reads two fields and nothing else; the case itself (story,
 * scene objects, HUD) is loaded only after the visitor accepts it.
 */

/** Same key as the case file (checked by a test). */
export const HIDDEN_CASE_KEY = "99sure.hidden.v1";

export interface CaseGlimpse {
  found: boolean;
  stage: "briefing" | "investigating" | "closed";
}

export function glimpseCase(read: () => string | null): CaseGlimpse {
  let raw: unknown = null;
  try {
    const text = read();
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const stage = r.stage === "investigating" || r.stage === "closed" ? r.stage : "briefing";
  return { found: r.found === true, stage };
}

export function readGlimpse(): CaseGlimpse {
  return glimpseCase(() => {
    try {
      return typeof window === "undefined" ? null : window.localStorage.getItem(HIDDEN_CASE_KEY);
    } catch {
      return null;
    }
  });
}

/** Seconds of surveying (Explore, Tour or Plan) before an unknown signal shows. */
export const SIGNAL_DWELL_S = 30;
/** Or this many different structures inspected. */
export const SIGNAL_INSPECTIONS = 2;

export function signalRevealed(
  glimpse: CaseGlimpse,
  surveyedSeconds: number,
  inspections: number,
): boolean {
  return glimpse.found || surveyedSeconds >= SIGNAL_DWELL_S || inspections >= SIGNAL_INSPECTIONS;
}
