// Lightweight scene-sequencing engine for the "Digital Twin Thesis" motion
// piece, ported from the claude.ai/design animations-v2 scaffold. Scenes play
// in authored order on a single clock, loop forever, and hard-cut at
// boundaries — exactly one scene is mounted at a time, keyed by index, so a
// scene never leaks state into a neighbor.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { flushSync } from "react-dom";

export interface SceneDef {
  name: string;
  dur: number;
}

export interface SceneProps {
  localTime: number;
  progress: number;
  dur: number;
  index: number;
  count: number;
}

const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace";

function fmt(t: number) {
  const total = Math.max(0, t);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const cs = Math.floor((total * 100) % 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

declare global {
  interface Window {
    // Deterministic seek hook used by the headless recorder (docs/media).
    __thesisSeek?: (t: number) => void;
    __thesisDuration?: number;
  }
}

export function SceneStage({
  width = 1920,
  height = 1080,
  bg = "#060a0d",
  scenes,
  components,
  chrome = true,
}: {
  width?: number;
  height?: number;
  bg?: string;
  scenes: SceneDef[];
  components: Record<string, ComponentType<SceneProps>>;
  chrome?: boolean;
}) {
  const duration = scenes.reduce((sum, s) => sum + s.dur, 0);

  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [scale, setScale] = useState(1);

  const stageRef = useRef<HTMLDivElement>(null);
  const lastTsRef = useRef<number | null>(null);

  // Auto-scale the fixed-size canvas to fit the viewport.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const barH = chrome ? 44 : 0;
    const measure = () => {
      const s = Math.min(el.clientWidth / width, (el.clientHeight - barH) / height);
      setScale(Math.max(0.05, s));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height, chrome]);

  // Clock: advance with rAF while playing, wrap at the end (loop).
  useEffect(() => {
    if (!playing) {
      lastTsRef.current = null;
      return;
    }
    let raf = 0;
    const step = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      setTime((t) => (t + dt) % duration);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      lastTsRef.current = null;
    };
  }, [playing, duration]);

  // Keyboard transport: space play/pause, arrows step, 0/Home rewind.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === "ArrowLeft") {
        setTime((t) => clamp(t - (e.shiftKey ? 1 : 0.1), 0, duration));
      } else if (e.code === "ArrowRight") {
        setTime((t) => clamp(t + (e.shiftKey ? 1 : 0.1), 0, duration));
      } else if (e.key === "0" || e.code === "Home") {
        setTime(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [duration]);

  // Recorder hook: pause and commit a frame synchronously so a screenshot
  // taken right after the call sees exactly the seeked timestamp.
  useEffect(() => {
    window.__thesisSeek = (t: number) => {
      flushSync(() => {
        setPlaying(false);
        setTime(clamp(t, 0, duration));
      });
    };
    window.__thesisDuration = duration;
    return () => {
      delete window.__thesisSeek;
      delete window.__thesisDuration;
    };
  }, [duration]);

  const seekFromPointer = useCallback(
    (clientX: number, track: HTMLDivElement) => {
      const rect = track.getBoundingClientRect();
      const x = clamp((clientX - rect.left) / rect.width, 0, 1);
      setTime(x * duration);
    },
    [duration],
  );

  // Resolve the active scene from the shared clock.
  let index = 0;
  let sceneStart = 0;
  for (let i = 0; i < scenes.length; i++) {
    if (time < sceneStart + scenes[i].dur || i === scenes.length - 1) {
      index = i;
      break;
    }
    sceneStart += scenes[i].dur;
  }
  const scene = scenes[index];
  const localTime = Math.max(0, time - sceneStart);
  const progress = clamp(localTime / scene.dur, 0, 1);
  const Active = components[scene.name];

  return (
    <div
      ref={stageRef}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: "#0a0a0a",
      }}
    >
      <div
        style={{
          flex: 1,
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        <div
          data-thesis-canvas
          style={{
            width,
            height,
            background: bg,
            position: "relative",
            overflow: "hidden",
            transform: `scale(${scale})`,
            transformOrigin: "center",
            flexShrink: 0,
            boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
          }}
        >
          {Active && (
            <Active
              key={index}
              localTime={localTime}
              progress={progress}
              dur={scene.dur}
              index={index}
              count={scenes.length}
            />
          )}
        </div>
      </div>

      {chrome && (
        <PlaybackBar
          time={time}
          duration={duration}
          playing={playing}
          onPlayPause={() => setPlaying((p) => !p)}
          onReset={() => setTime(0)}
          onScrub={seekFromPointer}
        />
      )}
    </div>
  );
}

function PlaybackBar({
  time,
  duration,
  playing,
  onPlayPause,
  onReset,
  onScrub,
}: {
  time: number;
  duration: number;
  playing: boolean;
  onPlayPause: () => void;
  onReset: () => void;
  onScrub: (clientX: number, track: HTMLDivElement) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    const track = trackRef.current;
    if (!track) return;
    onScrub(e.clientX, track);
    const move = (ev: PointerEvent) => onScrub(ev.clientX, track);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pct = duration > 0 ? (time / duration) * 100 : 0;
  const btn: React.CSSProperties = {
    width: 24,
    height: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 5,
    color: "#f6f4ef",
    cursor: "pointer",
    padding: 0,
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 12px",
        background: "rgba(20,20,20,0.92)",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 6,
        width: "100%",
        maxWidth: 680,
        color: "#f6f4ef",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      <button type="button" style={btn} onClick={onPlayPause} title="Play/pause (space)">
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="3" y="2" width="3" height="10" fill="currentColor" />
            <rect x="8" y="2" width="3" height="10" fill="currentColor" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 2l9 5-9 5V2z" fill="currentColor" />
          </svg>
        )}
      </button>
      <button type="button" style={btn} onClick={onReset} title="Return to start (0)">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M3 2v10M12 2L5 7l7 5V2z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <div
        style={{
          fontFamily: MONO,
          fontSize: 12,
          fontVariantNumeric: "tabular-nums",
          width: 64,
          textAlign: "right",
        }}
      >
        {fmt(time)}
      </div>

      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        style={{
          flex: 1,
          height: 22,
          position: "relative",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            height: 4,
            background: "rgba(255,255,255,0.12)",
            borderRadius: 2,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            width: `${pct}%`,
            height: 4,
            background: "oklch(72% 0.12 250)",
            borderRadius: 2,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `${pct}%`,
            top: "50%",
            width: 12,
            height: 12,
            marginLeft: -6,
            marginTop: -6,
            background: "#fff",
            borderRadius: 6,
            boxShadow: "0 2px 4px rgba(0,0,0,0.4)",
          }}
        />
      </div>

      <div
        style={{
          fontFamily: MONO,
          fontSize: 12,
          fontVariantNumeric: "tabular-nums",
          width: 64,
          textAlign: "left",
          color: "rgba(246,244,239,0.55)",
        }}
      >
        {fmt(duration)}
      </div>
    </div>
  );
}
