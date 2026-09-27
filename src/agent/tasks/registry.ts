import {
  parseObservation,
  type TaskSchemaRegistry,
  type Validated,
  type WorldObservation,
} from "../observation";
import { AFTER_HOURS_TASK, AfterHoursTaskSchema } from "./afterHoursSchema";

/**
 * The tasks this build knows how to validate. A new task adds its envelope
 * schema here; the generic contract, the runtime and the providers do not
 * change.
 */
export const TASK_SCHEMAS: TaskSchemaRegistry = {
  [AFTER_HOURS_TASK]: AfterHoursTaskSchema,
};

export function validateObservation(value: unknown): Validated<WorldObservation> {
  return parseObservation(value, TASK_SCHEMAS);
}
