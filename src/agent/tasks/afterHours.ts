import type { Game } from "../../game/Game";
import type { InputState } from "../../game/core/Input";
import type { Caption } from "../../game/afterhours/AfterHoursHud";
import {
  COFFEE_CART,
  DELIVERY,
  LISTENING_POINT,
  TERMINAL_SITES,
} from "../../game/afterhours/sites";
import { TUNING_AMOUNTS, TUNING_DIRECTIONS, type AgentIntent } from "../contract";
import { round, type TaskObservation } from "../observation";
import type { Summary } from "../trace";
import { AFTER_HOURS_TASK, TERMINAL_IDS, type AfterHoursState } from "./afterHoursSchema";
import type { ActorFrame, TaskAdapter, TaskTarget } from "./task";

/**
 * After Hours, seen the way a player sees it.
 *
 * Reads the After Hours HUD snapshot (the same one React renders), the E
 * prompt and the readouts the HUD draws — coffee meter, timer, receiver dial,
 * signal bars, the terminal panel's status and meters — and nothing behind
 * them. It does not import the station table or the terminal definitions, so
 * neither the hidden frequency nor a terminal's target can reach an
 * observation. It holds no setter: progression stays in `AfterHours`.
 */

const TERMINAL_LABEL: Record<(typeof TERMINAL_IDS)[number], string> = {
  rhythm: "Rhythm",
  bass: "Bass",
  harmony: "Harmony",
  melody: "Melody",
};

const TUNING_STATUS = {
  Locked: "locked",
  "Aligned — hold": "aligned_hold",
  Close: "close",
  Drifting: "drifting",
} as const;

/** Where to stand at the coffee cart (in front of it, like the waypoint). */
const CART_STAND = {
  x: COFFEE_CART.x + Math.sin(COFFEE_CART.yaw) * 1.6,
  z: COFFEE_CART.z + Math.cos(COFFEE_CART.yaw) * 1.6,
};

const MAX_CAPTIONS = 8;

export type TaskEventSink = (
  type: string,
  data?: Record<string, number | string | boolean>,
) => void;

type Trend = "rising" | "falling" | "steady" | null;

export class AfterHoursTaskAdapter implements TaskAdapter<AfterHoursState> {
  readonly id = AFTER_HOURS_TASK;
  /** Receives task events (coffee collected, terminal locked…) for traces. */
  onEvent: TaskEventSink = () => undefined;

  private time = 0;
  private readonly captions: (Caption & { at: number })[] = [];
  private lastCaptionId = -1;
  private lastBars: number | null = null;
  private lastMatch: { terminal: string; value: number } | null = null;
  private readonly counts = {
    coffeeCollections: 0,
    coffeeFailures: 0,
    receiverTuningInputs: 0,
    radioCommands: 0,
    terminalTuningInputs: 0,
  };
  private previous: {
    mission: string;
    heard: boolean;
    found: boolean;
    terminals: number;
    concert: boolean;
    completed: boolean;
    station: string | null;
  } | null = null;
  private readonly unsubscribe: () => void;
  private sampled: unknown = null;

  constructor(private readonly game: Game) {
    // Captions are recorded as they are shown, so a caption that appeared
    // between two decisions is still "heard".
    this.unsubscribe = game.afterHours.hud.subscribe(() => this.noteCaption());
  }

  private get snapshot() {
    return this.game.afterHours.hud.getSnapshot();
  }

  active(): boolean {
    return this.game.afterHours.active;
  }

  stage(): string {
    return this.snapshot.stage;
  }

  complete(): boolean {
    return this.snapshot.concert.completed;
  }

  passive(): boolean {
    const s = this.snapshot;
    return s.active && (s.concert.running || s.tuning?.locked === true);
  }

  careful(): boolean {
    return this.game.afterHours.mission.state === "active";
  }

  private noteCaption(): void {
    const c = this.snapshot.caption;
    if (!c || c.id === this.lastCaptionId) return;
    this.lastCaptionId = c.id;
    this.captions.push({ ...c, at: this.time });
    if (this.captions.length > MAX_CAPTIONS) this.captions.shift();
  }

