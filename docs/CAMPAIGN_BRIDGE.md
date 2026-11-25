# 99.9% SURE — Campaign bridge

Status: first browser-to-browser prototype implemented on the feature branch; cross-runtime CLEO save import remains proposed.

The browser chapter at `/?chapter=san-fierro` uses original procedural geometry and a three-observation case. It stores evidence and the verdict in a separate versioned local-storage key, `99sure.browser.campaign.v1`. The Pine Gap landing reads that record and displays it as narrative context, without changing After Hours progress. This is not the full San Fierro storyline, nor does the verdict yet change Pine Gap objectives.

## Narrative continuity

Chapter I (San Fierro) introduces CERTAIN, competing explanations, R.A.I.N. and the cost of mistaking confidence for evidence. After The Open Experiment, a fictional follow-up investigation takes the player to Pine Gap (Chapter II), where an anomalous signal must be independently characterized. Existing After Hours signal tuning is the starting gameplay substrate; its current objectives remain playable independently. Race Jev and Free Roam remain optional experiments rather than required narrative gates.

All events and research tasks in the campaign are fictional. The exterior reference does not represent current operations, access or real-world investigative procedures.

## Runtime boundary

San Fierro uses CLEO 5 and a separately installed PC game; Pine Gap uses the browser-based Satellite Vision Scape engine. Do not attempt to transfer engine snapshots, positions, credentials or game assets between them.

Proposed portable, player-controlled JSON handoff (version 1):

```json
{
  "version": 1,
  "source": "san-fierro",
  "completedMissions": [1, 2, 3, 4, 5],
  "conclusions": [],
  "nextChapter": "pine-gap"
}
```

Conclusion IDs and allowed verdicts must be mapped against the existing CLEO save semantics before implementation. An imported dossier is player-supplied narrative context, never independently verified scientific evidence. Reject malformed or unsupported versions; never execute imported content. Do not overwrite existing browser progress or game saves. No network account should be required.

## Delivery sequence

1. Present the shared game title and a chapter entry point, retaining the existing browser experiences.
2. Export a versioned dossier from the local San Fierro save at a safe checkpoint; use the existing slot-specific progression, without changing game saves.
3. Validate and preview the dossier in the browser before explicit import. Keep campaign state separate from existing After Hours saves.
4. Add a R.A.I.N. briefing and adapt the existing signal investigation to react to imported conclusions; retain an independent starting option.
5. Export a Pine Gap conclusion dossier for optional return to the lab, with an explicit import confirmation.

## Acceptance

- Existing San Fierro mission endings, browser modes and saved progress still work.
- Valid handoffs preserve supported decisions; malformed, incomplete and unknown-version files fail safely.
- Repeated imports do not duplicate progress or mutate unrelated saves.
- A full San Fierro-to-Pine Gap playtest in the real host game and browser is recorded before claiming seamless campaign continuity.
- Capture genuine gameplay screenshots for both chapters and label any headless previews separately.
