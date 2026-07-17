// Scene components for the "Digital Twins of Infrastructure" animated piece,
// ported from the claude.ai/design project (digital-twin-scenes.jsx). All
// motion is driven from the scene clock (localTime/progress) so playback,
// scrubbing, and frame capture render identically.
import { createContext, useContext } from "react";
import type { SceneProps } from "./engine";

const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace";
const BG = "#060a0d";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
const formatNum = (n: number) => Math.round(n).toLocaleString("en-US");
const pad2 = (n: number) => String(n).padStart(2, "0");
const fmtClock = (t: number) => {
  const s = Math.floor(Math.max(0, t));
  const cs = Math.floor((t - s) * 10);
  return `T+${pad2(Math.floor(s / 60))}:${pad2(s % 60)}.${cs}`;
};
const reveal = (text: string, t0: number, t1: number, localTime: number) => {
  if (localTime <= t0) return "";
  if (localTime >= t1) return text;
  return text.slice(0, Math.round(text.length * ((localTime - t0) / (t1 - t0))));
};
// deterministic pseudo-random in [0,1)
const prand = (i: number) => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export interface TweakState {
  accentColor: string;
  showDisclaimer: boolean;
  showTelemetry: boolean;
}

export const TWEAK_DEFAULTS: TweakState = {
  accentColor: "#48ff9e",
  showDisclaimer: true,
  showTelemetry: true,
};

export const ACCENT_OPTIONS = ["#4fe3ff", "#ffb020", "#48ff9e", "#e8f4f5"];

export const TweakCtx = createContext<TweakState>({
  accentColor: "#4fe3ff",
  showDisclaimer: true,
  showTelemetry: true,
});
const useTweakCtx = () => useContext(TweakCtx);

// ── shared HUD chrome ────────────────────────────────────────────────────
function Corner({ pos, accent }: { pos: "tl" | "tr" | "bl" | "br"; accent: string }) {
  const s = 26,
    o = 34;
  const map = {
    tl: { left: o, top: o, borderTop: `2px solid ${accent}`, borderLeft: `2px solid ${accent}` },
    tr: { right: o, top: o, borderTop: `2px solid ${accent}`, borderRight: `2px solid ${accent}` },
    bl: { left: o, bottom: o, borderBottom: `2px solid ${accent}`, borderLeft: `2px solid ${accent}` },
    br: { right: o, bottom: o, borderBottom: `2px solid ${accent}`, borderRight: `2px solid ${accent}` },
  } as const;
  return <div style={{ position: "absolute", width: s, height: s, opacity: 0.9, ...map[pos] }} />;
}

function HUDChrome({
  accent,
  label,
  sceneIndex,
  sceneCount,
  localTime,
  showDisclaimer,
  showTelemetry,
}: {
  accent: string;
  label: string;
  sceneIndex: number;
  sceneCount: number;
  localTime: number;
  showDisclaimer: boolean;
  showTelemetry: boolean;
}) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `linear-gradient(rgba(120,200,220,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(120,200,220,0.06) 1px, transparent 1px)`,
          backgroundSize: "46px 46px",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          height: 2,
          top: `${(localTime * 7) % 100}%`,
          background: `linear-gradient(90deg, transparent, ${accent}66, transparent)`,
        }}
      />
      <Corner pos="tl" accent={accent} />
      <Corner pos="tr" accent={accent} />
      <Corner pos="bl" accent={accent} />
      <Corner pos="br" accent={accent} />
      <div
        style={{
          position: "absolute",
          left: 54,
          top: 42,
          fontFamily: MONO,
          fontSize: 14,
          letterSpacing: "0.14em",
          color: accent,
          opacity: 0.9,
        }}
      >
        {label}
      </div>
      {showTelemetry && (
        <div
          style={{
            position: "absolute",
            right: 54,
            top: 42,
            fontFamily: MONO,
            fontSize: 13,
            color: "rgba(234,246,248,0.55)",
            letterSpacing: "0.04em",
          }}
        >
          {fmtClock(localTime)}
        </div>
      )}
      {showTelemetry && (
        <div
          style={{
            position: "absolute",
            right: 54,
            bottom: 38,
            fontFamily: MONO,
            fontSize: 13,
            color: "rgba(234,246,248,0.4)",
            letterSpacing: "0.08em",
          }}
        >
          SCENE {pad2(sceneIndex + 1)}/{pad2(sceneCount)}
        </div>
      )}
      {showDisclaimer && (
        <div
          style={{
            position: "absolute",
            left: 54,
            bottom: 38,
            fontFamily: MONO,
            fontSize: 12,
            color: "rgba(255,176,32,0.8)",
            letterSpacing: "0.05em",
          }}
        >
          SYNTHETIC COMPOSITE — ILLUSTRATIVE, NOT ACTUAL IMAGERY
        </div>
      )}
    </>
  );
}

