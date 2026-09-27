/** Opt-in, one real provider decision through the server adapter and real runtime. */
import { Game } from "../src/game/Game";
import { createDecisionHandler } from "../src/server/agent/handler";
import { ProviderFailure } from "../src/agent/provider";
import { DecisionSchema } from "../src/agent/contract";
if (process.env.AGENT_LIVE_TEST !== "1" || !process.env.TYPESAFE_API_KEY)
  throw new Error("Set AGENT_LIVE_TEST=1 and server-side TYPESAFE_API_KEY");
const g = new Game({ visuals: false, storage: null });
g.afterHours.start();
g.frame(1 / 60, { simulate: true, camera: null, establishing: false });
const handler = createDecisionHandler({
  key: process.env.TYPESAFE_API_KEY,
  model: process.env.TYPESAFE_MODEL,
});
let result: unknown = null;
g.agent.runtime.setMode("agent", {
  id: "jev",
  async decide({ observation }) {
    const response = await handler(
      new Request("https://smoke.local/api/agent/jev/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "live-smoke-session", observation }),
      }),
    );
    if (!response.ok) throw new ProviderFailure(`provider_http_${response.status}`);
    const decision = DecisionSchema.parse(await response.json());
    result = decision;
    return decision;
  },
});
g.frame(1 / 60, { simulate: true, camera: null, establishing: false });
await new Promise((r) => setTimeout(r, 4500));
if (!result) {
  console.log(JSON.stringify({ verified: false, outcome: g.agent.runtime.lastOutcome }));
  g.dispose();
  process.exit(1);
}
// No second provider call: execute just the selected intention for one second.
for (let i = 0; i < 60; i++) g.frame(1 / 60, { simulate: true, camera: null, establishing: false });
console.log(
  JSON.stringify({
    provider: "jev",
    decision: result,
    execution: g.agent.runtime.lastOutcome ?? g.agent.runtime.state,
    position: g.player.position.toArray(),
    task: g.afterHours.hud.getSnapshot().stage,
  }),
);
g.dispose();
