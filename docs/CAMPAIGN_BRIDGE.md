# 99.9% SURE — Campaign bridge

## San Fierro campaign

Start at **Play Christopher's San Fierro story** on the San Fierro chapter menu or open `/?chapter=san-fierro&story=full`. The browser adaptation uses the original Harbor District, the shared driving and collision systems, and Christopher's existing rig. The lab, the rooftop relay, the broadcast and the pier are fictional places. The story is captioned and uses the browser's original radio cues.

| Episode | Checkpoints and decisions |
| --- | --- |
| **99.9% SURE** | Drive clear of patrol, review Christopher's alert, frame the courtyard class, file Daily Bread, log three stationary readings, escort the family, correct the public claims and return to HQ. Claim IDs 0-9 retain their first answers. Teaching corrections do not change the score. |
| **Ghost Frequency** | Compare wagon bearings and handheld sweeps, follow the technician, take the relay and choose early publication or a timed lab verification. A late return records a wiped buffer. |
| **False Positive** | Visit Marisol, Dex and Ray in any order. Observe the case and witness, follow the courier and read the manifest, or document the car-door incident and corroboration. One detention stays on file. Two reset the current triage leg from the last saved decision. |
| **Everything Is Connected** | Collect four observations, classify four links and join the broadcast. Calling ice cream a cause triggers the protest pursuit. Other answers allow the quiet return. |
| **The Open Experiment** | Deliver three independent kits. Rough impacts can break the kits still aboard. Recover the fuse or use the wagon battery, grade the independent returns and answer Bracket's private fee offer. |

The HQ opens eight R.A.I.N. assignments in story order. Duplicate sources and weak observations alter the visible hypothesis scores. A careful ruling stands. A retracted, sloppy or cautious ruling can be reopened. The cymatics rig logs six modes and a generator-off control. The lab carries forward the last publication, research reputation and grants. A revised ruling can earn the remaining grant up to the award for a careful ruling.

The full story requires writable browser storage. If a checkpoint write fails during play, the handoff stays on the current page; allow site storage and retry without reloading. The campaign uses `99sure.city.campaign.v1`. A checkpoint keeps filed choices, field observations, and the last recorded triage clocks. An unfinished drive or observation restarts from the relevant marker. Daily Bread retains its existing record. A previously filed delivery counts once toward the city campaign.

After filing **The Open Experiment**, select **Continue to Pine Gap** at HQ. The receiving briefing shows the actual delivery verdicts, relay and triage outcomes, broadcast classification, independent results, power and fee choice, and HQ research. **Go and look** starts or resumes the field investigation with its own evidence and history.

The browser adaptations use the story beats and stable claim/assignment IDs from the repository's mission design and story documents. Physical routes, timing, caption wording and the exterior lab were authored for the browser district.

### Browser playtest

Run `scripts/playtest-city-story.mjs` with `CITY_BREAD_STATE=1` and `CITY_OUT` to save the isolated test browser state after filing Daily Bread. Run `scripts/playtest-san-fierro-campaign.mjs` against the same local development origin with `CITY_BREAD_SAVE` pointing to that state and `CITY_INPUT` set to `desktop` or `touch`. Its dossier state feeds `scripts/playtest-field-campaign.mjs` through `PINE_STORAGE_STATE` and the same origin. Pass `--phone` for touch. The scripts shorten long journeys between marked locations through development handles and exercise the field interactions with keyboard or touch controls.

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
