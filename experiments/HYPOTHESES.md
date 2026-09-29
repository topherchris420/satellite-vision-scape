# Hypothesis backlog

Testable questions about behaviour in this world, newest evidence first. Each one is either **open** (worth running), **answered** (with the evidence and what we decided), or **blocked** (with what it needs). Keep entries short: the definition holds the design, the report holds the numbers, this file holds the decision.

How to add one: write the question and the observation that prompted it, copy the nearest definition in [`definitions/`](definitions/), run `bun run experiment <id>`, then come back and write the decision. Method: [docs/EXPERIMENTS.md](../docs/EXPERIMENTS.md).

Evidence words mean different things: **built** (it exists), **ran** (runs recorded), **observed** (measured from traces), **reproduced** (identical deterministic runs, or enough seeded replicates), **established** (held across builds, days and model versions; nothing here is yet).

---

## Answered

### Does decision latency change what happens in the world, or only how long it takes?

[`decision-latency`](definitions/decision-latency.json) · [report](results/decision-latency/report.md) · scripted baseline, 10 paired runs × 4 latencies · **reproduced**

- **Observed first: latency exposed two environment bugs, not a latency effect.** At run B's latency the baseline finished only **4/10** journeys; at 10× **0/10**. `bun run trace` showed a stall of 1,712 decisions re-arriving at the listening point (a parked car's "Enter vehicle" prompt hid "Begin the midnight transmission"), then, after that fix, 211 `route_blocked` in a row (the player pressed against the car; the planner read the start itself as blocked). Both fixed; archived before-results in [`archive/`](archive/).
- **After the fixes:** completion **10/10 at every latency** up to 10×. Time to goal rises with latency: +20 s at run B's latency (my "within 10 s" prediction: **NOT SUPPORTED**), +75 s at 4× (**SUPPORTED**), ~+200 s at 10×. Coffee unchanged (**SUPPORTED**, once the exit fix below removed a confound).
- **Decision:** latency is a cost in time, not in outcomes, for a decider that is always right. Speed is still not today's constraint for Jev; a model that corrects itself pays latency once per correction, which this does not measure.

### Are 3-second route reviews paying for anything?

[`travel-review-interval`](definitions/travel-review-interval.json) · [report](results/travel-review-interval/report.md) · baseline at run B's latency, 10 paired runs · **reproduced**

- Reviewing every 6 s instead of 3 s saves **32 requests per journey** (152 → 120, 21%) with no change in completion or coffee (**SUPPORTED**), but costs **~6 s** (445.9 → 451.5 s; my ±5 s prediction **NOT SUPPORTED**): a review near the destination lets the agent get out sooner.
- Before the careful-exit fix, 3 s reviews cost **7 points of coffee** in 10/10 pairs: a review arriving while the car still rolled chose to get out at ~6 m/s and the game's hard stop spilled it. That is why the baseline had always delivered 93%.
- **Decision:** keep 3 s. The NEXT_MODEL tripwire (reviews change the plan < 1% over ≥ 5 live runs) still stands; this measured its price: about 32 calls and 6 s per journey.

### Is a control bigger than the target zone enough to reproduce run A's oscillation?

[`tuning-control-magnitude`](definitions/tuning-control-magnitude.json) · [report](results/tuning-control-magnitude/report.md) · **reproduced**

- **Yes.** A policy with a _perfect_ direction rule that always uses a long hold locked **0 of 4 terminals in 10/10 runs**: 153 overshoots and 152 direction reversals in 433 s at the panels. Graded turns: 4/4, 0 overshoots, 20 inputs. One click at a time: 4/4 but 104 inputs (**SUPPORTED** ×3).
- **Decision:** run A's failure does not require a reasoning failure; control size alone produces it. `control_magnitudes` is covering a real trap, and any agent needs to pick control size by distance. This is also what the receiver showed in run B (4 long turns alternating 401 ↔ 443 around 420 before Jev switched to short turns).

### What does the tuning task charge an agent that cannot read the match trend?

[`tuning-trend-reading`](definitions/tuning-trend-reading.json) · [report](results/tuning-trend-reading/report.md) · **reproduced**

- **Almost nothing, and that is a finding about the task.** A policy that never reverses on a falling meter (`sweep`) was identical to the trend-reading one: every dial starts on the side nearer the middle, so "turn towards the middle" is right at all four panels, and graded turns never overshoot. Even `blind` (always starts up) costs only **+7 inputs** (27 vs 20) and 11 s. Both "≥ 10 more inputs" predictions: **NOT SUPPORTED**. (`blind` was added after a 2-run pilot; the original predictions were not changed.)
- **Decision:** the terminal stage exercises trend reading only after an overshoot. Jev also passes both trend probes 20/20 without `trend_inference`. See the open question on start sides below.

### Is `lean` ready to be the default question?

Probes, [`evals/results/2026-09-29-jev-jev-1.13.0.json`](../evals/results/2026-09-29-jev-jev-1.13.0.json) · Jev `jev-1.13.0`, 10 trials per cell, 400 calls · **observed**

- **No.** Without `hold_still_rule` (which `lean` drops) Jev fails both "keep still" probes **0/10**, answering a one-click turn at an ALIGNED terminal and at the receiver's hold bar. With it: 10/10.
- **Decision:** keep `full` as the default. `assist-profiles-journey` (≈ 2,000 calls) is not worth running until `hold_still_rule` passes without help.

