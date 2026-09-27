import type { WorldObservation } from "./contract";
export function observationHash(value: WorldObservation): string {
  let h = 2166136261;
  for (const c of JSON.stringify(value)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
export class TraceRecorder {
  readonly header;
  readonly records: Record<string, unknown>[] = [];
  dropped = 0;
  constructor(
    buildId = "development",
    readonly session = crypto.randomUUID(),
    context = { environment: "unknown", task: "unknown" },
  ) {
    this.header = {
      schema: "svs-agent-trace/v1",
      observationSchema: "svs-agent-observation/v1",
      actionContract: "svs-agent-action/v1",
      ...context,
      providerId: "human",
      controlMode: "human",
      model: null as string | null,
      session,
      buildId,
      timestamp: new Date().toISOString(),
    };
  }
  add(type: string, data: Record<string, unknown> = {}) {
    if (this.records.length >= 10000) {
      this.records.shift();
      this.dropped++;
    }
    this.records.push({ type, ...data });
  }
  export(evaluation: unknown) {
    return JSON.stringify(
      { ...this.header, dropped: this.dropped, records: this.records, evaluation },
      null,
      2,
    );
  }
}
