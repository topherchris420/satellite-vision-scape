import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";

import * as THREE from "three";
import { Terrain } from "./Terrain";
import { Structures } from "./Structures";
import { SiteFeatures } from "./SiteFeatures";
import { Roads } from "./Roads";
import { Controls, type ControlMode, type FocusRequest } from "./Controls";
import { Lighting, type TimeOfDay } from "./Lighting";
import { HUD } from "./HUD";
import { useIsMobile } from "@/hooks/use-mobile";
import type { Selection } from "@/lib/selection";

// Fires once after the first few frames have actually been drawn, so the
// loading overlay stays up through shader compilation instead of revealing a
// half-built scene.
function ReadyProbe({ onReady }: { onReady: () => void }) {
  const frames = useRef(0);
  useFrame(() => {
    frames.current += 1;
    if (frames.current === 3) setTimeout(onReady, 0);
  });
  return null;
}

// Streams the camera position/heading into the minimap marker every frame,
// bypassing React state so the HUD never re-renders for camera motion.
function CameraTracker({ markerRef }: { markerRef: React.RefObject<SVGGElement | null> }) {
  const dir = useRef(new THREE.Vector3());
  useFrame(({ camera }) => {
    const el = markerRef.current;
    if (!el) return;
    camera.getWorldDirection(dir.current);
    // Minimap is world metres: x right, z down. The marker arrow points "up"
    // (−z), so rotate it clockwise by the camera's heading.
    const deg = (Math.atan2(dir.current.x, -dir.current.z) * 180) / Math.PI;
    el.setAttribute(
      "transform",
      `translate(${camera.position.x.toFixed(1)} ${camera.position.z.toFixed(1)}) rotate(${deg.toFixed(1)})`
    );
  });
  return null;
}

// Pulsing ground ring highlighting the currently inspected structure.
function SelectionRing({ sel }: { sel: Selection }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    ref.current?.scale.setScalar(1 + Math.sin(clock.elapsedTime * 3) * 0.05);
  });
  return (
    <mesh ref={ref} position={[sel.pos[0], 0.25, sel.pos[1]]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[sel.radius + 1, sel.radius + 1.9, 48]} />
      <meshBasicMaterial color="#fbbf24" transparent opacity={0.8} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

export function SiteScene() {
  const [mode, setMode] = useState<ControlMode>("fly");
  const [time, setTime] = useState<TimeOfDay>("day");
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [dpr, setDpr] = useState<number | [number, number]>([1, 1.75]);
  const markerRef = useRef<SVGGElement>(null);
  const isMobile = useIsMobile();

  const flyToSelection = useCallback(() => {
    if (!selected) return;
    setMode("fly");
    setFocus({ x: selected.pos[0], z: selected.pos[1], r: selected.radius, ts: Date.now() });
  }, [selected]);

  // A stale focus request would replay its glide when FlyMover remounts.
  useEffect(() => {
    if (mode !== "fly") setFocus(null);
  }, [mode]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.code) {
        case "Digit1":
          setMode("fly");
          break;
        case "Digit2":
          if (!isMobile) setMode("fps");
          break;
        case "Digit3":
          setMode("cinematic");
          break;
        case "KeyN":
          setTime((t) => (t === "day" ? "night" : "day"));
          break;
        case "KeyH":
          setShowHelp((v) => !v);
          break;
        case "Escape":
          setSelected(null);
          setShowHelp(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile]);

  const fogColor = time === "day" ? "#d9c9a8" : "#0a1024";

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-900">
      <HUD
        mode={mode}
        onModeChange={setMode}
        time={time}
        onTimeChange={setTime}
        selected={selected}
        onClearSelected={() => setSelected(null)}
        onFlyTo={flyToSelection}
        showHelp={showHelp}
        onToggleHelp={() => setShowHelp((v) => !v)}
        markerRef={markerRef}
        isMobile={isMobile}
      />

      {/* Loading overlay — fades out once the first frames are on screen */}
      <div
        className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-slate-950 transition-opacity duration-700 ${
          ready ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-amber-300" />
        <div className="text-sm text-white/70">Building site model…</div>
      </div>

      <Canvas
        shadows
        dpr={dpr}
        camera={{ fov: 55, near: 0.1, far: 2000, position: [0, 120, 180] }}
        gl={{
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
        onPointerMissed={() => setSelected(null)}
      >
        {/* Drop render resolution instead of frame rate on weaker machines */}
        <PerformanceMonitor onDecline={() => setDpr(1)} />
        <Suspense fallback={null}>
          <Lighting time={time} />
          <Terrain />
          <Roads />
          <Structures onSelect={setSelected} />
          <SiteFeatures />
          {selected && <SelectionRing sel={selected} />}
          <fog attach="fog" args={[fogColor, 350, 1100]} />
          <ReadyProbe onReady={() => setReady(true)} />
        </Suspense>

        <CameraTracker markerRef={markerRef} />
        <Controls mode={mode} focus={focus} />
      </Canvas>
    </div>
  );
}
