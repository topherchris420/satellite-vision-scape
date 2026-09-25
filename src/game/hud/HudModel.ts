import { HUD } from "../config";
import { GameplayState } from "../core/GameState";
import type { Prompt } from "../interaction/InteractionManager";

/** Discrete HUD state; React re-renders only when one of these changes. */
export interface HudSnapshot {
  state: GameplayState;
  prompt: Prompt | null;
  vehicleLabel: string | null;
  message: string | null;
  headlights: boolean;
  muted: boolean;
}

/** DOM nodes for fast-changing readouts, written directly at a capped rate. */
export interface HudReadoutElements {
  speed: HTMLElement | null;
  gear: HTMLElement | null;
  speedBar: HTMLElement | null;
}

export interface HudReadoutValues {
  speedKmh: number;
  gear: string;
  /** 0..1 fraction of top speed, for the bar. */
  speedFraction: number;
}

/**
 * Bridge between the simulation and the DOM HUD. Discrete state is exposed
 * through a subscribe / getSnapshot pair (for React's useSyncExternalStore);
 * continuous readouts bypass React entirely and are written at `readoutHz`
 * only when their text actually changes, so the HUD never forces a
 * per-frame React render or layout.
 */
export class HudModel {
  private snapshot: HudSnapshot = {
    state: GameplayState.OnFoot,
    prompt: null,
    vehicleLabel: null,
    message: null,
    headlights: false,
    muted: false,
  };
  private readonly listeners = new Set<() => void>();
  private elements: HudReadoutElements = { speed: null, gear: null, speedBar: null };
  private readoutTimer = 0;
  private lastSpeed = "";
  private lastGear = "";
  private lastBar = "";
  private messageTimer = 0;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  update(partial: Partial<HudSnapshot>): void {
    const next = { ...this.snapshot, ...partial };
    const prev = this.snapshot;
    const changed =
      next.state !== prev.state ||
      next.vehicleLabel !== prev.vehicleLabel ||
      next.message !== prev.message ||
      next.headlights !== prev.headlights ||
      next.muted !== prev.muted ||
      next.prompt?.label !== prev.prompt?.label ||
      next.prompt?.key !== prev.prompt?.key;
    if (!changed) return;
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  showMessage(text: string, duration: number): void {
    this.messageTimer = duration;
    this.update({ message: text });
  }

  tick(dt: number): void {
    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.update({ message: null });
    }
  }

  bindReadouts(elements: HudReadoutElements): void {
    this.elements = elements;
    this.lastSpeed = this.lastGear = this.lastBar = "";
  }

  writeReadouts(dt: number, values: HudReadoutValues): void {
    this.readoutTimer -= dt;
    if (this.readoutTimer > 0) return;
    this.readoutTimer = 1 / HUD.readoutHz;
    const speed = Math.round(values.speedKmh).toString().padStart(3, "0");
    if (speed !== this.lastSpeed && this.elements.speed) {
      this.elements.speed.textContent = speed;
      this.lastSpeed = speed;
    }
    if (values.gear !== this.lastGear && this.elements.gear) {
      this.elements.gear.textContent = values.gear;
      this.lastGear = values.gear;
    }
    const bar = `scaleX(${Math.min(1, Math.max(0, values.speedFraction)).toFixed(2)})`;
    if (bar !== this.lastBar && this.elements.speedBar) {
      this.elements.speedBar.style.transform = bar;
      this.lastBar = bar;
    }
  }
}