function Chip({ text, accent }: { text: string; accent: string }) {
  return (
    <div
      style={{
        border: `1px solid ${accent}`,
        borderRadius: 2,
        padding: "12px 20px",
        fontSize: 20,
        letterSpacing: "0.08em",
        color: accent,
        background: `${accent}12`,
        fontFamily: MONO,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </div>
  );
}

// ── Scene 1: Thesis ─────────────────────────────────────────────────────
export function Thesis({ localTime, index, count }: SceneProps) {
  const { accentColor, showDisclaimer, showTelemetry } = useTweakCtx();
  const accent = accentColor || "#4fe3ff";
  const chipsIn = clamp01((localTime - 0.4) / 1.0);
  const plusIn = clamp01((localTime - 1.5) / 0.4);
  const arrowIn = clamp01((localTime - 2.0) / 0.4);
  const bigText = "CONVINCING, NAVIGABLE DIGITAL TWINS";
  const bigRevealed = reveal(bigText, 2.3, 4.3, localTime);
  const subOpacity = clamp01((localTime - 4.5) / 0.5);
  return (
    <div style={{ position: "absolute", inset: 0, background: BG, overflow: "hidden", fontFamily: MONO }}>
      <HUDChrome
        accent={accent}
        label="THESIS // 01"
        sceneIndex={index}
        sceneCount={count}
        localTime={localTime}
        showDisclaimer={showDisclaimer}
        showTelemetry={showTelemetry}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "40%",
          transform: "translate(-50%,-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 22,
          width: 1300,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 18,
            alignItems: "center",
            opacity: chipsIn,
            transform: `translateY(${(1 - chipsIn) * 14}px)`,
          }}
        >
          <Chip text="COMMODITY GRAPHICS PIPELINES" accent={accent} />
          <div style={{ color: accent, fontSize: 24, opacity: plusIn }}>+</div>
          <Chip text="PUBLICLY AVAILABLE IMAGERY" accent={accent} />
        </div>
        <div style={{ fontSize: 26, color: accent, opacity: arrowIn }}>▼</div>
        <div
          style={{
            fontSize: 66,
            fontWeight: 800,
            color: "#eaf6f8",
            textAlign: "center",
            letterSpacing: "-0.01em",
            lineHeight: 1.15,
            textShadow: `0 0 34px ${accent}55`,
          }}
        >
          {bigRevealed}
          <span style={{ opacity: bigRevealed.length < bigText.length ? 1 : 0, color: accent }}>_</span>
        </div>
        <div style={{ fontSize: 28, color: "rgba(234,246,248,0.72)", opacity: subOpacity, letterSpacing: "0.02em" }}>
          of complex infrastructure.
        </div>
      </div>
    </div>
  );
}

