import type { Game } from "../../game/Game";
import {
  COFFEE_CART,
  DELIVERY,
  LISTENING_POINT,
  TERMINAL_SITES,
} from "../../game/afterhours/sites";
import { INTERACTION } from "../../game/config";
import type { AgentIntent, NavigationTarget, TaskObservation } from "../contract";
import type { TaskAdapter } from "./task";
/** Read-only adapter. Exports HUD facts, never progression objects or puzzle definitions. */
export class AfterHoursTaskAdapter implements TaskAdapter {
  readonly id = "after-hours";
  private clues: string[] = [];
  private attempts = { receiverAttempts: 0, terminalTuningAttempts: 0 };
  noteIntent(intent: AgentIntent) {
    if (intent.intent === "tune_receiver") this.attempts.receiverAttempts++;
    if (intent.intent === "tune_terminal") this.attempts.terminalTuningAttempts++;
  }
  constructor(private readonly game: Game) {}
  observe(): TaskObservation {
    const ah = this.game.afterHours,
      s = ah.hud.getSnapshot(),
      t = ah.session?.tuning;
    if (s.caption && !this.clues.includes(s.caption.text))
      this.clues = [...this.clues, s.caption.text].slice(-12);
    return {
      id: this.id,
      stage: s.stage,
      objective: s.objective,
      complete: s.concert.completed,
      clues: [...this.clues],
      facts: {
        active: ah.active,
        coffeeState: s.mission.state,
        carrying: s.mission.carrying,
        coffeeRemaining: s.mission.carrying
          ? Math.round(ah.mission.spill.integrity)
          : (s.mission.result?.percent ?? null),
        coffeeTimeRemaining: s.mission.carrying ? Math.ceil(ah.mission.remaining) : null,
        radioReach: s.radio.inReach,
        radioPower: s.radio.power,
        station: s.radio.stationLabel,
        frequency: Number(ah.radio.frequency.toFixed(1)),
        signalStrength: Math.round(ah.radio.strength * 5),
        receiverHolding: s.radio.holding,
        channelDiscovered: s.radio.f420Discovered,
        terminal: s.tuning?.layer ?? null,
        terminalStatus: t?.status ?? null,
        terminalDial: t ? Number(t.dial.toFixed(3)) : null,
        terminalAlignment: t ? Math.round(t.alignment * 100) : null,
        terminalsCompleted: Object.values(s.terminals).filter(Boolean).length,
        concertAvailable: s.concert.unlocked,
        concertRunning: s.concert.running,
      },
    };
  }
  targets(): NavigationTarget[] {
    const g = this.game,
      ah = g.afterHours,
      s = ah.hud.getSnapshot();
    if (!ah.active) return [];
    const p = g.interaction.driven?.physics ?? g.player.position;
    const foot = g.interaction.state === "ON_FOOT" && !g.movementLocked;
    const result: NavigationTarget[] = [];
    const site = (
      id: string,
      loc: { x: number; z: number; label: string },
      radius: number,
      kind: NavigationTarget["kind"],
      enabled: boolean,
    ) =>
      result.push({
        id,
        ...loc,
        radius,
        kind,
        usable: foot && enabled && Math.hypot(p.x - loc.x, p.z - loc.z) <= radius,
      });
    // Mission briefing explicitly reveals cart and technician, unlike hidden terminals.
    site("coffee_cart", COFFEE_CART, 2.6, "site", s.mission.state !== "active");
    site("technician", DELIVERY, 3, "site", s.mission.state === "active");
    if (s.terminalsRevealed)
      for (const t of TERMINAL_SITES)
        if (!s.terminals[t.layer]) site(t.layer, t, 2.4, "terminal", true);
    if (s.concert.unlocked)
      site("listening_point", LISTENING_POINT, 4, "concert", !s.concert.running);
    for (const v of g.vehicles.vehicles) {
      if (Math.hypot(p.x - v.physics.x, p.z - v.physics.z) > 65 && v !== g.interaction.vehicle)
        continue;
      const yaw = v.physics.yaw,
        offset = -(v.spec.collider.halfWidth + INTERACTION.doorStandOff),
        dz = v.spec.doors.hingeZ - 0.73;
      const x = v.physics.x + Math.cos(yaw) * offset + Math.sin(yaw) * dz,
        z = v.physics.z - Math.sin(yaw) * offset + Math.cos(yaw) * dz;
      result.push({
        id: v.id,
        label: v.label,
        x,
        z,
        radius: 1.4,
        kind: "vehicle",
        usable:
          foot &&
          Math.hypot(p.x - x, p.z - z) < 1.4 &&
          g.interaction.prompt?.label === "Enter vehicle",
      });
    }
    return result.map(({ id, label, x, z, radius, kind, usable }) => ({
      id,
      label,
      x,
      z,
      radius,
      kind,
      usable,
    }));
  }
  legalIntents(): AgentIntent[] {
    const g = this.game,
      s = g.afterHours.hud.getSnapshot();
    const out: AgentIntent[] = [{ intent: "wait" }, { intent: "request_human" }];
    if (!g.afterHours.active) return out;
    if (s.tuning)
      return [
        ...out,
        { intent: "tune_terminal", direction: "up" },
        { intent: "tune_terminal", direction: "down" },
        { intent: "leave_terminal" },
      ];
    const foot = g.interaction.state === "ON_FOOT",
      driving = g.interaction.state === "DRIVING";
    if (driving) out.push({ intent: "stop_vehicle" }, { intent: "exit_vehicle" });
    if (foot || driving)
      for (const t of this.targets()) {
        if (!driving || t.kind !== "vehicle")
          out.push({ intent: driving ? "drive_to" : "navigate_to", target: t.id });
        if (t.usable)
          out.push({
            intent:
              t.kind === "vehicle"
                ? "enter_vehicle"
                : t.kind === "concert"
                  ? "start_concert"
                  : "interact",
            target: t.id,
          });
      }
    if (s.radio.inReach && (foot || driving))
      out.push(
        { intent: "radio_power" },
        { intent: "radio_next_station" },
        { intent: "radio_next_track" },
        { intent: "radio_previous_track" },
        { intent: "tune_receiver", direction: "up" },
        { intent: "tune_receiver", direction: "down" },
      );
    return out;
  }
  evaluate() {
    const ah = this.game.afterHours;
    return {
      ...this.attempts,
      coffeeRemaining:
        ah.mission.result?.percent ??
        (ah.mission.state === "active" ? Math.round(ah.mission.spill.integrity) : null),
      coffeeMissionTime: ah.mission.result?.seconds ?? null,
      terminalsCompleted: Object.values(ah.progress.terminals).filter(Boolean).length,
      concertReached: ah.concert.state === "running" || ah.progress.concertCompleted,
    };
  }
}
