import type { TimeOfDay } from "../Game";
import type { RadioPlaybackStatus } from "../audio/RadioAudio";
import type { FailReason, MissionResult, MissionState } from "./coffee";
import type {
  CharacterKind,
  LayerId,
  LoadOutcome,
  Preferences,
  Stage,
  StationId,
} from "./progress";
import type { TuningKind } from "./puzzle";

export type CaptionKind = "story" | "radio" | "numbers" | "announcement" | "final" | "system";

export interface Caption {
  id: number;
  speaker: string;
  text: string;
  kind: CaptionKind;
}

export interface AfterHoursSnapshot {
  active: boolean;
  stage: Stage;
  objective: string | null;
  /** Short key hint shown under the objective. */
  hint: string | null;
  caption: Caption | null;
  recordZero: { open: boolean; observer: "human" | "agent" };
  /** Album credit toast (opening, after the concert, on request). */
  credit: { id: number; reason: "opening" | "return" } | null;
  radio: {
    power: boolean;
    stationId: StationId | null;
    stationLabel: string;
    trackIndex: number;
    volume: number;
    status: RadioPlaybackStatus | "silent";
    ownerLabel: string | null;
    inReach: boolean;
    f420Discovered: boolean;
    holding: boolean;
  };
  mission: {
    state: MissionState;
    carrying: boolean;
    failReason: FailReason | null;
    result: MissionResult | null;
  };
  tuning: {
    layer: LayerId;
    label: string;
    kind: TuningKind;
    instruction: string;
    locked: boolean;
  } | null;
  altered: { unlocked: boolean; on: boolean };
  concert: {
    running: boolean;
    cinematic: boolean;
    section: string | null;
    unlocked: boolean;
    completed: boolean;
  };
  terminals: Record<LayerId, boolean>;
  terminalsRevealed: boolean;
  preferences: Preferences;
  character: CharacterKind;
  timeOverride: TimeOfDay | null;
  storage: { persistent: boolean; outcome: LoadOutcome };
  audioAvailable: boolean;
  waypointLabel: string | null;
}

/**
 * Bridge between After Hours and the DOM. Discrete state goes through
 * subscribe / getSnapshot (React re-renders only when something actually
 * changed); continuous readouts — timers, meters, dials, distances — are
 * written straight to bound elements, only when their text changes.
 */
export class AfterHoursHud {
  private snapshot: AfterHoursSnapshot;
  private serialised = "";
  private readonly listeners = new Set<() => void>();
  private readonly elements = new Map<string, HTMLElement | SVGElement>();
  private readonly cache = new Map<string, string>();
  /** Terminal waveform canvas. */
  canvas: HTMLCanvasElement | null = null;

  constructor(initial: AfterHoursSnapshot) {
    this.snapshot = initial;
    this.serialised = JSON.stringify(initial);
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  publish(next: AfterHoursSnapshot): boolean {
    const text = JSON.stringify(next);
    if (text === this.serialised) return false;
    this.serialised = text;
    this.snapshot = next;
    for (const l of this.listeners) l();
    return true;
  }

  bind(key: string, element: HTMLElement | SVGElement | null): void {
    if (element) this.elements.set(key, element);
    else this.elements.delete(key);
    this.cache.delete(key);
  }

  text(key: string, value: string): void {
    const el = this.elements.get(key);
    if (!el || this.cache.get(key) === value) return;
    this.cache.set(key, value);
    el.textContent = value;
  }

  /** Set a style property (or an attribute, for `attr:` keys) when it changes. */
  style(key: string, property: string, value: string): void {
    const el = this.elements.get(key);
    const cacheKey = `${key}|${property}`;
    if (!el || this.cache.get(cacheKey) === value) return;
    this.cache.set(cacheKey, value);
    if (property.startsWith("attr:")) el.setAttribute(property.slice(5), value);
    else (el as HTMLElement).style.setProperty(property, value);
  }

  get bound(): boolean {
    return this.elements.size > 0;
  }
}