// ── Scene 2: Sources ────────────────────────────────────────────────────
const TILE_TYPES = [
  "SAT-TILE",
  "STREET-LEVEL",
  "DRONE / UGC",
  "OPEN AERIAL",
  "MAP VECTOR",
  "CROWD PHOTO",
  "SAT-TILE",
  "STREET-LEVEL",
  "DRONE / UGC",
  "OPEN AERIAL",
  "MAP VECTOR",
  "CROWD PHOTO",
];
function tileTexture(i: number, accent: string) {
  const kind = i % 6;
  const grads = [
    `repeating-linear-gradient(0deg, ${accent}22 0 6px, transparent 6px 14px), linear-gradient(160deg, #14231f, #0a1512)`,
    `linear-gradient(180deg, ${accent}18, transparent 60%), linear-gradient(200deg,#141a1f,#0a0d10)`,
    `repeating-linear-gradient(120deg, ${accent}14 0 3px, transparent 3px 9px), linear-gradient(#101418,#0b0e10)`,
    `radial-gradient(circle at 30% 30%, ${accent}22, transparent 60%), linear-gradient(#141210,#0c0a09)`,
    `repeating-linear-gradient(90deg, ${accent}20 0 2px, transparent 2px 22px), repeating-linear-gradient(0deg, ${accent}20 0 2px, transparent 2px 22px), #0a0d10`,
    `linear-gradient(135deg, ${accent}1a 25%, transparent 25%), linear-gradient(#12100e,#0b0a09)`,
  ];
  return grads[kind];
}
export function Sources({ localTime, progress, index, count }: SceneProps) {
  const { accentColor, showDisclaimer, showTelemetry } = useTweakCtx();
  const accent = accentColor || "#4fe3ff";
  const cols = 6,
    tileW = 210,
    tileH = 128,
    gap = 18;
  const gridW = cols * tileW + (cols - 1) * gap;
  const gridH = 2 * tileH + gap;
  const startX = (1920 - gridW) / 2,
    startY = 350;
  const indexed = formatNum(easeOutCubic(clamp01(progress)) * 1247);
  const reticleT = clamp01((localTime - 0.4) / 5.2);
  const rx = startX + gridW * reticleT,
    ry = startY + gridH * reticleT;
  return (
    <div style={{ position: "absolute", inset: 0, background: BG, overflow: "hidden", fontFamily: MONO }}>
      <HUDChrome
        accent={accent}
        label="INPUT // 02"
        sceneIndex={index}
        sceneCount={count}
        localTime={localTime}
        showDisclaimer={showDisclaimer}
        showTelemetry={showTelemetry}
      />
      <div style={{ position: "absolute", left: "50%", top: 150, transform: "translateX(-50%)", textAlign: "center" }}>
        <div style={{ fontSize: 32, color: "#eaf6f8", fontWeight: 700, letterSpacing: "0.01em" }}>
          SOURCE: PUBLICLY AVAILABLE IMAGERY
        </div>
        <div style={{ fontSize: 22, color: accent, marginTop: 12, letterSpacing: "0.06em" }}>
          IMAGES INDEXED: {indexed}
        </div>
      </div>
      {TILE_TYPES.map((type, i) => {
        const col = i % cols,
          row = Math.floor(i / cols);
        const appearAt = 0.35 + i * 0.09;
        const t = clamp01((localTime - appearAt) / 0.5);
        const x = startX + col * (tileW + gap),
          y = startY + row * (tileH + gap);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: tileW,
              height: tileH,
              opacity: t,
              transform: `translateY(${(1 - t) * 20}px)`,
              border: `1px solid ${accent}55`,
              background: tileTexture(i, accent),
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 8,
                bottom: 8,
                fontSize: 11,
                color: accent,
                letterSpacing: "0.05em",
                background: "rgba(6,10,13,0.6)",
                padding: "2px 6px",
              }}
            >
              {type}
            </div>
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: rx,
          top: ry,
          width: 30,
          height: 30,
          transform: "translate(-50%,-50%)",
          opacity: clamp01((localTime - 0.4) / 0.3),
          border: `1px solid ${accent}`,
          borderRadius: "50%",
        }}
      >
        <div style={{ position: "absolute", left: "50%", top: -8, width: 1, height: 8, background: accent }} />
        <div style={{ position: "absolute", left: "50%", bottom: -8, width: 1, height: 8, background: accent }} />
        <div style={{ position: "absolute", top: "50%", left: -8, height: 1, width: 8, background: accent }} />
        <div style={{ position: "absolute", top: "50%", right: -8, height: 1, width: 8, background: accent }} />
      </div>
    </div>
  );
}

