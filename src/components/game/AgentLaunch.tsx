import { useState } from "react";
import { Bot, Users } from "lucide-react";
import type { Game } from "@/game/Game";
import { probeJev } from "@/agent/providers/jev";
import { providerFor } from "@/lib/agent-ui";

/**
 * "Jev After Hours" and "Co-pilot", beside the ordinary After Hours button.
 *
 * Jev's availability is checked only when one of these is pressed (a GET
 * that costs no model call), so ordinary play makes no agent requests. If
 * Jev is not configured nothing starts and the buttons say so; playing
 * yourself is unaffected.
 */
export function AgentLaunch({
  game,
  onStart,
}: {
  game: Game;
  /** Start (or resume) After Hours without capturing the mouse. */
  onStart: () => void;
}) {
  const [state, setState] = useState<"idle" | "checking" | "unavailable">("idle");

  const launch = async (mode: "agent" | "copilot") => {
    // Audio may only start inside a user gesture: unlock it now, before the probe.
    game.unlockAudio();
    setState("checking");
    const ready = await launchAgentWhenStarted(game, mode, onStart);
    setState(ready ? "idle" : "unavailable");
  };

  const style =
    "flex items-center gap-1.5 rounded-lg border border-[#7fd6d0]/30 px-3 py-2 text-[10px] font-bold uppercase tracking-[.16em] text-[#b5e5e2] transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        <button
          className={style}
          disabled={state !== "idle"}
          onClick={() => void launch("agent")}
          title="Jev plays After Hours; press H at any time to take control"
        >
          <Bot size={12} /> Jev After Hours
        </button>
        <button
          className={style}
          disabled={state !== "idle"}
          onClick={() => void launch("copilot")}
          title="You play; Jev suggests, and acts only when you hand it a move"
        >
          <Users size={12} /> Co-pilot
        </button>
      </div>
      {state === "checking" && (
        <span className="font-sans text-[10px] text-white/45">Connecting to Jev…</span>
      )}
      {state === "unavailable" && (
        <span className="font-sans text-[10px] text-amber-200/75">
          Jev After Hours · Unavailable on this deployment
        </span>
      )}
    </div>
  );
}

/** Probe first; only a reachable Jev starts After Hours in an agent mode. */
async function launchAgentWhenStarted(
  game: Game,
  mode: "agent" | "copilot",
  onStart: () => void,
): Promise<boolean> {
  const status = await probeJev(AbortSignal.timeout(4000));
  if (!status.available) return false;
  onStart();
  if (!game.afterHours.active) return false;
  game.agent.runtime.start(mode, providerFor(game, "jev"));
  return true;
}
