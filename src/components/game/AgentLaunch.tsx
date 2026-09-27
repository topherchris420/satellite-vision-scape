import type { Game } from "@/game/Game";
import { JevProvider, probeJev } from "@/agent/providers/jev";
/** Launch from briefing/pause with the cursor free for delegation controls. */
export function AgentLaunch({ game, onStart }: { game: Game; onStart: () => void }) {
  const launch = (mode: "agent" | "copilot") => {
    onStart();
    game.input.releaseAll();
    const runtime = game.agent.runtime;
    runtime.setMode(mode, null);
    void probeJev(AbortSignal.timeout(4500)).then((ready) => {
      if (runtime.mode !== mode || runtime.provider !== null) return;
      if (ready) runtime.setMode(mode, new JevProvider(game.agent.trace.session));
      else {
        runtime.setMode(mode, {
          id: "jev-unavailable",
          decide: async () => {
            throw new Error("Jev unavailable on this deployment");
          },
        });
        runtime.state = "OFFLINE";
        runtime.lastOutcome = "Jev unavailable on this deployment";
      }
    });
  };
  const style =
    "rounded-lg border border-[#7fd6d0]/30 px-3 py-2 text-[10px] uppercase tracking-wider text-[#b5e5e2] hover:bg-white/10";
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <button className={style} onClick={() => launch("agent")}>
        Jev After Hours
      </button>
      <button className={style} onClick={() => launch("copilot")}>
        Co-pilot
      </button>
    </div>
  );
}
