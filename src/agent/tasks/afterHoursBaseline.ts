import { intentKey, type AgentIntent, type TuningAmount } from "../contract";
import type { NavigationTarget, WorldObservation } from "../observation";
import type { AfterHoursState } from "./afterHoursSchema";

/**
 * A scripted After Hours baseline: a hand-written policy, clearly labelled,
 * that plays the task from the observation alone.
 *
 * It exists to exercise the runtime end to end (the mock provider) and to
 * give comparisons a deterministic reference. It is **not** Jev and is never
 * presented as Jev. It reads nothing but the `WorldObservation` a provider
 * receives — the same objective line, captions, meters and legal intents —
 * and can only return an intent from the legal set. When the observation
 * does not say what to do, it waits or asks for help; it has no hidden
 * knowledge of targets or answers.
 */

const DIGITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

/**
 * The number a Numbers Station transmission spells, from its captions: the
 * digits of the first complete group, once the same group has been heard
 * twice in the transmission ("Four. Two. Zero. Four. Two. Zero.").
 */
export function numberFromCaptions(captions: AfterHoursState["captions"]): number | null {
  for (let i = captions.length - 1; i >= 0; i--) {
    const c = captions[i];
    if (c.kind !== "numbers") continue;
    const digits = c.text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w in DIGITS)
      .map((w) => DIGITS[w]);
    if (digits.length >= 6) {
      const half = digits.length / 2;
      const a = digits.slice(0, half).join("");
      const b = digits.slice(half).join("");
      if (Number.isInteger(half) && a === b) return Number(a);
    }
  }
  return null;
}

/** Tuning amount for a remaining distance, in the device's feel. */
function amountFor(remaining: number, long: number, short: number): TuningAmount {
  if (remaining > long) return "long";
  if (remaining > short) return "short";
  return "tap";
}

export function createAfterHoursBaseline(): (o: WorldObservation) => AgentIntent {
  let dialDirection: "up" | "down" | null = null;
  let dialTerminal: string | null = null;

  return (observation) => {
    const o = observation as WorldObservation<AfterHoursState>;
    const st = o.task.state;
    const legal = new Map(o.legal.map((i) => [intentKey(i), i]));
    const offered = (intent: AgentIntent): AgentIntent | null =>
      legal.get(intentKey(intent)) ?? null;
    const wait: AgentIntent = { intent: "wait" };
    const target = (id: string): NavigationTarget | undefined =>
      o.navigation.targets.find((t) => t.id === id);
    const driving = o.actor.locomotion === "driving";
    const onFoot = o.actor.locomotion === "on_foot";

    /** Get to a target: drive if in a vehicle, else walk (taking a car for long trips). */
    const go = (id: string, walkWithin = 120): AgentIntent => {
      const t = target(id);
      if (!t) return wait;
      if (driving) {
        if (t.distanceM < 22) return offered({ intent: "exit_vehicle" }) ?? wait;
        return offered({ intent: "drive_to", target: id }) ?? wait;
      }
      if (onFoot && t.distanceM > walkWithin) {
        const car = o.navigation.targets
          .filter((v) => v.kind === "vehicle" && v.distanceM < 60)
          .sort((a, b) => a.distanceM - b.distanceM)[0];
        if (car)
          return (
            offered({ intent: "enter_vehicle", target: car.id }) ??
            offered({ intent: "navigate_to", target: car.id }) ??
            wait
          );
      }
      return offered({ intent: "navigate_to", target: id }) ?? wait;
    };

    if (o.actor.busy && !st.tuning) return wait;

    // An open terminal: follow the match meter.
    if (st.tuning) {
      const t = st.tuning;
      if (t.status === "aligned_hold" || t.status === "locked") return wait;
      if (dialTerminal !== t.terminal) {
        dialTerminal = t.terminal;
        dialDirection = t.dialPercent > 50 ? "down" : "up";
      } else if (t.matchTrend === "falling") {
        dialDirection = dialDirection === "up" ? "down" : "up";
      }
      if (t.dialPercent <= 1) dialDirection = "up";
      if (t.dialPercent >= 99) dialDirection = "down";
      const amount = t.matchPercent < 40 ? "long" : t.matchPercent < 80 ? "short" : "tap";
      return offered({ intent: "tune_terminal", direction: dialDirection!, amount }) ?? wait;
    }
    dialTerminal = null;

    if (st.coffee.retryAvailable) return offered({ intent: "retry" }) ?? go("coffee_cart");

    switch (o.task.stage) {
      case "coffee": {
        if (!st.coffee.carrying)
          return offered({ intent: "interact", target: "coffee_cart" }) ?? go("coffee_cart");
        return offered({ intent: "interact", target: "technician" }) ?? go("technician", 60);
      }
      case "channel": {
        if (!st.radio.inReach && st.radio.vehicle) return go(st.radio.vehicle, 1e9);
        if (!st.radio.powered) return offered({ intent: "radio_power" }) ?? wait;
        const wanted = numberFromCaptions(st.captions);
        if (wanted === null) {
          if (st.radio.station !== "Numbers Station")
            return offered({ intent: "radio_next_station" }) ?? wait;
          return wait; // listen
        }
        const diff = wanted - st.radio.frequency;
        if (Math.abs(diff) <= 0.2) return wait; // hold it there
        return (
          offered({
            intent: "tune_receiver",
            direction: diff > 0 ? "up" : "down",
            amount: amountFor(Math.abs(diff), 30, 2.5),
          }) ?? wait
        );
      }
      case "terminals": {
        const next = (st.terminals ?? [])
          .filter((t) => !t.completed)
          .sort((a, b) => a.distanceM - b.distanceM)[0];
        if (!next) return wait;
        return offered({ intent: "interact", target: next.id }) ?? go(next.id);
      }
      case "concert":
        if (st.concert.running) return wait;
        return offered({ intent: "start_concert" }) ?? go("listening_point");
      default:
        return wait;
    }
  };
}
