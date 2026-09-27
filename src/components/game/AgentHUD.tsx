import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Game } from "@/game/Game";
import type { AgentHudSnapshot } from "@/agent/hud";
import { useAfterHours } from "@/hooks/use-after-hours";
import {
  downloadTrace,
  launchAgent,
  parseAgentQuery,
  startReplay,
  type AgentKind,
} from "@/lib/agent-ui";

/**
 * The agent's seat at the table: a small panel that shows what the agent
 * observed, chose and is doing, a transient banner when control changes
 * hands, and — in co-pilot — the current suggestion with the button that
 * hands it over. It shows phrases and measurements, never reasoning.
 *
 * In ordinary human play it renders nothing and makes no requests.
 */

const panel =
  "border border-white/10 bg-[#071014]/82 text-white shadow-[0_16px_50px_rgba(0,0,0,.28)] backdrop-blur-xl";
const button =
  "rounded-md border border-white/15 px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[.16em] text-white/80 transition hover:bg-white/10 disabled:opacity-40";

const STATE_TEXT: Record<AgentHudSnapshot["state"], string> = {
  OFF: "Off",
  OBSERVING: "Observing",
  THINKING: "Thinking",
  ACTING: "Acting",
  BLOCKED: "Blocked",
  WAITING: "Waiting",
  HUMAN_CONTROL: "Human control",
  OFFLINE: "Offline",
};

const BANNER_MS = 3500;

/** A short name for buttons and headings; the full label is in the title. */
function shortName(id: string | undefined): string {
  switch (id) {
    case "jev":
      return "Jev";
    case "mock":
      return "Baseline";
    case "random":
      return "Random";
    case "replay":
      return "Replay";
    default:
      return "Agent";
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.2rem_1fr] gap-2 py-0.5">
      <span className="pt-px text-[8px] font-bold uppercase tracking-[.2em] text-white/35">
        {label}
      </span>
      <span className="line-clamp-2 min-w-0 font-sans text-[10.5px] leading-snug text-white/85">
        {children}
      </span>
    </div>
  );
}

function Banner({ s }: { s: AgentHudSnapshot }) {
  const n = s.notice;
  if (!n || n.ageMs > BANNER_MS) return null;
  const who = shortName(s.provider?.id);
  const [title, line, hint] =
    n.kind === "connected"
      ? s.mode === "copilot"
        ? [`${who.toUpperCase()} CO-PILOT`, "Suggestions only · you keep control", null]
        : [`${who.toUpperCase()} CONNECTED`, "Control delegated", "H · Take control"]
      : n.kind === "help"
        ? ["HUMAN CONTROL", `${who} asked you to take over`, null]
        : n.kind === "complete"
          ? ["TRANSMISSION RECEIVED", "Task complete", null]
          : ["HUMAN CONTROL", `${shortName(n.provider)} standing by`, null];
  return (
    <div
      role="status"
      className={`${panel} pointer-events-none absolute left-1/2 top-32 -translate-x-1/2 rounded-lg px-5 py-2.5 text-center animate-in fade-in slide-in-from-top-1 duration-500`}
    >
      <div className="text-[11px] font-bold uppercase tracking-[.28em] text-[#7fd6d0]">{title}</div>
      <div className="mt-0.5 font-sans text-[11px] text-white/70">{line}</div>
      {hint && (
        <div className="mt-1 text-[9px] uppercase tracking-[.2em] text-amber-200/80">{hint}</div>
      )}
    </div>
  );
}

