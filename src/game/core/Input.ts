/**
 * Device-independent input state. DOM listeners (see DomInput) and touch
 * controls write into it; gameplay reads actions, never raw key codes.
 * Edge-triggered actions ("pressed this frame") are cleared by `endFrame`.
 */

export type Action =
  | "forward"
  | "back"
  | "left"
  | "right"
  | "sprint"
  | "walkToggle"
  | "jump"
  | "handbrake"
  | "interact"
  | "headlights"
  | "mute"
  // After Hours
  | "radioPower"
  | "radioNext"
  | "radioPrevious"
  | "radioStation"
  | "volumeUp"
  | "volumeDown"
  | "tuneUp"
  | "tuneDown"
  | "cinematic"
  | "cancel"
  | "retry"
  | "alteredSignal"
  // Free Roam: hold to aim, press to fire (mouse buttons or keys)
  | "aim"
  | "fire"
  // Agent runtime: hand the character back to the person (H)
  | "takeover"
  // Free Roam: let Jev play (J), or have Jev assist (K)
  | "letJev"
  | "assist";

export const KEY_BINDINGS: Record<Action, readonly string[]> = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  sprint: ["ShiftLeft", "ShiftRight"],
  walkToggle: ["KeyC"],
  jump: ["Space"],
  handbrake: ["Space"],
  // E everywhere; F as well, for the "press F to enter" grammar of Free Roam.
  interact: ["KeyE", "KeyF"],
  headlights: ["KeyL"],
  mute: ["KeyM"],
  radioPower: ["KeyR"],
  radioNext: ["Period"],
  radioPrevious: ["Comma"],
  radioStation: ["KeyT"],
  volumeUp: ["Equal"],
  volumeDown: ["Minus"],
  tuneUp: ["BracketRight"],
  tuneDown: ["BracketLeft"],
  cinematic: ["KeyV"],
  cancel: ["KeyX"],
  retry: ["KeyY"],
  alteredSignal: ["KeyO"],
  // "Mouse0" / "Mouse2" are pointer buttons fed in by DomInputBinding as pseudo key codes.
  aim: ["KeyQ", "Mouse2"],
  fire: ["KeyZ", "Mouse0"],
  takeover: ["KeyH"],
  letJev: ["KeyJ"],
  assist: ["KeyK"],
};

/** Pseudo key code for a pointer button (0 left, 2 right). */
export const mouseCode = (button: number): string => `Mouse${button}`;

/** Every code the game consumes, so the DOM layer can prevent browser defaults. */
export const GAME_KEY_CODES: ReadonlySet<string> = new Set(Object.values(KEY_BINDINGS).flat());

/** Analog touch input written by the on-screen controls. */
export interface VirtualInput {
  moveX: number;
  moveY: number;
  sprint: boolean;
  /** Held button: jump on foot, handbrake while driving. */
  action: boolean;
  interactRequested: boolean;
  /** Held on-screen receiver tuning: −1, 0 or +1. */
  tune: number;
  /** Held on-screen terminal dial: −1, 0 or +1. */
  dial: number;
}

export class InputState {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private walkToggled = false;
  private lookAccumX = 0;
  private lookAccumY = 0;
  private zoomAccum = 0;

  readonly virtual: VirtualInput = {
    moveX: 0,
    moveY: 0,
    sprint: false,
    action: false,
    interactRequested: false,
    tune: 0,
    dial: 0,
  };

  keyDown(code: string): void {
    if (!this.down.has(code)) {
      this.pressed.add(code);
      if (KEY_BINDINGS.walkToggle.includes(code)) this.walkToggled = !this.walkToggled;
    }
    this.down.add(code);
  }

  keyUp(code: string): void {
    this.down.delete(code);
  }

  addLook(dx: number, dy: number): void {
    this.lookAccumX += dx;
    this.lookAccumY += dy;
  }

  addZoom(delta: number): void {
    this.zoomAccum += delta;
  }

  /** Drop every held key (window blur, pause) so nothing stays stuck down. */
  releaseAll(): void {
    this.down.clear();
    this.pressed.clear();
    this.virtual.moveX = 0;
    this.virtual.moveY = 0;
    this.virtual.action = false;
    this.virtual.interactRequested = false;
    this.virtual.tune = 0;
    this.virtual.dial = 0;
    this.lookAccumX = 0;
    this.lookAccumY = 0;
    this.zoomAccum = 0;
  }

  isDown(action: Action): boolean {
    if (action === "sprint" && this.virtual.sprint) return true;
    if ((action === "jump" || action === "handbrake") && this.virtual.action) return true;
    const codes = KEY_BINDINGS[action];
    for (let i = 0; i < codes.length; i++) if (this.down.has(codes[i])) return true;
    return false;
  }

  wasPressed(action: Action): boolean {
    if (action === "interact" && this.virtual.interactRequested) return true;
    const codes = KEY_BINDINGS[action];
    for (let i = 0; i < codes.length; i++) if (this.pressed.has(codes[i])) return true;
    return false;
  }

  get walkMode(): boolean {
    return this.walkToggled;
  }

  /** Movement intent in [-1, 1]²: x right, y forward. Keyboard is normalised. */
  moveAxes(out: { x: number; y: number }): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.isDown("right")) x += 1;
    if (this.isDown("left")) x -= 1;
    if (this.isDown("forward")) y += 1;
    if (this.isDown("back")) y -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    x += this.virtual.moveX;
    y += this.virtual.moveY;
    const total = Math.hypot(x, y);
    if (total > 1) {
      x /= total;
      y /= total;
    }
    out.x = x;
    out.y = y;
    return out;
  }

  get lookX(): number {
    return this.lookAccumX;
  }

  get lookY(): number {
    return this.lookAccumY;
  }

  get zoom(): number {
    return this.zoomAccum;
  }

  /** Clear per-frame edges and accumulated deltas after the frame consumed them. */
  endFrame(): void {
    this.pressed.clear();
    this.virtual.interactRequested = false;
    this.lookAccumX = 0;
    this.lookAccumY = 0;
    this.zoomAccum = 0;
  }
}