  observe(frame: ActorFrame): TaskObservation<AfterHoursState> {
    const ah = this.game.afterHours;
    const s = this.snapshot;
    const carrying = s.mission.carrying;

    const bars = Math.round(ah.radio.strength * 5);
    const signalTrend = trend(bars, this.lastBars);

    let tuning: AfterHoursState["tuning"] = null;
    const session = ah.session;
    if (session && s.tuning) {
      const t = session.tuning;
      const match = Math.round(t.alignment * 100);
      const previous = this.lastMatch?.terminal === s.tuning.layer ? this.lastMatch.value : null;
      tuning = {
        terminal: s.tuning.layer,
        label: `${s.tuning.label} terminal`,
        kind: s.tuning.kind,
        instruction: s.tuning.instruction,
        status: TUNING_STATUS[t.status],
        matchPercent: match,
        lockPercent: Math.round(t.lockProgress * 100),
        dialPercent: Math.round(t.dial * 100),
        matchBeforePercent: previous,
        matchTrend: trend(match, previous),
      };
    }

    const state: AfterHoursState = {
      prompt: this.game.interaction.prompt?.label ?? null,
      coffee: {
        state: s.mission.state,
        carrying,
        remainingPercent: carrying ? Math.max(0, Math.round(ah.mission.spill.integrity)) : null,
        timeRemainingS: carrying ? Math.max(0, Math.ceil(ah.mission.remaining)) : null,
        failReason: s.mission.failReason,
        delivered: s.mission.result
          ? { percent: s.mission.result.percent, seconds: Math.round(s.mission.result.seconds) }
          : null,
        retryAvailable: s.mission.state === "failed",
      },
      radio: {
        vehicle: s.radio.ownerLabel ? s.radio.ownerLabel.toLowerCase() : null,
        inReach: s.radio.inReach,
        powered: s.radio.power,
        station: s.radio.stationLabel,
        frequency: round(ah.radio.frequency, 1),
        signalBars: bars,
        holdPercent: s.radio.holding ? Math.round(ah.radio.holdProgress * 100) : null,
        signalTrend,
        signalAcquired: s.radio.f420Discovered,
      },
      captions: this.captions.map((c) => ({
        speaker: c.speaker.slice(0, 40),
        text: c.text.slice(0, 220),
        kind: c.kind,
        ageS: round(this.time - c.at, 1),
      })),
      terminals: s.terminalsRevealed
        ? TERMINAL_SITES.map((t) => ({
            id: t.layer,
            label: `${TERMINAL_LABEL[t.layer]} terminal`,
            completed: s.terminals[t.layer],
            distanceM: round(Math.hypot(t.x - frame.x, t.z - frame.z), 0),
            bearingDeg: relativeBearing(frame, t.x, t.z),
          }))
        : null,
      tuning,
      concert: {
        available: s.concert.unlocked,
        running: s.concert.running,
        complete: s.concert.completed,
        section: s.concert.section,
      },
    };
    return {
      id: AFTER_HOURS_TASK,
      stage: s.stage,
      objective: s.objective,
      complete: s.concert.completed,
      state,
    };
  }

  /** A few HUD facts for the agent panel's OBSERVE line (cheap, no observation). */
  observeHud(): { objective: string | null; facts: string[] } {
    const ah = this.game.afterHours;
    const s = this.snapshot;
    const facts: string[] = [];
    if (s.mission.carrying) {
      const left = Math.max(0, Math.ceil(ah.mission.remaining));
      facts.push(
        `Coffee · ${Math.max(0, Math.round(ah.mission.spill.integrity))}%`,
        `Timer · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`,
      );
    }
    if (s.stage === "channel" || s.radio.holding)
      facts.push(`Radio · ${s.radio.stationLabel} · ${ah.radio.frequency.toFixed(1)}`);
    const t = ah.session?.tuning;
    if (t && s.tuning)
      facts.push(`${s.tuning.label} · ${t.status} · ${Math.round(t.alignment * 100)}%`);
    if (s.stage === "terminals")
      facts.push(`Terminals · ${TERMINAL_IDS.filter((id) => s.terminals[id]).length}/4`);
    return { objective: s.objective, facts };
  }

  /**
   * Remember the meters as an action begins, so the next observation can
   * say whether they rose or fell since — what a player watching them sees.
   * Observing itself changes nothing.
   */
  markBaseline(): void {
    const ah = this.game.afterHours;
    this.lastBars = Math.round(ah.radio.strength * 5);
    const s = this.snapshot;
    this.lastMatch =
      ah.session && s.tuning
        ? { terminal: s.tuning.layer, value: Math.round(ah.session.tuning.alignment * 100) }
        : null;
  }

