import { decided, type DecisionRequest, type ProviderResult } from "../../provider";
import { decisionKey, type FreeRoamDecision } from "../decisions";
import type { FreeRoamObservation } from "../observation";
import type { FreeRoamProvider } from "../runtime";

/**
 * The scripted baseline: a fixed rule, in the browser, that never calls Jev.
 *
 * It exists so Free Roam can be exercised, tested and demonstrated without a
 * decision service, and so a run can be compared against something that is
 * plainly not a model. It sees exactly the observation Jev sees and can only
 * answer with one of its legal decisions. It is labelled as what it is —
 * "Scripted baseline" — everywhere it appears, and it is never recorded or
 * shown as Jev.
 */

export type Policy = (observation: FreeRoamObservation) => FreeRoamDecision;

const has = (o: FreeRoamObservation, type: FreeRoamDecision["type"]) => o.legal.some((d) => d.type === type);
const find = (o: FreeRoamObservation, d: FreeRoamDecision) =>
  o.legal.find((x) => decisionKey(x) === decisionKey(d)) ?? null;

/** Carry on with the objective; lose a pursuit if there is one; otherwise wait. */
export const scriptedPolicy: Policy = (o) => {
  if (o.attention.level >= 3 || o.attention.pursued) {
    if (has(o, "EVADE_PURSUIT") && (o.objective === null || !["escape", "survive"].includes(o.objective.kind)))
      return { type: "EVADE_PURSUIT" };
  }
  if (has(o, "CONTINUE_OBJECTIVE")) return { type: "CONTINUE_OBJECTIVE" };
  if (has(o, "EXPLORE")) return { type: "EXPLORE" };
  return find(o, { type: "WAIT" }) ?? o.legal[0];
};

export class ScriptedBaseline implements FreeRoamProvider {
  readonly id = "baseline";
  readonly label = "Scripted baseline (never calls Jev)";
  readonly source = "test" as const;

  constructor(private readonly policy: Policy = scriptedPolicy) {}

  async decide({ observation }: DecisionRequest<FreeRoamObservation>): Promise<ProviderResult<FreeRoamDecision>> {
    return decided<FreeRoamDecision>(this.policy(observation), { model: "scripted-baseline" });
  }
}
