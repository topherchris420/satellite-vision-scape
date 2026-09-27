import { useEffect, useState, useRef } from "react";
import type { Game } from "@/game/Game";
import { JevProvider, probeJev } from "@/agent/providers/jev";
import { RandomProvider, MockProvider, ReplayProvider } from "@/agent/providers/local";
import { IntentSchema } from "@/agent/contract";
/** Small, explicitly enabled control seat. No requests at all in ordinary human play. */
export function AgentHUD({ game }: { game: Game }) {
  const [open, setOpen] = useState(game.agent.runtime.mode !== "human"),
    [status, setStatus] = useState<"idle" | "checking" | "ready" | "unavailable">("idle");
  const [, refresh] = useState(0);
  const runtime = game.agent.runtime;
  const active = game.afterHours.active;
  const queryApplied = useRef(false);
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => refresh((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [open]);
  useEffect(() => {
    if (!active || queryApplied.current) return;
    const params = new URLSearchParams(location.search),
      controller = params.get("controller");
    if (controller === "random" || controller === "mock") {
      queryApplied.current = true;
      setOpen(true);
      runtime.setMode(
        "agent",
        controller === "random"
          ? new RandomProvider(Number(params.get("seed") ?? 42))
          : new MockProvider(),
      );
    } else if (controller === "jev" || params.has("copilot") || params.has("agentHud"))
      setOpen(true);
    if (
      status === "ready" &&
      !queryApplied.current &&
      (controller === "jev" || params.has("copilot"))
    ) {
      queryApplied.current = true;
      runtime.setMode(
        params.has("copilot") ? "copilot" : "agent",
        new JevProvider(game.agent.trace.session),
      );
    }
  }, [runtime, active, status, game]);
  useEffect(() => {
    if (!open || !active) return;
    const abort = new AbortController();
    setStatus("checking");
    void probeJev(abort.signal).then((ok) => {
      if (!abort.signal.aborted) setStatus(ok ? "ready" : "unavailable");
    });
    return () => abort.abort();
  }, [open, active]);
  useEffect(() => {
    const takeover = (e: Event) => {
      const target = e.target;
      if (target instanceof Element && target.closest("[data-agent-seat]")) return;
      if (runtime.mode === "agent" || game.agent.controls.source !== "human")
        runtime.takeover("human_ui_input");
    };
    // Radio, dial, and accessibility buttons can use direct semantic commands.
    document.addEventListener("pointerdown", takeover, true);
    document.addEventListener("click", takeover, true);
    return () => {
      document.removeEventListener("pointerdown", takeover, true);
      document.removeEventListener("click", takeover, true);
    };
  }, [runtime, game]);
  const launch = (mode: "agent" | "copilot") => {
    game.input.releaseAll();
    runtime.setMode(mode, new JevProvider(game.agent.trace.session));
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([game.agent.export()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `svs-agent-${game.agent.trace.session}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const replay = async (file: File | undefined) => {
    if (!file || file.size > 8000000) return;
    try {
      const trace = JSON.parse(await file.text());
      if (trace.schema !== "svs-agent-trace/v1" || !Array.isArray(trace.records)) return;
      const actions = trace.records
        .filter((r: { type?: string }) => r.type === "decision")
        .map((r: { action: unknown }) => IntentSchema.parse(r.action));
      game.input.releaseAll();
      runtime.setMode("agent", new ReplayProvider(actions));
    } catch {
      setStatus("unavailable");
    }
  };
  const button =
    "rounded border border-white/20 px-2 py-1.5 text-[10px] hover:bg-white/10 disabled:opacity-40";
  if (!active) return null;
  const describe = (a: import("@/agent/contract").AgentIntent) =>
    a.intent.replaceAll("_", " ") +
    ("target" in a
      ? ` · ${a.target.replaceAll("_", " ")}`
      : "direction" in a
        ? ` · ${a.direction}`
        : "");
  return (
    <aside
      data-agent-seat
      className="pointer-events-auto absolute right-3 top-24 z-20 w-64 max-w-[80vw] rounded-lg border border-white/15 bg-[#071014]/90 p-3 font-mono text-xs text-white shadow-lg"
    >
      <button
        className="w-full text-left text-[10px] tracking-[.18em]"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        AFTER HOURS · CONTROL {open ? "−" : "+"}
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-1">
            <button className={button} onClick={() => runtime.takeover()}>
              PLAY YOURSELF
            </button>
            <button
              className={button}
              disabled={status !== "ready"}
              onClick={() => launch("agent")}
            >
              JEV AFTER HOURS
            </button>
            <button
              className={button}
              disabled={status !== "ready"}
              onClick={() => launch("copilot")}
            >
              CO-PILOT
            </button>
          </div>
          {status === "unavailable" && (
            <p className="text-white/50">Jev unavailable on this deployment.</p>
          )}
          <div aria-live="polite">
            <strong>
              {runtime.mode === "human" ? "HUMAN" : (runtime.provider?.id.toUpperCase() ?? "AGENT")}{" "}
              · {runtime.state.replaceAll("_", " ")}
            </strong>
            <p className="mt-1 text-white/60">
              {runtime.executor.action
                ? describe(runtime.executor.action)
                : (runtime.lastOutcome ?? "Ready when you are.")}
            </p>
          </div>
          {runtime.suggestion && (
            <div>
              <p>Suggests: {describe(runtime.suggestion)}</p>
              <div className="mt-2 flex gap-2">
                <button
                  className={button}
                  onClick={() => {
                    game.input.releaseAll();
                    runtime.delegate();
                  }}
                >
                  LET AGENT ACT
                </button>
                <button className={button} onClick={() => runtime.dismiss()}>
                  DISMISS
                </button>
              </div>
            </div>
          )}
          {runtime.mode !== "human" && (
            <button className={`${button} w-full`} onClick={() => runtime.takeover()}>
              H · TAKE CONTROL
            </button>
          )}
          <p className="text-[10px] text-white/40">
            {Math.round(runtime.latencyMs)} ms · {game.agent.controls.source} input
          </p>
          <div className="flex gap-2">
            <button className={button} onClick={download}>
              EXPORT TRACE
            </button>
            <label className={`${button} cursor-pointer`}>
              REPLAY
              <input
                className="sr-only"
                type="file"
                accept=".json"
                onChange={(e) => void replay(e.target.files?.[0])}
              />
            </label>
          </div>
          <p className="text-[9px] text-white/40">
            Fictional gameplay · replay repeats intentions, not outcomes.
          </p>
        </div>
      )}
    </aside>
  );
}