// ── Scene 3: Pipeline ───────────────────────────────────────────────────
const NODES = [
  { label: "INGEST", sub: "1,247 IMAGES" },
  { label: "STRUCTURE FROM MOTION", sub: "SfM / SLAM" },
  { label: "POINT CLOUD", sub: "2.4M POINTS" },
  { label: "MESH + TEXTURE", sub: "1.1M TRIS / 8K" },
  { label: "NAVIGABLE TWIN", sub: "READY" },
];
export function Pipeline({ localTime, progress, index, count }: SceneProps) {
  const { accentColor, showDisclaimer, showTelemetry } = useTweakCtx();
  const accent = accentColor || "#4fe3ff";
  const n = NODES.length;
  const xs = [300, 630, 960, 1290, 1620];
  const cy = 430;
  const pcount = 140;
  const clusters = [
    [-90, 20],
    [40, 10],
    [150, -10],
  ];
  return (
    <div style={{ position: "absolute", inset: 0, background: BG, overflow: "hidden", fontFamily: MONO }}>
      <HUDChrome
        accent={accent}
        label="PIPELINE // 03"
        sceneIndex={index}
        sceneCount={count}
        localTime={localTime}
        showDisclaimer={showDisclaimer}
        showTelemetry={showTelemetry}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 110,
          transform: "translateX(-50%)",
          fontSize: 30,
          fontWeight: 700,
          color: "#eaf6f8",
        }}
      >
        PROCESSING PIPELINE
      </div>
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        {xs.slice(0, -1).map((x, i) => {
          const segProg = clamp01(progress * n - (i + 1));
          const nx = xs[i + 1];
          return (
            <line
              key={i}
              x1={x + 42}
              y1={cy}
              x2={x + (nx - x) * segProg - 42}
              y2={cy}
              stroke={accent}
              strokeWidth="2"
              opacity="0.7"
            />
          );
        })}
      </svg>
      {NODES.map((node, i) => {
        const activeFrac = clamp01(progress * n - i * 0.85);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: xs[i],
              top: cy,
              transform: "translate(-50%,-50%)",
              textAlign: "center",
              width: 240,
            }}
          >
            <div
              style={{
                width: 84,
                height: 84,
                margin: "0 auto",
                borderRadius: "50%",
                border: `2px solid ${accent}`,
                background: `${accent}${activeFrac > 0.5 ? "22" : "08"}`,
                boxShadow: activeFrac > 0.5 ? `0 0 26px ${accent}66` : "none",
                transition: "background 0.2s",
              }}
            />
            <div style={{ marginTop: 14, fontSize: 16, color: "#eaf6f8", letterSpacing: "0.04em", fontWeight: 600 }}>
              {node.label}
            </div>
            <div style={{ marginTop: 6, fontSize: 14, color: accent, opacity: activeFrac, letterSpacing: "0.04em" }}>
              {node.sub}
            </div>
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 700,
          transform: "translateX(-50%)",
          width: 1100,
          height: 200,
          border: `1px solid ${accent}44`,
          background: "rgba(255,255,255,0.02)",
        }}
      >
        <div style={{ position: "absolute", left: 14, top: 10, fontSize: 12, color: accent, letterSpacing: "0.08em" }}>
          POINT CLOUD PREVIEW
        </div>
        {Array.from({ length: pcount }).map((_, i) => {
          const cl = clusters[i % clusters.length];
          const jx = (prand(i) - 0.5) * 200,
            jy = (prand(i + 500) - 0.5) * 90;
          const appearAt = prand(i + 1000) * 0.8 + 0.1;
          const op = clamp01((progress - appearAt) / 0.1) * 0.8;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: 550 + cl[0] + jx,
                top: 100 + cl[1] + jy,
                width: 3,
                height: 3,
                borderRadius: "50%",
                background: accent,
                opacity: op,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Scene 4: Twin ───────────────────────────────────────────────────────
function Box({
  x,
  y,
  w,
  d,
  h,
  accent,
  label,
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  accent: string;
  label?: string;
}) {
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: d, transformStyle: "preserve-3d" }}>
      <div
        style={{
          position: "absolute",
          width: w,
          height: d,
          transform: `translateZ(${h}px)`,
          background: `${accent}22`,
          border: `1px solid ${accent}`,
          boxSizing: "border-box",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: w,
          height: h,
          left: 0,
          top: d,
          transformOrigin: "top",
          transform: "rotateX(-90deg)",
          background: `${accent}14`,
          border: `1px solid ${accent}99`,
          boxSizing: "border-box",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: d,
          height: h,
          left: w,
          top: 0,
          transformOrigin: "top left",
          transform: "rotateY(90deg)",
          background: `${accent}0a`,
          border: `1px solid ${accent}77`,
          boxSizing: "border-box",
        }}
      />
      {label && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: -18,
            width: w,
            transform: `translateZ(${h}px)`,
            textAlign: "center",
            fontFamily: MONO,
            fontSize: 12,
            color: accent,
            letterSpacing: "0.05em",
            opacity: 0.9,
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
export function Twin({ localTime, progress, index, count }: SceneProps) {
  const { accentColor, showDisclaimer, showTelemetry } = useTweakCtx();
  const accent = accentColor || "#4fe3ff";
  const entry = clamp01(localTime / 1.4);
  const camT = easeInOutSine(clamp01((localTime - 0.5) / 9));
  const heading = -42 + 20 * camT;
  const zoom = 0.82 + 0.28 * camT;
  const waypoints = [
    { t: [0.0, 0.34], label: "HANGAR-A", x: 760, y: 470 },
    { t: [0.34, 0.68], label: "TWR-01", x: 1150, y: 340 },
    { t: [0.68, 1.0], label: "DEPOT", x: 1080, y: 620 },
  ];
  const wp = waypoints.find((w) => progress >= w.t[0] && progress < w.t[1]) || waypoints[waypoints.length - 1];
  const navReady = clamp01((localTime - 8.6) / 0.8);
  return (
    <div style={{ position: "absolute", inset: 0, background: BG, overflow: "hidden", fontFamily: MONO }}>
      <HUDChrome
        accent={accent}
        label="DIGITAL TWIN // 04"
        sceneIndex={index}
        sceneCount={count}
        localTime={localTime}
        showDisclaimer={showDisclaimer}
        showTelemetry={showTelemetry}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          perspective: 1500,
          opacity: entry,
          transform: `scale(${0.94 + 0.06 * entry})`,
        }}
      >
        <div
          style={{
            width: 640,
            height: 420,
            position: "relative",
            transformStyle: "preserve-3d",
            transform: `rotateX(58deg) rotateZ(${heading}deg) scale(${zoom})`,
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: `linear-gradient(${accent}22 1px, transparent 1px), linear-gradient(90deg, ${accent}22 1px, transparent 1px)`,
              backgroundSize: "32px 32px",
            }}
          />
          <div style={{ position: "absolute", left: 10, top: 10, width: 620, height: 400, border: `2px dashed ${accent}66` }} />
          <div
            style={{
              position: "absolute",
              left: 40,
              top: 280,
              width: 480,
              height: 56,
              background: `${accent}0d`,
              border: `1px solid ${accent}55`,
            }}
          >
            <div style={{ position: "absolute", left: 0, right: 0, top: "50%", borderTop: `2px dashed ${accent}aa` }} />
          </div>
          <Box x={60} y={110} w={170} d={100} h={65} accent={accent} label="HANGAR-A" />
          <Box x={260} y={110} w={170} d={100} h={65} accent={accent} label="HANGAR-B" />
          <Box x={480} y={60} w={46} d={46} h={150} accent={accent} label="TWR-01" />
          <Box x={460} y={230} w={130} d={85} h={42} accent={accent} label="DEPOT" />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: wp.x,
          top: wp.y,
          width: 46,
          height: 46,
          transform: "translate(-50%,-50%)",
          border: `1px solid ${accent}`,
          opacity: 0.85,
        }}
      >
        <div style={{ position: "absolute", left: "50%", top: -10, width: 1, height: 10, background: accent }} />
        <div style={{ position: "absolute", left: "50%", bottom: -10, width: 1, height: 10, background: accent }} />
        <div style={{ position: "absolute", top: "50%", left: -10, height: 1, width: 10, background: accent }} />
        <div style={{ position: "absolute", top: "50%", right: -10, height: 1, width: 10, background: accent }} />
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 54,
            transform: "translateX(-50%)",
            fontSize: 13,
            color: accent,
            whiteSpace: "nowrap",
            letterSpacing: "0.06em",
          }}
        >
          WAYPOINT: {wp.label}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 54,
          top: 90,
          fontSize: 14,
          color: "rgba(234,246,248,0.6)",
          lineHeight: 1.9,
          letterSpacing: "0.03em",
        }}
      >
        <div>MODE: FREE NAVIGATION</div>
        <div>GRID: SYN-04 / SYN-11 (SIMULATED)</div>
        <div>SOURCE: PUBLIC IMAGERY COMPOSITE</div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 54,
          bottom: 90,
          fontSize: 18,
          color: accent,
          opacity: navReady,
          letterSpacing: "0.06em",
          fontWeight: 700,
        }}
      >
        NAVIGABLE ✓
      </div>
    </div>
  );
}

