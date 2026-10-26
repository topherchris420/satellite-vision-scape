# 99.9% SURE: mission design

An original GTA: San Andreas side mission for CJ and Christopher Woodyard,
founder of Vers3Dynamics. CERTAIN, SureThing Technologies' predictive
policing AI, keeps flagging innocent people with 99.9% confidence. Christopher's
research console R.A.I.N. does the opposite: it weighs independent evidence,
tracks what it does not know, and is allowed to say "I can't tell yet".

The point the mission makes through play, not speeches: an intelligent
system that recognises uncertainty can be more trustworthy than one that
always answers. It never claims that all AI is unsafe; CERTAIN fails because
it is never checked, and R.A.I.N. is an AI tool too.

## Structure

| Act | State (`iState`) | What happens | Player does |
|---|---|---|---|
| I. The Wrong Man | INTRO (2), POLICE_CHASE (3), DRIVE_TO_LAB (4) | A CERTAIN alert flags CJ outside his Doherty garage; a patrol car rolls up; two-star chase. Christopher calls. | Lose the police; answer the call; drive to Vers3Dynamics and walk into the door marker. |
| II. The Scientist | LAB_CUTSCENE (5) | Inside the lab: Christopher, the CERTAIN prediction map, R.A.I.N. explained. | First decision: CJ's own file (must be answered correctly). |
| III. The Resonance Run | INVESTIGATION (6) | Three flagged sites, three ways of collecting evidence. | Photograph a "paramilitary cell" (a tai chi class) from three markers; tail an "explosives van" (a bakery van) 15-60 m back without touching it; park on three measurement points and hold still. Two decisions per site. |
| IV. Confidently Wrong | RESCUE_SEQUENCE (7) | CERTAIN flags a family's minivan in Garcia; police converge. | Reach the minivan before the on-screen police ETA; escort it within 40 m while R.A.I.N. streams independent observations to dispatch; dispatch stands down. No harm to anyone is needed or rewarded. |
| V. The Demonstration | PUBLIC_DEMONSTRATION (8) | SureThing's live demo Downtown; Max Certainty on stage. | Walk up to the stage; three public validations (reject, abstain, accept); the final exchange. |
| VI. The Open-Source Twist | PUBLIC_DEMONSTRATION (8) | Max cuts the feed. Christopher closes his laptop: the logs are already in the open research registry. SFTV news report. | Watch. |
| VII. Mission Passed | FINAL_CUTSCENE (9), SUCCESS (10) | CJ takes Christopher back to the lab; the last talk outside the garage. | Drive back with Christopher. |
| | FAILURE (11), CLEANUP (12) | Failure text, then cleanup. | |

INACTIVE (1) is the launcher's state between runs. The current state,
checkpoint and score are published to CLEO shared variables 950-955 so the
launcher can restart from checkpoints.

## R.A.I.N.: the decision console

The console (`:RAIN_DECIDE`, `:DRAW_CONSOLE` in `src/inc/ui.txt`) shows:
CERTAIN's claim and its claimed confidence; four lines of independent
evidence; meters for signal quality, evidence and uncertainty; the validation
status; and three buttons. Choose with the stick or the left/right keys,
confirm with ENTER/EXIT (or Enter). Everything is drawn with the game's own
script text and rectangle commands, in the Vers3Dynamics teal `#0B5D63`.

- **ACCEPT** when independent evidence supports the claim.
- **REJECT** when the evidence contradicts it.
- **ABSTAIN** when there is not enough evidence to decide.