### Which assists does Jev still need, one at a time?

20-trial single-factor ablations, [`evals/results/`](../evals/results/) `*-ablate-*.json` · 200 calls · **observed**

- `trend_inference`, `spill_advice` and `semantic_bearings` each pass their probes **20/20 without the assist** (and 20/20 with it), which meets the retirement rule.
- **But** each probe is one captured observation, and Jev answers the same observation the same way (every cell of the matrix was 10/10 or 0/10). 20/20 measures consistency on one situation, not generality. **Decision:** eligible for retirement on the probes; retire only when an in-flow experiment agrees (below).

### Does removing semantic bearings make Jev's navigation worse?

[`semantic-bearings-navigation`](definitions/semantic-bearings-navigation.json) · [report](results/semantic-bearings-navigation/report.md) · live, 5 paired coffee runs per condition · **observed**

- **No measurable difference.** 10/10 runs delivered the coffee; time to goal 90.0 s with the assist, 89.7 s without (median paired change −0.3 s; my "≥ 10 s slower" prediction: **NOT SUPPORTED**). Route, distance (584 m), route efficiency (0.93) and coffee (100%) were identical, and **every run chose the same intents in the same order** in both conditions. 336 live requests.
- With its 20/20 probes, `semantic_bearings` now has evidence from both a fixed situation and play. **Decision:** eligible for retirement, not yet retired: the coffee run exercises only two navigation choices. The terminal stage (four destinations chosen by distance and direction) is defined and ready: [`semantic-bearings-terminals`](definitions/semantic-bearings-terminals.json) (≈ 1,300 requests). If it agrees, removing the assist from the default question is a one-line change.

### Is the coffee run a discriminating task at all?

[`coffee-run-human-agent`](definitions/coffee-run-human-agent.json) · [report](results/coffee-run-human-agent/report.md) · **reproduced** (agents only)

- The baseline delivers **10/10** (100% coffee, 87 s, route efficiency 0.93); the seeded random agent **0/10** (**SUPPORTED**). The random agent mostly ends its run by picking "hand control back" (a median of 5.5 requests), so this floor measures how quickly a uniform pick gives up as much as how it drives.

---

## Open

| Question                                                        | Why now (the observation)                                                                                                                                                                                                                                                                              | Cheapest next step                                                                                                                                                   |
| :-------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **How does a person's coffee run compare with the baseline's?** | No human reference run exists; sessions now record route, overshoots and the same windows as agents.                                                                                                                                                                                                   | Play with `?agentHud=1`, **Export trace**, `bun run experiment import coffee-run-human-agent human <file>`. Five people give a first picture.                        |
| **Can Jev decode 420 cold from the driver's seat?**             | `receiver-tune-toward-clue` fails 0/10 in **every** profile, `full` included: Jev always answers `enter_vehicle:uv-1`, the car holding the radio, which is exactly how it played run B before tuning correctly. The probe was captured on foot, so it grades Jev's own successful strategy as failure. | Recapture the probe from inside the vehicle (a baseline variant that tunes from the driver's seat), then re-ask. Do not regrade the existing results.                |
| **Do probes need several situations each?**                     | Every Jev cell was 10/10 or 0/10: repeating one observation measures consistency, not generality.                                                                                                                                                                                                      | Capture K observations per probe from seeded experiment runs (latency varies where the agent stands and what the meters read) and report pass rates over situations. |
| **Would random terminal start sides exercise trend reading?**   | `tuning-trend-reading`: "turn towards the middle" solves every panel, so trend reading only matters after an overshoot.                                                                                                                                                                                | A game change, so it needs a person's view too: does it make the puzzle better for people, or just harder? Try it behind a flag first.                               |
| **Does the exit stop spill go unmeasured?**                     | Before the careful-exit fix, a 7-point spill at the exit stop registered **0** hard-braking events: the metric only samples while `locomotion` is `driving`, and the stop happens while exiting.                                                                                                       | Count longitudinal deceleration through `exiting_vehicle` too, and check against the spill events.                                                                   |
| **Does co-pilot beat autonomous mode on the terminals?**        | Co-pilot exists and is traced, but every run so far is autonomous.                                                                                                                                                                                                                                     | Needs people: the same terminal stage in co-pilot vs human-only, measured by tuning inputs, overshoots and time at panels.                                           |
| **Do reviews ever change Jev's plan?**                          | Run B: 0 of 79. The baseline changes its plan in ~6 of 152 requests (always to get out near the destination).                                                                                                                                                                                          | Count `routeReviewsChanged` over ≥ 5 live journeys (the NEXT_MODEL tripwire). Comes free with any live journey experiment.                                           |
| **Does a stronger model need fewer assists?**                   | The ablations can now run per assist in minutes.                                                                                                                                                                                                                                                       | When a second model exists: the same probe matrix and `--only` ablations, side by side.                                                                              |

## Blocked

- **Several intents per call**, **screenshots instead of text**: their NEXT_MODEL tripwires (every probe ≥ 95% at `lean`; text probes ≥ 95% at `none`) are far from met: `hold_still_rule` fails without help.