  targets(): TaskTarget[] {
    const s = this.snapshot;
    if (!s.active) return [];
    // The briefing names the cart and the technician's hut from the start;
    // terminals appear with the signal guidance, the listening point when
    // the objective sends the player there.
    const list: TaskTarget[] = [
      {
        id: "coffee_cart",
        label: COFFEE_CART.label,
        kind: "place",
        reach: "any",
        x: CART_STAND.x,
        z: CART_STAND.z,
        footRadius: 1.2,
      },
      {
        id: "technician",
        label: `Technician · ${DELIVERY.label}`,
        kind: "person",
        reach: "any",
        x: DELIVERY.x,
        z: DELIVERY.z,
        footRadius: 1.8,
      },
    ];
    if (s.terminalsRevealed)
      for (const t of TERMINAL_SITES)
        if (!s.terminals[t.layer])
          list.push({
            id: t.layer,
            label: `${TERMINAL_LABEL[t.layer]} terminal · near ${t.antenna}`,
            kind: "device",
            reach: "any",
            x: t.x,
            z: t.z,
            footRadius: 1.4,
          });
    if (s.concert.unlocked)
      list.push({
        id: "listening_point",
        label: LISTENING_POINT.label,
        kind: "place",
        reach: "any",
        x: LISTENING_POINT.x,
        z: LISTENING_POINT.z,
        footRadius: 1.2,
      });
    return list;
  }

  legalIntents(frame: ActorFrame): AgentIntent[] {
    const ah = this.game.afterHours;
    const s = this.snapshot;
    if (!s.active) return [];
    const out: AgentIntent[] = [];

    // An open terminal panel owns the controls, as it does for a player.
    if (ah.session) {
      // A locked panel closes by itself: there is nothing to do but watch.
      if (s.tuning?.locked) return out;
      for (const direction of TUNING_DIRECTIONS)
        for (const amount of TUNING_AMOUNTS)
          out.push({ intent: "tune_terminal", direction, amount });
      out.push({ intent: "leave_terminal" });
      return out;
    }
    // The transmission plays out; there is nothing to do but listen.
    if (s.concert.running) return out;

    const free = frame.onFoot && !this.game.movementLocked;
    if (free || frame.driving)
      for (const t of this.targets())
        out.push({ intent: frame.driving ? "drive_to" : "navigate_to", target: t.id });

    if (free && frame.promptTarget) {
      const p = frame.promptTarget;
      if (p === "listening_point") out.push({ intent: "start_concert" });
      else if (p === "coffee_cart" || p === "technician" || isTerminal(p))
        out.push({ intent: "interact", target: p });
    }

    if (s.radio.inReach && (free || frame.driving)) {
      out.push(
        { intent: "radio_power" },
        { intent: "radio_next_station" },
        { intent: "radio_next_track" },
        { intent: "radio_previous_track" },
      );
      for (const direction of TUNING_DIRECTIONS)
        for (const amount of TUNING_AMOUNTS)
          out.push({ intent: "tune_receiver", direction, amount });
    }
    if (s.mission.state === "failed") out.push({ intent: "retry" });
    return out;
  }

  signature(): string {
    const s = this.snapshot;
    return [
      s.mission.state,
      this.game.afterHours.session?.layer ?? "-",
      s.concert.running,
      s.radio.power,
      s.radio.stationId ?? "-",
      s.radio.trackIndex,
      s.radio.f420Discovered,
    ].join("|");
  }

  summary(): Summary {
    const ah = this.game.afterHours;
    const s = this.snapshot;
    return {
      coffee: s.mission.state,
      coffeePercent: s.mission.carrying ? Math.round(ah.mission.spill.integrity) : null,
      station: s.radio.stationLabel,
      frequency: round(ah.radio.frequency, 1),
      terminalsCompleted: TERMINAL_IDS.filter((id) => s.terminals[id]).length,
      concert: s.concert.completed ? "complete" : s.concert.running ? "running" : "pending",
    };
  }