Scoring: the **first answer to each claim** earns +10 when correct or -5
when wrong (never below 0). Only that answer enters the first-try accuracy
counter. The
four teaching decisions (CJ's file and the three public ones) must be answered
correctly before the story moves on, with Christopher explaining why; the
others count and move on. Corrective retries show `CORRECTED +0` or `RETRY +0`
and do not alter score or accuracy. Maximum evidence score 100 across ten
unique claims. The three decision rules remain visible on the console.

The photography HUD shows capture progress and whether the player needs to
equip the camera, face the group or hold the shot. Shutter input still takes
the photograph immediately; holding the framing for 2.5 seconds also works.
The industrial HUD shows progress during each four-second stationary reading.

| # | Where | CERTAIN claims | Claimed | Evidence | Answer |
|---|---|---|---|---|---|
| 0 | Lab | Carl Johnson: critical threat | 99.9% | one nearby report, "green clothing", garage log puts him on site | REJECT |
| 1 | Site 1 | Paramilitary training cell | 97.2% | 3 consistent photos, mean age 71, no weapons, a tai chi flyer | REJECT |
| 2 | Site 1 | Instructor is a flight risk | 88.0% | one blurred frame, no history, no independent source | ABSTAIN |
| 3 | Site 2 | Van transporting explosives | 99.1% | flour, sugar and yeast; oven-warm cargo; bakery route | REJECT |
| 4 | Site 2 | Delivery reached the shelter | 61.0% | player follows the route and observes arrival; driver's account matches | ACCEPT |
| 5 | Site 3 | Deliberate signal jamming | 93.4% | 60 Hz hum that falls off like a generator, no modulation | REJECT |
| 6 | Site 3 | Port radar will fail tonight | 70.0% | no radar data, one sample, no mechanism | ABSTAIN |
| 7 | Stage | Row 3, aisle seat: pickpocket | 99.9% | hands in his own pockets, his own wallet, no complaints | REJECT |
| 8 | Stage | Rain at 4:15 PM today | 99.9% | neither system collected weather data; no basis to confirm or rule out rain | ABSTAIN |
| 9 | Stage | Crowd exceeds safe capacity | 76.0% | two independent counts agree, 214 and 211, capacity 150 | ACCEPT |

The last two show the point plainly: CERTAIN is 99.9% sure about something
neither system has measured, and only 76% sure about something two independent counts
agree on.

The bakery decisions cannot open until the van has reached its destination,
even if the evidence meter filled earlier. The earlier version's fixed speed
readings did not come from the vehicle's actual speed; the supported claim
now depends on an event the player observes.

## Validation affects the rescue

With at least **5 first-try correct answers out of the 7 pre-rescue claims**,
dispatch reviews the log at 340 ms per upload percentage point. Otherwise it
needs 600 ms per point. Christopher explains the difference before the escort
and a help box repeats the rule. This adds roughly 26 seconds of close escort
for a weak log, plus normal frame timing. Both routes remain winnable; neither
requires harming civilians. The upload timer starts after that explanation,
so dialogue time cannot fill the upload meter.

## Rewards

$2,500 plus $25 per evidence point (up to $5,000) and +10 respect, with the
pass card:

> MISSION PASSED! / 99.9% SURE / EXPERIMENT VALIDATED / RESEARCH PUBLISHED /
> INTELLIGENCE WITH RESTRAINT.

The money is deliberately modest: this is not a mission about getting rich.

## Failure conditions

| Code | Text (FXT) | Condition |
|---|---|---|
| 1 | Christopher was killed. | `hChris` dead at any point he is needed (in a scene or in CJ's group) |
| 2 | The research van was destroyed. | `hVan` wrecked during Act III |
| 3 | You lost the delivery van. | more than 140 m from the bakery van for 9 s |
| 4 | You hit the delivery van. | the van loses more than 40 health, or is wrecked |
| 5 | The police reached the minivan first. | the ETA runs out before CJ is within 28 m |
| 6 | The minivan was destroyed. | |
| 7 | You lost the minivan. | more than 180 m away for 9 s during the escort |
| 8 | You abandoned Christopher. | more than 260 m from him while he should be with CJ (a warning and a blip appear at 90 m) |
| 9 | Max Certainty was hurt. | Max dead during the demo |
| - | Wasted / Busted | the engine's death/arrest check unwinds the script; MISSION FAILED, then cleanup |

## Checkpoints and restarts

The launcher (`src/99sure_launcher.txt`) keeps the last checkpoint in the CLEO
save. After a failure it offers a retry from that checkpoint for 10 seconds
("Conversation - Yes", Y by default, or D-pad right); otherwise walking into
the marker again starts from the checkpoint.

| Checkpoint | Resume objective |
|---|---|
| 1 | Meet Christopher in the lab |
| 2 | Downtown investigation |
| 3 | Easter Basin delivery investigation |
| 4 | Industrial comparison readings |
| 5 | Rescue the family |
| 6 | SureThing demonstration |
| 7 | Return Christopher to the lab |

Later checkpoints stream their district before selecting a road node for
the research van. The lab door is cached while its own path data is loaded.
Christopher and the van are recreated as needed.

The checkpoint saves score and first-try counters **at its start**. A failure
rolls back partial decisions from that checkpoint, so replaying them cannot
duplicate rewards. Shared variables 953-955 hold this boundary snapshot;
the HUD uses live mission locals. After a pass the checkpoint resets and the
mission can be replayed. Updating from the old four-checkpoint launcher starts
a fresh run and recognises/removes its old saved blip.

## Dialogue

217 lines (about 16 minutes), in `dialogue/lines.json`, all subtitled from
`cleo\cleo_text\99sure.fxt`. The 62 lines the brief gives word for word are
kept verbatim and flagged `"exact": true`. A line plays its voice file
`cleo\99sure\audio\V3D<id>.mp3` if present and otherwise shows for an estimated
duration. The speaking character gets facial talk and, on foot, an upper-body
gesture (talk, nod, head shake, think, point, wave, shrug and so on, all stock
animations whose names were checked against the game's animation list).
Driving banter is queued and plays between objectives; cutscene lines wait
for each other. Cutscenes can be skipped with ENTER/EXIT.

Christopher is written to sound conversational, curious and calm, with a dry
sense of humour, explaining ideas in a sentence or two rather than in jargon.

## Cleanup

`:MISSION_CLEANUP` runs after a pass, a failure, Wasted or Busted. It removes
every blip, deletes or releases every character, car and object the mission
made, stops and frees audio streams, unloads the special character, models,
animations and the sprite dictionary, restores roads, the camera, widescreen,
player control, the wanted-level cap and group recruitment, and clears
`$ONMISSION`. The test VM checks all of this at the end of every scenario.

## Files

| Path | Contents |
|---|---|
| `src/99sure.txt` | the mission: start, acts, pass, fail, cleanup |
| `src/inc/*.txt` | variables, configuration, core systems (tick, dialogue, watchdog), UI, one file per act |
| `src/gen/*.txt` | generated: dialogue and claim tables, scene layouts |
| `src/99sure_launcher.txt` | the launcher |
| `src/99sure_debug.txt` | calibration overlay (optional) |
| `dialogue/` | lines, claims, interface text, recording script, audio manifest |
| `data/scenes.json` | prop and extra layouts |
