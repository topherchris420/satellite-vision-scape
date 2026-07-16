// "Digital Twins of Infrastructure" — the animated thesis piece, composed
// from the ported scenes plus an in-app tweaks panel (accent color,
// disclaimer, telemetry). Ported from Digital Twin Thesis.dc.html in the
// claude.ai/design project "Digital twins of infrastructure".
import { useMemo, useState } from "react";
import { SceneStage, type SceneDef } from "./engine";
import {
  ACCENT_OPTIONS,
  Closing,
  Pipeline,
  Sources,
  Thesis,
  Twin,
  TWEAK_DEFAULTS,
  TweakCtx,
  type TweakState,
} from "./scenes";

const SCENES: SceneDef[] = [
  { name: "Thesis", dur: 5.5 },
  { name: "Sources", dur: 6.5 },
  { name: "Pipeline", dur: 7.5 },
  { name: "Twin", dur: 9.5 },
  { name: "Closing", dur: 6.5 },
];

const COMPONENTS = { Thesis, Sources, Pipeline, Twin, Closing };

const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace";

export function DigitalTwinPiece({ chrome = true }: { chrome?: boolean }) {
  const [tweaks, setTweaks] = useState<TweakState>(TWEAK_DEFAULTS);
  const ctxVal = useMemo(() => tweaks, [tweaks]);
  return (
    <TweakCtx.Provider value={ctxVal}>
      <div style={{ position: "absolute", inset: 0 }}>
        <SceneStage width={1920} height={1080} bg="#060a0d" scenes={SCENES} components={COMPONENTS} chrome={chrome} />
        {chrome && <TweaksPanel tweaks={tweaks} onChange={(edits) => setTweaks((t) => ({ ...t, ...edits }))} />}
      </div>
    </TweakCtx.Provider>
  );
}

function TweaksPanel({
  tweaks,
  onChange,
}: {
  tweaks: TweakState;
  onChange: (edits: Partial<TweakState>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "fixed", right: 16, bottom: 16, zIndex: 40, fontFamily: MONO }}>
      {open && (
        <div
          style={{
            marginBottom: 8,
            width: 250,
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            background: "rgba(10,14,17,0.92)",
            border: "1px solid rgba(120,200,220,0.25)",
            borderRadius: 8,
            backdropFilter: "blur(12px)",
            color: "#eaf6f8",
            fontSize: 12,
          }}
        >
          <div style={{ letterSpacing: "0.12em", color: "rgba(234,246,248,0.55)", fontSize: 10 }}>TWEAKS</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ color: "rgba(234,246,248,0.72)" }}>Accent color</span>
            <div style={{ display: "flex", gap: 6 }}>
              {ACCENT_OPTIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  onClick={() => onChange({ accentColor: c })}
                  style={{
                    flex: 1,
                    height: 30,
                    borderRadius: 4,
                    background: c,
                    cursor: "pointer",
                    border: "1px solid rgba(255,255,255,0.2)",
                    outline: tweaks.accentColor === c ? "2px solid #eaf6f8" : "none",
                    outlineOffset: 1,
                  }}
                />
              ))}
            </div>
          </div>
          <Toggle
            label="Synthetic disclaimer"
            value={tweaks.showDisclaimer}
            onChange={(v) => onChange({ showDisclaimer: v })}
          />
          <Toggle
            label="Telemetry overlay"
            value={tweaks.showTelemetry}
            onChange={(v) => onChange({ showTelemetry: v })}
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "block",
          marginLeft: "auto",
          padding: "6px 12px",
          fontFamily: MONO,
          fontSize: 11,
          letterSpacing: "0.1em",
          color: "#eaf6f8",
          background: "rgba(10,14,17,0.92)",
          border: "1px solid rgba(120,200,220,0.25)",
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        {open ? "CLOSE" : "TWEAKS"}
      </button>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <span style={{ color: "rgba(234,246,248,0.72)" }}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        style={{
          position: "relative",
          width: 32,
          height: 18,
          border: 0,
          borderRadius: 999,
          background: value ? "#34c759" : "rgba(255,255,255,0.15)",
          transition: "background 0.15s",
          cursor: "pointer",
          padding: 0,
          flexShrink: 0,
        }}
      >
        <i
          style={{
            position: "absolute",
            top: 2,
            left: 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            transition: "transform 0.15s",
            transform: value ? "translateX(14px)" : "none",
          }}
        />
      </button>
    </div>
  );
}
