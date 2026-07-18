import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronUp, ChevronDown, Zap } from "lucide-react";
import { mobileInput, resetMobileInput } from "@/lib/mobile-input";
import type { ControlMode } from "./Controls";

// Maximum travel of the thumb from the joystick centre, in px. The base is
// 2×RADIUS + thumb, so the thumb rides the inner edge at full deflection.
const RADIUS = 46;

// A drag joystick that writes a normalized [-1, 1] vector into the shared
// mobileInput store. Pointer capture keeps tracking even if the finger slides
// off the pad, and touch-action:none stops the browser from scrolling the
// page out from under the drag.
function Joystick() {
  const baseRef = useRef<HTMLDivElement>(null);
  const activePointer = useRef<number | null>(null);
  const [thumb, setThumb] = useState({ x: 0, y: 0 });

  const update = useCallback((clientX: number, clientY: number) => {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > RADIUS) {
      dx = (dx / dist) * RADIUS;
      dy = (dy / dist) * RADIUS;
    }
    setThumb({ x: dx, y: dy });
    mobileInput.x = dx / RADIUS;
    // Screen y grows downward; forward is "up" on the stick, so negate.
    mobileInput.y = -dy / RADIUS;
  }, []);

  const release = useCallback(() => {
    activePointer.current = null;
    setThumb({ x: 0, y: 0 });
    mobileInput.x = 0;
    mobileInput.y = 0;
  }, []);

  // Belt-and-braces: if the pad unmounts mid-drag (e.g. mode switch), don't
  // leave the camera drifting forever.
  useEffect(() => release, [release]);

  return (
    <div
      ref={baseRef}
      onPointerDown={(e) => {
        activePointer.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        update(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (activePointer.current !== e.pointerId) return;
        update(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (activePointer.current === e.pointerId) release();
      }}
      onPointerCancel={(e) => {
        if (activePointer.current === e.pointerId) release();
      }}
      className="pointer-events-auto relative h-28 w-28 touch-none select-none rounded-full border border-white/20 bg-black/35 backdrop-blur-sm"
      aria-label="Movement joystick"
      role="slider"
    >
      {/* faint cross-hair to hint the four axes */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-white/20">
        <div className="absolute h-full w-px bg-current" />
        <div className="absolute h-px w-full bg-current" />
      </div>
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-12 w-12 rounded-full border border-white/40 bg-white/70 shadow-lg"
        style={{ transform: `translate(calc(-50% + ${thumb.x}px), calc(-50% + ${thumb.y}px))` }}
      />
    </div>
  );
}

// Hold-to-move vertical control. Press writes ±1 into mobileInput.up; release
// zeroes it. Free-fly only — first-person has no vertical axis.
function VerticalRocker() {
  const set = (v: number) => () => {
    mobileInput.up = v;
  };
  const clear = () => {
    mobileInput.up = 0;
  };
  useEffect(() => () => clear(), []);

  const btn =
    "pointer-events-auto flex h-12 w-12 touch-none select-none items-center justify-center rounded-xl border border-white/20 bg-black/35 text-white/90 backdrop-blur-sm active:bg-white/25";

  return (
    <div className="flex flex-col gap-2">
      <button
        className={btn}
        aria-label="Ascend"
        onPointerDown={set(1)}
        onPointerUp={clear}
        onPointerLeave={clear}
        onPointerCancel={clear}
      >
        <ChevronUp className="h-6 w-6" />
      </button>
      <button
        className={btn}
        aria-label="Descend"
        onPointerDown={set(-1)}
        onPointerUp={clear}
        onPointerLeave={clear}
        onPointerCancel={clear}
      >
        <ChevronDown className="h-6 w-6" />
      </button>
    </div>
  );
}

// On-screen movement controls for touch devices. The parent gates this on
// isMobile and hides it during the automated cinematic pass.
export function MobileControls({ mode }: { mode: ControlMode }) {
  const [boost, setBoost] = useState(false);

  const toggleBoost = () => {
    setBoost((b) => {
      const next = !b;
      mobileInput.boost = next;
      return next;
    });
  };

  useEffect(() => () => resetMobileInput(), []);

  // Whole cluster sits in the bottom-left corner so the selection card and
  // other HUD chrome on the right stay clear.
  return (
    <div className="pointer-events-none absolute bottom-0 left-0 z-20 flex items-end gap-3 p-4 pb-6">
      <Joystick />
      <div className="flex flex-col items-center gap-3">
        <button
          onClick={toggleBoost}
          aria-pressed={boost}
          aria-label="Boost"
          className={`pointer-events-auto flex h-12 w-12 touch-none select-none items-center justify-center rounded-xl border backdrop-blur-sm transition ${
            boost
              ? "border-amber-300 bg-amber-300 text-black"
              : "border-white/20 bg-black/35 text-white/90 active:bg-white/25"
          }`}
        >
          <Zap className="h-6 w-6" />
        </button>
        {mode === "fly" && <VerticalRocker />}
      </div>
    </div>
  );
}
