import type { MotorSnapshot } from "./executor";
export class EvaluationMetrics {
  elapsedTime = 0;
  distanceWalked = 0;
  distanceDriven = 0;
  collisions = 0;
  stuckRecoveries = 0;
  humanInterventions = 0;
  providerFailures = 0;
  wrongInteractions = 0;
  hardBraking = 0;
  hardAcceleration = 0;
  private latencies: number[] = [];
  private decisionCount = 0;
  private latencyTotal = 0;
  private previous: MotorSnapshot | null = null;
  tick(dt: number, m: MotorSnapshot) {
    this.elapsedTime += dt;
    if (this.previous) {
      const d = Math.hypot(m.x - this.previous.x, m.z - this.previous.z);
      if (d < 50) {
        if (m.locomotion === "DRIVING") this.distanceDriven += d;
        else if (m.locomotion === "ON_FOOT") this.distanceWalked += d;
      }
      if (m.locomotion === "DRIVING" && this.previous.locomotion === "DRIVING") {
        const accel = (Math.abs(m.speed) - Math.abs(this.previous.speed)) / dt;
        if (accel > 4) this.hardAcceleration += dt;
        if (accel < -4) this.hardBraking += dt;
      }
    }
    this.previous = { ...m };
  }
  decision(ms: number) {
    this.decisionCount++;
    this.latencyTotal += ms;
    this.latencies.push(ms);
    if (this.latencies.length > 10000) this.latencies.shift();
  }
  result(task: Record<string, number | string | boolean | null>, complete: boolean) {
    const sorted = [...this.latencies].sort((a, b) => a - b),
      n = sorted.length;
    return {
      generic: {
        taskCompletion: complete,
        elapsedTime: this.elapsedTime,
        distanceTraveled: this.distanceDriven + this.distanceWalked,
        distanceWalked: this.distanceWalked,
        distanceDriven: this.distanceDriven,
        collisions: this.collisions,
        stuckRecoveries: this.stuckRecoveries,
        humanInterventions: this.humanInterventions,
        agentDecisions: this.decisionCount,
        meanDecisionLatency: this.decisionCount ? this.latencyTotal / this.decisionCount : null,
        medianDecisionLatency: n
          ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2
          : null,
        providerFailures: this.providerFailures,
        wrongInteractions: this.wrongInteractions,
        hardBrakingSeconds: this.hardBraking,
        hardAccelerationSeconds: this.hardAcceleration,
      },
      task,
    };
  }
}
