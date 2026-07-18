import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import {
  EffectComposer,
  Bloom,
  N8AO,
  SMAA,
  Vignette,
  ToneMapping,
  DepthOfField,
  BrightnessContrast,
  HueSaturation,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";

import * as THREE from "three";
import { Terrain } from "./Terrain";
import { Structures } from "./Structures";
import { SiteFeatures } from "./SiteFeatures";
import { Roads } from "./Roads";
import { Atmosphere } from "./Atmosphere";
import { Controls, HOME_POSITION, type ControlMode, type FocusRequest } from "./Controls";
import { Lighting, type TimeOfDay } from "./Lighting";
import { HUD } from "./HUD";
import { MobileControls } from "./MobileControls";
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

// Streams the camera position/heading into the minimap marker and the HUD
// telemetry strip, bypassing React state so the HUD never re-renders for
// camera motion.
function CameraTracker({
  markerRef,
  telemetryRef,
}: {
  markerRef: React.RefObject<SVGGElement | null>;
  telemetryRef: React.RefObject<HTMLDivElement | null>;
}) {
  const dir = useRef(new THREE.Vector3());
  const frame = useRef(0);
  useFrame(({ camera }) => {
    camera.getWorldDirection(dir.current);
    // Minimap is world metres: x right, z down. The marker arrow points "up"
    // (−z), so rotate it clockwise by the camera's heading.
    const deg = (Math.atan2(dir.current.x, -dir.current.z) * 180) / Math.PI;
    const el = markerRef.current;
    if (el) {
      el.setAttribute(
        "transform",
        `translate(${camera.position.x.toFixed(1)} ${camera.position.z.toFixed(1)}) rotate(${deg.toFixed(1)})`
      );
    }
    // The readout only needs a few updates a second; fixed-width formatting
    // keeps the strip from jittering as digits change.
    const tel = telemetryRef.current;
    if (tel && frame.current++ % 6 === 0) {
      const grid = (v: number) =>
        `${v < 0 ? "-" : "+"}${Math.abs(Math.round(v)).toString().padStart(3, "0")}`;
      const hdg = ((Math.round(deg) % 360) + 360) % 360;
      const alt = Math.max(0, Math.round(camera.position.y));
      tel.textContent = `E ${grid(camera.position.x)} · N ${grid(-camera.position.z)} · ALT ${alt
        .toString()
        .padStart(3, "0")} M · HDG ${hdg.toString().padStart(3, "0")}°`;
    }
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
  const [showIndex, setShowIndex] = useState(false);
  const [dpr, setDpr] = useState<number | [number, number]>([1, 2]);
  // "high" runs the full post chain (AO, DoF); a sustained frame-rate drop
  // sheds the expensive passes first, then render resolution.
  const [quality, setQuality] = useState<"high" | "low">("high");
  const declineStage = useRef(0);
  const markerRef = useRef<SVGGElement>(null);
  const telemetryRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // Stage 0 = full post chain at native dpr; 1 sheds the expensive passes;
  // 2 also drops render resolution.
  const applyQuality = useCallback((stage: number) => {
    setQuality(stage >= 1 ? "low" : "high");
    setDpr(stage >= 2 ? 1 : [1, 2]);
  }, []);

  const flyToSelection = useCallback(() => {
    if (!selected) return;
    setMode("fly");
    setFocus({ x: selected.pos[0], z: selected.pos[1], r: selected.radius, ts: Date.now() });
  }, [selected]);

  // Site index click: inspect the structure and glide the camera to it.
  const inspectFromIndex = useCallback((s: Selection) => {
    setSelected(s);
    setMode("fly");
    setFocus({ x: s.pos[0], z: s.pos[1], r: s.radius, ts: Date.now() });
  }, []);

  // Minimap click: glide to an arbitrary map point at a survey standoff.
  const navigateTo = useCallback((x: number, z: number) => {
    setMode("fly");
    setFocus({ x, z, r: 10, ts: Date.now() });
  }, []);

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
        case "KeyI":
          setShowIndex((v) => !v);
          break;
        case "Escape":
          setSelected(null);
          setShowHelp(false);
          setShowIndex(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile]);

  const fogColor = time === "day" ? "#d4be98" : "#0a1024";

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
        onInspect={inspectFromIndex}
        onNavigate={navigateTo}
        showHelp={showHelp}
        onToggleHelp={() => setShowHelp((v) => !v)}
        showIndex={showIndex}
        onToggleIndex={() => setShowIndex((v) => !v)}
        markerRef={markerRef}
        telemetryRef={telemetryRef}
        isMobile={isMobile}
      />

      {/* Touch movement controls — free-fly/first-person only, not the
          automated cinematic pass */}
      {isMobile && ready && mode !== "cinematic" && <MobileControls mode={mode} />}

      {/* Loading overlay — fades out once the first frames are on screen */}
      <div
        className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-slate-950 transition-opacity duration-700 ${
          ready ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-amber-300" />
        <div className="text-sm text-white/70">Acquiring satellite downlink…</div>
      </div>

      <Canvas
        shadows
        dpr={dpr}
        camera={{ fov: 55, near: 0.1, far: 2000, position: HOME_POSITION }}
        gl={{
          antialias: false, // AA is handled by SMAA in the post chain
          toneMapping: THREE.ACESFilmicToneMapping,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
        onPointerMissed={() => setSelected(null)}
      >
        {/* Shed the expensive post passes first, then render resolution — and
            walk back up when the frame rate holds. After too many flip-flops,
            lock to the low tier rather than oscillate. */}
        <PerformanceMonitor
          flipflops={4}
          onDecline={() => {
            declineStage.current = Math.min(2, declineStage.current + 1);
            applyQuality(declineStage.current);
          }}
          onIncline={() => {
            declineStage.current = Math.max(0, declineStage.current - 1);
            applyQuality(declineStage.current);
          }}
          onFallback={() => {
            declineStage.current = 2;
            applyQuality(2);
          }}
        />
        <Suspense fallback={null}>
          <Lighting time={time} />
          <Terrain />
          <Roads />
          <Structures onSelect={setSelected} time={time} />
          <SiteFeatures />
          <Atmosphere time={time} />
          {selected && <SelectionRing sel={selected} />}
          <fog attach="fog" args={[fogColor, 450, 1500]} />
          <ReadyProbe onReady={() => setReady(true)} />
        </Suspense>

        <EffectComposer multisampling={0}>
          {/* Ground-truth contact shadows in corners and under structures */}
          {quality === "high" && <N8AO aoRadius={10} intensity={2.5} distanceFalloff={2} halfRes />}
          {/* HDR highlights: lit windows, beacons, sun glints */}
          <Bloom mipmapBlur intensity={0.55} luminanceThreshold={1.0} luminanceSmoothing={0.25} />
          {/* Shallow focus only for the automated cinematic pass */}
          {mode === "cinematic" && quality === "high" && (
            <DepthOfField focusDistance={0.03} focalLength={0.06} bokehScale={2.5} />
          )}
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          {/* Commercial-imagery grade: a touch more saturation + contrast */}
          <HueSaturation saturation={0.12} />
          <BrightnessContrast contrast={0.07} />
          <SMAA />
          <Vignette eskil={false} offset={0.22} darkness={0.5} />
        </EffectComposer>

        <CameraTracker markerRef={markerRef} telemetryRef={telemetryRef} />
        <Controls mode={mode} focus={focus} />
      </Canvas>
    </div>
  );
}
