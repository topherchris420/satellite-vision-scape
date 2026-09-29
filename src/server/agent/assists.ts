/**
 * Assists: the words the server adds to a question to cover for what today's
 * model cannot yet do on its own.
 *
 * Every hint in the TypeSafe question that goes beyond "what a player can see"
 * is one of these, named, with the failure that justified it and the
 * measurement that retires it. They are switched per deployment
 * (`JEV_ASSISTS`, server-only) so the same build can ask the question the way
 * today's model needs and the way next quarter's model should manage without
 * — and the capability probes (`scripts/probe-capabilities.ts`) measure the
 * difference instead of guessing it.
 *
 * Two rules keep this from overshooting:
 *
 *  - An assist states a *conclusion* the model could reach from facts already
 *    in `state` (or a control's feel a player learns by trying). Removing it
 *    never removes a fact the player has on screen.
 *  - An assist is retired only on evidence: its probes pass without it on the
 *    newest model (see `retirementVerdict`). Never on a hunch, never because
 *    a model "should" manage.
 */

export const ASSIST_IDS = [
  "trend_inference",
  "hold_still_rule",
  "control_magnitudes",
  "spill_advice",
  "semantic_bearings",
] as const;
export type AssistId = (typeof ASSIST_IDS)[number];

export interface AssistSpec {
  id: AssistId;
  /** What the question says when the assist is on. */
  adds: string;
  /** The model limitation it covers, and where that was seen. */
  evidence: string;
  /** Probes that exercise it (ids in `src/agent/probes`). */
  probes: string[];
  /** What the question says instead when it is off. */
  without: string;
}

export const ASSISTS: Record<AssistId, AssistSpec> = {
  trend_inference: {
    id: "trend_inference",
    adds: 'Terminal feedback spelled out: "turning up raised the match: the reference lies further up", "you turned past it".',
    evidence:
      "Live run A (2026-09-27): 473 decisions alternating dial up / dial down at the Harmony terminal; the meter trend was in `state` but not acted on.",
    probes: ["terminal-reverse-after-overshoot", "terminal-continue-while-rising"],
    without: "The match before and after the last turn, as numbers. No direction is inferred.",
  },
  hold_still_rule: {
    id: "hold_still_rule",
    adds: '"Keeping the dial completely still (Wait) locks it; turning now can break it" on terminal and receiver holds, plus a Wait rule in the context.',
    evidence:
      "Live run A: at ALIGNED the model kept turning; after this hint, targeted checks chose Wait 4/4.",
    probes: ["terminal-hold-when-aligned", "receiver-hold-signal"],
    without: "The status word and the hold meter only (ALIGNED · lock meter 40%).",
  },
  control_magnitudes: {
    id: "control_magnitudes",
    adds: "How far each control moves a dial (a click ≈ 1%, a short hold ≈ 5%, a long hold ≈ 20%).",
    evidence:
      "Live run A: a short hold was bigger than the aligned zone, so every correction overshot.",
    probes: ["terminal-reverse-after-overshoot", "receiver-tune-toward-clue"],
    without: "Only the control names: one click, a short hold, a long hold.",
  },
  spill_advice: {
    id: "spill_advice",
    adds: '"Braking hard, launching, sharp cornering and collisions spill it; speed alone does not", plus "prefer smooth driving" in the context.',
    evidence:
      "Precautionary: added with the first integration, before any failure was seen. The executor already drives smoothly with the coffee aboard.",
    probes: ["coffee-deliver-while-driving"],
    without: "The coffee meter and timer only.",
  },
  semantic_bearings: {
    id: "semantic_bearings",
    adds: 'Directions in words ("ahead and to the left") instead of signed degrees.',
    evidence:
      "TypeSafe's integration guidance: Jev reads semantic descriptions better than raw numbers and should not invert directions.",
    probes: ["coffee-deliver-while-driving", "terminal-go-to-terminal"],
    without: "Signed relative bearings in degrees (+ right, − left) and distances in metres.",
  },
};

/**
 * Profiles, from today's model to the bet on the next one:
 *
 *  - `full`: every assist — exactly what live run B used. The default.
 *  - `lean`: facts, not conclusions. The screen, the controls' feel and
 *    directions in words stay; the coaching goes. This is the question we
 *    expect the next model to answer as well as today's answers `full`.
 *  - `none`: raw facts in numbers. A ceiling probe, not a shipping profile:
 *    it shows how far the frontier is, so `lean` is neither too timid nor
 *    too far ahead.
 */
