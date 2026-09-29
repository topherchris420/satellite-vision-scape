# Experiments

Questions about behaviour in Satellite Vision Scape, put into the world and measured. Method: [docs/EXPERIMENTS.md](../docs/EXPERIMENTS.md). Decisions and open questions: [HYPOTHESES.md](HYPOTHESES.md).

```sh
bun run experiment list          # every definition and whether it has been run
bun run experiment <id>          # run it, then write results/<id>/report.md
bun run experiment report <id>   # re-measure the traces and rewrite the report
```

| Experiment                                                                       | Question                                                                          | Provider                    | Status                             |
| :------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------- | :-------------------------- | :--------------------------------- |
| [`tuning-control-magnitude`](results/tuning-control-magnitude/report.md)         | Is a control bigger than the target zone enough to reproduce run A's oscillation? | baseline                    | run                                |
| [`tuning-trend-reading`](results/tuning-trend-reading/report.md)                 | What does tuning charge an agent that cannot read the match trend?                | baseline                    | run                                |
| [`decision-latency`](results/decision-latency/report.md)                         | Does decision latency change what happens, or only how long it takes?             | baseline                    | run                                |
| [`travel-review-interval`](results/travel-review-interval/report.md)             | Are 3-second route reviews paying for anything?                                   | baseline                    | run                                |
| [`coffee-run-human-agent`](results/coffee-run-human-agent/report.md)             | A person, the baseline and the chance floor on the coffee run                     | baseline, random, **human** | run; awaiting human runs           |
| [`semantic-bearings-navigation`](results/semantic-bearings-navigation/report.md) | Does removing semantic bearings make Jev's navigation worse?                      | **Jev (live)**              | run                                |
| [`assist-profiles-journey`](definitions/assist-profiles-journey.json)            | Can Jev complete After Hours on the lean question?                                | **Jev (live)**              | not run: the probes already say no |

```text
definitions/<id>.json                 hypothesis, design, predictions (svs-experiment/v1)
results/<id>/result.json              every run, its seed, status and trace link, plus provenance
results/<id>/runs/*.trace.json.gz     the raw evidence, one svs-agent-trace/v1 per run
results/<id>/report.md, summary.json  rebuilt from those traces
archive/<date>-<commit>-<id>/         earlier results kept for before/after comparisons
lib/                                  the code (Node-side, never bundled for the browser)
```
