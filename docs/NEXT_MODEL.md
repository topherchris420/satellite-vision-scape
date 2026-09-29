# Built for the next model, measured on this one

> **Ship the question today's model needs. Keep the question next quarter's model should need ready, and let measurements decide when to switch.**

Products built on agents age with the model underneath them. If you build around today's weaknesses, the product is stale by the next release. If you build for a model nobody has yet, it is broken today. This document is how Satellite Vision Scape avoids both mistakes. We do it with three instruments you can run, and a ledger of what they said.

- **Assists.** Every word the server adds to cover for today's model is a named, switchable assist. Each one records the failure that justified it and the probes that can retire it.
- **Probes.** Single decisions from real gameplay, where any player would agree on the answer. We ask them again and again and grade each answer against the chance floor. They cost cents and minutes, not a 7-minute run.
- **Tripwires.** Bigger bets we have deliberately not built yet. Each one names the number that would trigger it.

Nothing here is a forecast. Each line is either a measurement or a rule that says which measurement would change the plan.

---

## 1. The upgrade we already lived through

The last model upgrade came from the shape of the question, not from new model weights:

| Run   | Question                                                                                                                                                | Result                                                                                                                                              |
| :---- | :------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | Terminal meters as facts (match %, lock %, status word)                                                                                                 | Coffee delivered, 420 found, then **473 decisions** alternating dial up / dial down at the Harmony terminal. Stopped by hand.                       |
| **B** | Plus: what the last turn did ("raised the match: the reference lies further up"), "keep still (Wait) and it locks", how far each control moves the dial | **Complete** in 7 min 38 s: 212 decisions, 100% coffee, 0 collisions, 0 interventions. Each terminal settled in 5 turns and locked on a Wait (4/4). |

Run B's fix gave Jev no new facts. It spelled out conclusions a player draws by watching the meters. That help is real, but it is also a bet on today's model. The next model should draw those conclusions itself, and until then every extra word costs bytes on every call. It also hides whether the model has improved. So each conclusion is now an assist ([`src/server/agent/assists.ts`](../src/server/agent/assists.ts)):

| Assist               | What it adds                                                                             | Why it exists                                                                              | Probes that retire it                                                |
| :------------------- | :--------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- | :------------------------------------------------------------------- |
| `trend_inference`    | "Turning up raised the match: the reference lies further up" · "you turned past it"      | Run A: 473 decisions oscillating; the trend was in `state`, not acted on                   | `terminal-reverse-after-overshoot`, `terminal-continue-while-rising` |
| `hold_still_rule`    | "Keep the dial completely still (Wait) and it locks", on terminals and the receiver hold | Run A: kept turning at ALIGNED. With it, targeted checks chose Wait 4/4                    | `terminal-hold-when-aligned`, `receiver-hold-signal`                 |
| `control_magnitudes` | A click ≈ 1%, a short hold ≈ 5%, a long hold ≈ 20%                                       | Run A: a short hold was wider than the aligned zone, so every correction overshot          | `terminal-reverse-after-overshoot`, `receiver-tune-toward-clue`      |
| `spill_advice`       | "Braking hard, launching, sharp cornering and collisions spill it"                       | Precautionary: added before any failure was seen, and the executor already drives smoothly | `coffee-deliver-while-driving`                                       |
| `semantic_bearings`  | "ahead and to the left" instead of `at bearing −40°`                                     | TypeSafe guidance: Jev reads words better than numbers                                     | `coffee-deliver-while-driving`, `terminal-go-to-terminal`            |

Assists are grouped into three profiles, set per deployment with `JEV_ASSISTS` (server-only, not secret):

| Profile          | What Jev is told                                                                              | Role                                                                                                             | Mean question size\* |
| :--------------- | :-------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- | -------------------: |
| `full` (default) | Everything above. **Byte-identical** to run B's question (checked over 155 real observations) | What today's model needs                                                                                         |              4,917 B |
| `lean`           | Facts, not conclusions: the screen, how the controls feel, directions in words. No coaching   | **The bet**: what the next model should manage with                                                              |      4,638 B (−5.7%) |
| `none`           | Raw facts, numbers in degrees                                                                 | Ceiling probe, never shipped: it shows how far the frontier is, so `lean` is neither too timid nor too far ahead |      4,432 B (−9.9%) |

<sub>\* JSON bytes of the TypeSafe request, averaged over the 155 observations of one headless baseline journey on this build.</sub>

Two rules keep this honest. First, **an assist only states a conclusion**: switching one off never removes a fact the player has on screen (a test checks this). Second, **an assist is retired only on evidence**: never because a model "should" manage.

## 2. Probes: ten decisions the whole mission depends on

