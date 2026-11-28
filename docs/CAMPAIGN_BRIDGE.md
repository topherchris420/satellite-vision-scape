# 99.9% SURE — Campaign bridge

## Browser handoff

1. Open **Daily Bread** from the San Fierro city case. Follow the delivery and file both findings at the lab.
2. Select **Continue to Pine Gap briefing** from the filed report. With a report saved on this browser and site, the Pine Gap landing also offers **Open Daily Bread field briefing**.
3. Ines reads both judgments as filed and relates them to the new signal investigation. **Go and look** starts or resumes the Pine Gap case using its own progress.

The briefing reads the version 1 Daily Bread record under `99sure.city.bakery.v1`. An incomplete, malformed or unknown-version record leads to the ordinary Pine Gap landing. Opening the relay is read-only. Entering the field case records discovery as usual and resumes any existing field progress. The city findings carry no field evidence, case completion or After Hours reward. Players can explore Pine Gap independently and discover the original signal through the survey.

The earlier three-observation San Fierro case remains available and uses its own `99sure.browser.campaign.v1` record.

## Narrative continuity

Chapter I (San Fierro) introduces CERTAIN, competing explanations, R.A.I.N. and the cost of mistaking confidence for evidence. After The Open Experiment, a fictional follow-up investigation takes the player to Pine Gap (Chapter II), where an anomalous signal must be independently characterized. Existing After Hours signal tuning is the starting gameplay substrate; its current objectives remain playable independently. Race Jev and Free Roam remain optional experiments rather than required narrative gates.

All events and research tasks in the campaign are fictional. The exterior reference does not represent current operations, access or real-world investigative procedures.

## Proposed CLEO save import

The native San Fierro campaign uses CLEO 5 and a separately installed PC game; Pine Gap uses the browser-based Satellite Vision Scape engine. Do not attempt to transfer engine snapshots, positions, credentials or game assets between them.

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

### Native delivery sequence

1. Present the shared game title and a chapter entry point, retaining the existing browser experiences.
2. Export a versioned dossier from the local San Fierro save at a safe checkpoint; use the existing slot-specific progression, without changing game saves.
3. Validate and preview the dossier in the browser before explicit import. Keep campaign state separate from existing After Hours saves.
4. Add a R.A.I.N. briefing and adapt the existing signal investigation to react to imported conclusions; retain an independent starting option.
5. Export a Pine Gap conclusion dossier for optional return to the lab, with an explicit import confirmation.

### Native acceptance

- Existing San Fierro mission endings, browser modes and saved progress still work.
- Valid handoffs preserve supported decisions; malformed, incomplete and unknown-version files fail safely.
- Repeated imports do not duplicate progress or mutate unrelated saves.
- A full San Fierro-to-Pine Gap playtest in the real host game and browser is recorded before claiming seamless campaign continuity.
- Capture genuine gameplay screenshots for both chapters and label any headless previews separately.
