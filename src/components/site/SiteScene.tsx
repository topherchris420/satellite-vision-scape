import { Suspense, useCallback, useEffect, useMemo, useRef, useState, startTransition } from "react";
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
import { TerrainDebug, TerrainDebugHUD } from "./TerrainDebug";
import { useIsMobile } from "@/hooks/use-mobile";
import type { Selection } from "@/lib/selection";
import { sampleTerrainFrame } from "@/lib/terrain";
import { SpatialContextLayer, type ContextStatus } from "./SpatialContextLayer";
import { FIXTURE_MANIFEST } from "@/lib/terrain/fixture";

export type QualityTier = "low" | "medium" | "high" | "ultra";

function ReadyProbe({ onReady }: { onReady: () => void }) {
  const frames = useRef(0);

  useEffect(() => {
    const timer = setTimeout(onReady, 1200);
    return () => clearTimeout(timer);
  }, [onReady]);

  useFrame(() => {
    frames.current += 1;
    if (frames.current === 3) setTimeout(onReady, 0);
  });
  return null;
}

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
    const deg = (Math.atan2(dir.current.x, -dir.current.z) * 180) / Math.PI;
    const el = markerRef.current;
    if (el) {
      el.setAttribute(
        "transform",
        `translate(${camera.position.x.toFixed(1)} ${camera.position.z.toFixed(1)}) rotate(${deg.toFixed(1)})`
      );
    }
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

