// Shared virtual movement input for touch devices.
//
// The on-screen joystick and buttons write into this module-level store; the
// camera movers in Controls.tsx and the game runtime read it every frame and
// blend it with keyboard input. Keeping it outside React (a plain mutable
// object rather than state) means dragging the stick never triggers a
// re-render — the values are sampled inside the r3f render loop, exactly like
// the keyboard refs.
//
// All axes are normalized to [-1, 1] so partial stick deflection maps to
// partial speed:
//   x  — strafe, right positive
//   y  — forward, "up" on the stick positive
//   up — vertical, up positive (free-fly only)
// Play-mode buttons:
//   action   — held: jump on foot, handbrake while driving
//   interact — one-shot: enter / exit vehicle, operate a barrier
// Free Roam buttons:
//   aim      — one-shot: raise or lower the sights (the latch is the game's input state, which
//              drops it when the avatar cannot aim or someone else takes the controls)
//   fire     — held: the trigger, at the weapon's own rate; a press always lasts one frame at least,
//              so a tap between two slow frames still fires
export const mobileInput = {
  x: 0,
  y: 0,
  up: 0,
  boost: false,
  action: false,
  interact: false,
  aim: false,
  fire: false,
  firePulse: false,
};

// True while any control is actively deflected — lets the movers cancel an
// in-progress fly-to glide the moment the user grabs the stick.
export function mobileInputActive() {
  return (
    Math.abs(mobileInput.x) > 0.01 ||
    Math.abs(mobileInput.y) > 0.01 ||
    Math.abs(mobileInput.up) > 0.01
  );
}

/** Read and clear the one-shot interact request. */
export function consumeMobileInteract(): boolean {
  const pressed = mobileInput.interact;
  mobileInput.interact = false;
  return pressed;
}

/** Whether the trigger is down this frame: held, or pressed and let go since the last one. */
export function consumeMobileFire(): boolean {
  const down = mobileInput.fire || mobileInput.firePulse;
  mobileInput.firePulse = false;
  return down;
}

/** Read and clear the one-shot request to raise or lower the sights. */
export function consumeMobileAim(): boolean {
  const pressed = mobileInput.aim;
  mobileInput.aim = false;
  return pressed;
}

export function resetMobileInput() {
  mobileInput.x = 0;
  mobileInput.y = 0;
  mobileInput.up = 0;
  mobileInput.boost = false;
  mobileInput.action = false;
  mobileInput.interact = false;
  mobileInput.aim = false;
  mobileInput.fire = false;
  mobileInput.firePulse = false;
}