  evaluate(): Summary {
    const ah = this.game.afterHours;
    const p = ah.progress;
    const result = ah.mission.result;
    return {
      stage: this.snapshot.stage,
      coffeeDelivered: p.coffeeCompleted,
      coffeeRemainingPercent: result?.percent ?? p.bestCoffee?.percent ?? null,
      coffeeMissionSeconds: result ? round(result.seconds, 1) : (p.bestCoffee?.seconds ?? null),
      coffeeCollections: this.counts.coffeeCollections,
      coffeeFailures: this.counts.coffeeFailures,
      radioCommands: this.counts.radioCommands,
      receiverTuningInputs: this.counts.receiverTuningInputs,
      frequencyFound: p.channelDiscovered,
      terminalTuningInputs: this.counts.terminalTuningInputs,
      terminalsCompleted: TERMINAL_IDS.filter((id) => p.terminals[id]).length,
      concertReached: ah.concert.state === "running" || p.concertCompleted,
      concertCompleted: p.concertCompleted,
    };
  }

  /**
   * Per-frame bookkeeping from the input gameplay actually read this frame
   * (the person's or the agent's — counted the same way) and from the HUD.
   */
  sampleInput(input: InputState): void {
    const ah = this.game.afterHours;
    if (!ah.active) return;
    if (ah.session) {
      if (input.wasPressed("left") || input.wasPressed("right")) this.counts.terminalTuningInputs++;
    } else if (input.wasPressed("tuneUp") || input.wasPressed("tuneDown")) {
      this.counts.receiverTuningInputs++;
    }
    for (const a of ["radioPower", "radioStation", "radioNext", "radioPrevious"] as const)
      if (input.wasPressed(a)) this.counts.radioCommands++;
  }

  sample(dt: number): void {
    this.time += dt;
    const ah = this.game.afterHours;
    const s = this.snapshot;
    // The HUD snapshot is immutable and replaced on every change (the clue
    // flag marks it dirty too): nothing to compare until it changes.
    if (s === this.sampled) return;
    this.sampled = s;
    const next = {
      mission: s.mission.state as string,
      heard: ah.heardClue,
      found: s.radio.f420Discovered,
      terminals: TERMINAL_IDS.filter((id) => s.terminals[id]).length,
      concert: s.concert.running,
      completed: s.concert.completed,
      station: s.radio.stationId,
    };
    const prev = this.previous;
    this.previous = next;
    if (!prev || !ah.active) return;
    if (next.mission !== prev.mission) {
      if (next.mission === "active") {
        this.counts.coffeeCollections++;
        this.onEvent("coffee_collected");
      } else if (next.mission === "completed" && s.mission.result) {
        this.onEvent("coffee_delivered", {
          percent: s.mission.result.percent,
          seconds: round(s.mission.result.seconds, 1),
        });
      } else if (next.mission === "failed") {
        this.counts.coffeeFailures++;
        this.onEvent("coffee_failed", { reason: s.mission.failReason ?? "unknown" });
      }
    }
    if (next.heard && !prev.heard) this.onEvent("frequency_clue_discovered");
    if (next.found && !prev.found) this.onEvent("receiver_locked");
    if (next.terminals > prev.terminals)
      this.onEvent("terminal_completed", { completed: next.terminals });
    if (next.concert && !prev.concert) this.onEvent("concert_started");
    if (next.completed && !prev.completed) this.onEvent("concert_completed");
    if (next.station !== prev.station)
      this.onEvent("radio_event", { station: s.radio.stationLabel });
  }

  dispose(): void {
    this.unsubscribe();
  }
}

function trend(value: number, previous: number | null): Trend {
  if (previous === null) return null;
  return value > previous ? "rising" : value < previous ? "falling" : "steady";
}

function isTerminal(id: string): boolean {
  return (TERMINAL_IDS as readonly string[]).includes(id);
}

/** Bearing of (x, z) relative to the actor's facing: +right, −left, degrees. */
export function relativeBearing(
  frame: { x: number; z: number; heading: number },
  x: number,
  z: number,
): number {
  const angle = Math.atan2(x - frame.x, z - frame.z);
  const relative = Math.atan2(Math.sin(angle - frame.heading), Math.cos(angle - frame.heading));
  // Game yaw grows to the left; players read right as positive.
  return round((-relative * 180) / Math.PI, 0);
}