// Terrain-conforming Selection Ring
function SelectionRing({ sel }: { sel: Selection }) {
  const ref = useRef<THREE.Mesh>(null);
  const frame = sampleTerrainFrame(sel.pos[0], sel.pos[1]);

  const quat = useMemo(() => {
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 0, 1);
    q.setFromUnitVectors(up, frame.normal);
    return q;
  }, [frame.normal]);

  useFrame(({ clock }) => {
    ref.current?.scale.setScalar(1 + Math.sin(clock.elapsedTime * 3) * 0.05);
  });

  return (
    <mesh
      ref={ref}
      position={[sel.pos[0], frame.height + 0.25, sel.pos[1]]}
      quaternion={quat}
    >
      <ringGeometry args={[sel.radius + 1, sel.radius + 1.9, 48]} />
      <meshBasicMaterial
        color="#fbbf24"
        transparent
        opacity={0.8}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export function SiteScene() {
  const isMobile = useIsMobile();
  const [mode, setMode] = useState<ControlMode>("fly");
  const [time, setTime] = useState<TimeOfDay>("day");
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showIndex, setShowIndex] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  // Quality Tier Architecture
  const [qualityTier, setQualityTier] = useState<QualityTier>(isMobile ? "low" : "high");
  const [manualQuality, setManualQuality] = useState(false);

  const markerRef = useRef<SVGGElement>(null);
  const telemetryRef = useRef<HTMLDivElement>(null);
  const [contextStatus, setContextStatus] = useState<ContextStatus>({
    state: "loading",
    entities: 0,
  });
  const onContextStatus = useCallback((status: ContextStatus) => setContextStatus(status), []);

  const [sceneStage, setSceneStage] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const t1 = setTimeout(() => startTransition(() => setSceneStage(1)), 50);
    const t2 = setTimeout(() => startTransition(() => setSceneStage(2)), 300);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [ready]);

  const handleQualityChange = useCallback((q: QualityTier) => {
    setQualityTier(q);
    setManualQuality(true);
  }, []);

  const flyToSelection = useCallback(() => {
    if (!selected) return;
    setMode("fly");
    setFocus({ x: selected.pos[0], z: selected.pos[1], r: selected.radius, ts: Date.now() });
  }, [selected]);

  const inspectFromIndex = useCallback((s: Selection) => {
    setSelected(s);
    setMode("fly");
    setFocus({ x: s.pos[0], z: s.pos[1], r: s.radius, ts: Date.now() });
  }, []);

  const navigateTo = useCallback((x: number, z: number) => {
    setMode("fly");
    setFocus({ x, z, r: 10, ts: Date.now() });
  }, []);

  useEffect(() => {
    if (mode !== "fly") setFocus(null);
  }, [mode]);

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
        case "KeyG":
          setShowDebug((v) => !v);
          break;
        case "Escape":
          setSelected(null);
          setShowHelp(false);
          setShowIndex(false);
          setShowDebug(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile]);

  const fogColor = time === "day" ? "#d4be98" : "#0a1024";

  // Derive DPR and post features from QualityTier
  const dpr: number | [number, number] = qualityTier === "ultra" ? [1, 2] : qualityTier === "high" ? [1, 1.5] : 1;
  const enableAO = qualityTier === "high" || qualityTier === "ultra";
  const enableDoF = qualityTier === "ultra" && mode === "cinematic";

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-900">
      <HUD
        mode={mode}
        onModeChange={setMode}
        time={time}
        onTimeChange={setTime}
        qualityTier={qualityTier}
        onQualityChange={handleQualityChange}
        showDebug={showDebug}
        onToggleDebug={() => setShowDebug((v) => !v)}
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

      {showDebug && <TerrainDebugHUD onClose={() => setShowDebug(false)} />}

      <aside
        className="pointer-events-auto absolute bottom-4 left-4 z-20 w-72 rounded-lg bg-slate-950/80 p-3 font-mono text-[10px] text-white/70 backdrop-blur-sm"
        aria-label="Spatial provenance"
      >
        <div className="mb-2 text-xs font-semibold text-white">Spatial provenance</div>
        <div className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1">
          <span className="text-emerald-300">PHYSICAL</span>
          <span>Local artifact · EGM2008 orthometric · ILLUSTRATIVE</span>
          <span className="text-amber-300">TWIN</span>
          <span>Procedural geometry · RECONSTRUCTED / ILLUSTRATIVE</span>
          <span className="text-rose-300">DYNAMIC</span>
          <span>
            USGS earthquakes · REPORTED · {contextStatus.state.toUpperCase()} (
            {contextStatus.entities})
          </span>
        </div>
        <details className="mt-2 border-t border-white/10 pt-2">
          <summary className="cursor-pointer text-white/80">Terrain manifest & limitations</summary>
          <p className="mt-1">
            {FIXTURE_MANIFEST.tileset} · {FIXTURE_MANIFEST.resolutionM} m ·{" "}
            {FIXTURE_MANIFEST.artifactHash.slice(0, 24)}…
          </p>
          <p className="mt-1 text-white/50">
            Development fixture, not survey-grade. Network context is optional and falls back
            cleanly.
          </p>
        </details>
      </aside>

      {isMobile && ready && mode !== "cinematic" && <MobileControls mode={mode} />}

      <div
        className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-slate-950 transition-opacity duration-700 ${
          ready ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-amber-300" />
        <div className="text-sm text-white/70 font-mono">Acquiring satellite downlink…</div>
      </div>

      <Canvas
        shadows
        dpr={dpr}
        camera={{ fov: 55, near: 0.1, far: 2000, position: HOME_POSITION }}
        gl={{
          antialias: false,
          toneMapping: THREE.ACESFilmicToneMapping,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
        onPointerMissed={() => setSelected(null)}
      >
        {!manualQuality && (
          <PerformanceMonitor
            flipflops={4}
            onDecline={() => {
              if (qualityTier === "ultra") setQualityTier("high");
              else if (qualityTier === "high") setQualityTier("medium");
              else if (qualityTier === "medium") setQualityTier("low");
            }}
            onIncline={() => {
              if (qualityTier === "low") setQualityTier("medium");
              else if (qualityTier === "medium") setQualityTier("high");
            }}
          />
        )}
        <Suspense fallback={null}>
          <Lighting time={time} />
          <Terrain />
          {sceneStage >= 1 && <Roads />}
          {sceneStage >= 1 && <Structures onSelect={setSelected} time={time} />}
          {sceneStage >= 2 && <SiteFeatures />}
          {sceneStage >= 2 && <Atmosphere time={time} />}
          {sceneStage >= 2 && <SpatialContextLayer onStatus={onContextStatus} />}
          {selected && <SelectionRing sel={selected} />}
          {showDebug && <TerrainDebug />}
          <fog attach="fog" args={[fogColor, 450, 1500]} />
          <ReadyProbe onReady={() => setReady(true)} />
        </Suspense>

        {ready && (
          <EffectComposer multisampling={0}>
            {enableAO && (
              <N8AO aoRadius={10} intensity={2.5} distanceFalloff={2} halfRes={qualityTier !== "ultra"} />
            )}
            <Bloom mipmapBlur intensity={0.55} luminanceThreshold={1.0} luminanceSmoothing={0.25} />
            {enableDoF && (
              <DepthOfField focusDistance={0.03} focalLength={0.06} bokehScale={2.5} />
            )}
            <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
            <HueSaturation saturation={0.12} />
            <BrightnessContrast contrast={0.07} />
            <SMAA />
            <Vignette eskil={false} offset={0.22} darkness={0.5} />
          </EffectComposer>
        )}

        <CameraTracker markerRef={markerRef} telemetryRef={telemetryRef} />
        <Controls mode={mode} focus={focus} />
      </Canvas>
    </div>
  );
}
