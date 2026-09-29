# Experiments

> **Build hypotheses quickly. Put them into the world. Measure what actually happens. Let the evidence decide what gets improved next.**

The agent runtime already keeps one promise: _the agent decides what it wants to do; Satellite Vision Scape decides whether it succeeds._ This document is about the second promise: a question about behaviour ("does X make agents worse?") should turn into runs, traces, measurements and a comparison with almost no ceremony, and the answer should be allowed to be _no_.

```text
question → hypothesis → definition → paired runs → one trace per run → metrics read from the traces
        → comparison + a verdict by fixed rules → the next hypothesis
```

Nothing here is a new metric system. Every number is read from the `svs-agent-trace/v1` traces and `svs-agent-evaluation/v1` blocks the runtime already records, and every report is rebuilt from the trace files each time it is written.

---

## 1. Five commands

```sh
bun run experiment list                       # every experiment, its question and whether it has been run
bun run experiment tuning-control-magnitude   # run one (free conditions), write report.md + summary.json
bun run trace <trace.json[.gz]>               # what happened in one run, and a diagnosis
bun run compare <trace|result-dir>...         # side by side: people and agents, or before and after
bun run probes -- --provider baseline         # single-decision capability probes (see NEXT_MODEL.md)
```

Useful flags: `--runs 3` (a quick look; the result is marked **partial**), `--only a,b` (some conditions), `--out <dir>` (keep a result somewhere else, e.g. a before/after snapshot), `report <id>` (re-measure the traces and rewrite the report), `check <id>` (validate without running), `import <id> <condition> <trace.json>` (add a person's run). Re-running an experiment replaces its previous result (imported human runs are kept); git keeps the history, and `--out` keeps a snapshot beside it.

Live, billable providers are opt-in three times over: the definition says `"live": true`, the command says `--live`, and the environment has `AGENT_LIVE_TEST=1` plus a server-side `TYPESAFE_API_KEY`. Without all three a billable condition refuses to run and the error names the free conditions you can run instead. CI never has them, and a test fails if any experiment test makes a network call.

## 2. A definition

`experiments/definitions/<id>.json`, schema `svs-experiment/v1`, validated by [`experiments/lib/definition.ts`](../experiments/lib/definition.ts):

```jsonc
{
  "schema": "svs-experiment/v1",
  "id": "tuning-control-magnitude",
  "title": "Is a control bigger than the target zone enough to reproduce run A's oscillation?",
  "question": "…as someone would ask it…",
  "hypothesis": "We believe changing X will alter Y, because …",
  "motivation": { "observation": "what we saw", "evidence": ["file or trace + where"] },
  "environment": "pine-gap",
  "task": "after-hours",
  "episode": { "until": "terminals_completed", "maxSimSeconds": 600 },
  "independentVariable": "tuningAmount",
  "controlled": { "provider": "baseline", "tuningDirection": "trend", "latency": "run-b" },
  "conditions": [
    { "id": "graded", "label": "…", "set": { "tuningAmount": "graded" } },
    { "id": "long", "label": "…", "set": { "tuningAmount": "long" } },
  ],
  "runsPerCondition": 10,
  "seed": 1,
  "dependentMetrics": ["completed", "terminalOvershoots", "terminalTuningInputs"],
  "predictions": [
    {
      "metric": "terminalOvershoots",
      "from": "graded",
      "to": "long",
      "direction": "increase",
      "minEffect": 10,
    },
  ],
  "falsificationCriteria": ["long overshoots fewer than 10 more times than graded"],
  "limitations": ["…"],
}
```

**Validation is strict on purpose**, because a malformed experiment produces numbers that look like evidence:

- **One independent variable.** A condition may set the independent variable and nothing else; everything else lives in `controlled`. A condition cannot be confounded by construction.
- **Every setting must mean something for its provider.** `assists` only changes Jev's server-side question; on the scripted baseline it is rejected, because the baseline never reads the question and the "experiment" would compare two identical things.
- **Assist names are parsed strictly.** In a deployment a typo in `JEV_ASSISTS` falls back to `full`; in an experiment it is an error, so a condition can never silently become a different one.
- **Predictions need a stated way to be wrong** (`falsificationCriteria`), a known metric and two known conditions.
- **Billable providers need `"live": true`.**

### The knobs

| Variable          | Applies to            | Values                                                                                      |
| :---------------- | :-------------------- | :------------------------------------------------------------------------------------------ |
| `provider`        | all                   | `baseline` (scripted), `random` (seeded), `jev` (live), `human` (imported)                  |
| `latency`         | baseline, random      | `instant`, `run-b` (resampled from run B's 213 recorded latencies), `run-b-xK`              |
| `reviewMs`        | baseline, random, jev | how often a travel intent is re-asked (product default 3000)                                |
| `tuningAmount`    | baseline              | `graded`, or always `tap` / `short` / `long`                                                |
| `tuningDirection` | baseline              | `trend`, `sweep` (cannot read the trend), `blind` (cannot read the trend, always starts up) |
| `assists`         | jev                   | `full`, `lean`, `none`, `full-<assist>` (single-factor ablation) or a list of assist ids    |

Adding a knob means adding it to `VARIABLES` in `definition.ts` and to `buildProvider` / `runEpisode` in `runner.ts`. Knobs never give an agent more authority: they change the policy, the question, the latency or the review cadence, never what the world lets anyone do.

### Episodes

`until` names the world event that ends a run: `coffee_delivered`, `receiver_locked`, `terminals_completed` or `task_complete`. A run also ends when the agent hands control back, when it runs out of simulated time (`maxSimSeconds`) or, for live providers, requests (`maxCallsPerRun`). How it ended is recorded per run.

## 3. Runs, seeds and determinism

Run _i_ of **every** condition uses seed `seed + i`, so conditions are compared pair by pair on the same random numbers (the random agent's picks, the latency draws). The simulation is deterministic for a given sequence of inputs (`Math.random` only feeds visual dust), so:

- a condition with no stochastic source (the baseline at `instant` latency) repeats **exactly**. Its extra runs are copies, and the report checks that they are identical ("reproduced: yes");
- a condition with a stochastic source (seeded latency, the random agent, a live model, a person) gives genuinely different runs.

Local providers' latency is measured on the **simulation** clock: it is how long the world waited for the answer, which is `0` for a scripted policy at `instant` and the drawn delay otherwise. (Measuring the CPU time of a script made deterministic conditions look noisy; a test caught it.) Live providers are paced to the wall clock, like a browser.

## 4. Metrics: shared or agent only

[`experiments/lib/metrics.ts`](../experiments/lib/metrics.ts) names every metric, where it comes from, and **who it can be measured for**:

- **Shared**: measured from the world or from the input gameplay read, identically for a person and an agent: completion (the goal's world event), time to goal, distances, collisions, hard braking and acceleration, coffee retained, coffee run distance and route efficiency (from route samples), receiver and terminal tuning inputs, **terminal overshoots** (the panel read ALIGNED, then stopped reading it without locking), time at terminal panels, terminals locked.
- **Agent only**: exists because a runtime decided or an executor drove: provider requests, decisions, decision latency p50/p95, provider failures, stale answers, rejected decisions, route reviews kept or changed, wait decisions, stuck recoveries, presses checked for effect, human interventions, decided direction reversals.

For a person an agent-only metric is **n/a, not zero**, and reports and comparisons print it that way. A metric a trace cannot support (an old trace without route samples) reads **missing**, never zero.

## 5. Evidence: the aggregate never outranks the runs

```text
experiments/results/<id>/
├── result.json          every run: condition, index, seed, status, how it ended, trace file + sha256 + session id; provenance
├── runs/<run>.trace.json.gz   the raw evidence (svs-agent-trace/v1, ~16 KB each)
├── summary.json         aggregates and verdicts, recomputed from the traces
└── report.md            the same, for people
```

`bun run experiment report <id>` re-reads every trace, checks it against its recorded hash and measures it again. A missing trace, a trace that no longer matches its hash, a run that crashed, or a provider that never answered (an outage, not behaviour) is **excluded and listed with its reason, never averaged**. A statistic can always be followed down: report → run id → trace file → `bun run trace <file> --decisions a-b` → the individual decisions and outcomes.

**Provenance** (in `result.json` and the report): commit, branch and whether code (`src/`, `scripts/`, lockfile) had uncommitted changes; Bun version and platform; trace, observation, action, evaluation and experiment schema versions; the definition's path and hash (and a snapshot of it); the latency source and its hash; models reported by the provider; start and finish times; the exact command. Prompts, credentials and provider reasoning are never recorded.

## 6. Verdicts

Measurements come first; a verdict is optional and mechanical. For each prediction ([`aggregate.ts`](../experiments/lib/aggregate.ts)):

| Label             | When                                                                                                                                                                                                                                                                     |
| :---------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SUPPORTED**     | `increase`/`decrease`: the median paired change is at least `minEffect` in the predicted direction **and** an exact one-sided sign test on the pairs gives p < 0.05. `no_change`: the median \|change\| is within `minEffect` and at most a fifth of pairs move further. |
| **NOT SUPPORTED** | `increase`/`decrease`: the median paired change falls short of `minEffect` in the predicted direction (no change, or the other way). `no_change`: the median \|change\| exceeds `minEffect` and a two-sided sign test gives p < 0.05.                                    |
| **INCONCLUSIVE**  | fewer complete pairs than `minRunsForVerdict` (default 5), or the median meets the threshold but the pairs disagree.                                                                                                                                                     |
| **NO VERDICT**    | a condition's runs are unpaired (a person's): measurements only.                                                                                                                                                                                                         |

Two deterministic conditions give one exact difference; it is judged against `minEffect` alone and flagged **exact**: it describes this build, not a distribution. No model is ever asked whether an experiment "worked".

**Evidence levels.** Every report separates what was _built_ (the definition validates), _ran_ (runs recorded), _observed_ (measured from verified traces), _reproduced_ (deterministic conditions identical across runs, or enough seeded replicates) and _established_, which the tool never claims: that would take the result holding on another build, on other days and, for a model, on other model versions.

## 7. From a failed trace to the next experiment

Run A's oscillation is the model: a failure became visible in the decision log, was diagnosed, got a small intervention and was measured again. `bun run trace` makes the first half cheap:

```text
$ bun run trace experiments/results/tuning-control-magnitude/runs/long-01.trace.json.gz
Diagnosis (3 findings):
  [high] oscillation: 317 tune_terminal turns with 157 direction reversals and no lock (seq 66–382, amounts: long)
         look: bun run trace … --decisions 66-382
         next: Is the control step larger than the target zone? Compare always-long turns with graded turns on the same seeds
  [high] stalled: 479.3 s and 329 decisions without task progress …
```

It finds oscillations, stalls (long stretches of decisions without task progress), repeated presses with no effect, stuck or unroutable travel, provider failures and rejected or stale answers, each with the sequence numbers to look at. Then: write the question in [`experiments/HYPOTHESES.md`](../experiments/HYPOTHESES.md), copy the nearest definition, run it. The report's "What the traces show" section runs the same diagnosis over every run of every condition.

**This loop found two bugs on its first day.** `decision-latency` was meant to ask whether a slower model does worse. At run B's latency the scripted baseline finished only 4 of 10 journeys. The diagnosis said _stalled: 1,712 decisions without task progress_; the decisions showed `navigate_to listening_point → arrived`, over and over; the world showed why: the car was parked 4 m away and "Enter vehicle" hid "Begin the midnight transmission". After that fix, 10× latency still finished 5/10: _211 route_blocked in a row_, because the player stood pressed against the car and the planner treated the start itself as blocked. After both fixes: 10/10 at every latency. Both archived results are committed ([`experiments/archive/`](../experiments/archive/)), so the before/after is `bun run compare` away.

## 8. Assists are hypotheses

Every assist in Jev's question ([`src/server/agent/assists.ts`](../src/server/agent/assists.ts)) records why it exists, the capability it covers, the probes and experiments that measure it, and, through `RETIREMENT`, the result that retires it. The ledger of what the measurements said is in [NEXT_MODEL.md](NEXT_MODEL.md#6-ledger).

**A caution about probes, learned from running them.** A probe is one captured observation asked many times. Jev answers the same observation the same way nearly every time (every cell of the first matrix was 10/10 or 0/10), so 20/20 measures _consistency on one situation_, not generality across situations: the trials are not independent draws of situations, whatever the Wilson bound assumes. The retirement rule is therefore necessary, not sufficient. Before an assist is removed from the default question, an in-flow experiment (many situations, as `semantic-bearings-navigation` does for its assist) should agree.

## 9. People

A person's run is recorded in the browser with `?agentHud=1` and **Export trace**, then imported into a `human` condition:

```sh
bun run experiment import coffee-run-human-agent human ~/Downloads/svs-trace-….json
```

The import checks the schema, environment and task, and refuses a trace with agent control in a human condition (or a person's trace in an agent condition). Human runs are unpaired (nobody controls a person's seed), so they get measurements and comparisons, never a verdict. Sessions now record route samples for everyone, so a person's route, distance, collisions, coffee and tuning inputs are measured by the same code as an agent's. Nothing about a person's confidence, intentions or state of mind is inferred.

## 10. Limitations

- **Scripted baselines are policies, not models.** Experiments on the baseline describe what the world does to a policy (and have found real bugs); they say nothing about what a model would do. Model questions need live runs.
- **Paired seeds align the order of live runs, not the model's randomness.** Live verdicts rest on the model's own run-to-run variation.
- **Small samples stay small.** Five paired runs can show a large effect; they cannot rule out a small one. Reports print n beside every number.
- **Client-reported.** Traces are produced by the same client that ran the episode; nothing here is server-attested.
- **One environment, one task.** The metrics registry, the goals and the knobs are After Hours-specific where they have to be.