[`evals/after-hours-probes.json`](../evals/after-hours-probes.json) holds ten observations captured from the real game by `bun run probes:capture`. It is deterministic: the same build captures byte-identical observations. The scripted baseline walks into nine of the situations. It tunes too cleanly ever to overshoot, so a heavy-handed variant (always a long hold, run A's habit) produces the tenth. The observation is always the game's own. Grading rules live in [`src/agent/probes/afterHours.ts`](../src/agent/probes/afterHours.ts) and read only the observation, like a provider.

| Probe                              | The situation                                   | Passes                  | Chance | Per run† |
| :--------------------------------- | :---------------------------------------------- | :---------------------- | -----: | -------: |
| `coffee-go-to-cart`                | Start of the night, briefing on screen          | Walk to the cart        |     6% |        4 |
| `coffee-deliver-while-driving`     | Coffee aboard, 16 options                       | Drive to the technician |     6% |       17 |
| `receiver-tune-toward-clue`        | "Four. Two. Zero." heard, dial at 318           | Tune up (any amount)    |    17% |        2 |
| `receiver-hold-signal`             | Hold bar filling at 8%                          | Wait                    |     6% |        2 |
| `terminal-go-to-terminal`          | Four signals revealed, none tuned               | Go to any terminal      |    19% |        1 |
| `terminal-open-when-prompted`      | "E · Tune the harmony terminal"                 | Use it                  |     5% |        4 |
| `terminal-hold-when-aligned`       | ALIGNED, lock meter 16%, last turn raised match | Wait                    |    11% |        4 |
| `terminal-reverse-after-overshoot` | Long hold up took the match 86% → 25%           | Turn down (any amount)  |    33% |       0‡ |
| `terminal-continue-while-rising`   | Long hold up took the match 0% → 54%            | Turn up again           |    33% |       12 |
| `concert-start-when-prompted`      | At the listening point                          | Begin the transmission  |     5% |        1 |

<sub>† How often the situation came up in one baseline journey: the weight a failure there carries. ‡ The baseline never overshoots; run A's Jev did, hundreds of times.</sub>

**Chance** is what a uniform random pick scores. We measured it over 1,000 seeded trials per probe (`evals/results/2026-09-27-random.json`), and all ten analytic floors fall inside the measured 95% intervals. A pass rate only means something next to it.

**The scripted baseline, asked each probe cold, passes 9/10** (`evals/results/2026-09-27-baseline.json`). It fails `terminal-continue-while-rising` because it steers the dial from its own memory of earlier calls, not from the observation's `previousOutcome`, and a cold probe has no such memory. That is an honest limit of single-decision probes: they measure what can be concluded from one observation, which is exactly what the assists cover.

### Running them against a model

```sh
bun run probes -- --provider random --repeats 1000    # the chance floor (free)
bun run probes -- --provider baseline --repeats 1     # the scripted reference (free)

# Billable, opt-in, never in CI: Jev through the real handler and JevProvider, in process.
AGENT_LIVE_TEST=1 TYPESAFE_API_KEY=… bun run probes -- --provider jev --profiles full,lean,none --repeats 10   # 300 calls, ~3 min
AGENT_LIVE_TEST=1 TYPESAFE_API_KEY=… bun run probes -- --provider jev --ablate --repeats 10                  # full and full-minus-each: 600 calls
```

Each run writes `evals/results/<date>-<provider>[-<model>].json` with tallies, Wilson 95% intervals, the answer distribution per cell and a verdict per assist. It also prints a Markdown table for the ledger below.

### The retirement rule

For each assist, `retirementVerdict` compares its probes with and without it, on one model:

- at least **10 trials** per probe per profile, or the verdict is `insufficient_data`;
- without the assist, the **Wilson 95% lower bound ≥ 0.80** on every one of its probes;
- and no probe drops by **more than 5 points** compared with the assist on.

Then, and only then, `retire`. 19/20 is not enough: its lower bound is 0.76. 20/20 is (0.84). The single-factor ablation (`--ablate`) is the clean test. Comparing `full` with `lean` drops three assists at once, so a regression there cannot be pinned on one of them.

**Necessary, not sufficient.** Running the matrix taught us the rule's blind spot: each probe is _one_ captured observation, and Jev answers the same observation the same way nearly every time (every cell of the first matrix was 10/10 or 0/10). Twenty trials of one situation measure consistency, not generality; they are not twenty independent situations, whatever the Wilson bound assumes. So a `retire` on the probes makes an assist _eligible_; it is removed from the default question only when an in-flow experiment agrees ([docs/EXPERIMENTS.md §8](EXPERIMENTS.md#8-assists-are-hypotheses)). Each assist's spec now names the capability it `covers` and the `experiments` that measure it. Single-factor ablations are cheap with `--only`: `--profiles full,full-semantic_bearings --only coffee-deliver-while-driving,terminal-go-to-terminal --repeats 20` is 80 calls.

## 3. What a trace says we are paying for

The committed run B trace ([`docs/traces/jev-after-hours-live-2026-09-27.json`](traces/jev-after-hours-live-2026-09-27.json)) accounts for every call:

| Of Jev's 212 decisions                             |        Count | What it tells us                                                                                                                            |
| :------------------------------------------------- | -----------: | :------------------------------------------------------------------------------------------------------------------------------------------ |
| Mid-route reviews that confirmed the current route |     79 (37%) | **0 of 79 changed the plan.** The 3 s travel review is paying for a failure it has not yet caught                                           |
| Wait during the concert stage                      |     49 (23%) | Paid calls with nothing to decide                                                                                                           |
| Decisions below 0.6 confidence                     |     80 (38%) | Where the frontier is: **26 of the 40 dial turns** (receiver and terminals), and 36 in the concert stage, where there was nothing to decide |
| Latency, median / p95                              | 289 / 397 ms | Far inside the loop's 6 s timeout. Speed is not today's constraint; judgement on the dials is                                               |

**Fixed in this change: no model calls for non-decisions.** On the current build, the same pattern reproduces with the scripted baseline. While the midnight transmission played, vehicle navigation was still offered, so the runtime asked for a decision **57 times out of 212, and every answer was Wait**. A task can now say it is playing itself out (`TaskAdapter.passive()`), and the environment then offers only waiting, which the runtime already handles without a call. Same journey, same world:

| Scripted baseline, full journey |  Before |          After |
| :------------------------------ | ------: | -------------: |
| Provider calls                  |     212 | **155 (−27%)** |
| Calls while the concert plays   |      57 |          **0** |
| Mission time                    | 411.9 s |        411.9 s |
| Coffee delivered · collisions   | 93% · 0 |        93% · 0 |

At run B's 289 ms median, that is about 16 s of model time and over a quarter of the calls per run. As models get stronger and more expensive per call, not asking gets worth more.

## 4. Tripwires: bets we have not placed, and what would place them

| Bet                                         | Why not yet                                                                                                                                                                                                                           | Build it when                                                                                                                                                 |
| :------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Make `lean` the default**                 | Measured 2026-09-29: without `hold_still_rule` Jev fails both hold probes 0/10                                                                                                                                                        | Every assist `lean` drops gets `retire` on the production model, **and** one full `lean` journey matches run B (complete, 0 collisions, ≤ 1.2× its decisions) |
| **Stretch the 3 s travel review to 6 s**    | One run is an existence proof, not a rate. The price is now measured (baseline, 10 paired runs): 6 s saves 32 requests and costs ~6 s per journey ([travel-review-interval](../experiments/results/travel-review-interval/report.md)) | Across ≥ 5 live runs, reviews change the plan < 1% of the time (run B: 0/79). That would save about 40 of run B's 212 calls                                   |
| **Several intents per call** (a short plan) | Needs every single step to be reliable first; a wrong plan costs more than a wrong step                                                                                                                                               | Every probe ≥ 95% at `lean`, and reviews change the plan < 1%                                                                                                 |
| **Screenshots instead of text state**       | Perception would confound reasoning; we could no longer tell which one failed                                                                                                                                                         | Text probes ≥ 95% at `none`: the remaining gap would then be perception, and worth measuring                                                                  |
| **A second model provider**                 | Nothing blocks it: the contract is provider-neutral and the probes compare like for like from day one                                                                                                                                 | When there is a second model worth comparing. Cost: one `AgentProvider` and a server adapter                                                                  |
| **Coordinates or exact dial values**        | **Never.** A design boundary, not a capability gap: an agent gets the same controls as a person                                                                                                                                       | —                                                                                                                                                             |

## 5. What we did not do

We did not delete run B's hints because a newer model "probably" doesn't need them. We did not make `lean` the default. We did not write prompts for hypothetical models, or add intents no model has asked for. The live probe matrix for Jev was first run on 2026-09-29 (below). We did not retire the three assists that passed 20/20 without help on the probes: see the caution in §2.

## 6. Ledger

Append one row per probe run, newest first. Results live in [`evals/results/`](../evals/results/).

| Date       | Provider · model   | Profile                                     | Probes passed      | Notes                                                                                                                                                                                                                                                                                                                                        |
| :--------- | :----------------- | :------------------------------------------ | :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-29 | Jev (`jev-1.13.0`) | full vs full-minus-one, 20 trials           | 20 / 20 each       | Single-factor ablations: `trend_inference`, `spill_advice`, `semantic_bearings` each meet the retirement rule on the probes (eligible, not retired: §2)                                                                                                                                                                                      |
| 2026-09-29 | Jev (`jev-1.13.0`) | full · lean · none · full-semantic_bearings | 9 · 7 · 7 · 9 / 10 | 10 trials per cell, 400 calls, every cell 10/10 or 0/10. `hold_still_rule` needed (hold probes 0/10 without it). `receiver-tune-toward-clue` 0/10 in every profile: Jev answers `enter_vehicle:uv-1`, as it played run B before tuning correctly from the driver's seat; a probe-validity question ([backlog](../experiments/HYPOTHESES.md)) |
| 2026-09-27 | scripted baseline  | n/a                                         | 9 / 10             | Cold; misses `terminal-continue-while-rising` (steers from memory)                                                                                                                                                                                                                                                                           |
| 2026-09-27 | random, seeded     | n/a                                         | 5–34% each         | 1,000 trials per probe; matches the analytic chance floor                                                                                                                                                                                                                                                                                    |
