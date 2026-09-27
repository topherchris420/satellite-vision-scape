import { intentKey, type AgentIntent } from "../contract";
import type { WorldObservation } from "../observation";
import type { AfterHoursState } from "../tasks/afterHoursSchema";
import { numberFromCaptions } from "../tasks/afterHoursBaseline";

/**
 * Capability probes: single decisions with an answer any player would agree
 * on, each taken from a real observation of the running game.
 *
 * A probe is a question the whole mission depends on ("the dial is aligned —
 * do you keep still?"), asked out of the flow of a run so it can be repeated
 * cheaply, compared across models and across assist profiles, and read
 * against the chance floor of a uniform pick among the legal intents. They
 * measure; they do not train and do not appear in any question.
 *
 * `matches` finds the situation in a stream of observations (the capture
 * script keeps the first match); `passes` grades one answer. Both read the
 * observation only, like any provider.
 */

export const PROBE_SCHEMA = "svs-agent-probes/v1" as const;

type Obs = WorldObservation<AfterHoursState>;

export interface Probe {
  id: string;
  title: string;
  /** What passing shows the model can do. */
  measures: string;
  /** The passing answers, in words. */
  expected: string;
  matches(o: Obs): boolean;
  passes(intent: AgentIntent, o: Obs): boolean;
}

const lastTune = (o: Obs) =>
  o.previousOutcome?.intent.intent === "tune_terminal" ? o.previousOutcome.intent : null;

const has = (o: Obs, key: string) => o.legal.some((i) => intentKey(i) === key);

const TERMINALS = new Set(["rhythm", "bass", "harmony", "melody"]);