export const ASSIST_PROFILES = {
  full: ASSIST_IDS,
  lean: ["control_magnitudes", "semantic_bearings"],
  none: [],
} as const satisfies Record<string, readonly AssistId[]>;

export type AssistProfile = keyof typeof ASSIST_PROFILES;
export const DEFAULT_ASSIST_PROFILE: AssistProfile = "full";

export interface Assists {
  profile: string;
  on: ReadonlySet<AssistId>;
}

export function assistsFor(profile: AssistProfile): Assists {
  return { profile, on: new Set(ASSIST_PROFILES[profile]) };
}

export const FULL_ASSISTS: Assists = assistsFor("full");

/** Every assist but one: the single-factor ablation (`full-trend_inference`). */
export function assistsWithout(id: AssistId): Assists {
  return { profile: `full-${id}`, on: new Set(ASSIST_IDS.filter((a) => a !== id)) };
}

/**
 * Parse an assist configuration strictly: a profile name (`full`, `lean`,
 * `none`), a single-factor ablation (`full-trend_inference`) or a
 * comma-separated list of assist ids. Anything else is `null`: experiments
 * use this so a typo is an error, never a silently different condition.
 */
export function parseAssists(value: string | undefined): Assists | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  if (v in ASSIST_PROFILES) return assistsFor(v as AssistProfile);
  if (v.startsWith("full-")) {
    const id = v.slice(5);
    return ASSIST_IDS.includes(id as AssistId) ? assistsWithout(id as AssistId) : null;
  }
  const ids = v.split(",").map((s) => s.trim());
  if (ids.length > 0 && ids.every((id): id is AssistId => ASSIST_IDS.includes(id as AssistId))) {
    const on = new Set(ids);
    return { profile: [...on].sort().join(","), on };
  }
  return null;
}

/**
 * `JEV_ASSISTS`: anything `parseAssists` accepts. Anything unrecognised falls
 * back to `full`, so on a deployment a typo can only make the question more
 * helpful, never less.
 */
export function resolveAssists(value: string | undefined): Assists {
  return parseAssists(value) ?? FULL_ASSISTS;
}

// --- Retirement: the decision rule, applied to measurements ------------------------------

export interface ProbeTally {
  probe: string;
  profile: string;
  passes: number;
  trials: number;
}

/** Wilson score interval at 95%: honest bounds for small samples. */
export function wilson(passes: number, trials: number): { low: number; high: number } {
  if (trials === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = passes / trials;
  const d = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / d;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export const RETIREMENT = {
  /** Trials per probe per profile before any verdict. */
  minTrials: 10,
  /** Without the assist, its probes must still pass at least this often (Wilson lower bound). */
  floor: 0.8,
  /** And may not drop more than this below the same probes with it. */
  maxRegression: 0.05,
} as const;

export type Verdict = "retire" | "keep" | "insufficient_data";

/**
 * Should `assist` go? Compares its probes between a profile that has it
 * (`withProfile`) and one that does not (`withoutProfile`) for one model.
 * Retire only when every probe has enough trials, clears the floor without
 * it, and does not regress by more than `maxRegression`.
 */
export function retirementVerdict(
  assist: AssistId,
  tallies: readonly ProbeTally[],
  withProfile: string,
  withoutProfile: string,
): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  let insufficient = false;
  let keep = false;
  for (const probe of ASSISTS[assist].probes) {
    const w = tallies.find((t) => t.probe === probe && t.profile === withProfile);
    const wo = tallies.find((t) => t.probe === probe && t.profile === withoutProfile);
    if (!w || !wo || w.trials < RETIREMENT.minTrials || wo.trials < RETIREMENT.minTrials) {
      insufficient = true;
      reasons.push(`${probe}: fewer than ${RETIREMENT.minTrials} trials`);
      continue;
    }
    const low = wilson(wo.passes, wo.trials).low;
    const drop = w.passes / w.trials - wo.passes / wo.trials;
    if (low < RETIREMENT.floor) {
      keep = true;
      reasons.push(
        `${probe}: ${wo.passes}/${wo.trials} without it (lower bound ${low.toFixed(2)} < ${RETIREMENT.floor})${
          wo.passes === wo.trials
            ? "; every trial passed, so more trials, not this result, would decide"
            : ""
        }`,
      );
    } else if (drop > RETIREMENT.maxRegression) {
      keep = true;
      reasons.push(`${probe}: drops ${(drop * 100).toFixed(0)} points without it`);
    } else reasons.push(`${probe}: ${wo.passes}/${wo.trials} without it, holds`);
  }
  return { verdict: keep ? "keep" : insufficient ? "insufficient_data" : "retire", reasons };
}