export function AgentHUD({
  game,
  isMobile,
  onReleasePointer,
}: {
  game: Game;
  isMobile: boolean;
  onReleasePointer: () => void;
}) {
  const s = useSyncExternalStore(
    game.agent.hud.subscribe,
    game.agent.hud.getSnapshot,
    game.agent.hud.getSnapshot,
  );
  const after = useAfterHours(game);
  const query = useMemo(
    () => parseAgentQuery(typeof location === "undefined" ? "" : location.search),
    [],
  );
  const [pinned, setPinned] = useState(query.hud);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const applied = useRef(false);
  const runtime = game.agent.runtime;
  const agentVisible = s.mode !== "human";

  // Development entry points: applied once, when After Hours is running.
  useEffect(() => {
    if (!after.active || applied.current || query.controller === "human") return;
    applied.current = true;
    if (query.controller === "replay") {
      setPinned(true);
      setMessage("Choose a trace file to replay.");
      return;
    }
    onReleasePointer();
    const kind = query.controller as AgentKind;
    void launchAgent(game, query.copilot ? "copilot" : "agent", kind, query.seed).then((r) => {
      if (!r.ok) setMessage(`${kind === "jev" ? "Jev" : kind} unavailable: ${r.detail}`);
    });
  }, [after.active, game, query, onReleasePointer]);

  // Any click on the page outside this panel is the person acting: while the
  // agent holds the character, it hands control back first (radio and dial
  // buttons act directly, not through input).
  useEffect(() => {
    const onPointer = (e: Event) => {
      const t = e.target;
      if (t instanceof Element && t.closest("[data-agent-seat]")) return;
      if (!runtime.controlling) return;
      if (runtime.mode === "agent") runtime.toHuman("human_ui");
      else runtime.cancelDelegation("human_ui");
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [runtime]);

  if (!after.active) return null;
  // After an agent has played, the panel stays (compact) for export and relaunch.
  if (!agentVisible && !pinned && s.decisions === 0) return <Banner s={s} />;

  const start = async (mode: "agent" | "copilot", kind: AgentKind) => {
    setBusy(true);
    setMessage(null);
    const r = await launchAgent(game, mode, kind, query.seed);
    setBusy(false);
    if (!r.ok)
      setMessage(kind === "jev" ? `Jev unavailable on this deployment. ${r.detail}` : r.detail);
  };
  const replay = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 16_000_000) return setMessage("That trace is too large.");
    const r = startReplay(game, await file.text());
    setMessage(r.ok ? `Replaying ${r.detail}.` : r.detail);
  };

  const who = s.provider?.label ?? "Agent";
  const short = shortName(s.provider?.id);
  const failure =
    s.failure?.kind === "unavailable"
      ? `${who} unavailable on this deployment`
      : s.failure
        ? `${s.failure.kind.replaceAll("_", " ")}${s.failure.detail ? ` · ${s.failure.detail}` : ""}`
        : null;

  return (
    <>
      <Banner s={s} />
      <aside
        data-agent-seat
        aria-label="Agent control"
        className={`${panel} pointer-events-auto absolute rounded-xl p-3 ${
          isMobile
            ? "bottom-[9.5rem] left-1/2 w-[min(20rem,calc(100vw-1.5rem))] -translate-x-1/2"
            : "left-5 top-[17.5rem] w-[17rem]"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div
            className="min-w-0 truncate text-[10px] font-bold uppercase tracking-[.2em] text-[#7fd6d0]"
            title={s.provider?.label}
          >
            {s.mode === "human"
              ? "Human control"
              : `${short} · ${s.mode === "copilot" ? (s.delegated ? "Delegated" : "Co-pilot") : "Autonomous"}`}
          </div>
          <div
            className="flex shrink-0 items-center gap-1.5 text-[9px] uppercase tracking-[.16em] text-white/55"
            aria-live="polite"
          >
            {s.thinking && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#7fd6d0]" aria-hidden />
            )}
            {s.mode === "human"
              ? null
              : s.thinking && s.state === "ACTING"
                ? "Acting · thinking"
                : STATE_TEXT[s.state]}
          </div>
        </div>

        {s.mode !== "human" && (
          <div className="mt-1.5 border-t border-white/10 pt-1">
            <Row label="Observe">
              {s.observe.facts.length > 0
                ? s.observe.facts.join(" · ")
                : (s.observe.objective ?? "—")}
            </Row>
            {(s.mode === "agent" || s.delegated) && (
              <>
                <Row label="Choose">
                  {s.chosen ? (
                    <>
                      {s.chosen.phrase}
                      <span className="text-white/40">
                        {s.chosen.confidence !== null &&
                          ` · ${Math.round(s.chosen.confidence * 100)}%`}
                        {` · ${s.chosen.latencyMs} ms`}
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </Row>
                <Row label="Act">{s.acting ?? "—"}</Row>
                <Row label="Outcome">{s.outcome ?? "—"}</Row>
              </>
            )}
          </div>
        )}

        {s.suggestion && (
          <div className="mt-2 rounded-lg border border-[#7fd6d0]/30 bg-[#0B5D63]/25 p-2.5">
            <div className="text-[8px] font-bold uppercase tracking-[.22em] text-[#7fd6d0]">
              {short} suggests
            </div>
            <div className="mt-1 font-sans text-[12px] text-white">{s.suggestion.phrase}</div>
            <div className="mt-2 flex gap-2">
              <button className={button} onClick={() => runtime.delegate()}>
                Let {short} {s.suggestion.verb.toLowerCase()}
              </button>
              <button className={button} onClick={() => runtime.dismiss()}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        {failure && s.mode !== "human" && (
          <p className="mt-2 font-sans text-[10px] text-amber-200/80">{failure}</p>
        )}
        {message && <p className="mt-2 font-sans text-[10px] text-amber-200/80">{message}</p>}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {s.mode !== "human" ? (
            <button className={button} onClick={() => runtime.toHuman("human_ui")}>
              {isMobile ? "Take control" : "H · Take control"}
            </button>
          ) : (
            <>
              <button className={button} disabled={busy} onClick={() => void start("agent", "jev")}>
                Jev After Hours
              </button>
              <button
                className={button}
                disabled={busy}
                onClick={() => void start("copilot", "jev")}
              >
                Co-pilot
              </button>
            </>
          )}
          <button className={button} onClick={() => downloadTrace(game)}>
            Export trace
          </button>
          {s.mode === "human" && (
            <label className={`${button} cursor-pointer`}>
              Replay
              <input
                className="sr-only"
                type="file"
                accept="application/json,.json"
                onChange={(e) => void replay(e.target.files?.[0])}
              />
            </label>
          )}
        </div>
      </aside>
    </>
  );
}