export const AFTER_HOURS_PROBES: readonly Probe[] = [
  {
    id: "coffee-go-to-cart",
    title: "Start the night: fetch the coffee",
    measures: "Reading a briefing objective and choosing the matching destination.",
    expected: "Walk to the coffee cart (or use it, if already there).",
    matches: (o) =>
      o.task.stage === "coffee" &&
      o.task.state.coffee.state === "available" &&
      o.actor.locomotion === "on_foot" &&
      has(o, "navigate_to:coffee_cart"),
    passes: (i) =>
      intentKey(i) === "navigate_to:coffee_cart" || intentKey(i) === "interact:coffee_cart",
  },
  {
    id: "coffee-deliver-while-driving",
    title: "Coffee aboard: drive it to the technician",
    measures: "Keeping a multi-step goal across a change of vehicle, among ~20 options.",
    expected: "Drive to the technician.",
    matches: (o) =>
      o.task.state.coffee.carrying &&
      o.actor.locomotion === "driving" &&
      (o.navigation.targets.find((t) => t.id === "technician")?.distanceM ?? 0) > 150,
    passes: (i) => intentKey(i) === "drive_to:technician",
  },
  {
    id: "receiver-tune-toward-clue",
    title: "Decode the numbers station, turn towards it",
    measures:
      "Turning spoken digits into a number and comparing it with the dial: no hint says which way.",
    expected: "Turn the receiver up (any amount): the captions spell 420 and the dial is below it.",
    matches: (o) => {
      const r = o.task.state.radio;
      const heard = numberFromCaptions(o.task.state.captions);
      return (
        heard !== null &&
        r.inReach &&
        r.powered &&
        !r.signalAcquired &&
        r.holdPercent === null &&
        heard - r.frequency > 20 &&
        has(o, "tune_receiver:up:long")
      );
    },
    passes: (i) => i.intent === "tune_receiver" && i.direction === "up",
  },
  {
    id: "receiver-hold-signal",
    title: "Signal caught: keep the dial still",
    measures: "Recognising that the best action is no action while a hold meter fills.",
    expected: "Wait.",
    matches: (o) => o.task.state.radio.holdPercent !== null && o.task.state.radio.holdPercent < 80,
    passes: (i) => i.intent === "wait",
  },
  {
    id: "terminal-go-to-terminal",
    title: "Signals revealed: go to a terminal",
    measures: "Picking a destination from a list of places, distances and directions.",
    expected: "Walk or drive to any terminal that is not tuned yet.",
    matches: (o) =>
      o.task.stage === "terminals" &&
      o.task.state.tuning === null &&
      o.execution === null &&
      o.actor.locomotion === "on_foot" &&
      o.task.state.prompt === null &&
      (o.task.state.terminals?.every((t) => !t.completed) ?? false),
    passes: (i) =>
      (i.intent === "navigate_to" || i.intent === "drive_to") && TERMINALS.has(i.target),
  },
  {
    id: "terminal-open-when-prompted",
    title: "At the terminal: use it",
    measures: "Acting on the on-screen prompt instead of wandering on.",
    expected: "Use the terminal the prompt names.",
    matches: (o) => o.legal.some((i) => i.intent === "interact" && TERMINALS.has(i.target)),
    passes: (i, o) => i.intent === "interact" && TERMINALS.has(i.target) && has(o, intentKey(i)),
  },
  {
    id: "terminal-hold-when-aligned",
    title: "Aligned: stop turning",
    measures: "The run A failure: stopping when the panel says ALIGNED instead of fiddling.",
    expected: "Wait.",
    matches: (o) =>
      o.task.state.tuning?.status === "aligned_hold" && o.task.state.tuning.lockPercent < 60,
    passes: (i) => i.intent === "wait",
  },
  {
    id: "terminal-reverse-after-overshoot",
    title: "The match fell: turn back",
    measures:
      "The other half of the run A failure: inferring from a meter's before and after that the last turn went past the reference.",
    expected: "Turn the dial the other way (any amount).",
    matches: (o) => {
      const t = o.task.state.tuning;
      return (
        t !== null &&
        t.status !== "aligned_hold" &&
        t.status !== "locked" &&
        t.matchTrend === "falling" &&
        (t.matchBeforePercent ?? 0) >= 60 &&
        lastTune(o) !== null
      );
    },
    passes: (i, o) => {
      const last = lastTune(o);
      return (
        i.intent === "tune_terminal" &&
        last !== null &&
        "direction" in last &&
        i.direction !== last.direction
      );
    },
  },
  {
    id: "terminal-continue-while-rising",
    title: "The match rose: keep going",
    measures: "Following a rising meter in the same direction.",
    expected: "Turn the dial the same way again (any amount).",
    matches: (o) => {
      const t = o.task.state.tuning;
      return (
        t !== null &&
        t.status !== "aligned_hold" &&
        t.status !== "locked" &&
        t.matchTrend === "rising" &&
        t.matchPercent < 85 &&
        lastTune(o) !== null
      );
    },
    passes: (i, o) => {
      const last = lastTune(o);
      return (
        i.intent === "tune_terminal" &&
        last !== null &&
        "direction" in last &&
        i.direction === last.direction
      );
    },
  },
  {
    id: "concert-start-when-prompted",
    title: "At the listening point: begin",
    measures: "Finishing: taking the final action when it is offered.",
    expected: "Begin the transmission.",
    matches: (o) => has(o, "start_concert"),
    passes: (i) => i.intent === "start_concert",
  },
];

export function probeById(id: string): Probe | undefined {
  return AFTER_HOURS_PROBES.find((p) => p.id === id);
}

/** Share of the offered intents that pass: what a uniform random pick scores. */
export function chanceFloor(probe: Probe, o: WorldObservation): number {
  const obs = o as Obs;
  if (obs.legal.length === 0) return 0;
  return obs.legal.filter((i) => probe.passes(i, obs)).length / obs.legal.length;
}

export interface ProbeFixture {
  id: string;
  /** The policy that walked into the situation; the observation is the game's own. */
  capturedBy: string;
  observation: WorldObservation;
}

export interface ProbeFile {
  schema: typeof PROBE_SCHEMA;
  environment: string;
  task: string;
  capturedAt: string;
  capturedWith: string;
  probes: ProbeFixture[];
}