// ── Scene 5: Closing ────────────────────────────────────────────────────
const CHECKS = ["CONVINCING", "NAVIGABLE", "BUILT FROM COMMODITY PIPELINES", "SOURCED FROM PUBLIC IMAGERY ONLY"];
export function Closing({ localTime, index, count }: SceneProps) {
  const { accentColor, showDisclaimer, showTelemetry } = useTweakCtx();
  const accent = accentColor || "#4fe3ff";
  const headerOp = clamp01((localTime - 0.2) / 0.6);
  const statement = "Treat this as a baseline adversary capability.";
  const statementRevealed = reveal(statement, 3.0, 4.5, localTime);
  const subOpacity = clamp01((localTime - 4.7) / 0.5);
  return (
    <div style={{ position: "absolute", inset: 0, background: BG, overflow: "hidden", fontFamily: MONO }}>
      <HUDChrome
        accent={accent}
        label="IMPLICATION // 05"
        sceneIndex={index}
        sceneCount={count}
        localTime={localTime}
        showDisclaimer={showDisclaimer}
        showTelemetry={showTelemetry}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "38%",
          transform: "translate(-50%,-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 18,
          width: 1200,
        }}
      >
        <div style={{ fontSize: 20, color: accent, letterSpacing: "0.16em", opacity: headerOp }}>
          CAPABILITY CONFIRMED
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
          {CHECKS.map((c, i) => {
            const at = 1.1 + i * 0.45;
            const t = clamp01((localTime - at) / 0.4);
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  opacity: t,
                  transform: `translateX(${(1 - t) * 16}px)`,
                }}
              >
                <span style={{ color: accent, fontSize: 20 }}>✓</span>
                <span style={{ fontSize: 22, color: "#eaf6f8", letterSpacing: "0.03em" }}>{c}</span>
              </div>
            );
          })}
        </div>
        <div
          style={{
            fontSize: 44,
            fontWeight: 800,
            color: "#eaf6f8",
            textAlign: "center",
            marginTop: 20,
            lineHeight: 1.3,
            textShadow: `0 0 30px ${accent}55`,
          }}
        >
          {statementRevealed}
          <span style={{ opacity: statementRevealed.length < statement.length ? 1 : 0, color: accent }}>_</span>
        </div>
        <div style={{ fontSize: 18, color: "rgba(234,246,248,0.6)", opacity: subOpacity, letterSpacing: "0.04em" }}>
          Digital twins of sensitive infrastructure — no privileged access required.
        </div>
      </div>
    </div>
  );
}
