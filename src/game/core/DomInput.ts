import { CAMERA } from "../config";
import { GAME_KEY_CODES, type InputState } from "./Input";

/**
 * Pointer-lock deltas larger than this in one event are browser artefacts
 * (Chromium can report the cursor's jump to the lock point as movement).
 */
const MAX_LOOK_DELTA = 280;
/** Mouse events discarded right after the lock engages, for the same reason. */
const EVENTS_IGNORED_AFTER_LOCK = 2;

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/**
 * Wires browser events into an InputState. Mouse look uses pointer-lock
 * deltas when the lock is held and falls back to click-drag otherwise (for
 * embeds where pointer lock is unavailable). Touch drags on the canvas look
 * around; the on-screen joystick lives in separate DOM and never reaches here.
 */
export class DomInputBinding {
  private enabled = false;
  private dragPointer: number | null = null;
  private ignoreMoves = 0;
  private wasLocked = false;
  // Drag deltas are derived from client coordinates because touch pointers
  // do not report movementX/Y consistently across browsers.
  private lastX = 0;
  private lastY = 0;
  private readonly touchScale = CAMERA.touchLookSensitivity / CAMERA.lookSensitivity;

  constructor(
    private readonly input: InputState,
    private readonly element: HTMLElement,
  ) {}

  attach(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibility);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", this.onLockChange);
    this.element.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    this.element.addEventListener("wheel", this.onWheel, { passive: true });
  }

  detach(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVisibility);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.element.removeEventListener("wheel", this.onWheel);
    this.input.releaseAll();
  }

  /** Only an enabled binding feeds gameplay; key-ups are always honoured. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.dragPointer = null;
    this.input.releaseAll();
  }

  private get locked(): boolean {
    return document.pointerLockElement === this.element;
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled || e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return;
    if (GAME_KEY_CODES.has(e.code)) e.preventDefault();
    this.input.keyDown(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.input.keyUp(e.code);
  };

  private readonly onBlur = () => this.input.releaseAll();

  private readonly onVisibility = () => {
    if (document.hidden) this.input.releaseAll();
  };

  private readonly onLockChange = () => {
    const locked = this.locked;
    if (locked && !this.wasLocked) this.ignoreMoves = EVENTS_IGNORED_AFTER_LOCK;
    this.wasLocked = locked;
  };

  private readonly onMouseMove = (e: MouseEvent) => {
    if (!this.enabled || !this.locked) return;
    if (this.ignoreMoves > 0) {
      this.ignoreMoves--;
      return;
    }
    if (Math.abs(e.movementX) > MAX_LOOK_DELTA || Math.abs(e.movementY) > MAX_LOOK_DELTA) return;
    this.input.addLook(e.movementX, e.movementY);
  };

  private readonly onPointerDown = (e: PointerEvent) => {
    if (!this.enabled || this.locked) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    this.dragPointer = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.enabled || this.locked || e.pointerId !== this.dragPointer) return;
    const scale = e.pointerType === "touch" ? this.touchScale : 1;
    this.input.addLook((e.clientX - this.lastX) * scale, (e.clientY - this.lastY) * scale);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (e.pointerId === this.dragPointer) this.dragPointer = null;
  };

  private readonly onWheel = (e: WheelEvent) => {
    if (this.enabled) this.input.addZoom(e.deltaY);
  };
}
