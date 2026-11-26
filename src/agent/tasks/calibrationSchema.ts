import { z } from "zod";
import { taskObservationSchema } from "../observation";

export const CALIBRATION_TASK = "field-calibration";
export const CalibrationSchema = taskObservationSchema(
  CALIBRATION_TASK,
  z
    .object({
      samples: z.array(z.enum(["reference", "blank"])).max(2),
    })
    .strict(),
);
