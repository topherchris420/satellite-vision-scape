import type { AgentIntent, NavigationTarget, TaskObservation } from "../contract";
export interface TaskAdapter {
  readonly id: string;
  observe(): TaskObservation;
  targets(): NavigationTarget[];
  legalIntents(): AgentIntent[];
  evaluate(): Record<string, number | string | boolean | null>;
}
