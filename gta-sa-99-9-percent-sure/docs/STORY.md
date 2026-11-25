# The Vers3Dynamics storyline

99.9% SURE introduces Christopher Woodyard and his lab. The expansion turns
that lab into a place in San Fierro that stays open after the mission, gives
it a research terminal worth coming back to, and continues the story over four
more missions. Every script follows the same rules as mission 1: stock models,
stock animations, original text, sound and sprites, and nothing written to
the game's own save.

| # | Mission | Script | What you do | Its own idea |
|---|---|---|---|---|
| 1 | **99.9% SURE** | `99sure.cm` | Lose the police, meet Christopher, validate CERTAIN's flags at three sites, clear a family's minivan, crash SureThing's demo | Accept, reject, abstain |
| - | **Vers3Dynamics HQ** | `v3dhq.cm` | Free roam inside the lab: research assignments, the cymatics rig, the diagram wall, Christopher's routine and conversations | Weighing evidence well is the game |
| 2 | **Ghost Frequency** | `v3dghost.cm` | Direction-find a mystery signal by ear, reject a loud fake source and an echo, stop a van, choose how to publish | Loud is not the same as the source |
| 3 | **False Positive** | `v3dfalse.cm` | Three people flagged at once, three clocks, two observations each, verdicts before a private team acts | Triage; careful is not "everyone is innocent" |
| 4 | **Everything Is Connected** | `v3dlink.cm` | Gather observations around the city, call four links on a correlation board, debate a radio host live | Cause, common cause, coincidence, can't tell |
| 5 | **The Open Experiment** | `v3dopen.cm` | Deliver replication kits, protect them, catch a saboteur, watch independent replications, face a private offer | A result is real when others can reproduce it |

## The world script

`99sure_launcher.cs` runs all the time. Before mission 1 is passed it shows a
**?** at CJ's garage in Doherty. Afterwards the **?** sits at the lab door down
the street, and walking into it opens the HQ. From inside, Christopher's
mission marker hands over to the launcher (shared variable 959), which starts
the story mission. After any failure the launcher offers a retry from the last
checkpoint, for every mission. When mission 1 is first passed it says so:
"Vers3Dynamics is open".

## The record

Progress is kept in CLEO shared variables, which CLEO writes to its own save
file beside each game save slot and keeps when a script file changes. The
game's save is untouched.

| Var | Name | Contents |
|---|---|---|
| 950-955 | state | mission state, checkpoint, evidence snapshot (as mission 1) |
| 956-957 | blip | the launcher's contact blip and its marker |
| 958 | `SV_MISSION` | which script is running (1-5, 9 the HQ) |
| 959 | `SV_HANDOFF` | the story mission the HQ hands over to |
| 960 | `REC_MAGIC` | 39931 once a record exists |
| 961 | `REC_STORY` | bit n-1: mission n passed; bit 8: the fee refused, bit 9: the fee taken |
| 962 | `REC_CASES` | bit c-1: research assignment c concluded |
| 963 | `REC_VERDICT` | two bits per assignment: 1 accept, 2 reject, 3 abstain |
| 964 | `REC_CAREFUL` | two bits per assignment: 0 too cautious, 1 careful, 2 right but sloppy, 3 retracted |
| 965 | `REC_REP` | research reputation, 0-100 (starts at 50) |
| 966 | `REC_MODES` | bit m-1: cymatics mode m logged |
| 967 | `REC_FLAGS` | news pending (bits 0-1 and 9-12), the atlas, each mission's lasting consequence, the first visit |
| 968 | `REC_AUDIO` | music, ambience, voices, effects: four 4-bit levels, 0-10 |
| 969 | `REC_BEST` | best mission 1 evidence score |
| 970 | `REC_VISITS` | HQ visits |

## The HQ

The lab is the game's "Warehouse 1" interior (18), furnished by script with
stock props: mission 1's workshop plus a diagram wall and the rig's driver
cabinet. More props arrive as the story goes on: the recovered relay, the
SENTINEL audit binders, the correlation screens, the demo rig and a souvenir
barrier, and the cymatics atlas on display once it is complete.

- **Arrival:** a fade, a location card in the game's zone-name style, the room
  tone and the lab score at the player's levels. On the first visit a short
  scene; afterwards one greeting chosen by what has happened since (a
  retraction in the paper, good news, a mission waiting, the open registry).
- **Teal lights** mark the stations; a help line names each one.
- **Christopher** works his way round his stations (desk, oscilloscopes, the
  plate, the diagram wall, the shelves), pushes his glasses up, scratches his
  head over a problem, turns to CJ when he comes close, thinks out loud, and
  has ten conversations for **Y**, some only after the missions they refer to.
  All of it uses stock animations; see [CHARACTER.md](CHARACTER.md) for which.
- **The door** ends the visit. On the way out the paper reports the last
  careful or careless conclusion, once.

### R.A.I.N. research assignments

Eight assignments, unlocked by the story and, for the last, by concluding
five. Each one:

1. **Brief:** a claim and three competing explanations.
2. **Evidence board:** four cards, each with its source. Weigh or set aside.
   R.A.I.N.'s support bars follow what is weighed. Some cards repeat another
   card's source, some are coincidences, some are opinions or marketing.
3. **Experiment:** lab time for one test. One of the two can decide the case;
   the other cannot. The informative one is not always first.
4. **Verdict:** accept, reject or abstain on the claim. R.A.I.N. reads only
   what was weighed: weigh rubbish and it reads rubbish.
5. **Audit:** *careful* (right, clean evidence), *right for the wrong reasons*,
   *retraction* (wrong) or *too cautious* (abstained when the evidence was
   enough). Notes say what went wrong. A grant, reputation, and the news.

Retracted, sloppy and cautious conclusions can be reopened; careful ones stand.
`tools/gen_story.py` checks every assignment so that careful reasoning reaches
its verdict; three of them (the burger, the bridge hum and Chiliad) give the
wrong answer if you weigh everything and skip the test.

| # | Assignment | Truth | The trap |
|---|---|---|---|
| 1 | The Lucky Burger | reject | one caller quoted twice, a casino bulletin with no comparison |
| 2 | Static on Channel 9 | reject | a petition is opinions; the timing matches the neighbour too |
| 3 | Ninety-Nine Point Nine | accept | the TV special is our own log again; the "independent" verifier isn't |
| 4 | The Bridge Hum | accept | a ghost story and a fisherman's bad night outweigh the physics if weighed |
| 5 | Ice Cream and Crime | reject | the same dataset twice; a union press release |
| 6 | The Relay Recording | accept | a radio host decoding by ear |
| 7 | Sentinel's Map | accept | the vans follow the flags, not the other way round |
| 8 | Under Chiliad | abstain | one reading retold on the news; hikers' lights |

### The cymatics rig

A signal generator drives a square plate. Six modes at f = 34 Hz x (m² + n²):
170, 340, 442, 578, 850 and 986 Hz. The building's wiring shakes the plate at
60, 120 and 180 Hz whether the generator is on or not, and 180 Hz sits right
next to the first mode. Logging the hum with the generator on earns a hint;
switching the generator off and logging it again is the control experiment,
and is rewarded. The generator tone follows the dial (one 220 Hz loop played
faster or slower); the plate's ring grows with the response; the sand forms
the mode's pattern only at a real resonance. Six modes complete the atlas:
a grant, reputation, and the atlas on display in the lab.

## Ghost Frequency

A seven-pulse signal on 166.25 MHz, called a ghost by Radio Free Fierro.

- **Receiver HUD:** signal strength, pattern against noise, a sixteen-point
  compass with the bearing lit. The audio mixes an original static loop and
  the signal loop by strength and pattern share.
- **Bearings from the van** at two posts cross at a neon sign in Queens: the
  needle is pinned, but it only buzzes. Verdict: reject.
- **On-foot sweeps** with the handheld: turn until the pattern is clean, then
  hold still. The first points up at the Gant Bridge cables, an echo. Verdict:
  reject. The second, from the Esplanade, finds the source.
- **The relay:** a SureThing technician drives off with it. Stop his van
  without hurting him, then take the relay from the back.
- **The choice:** publish the recording now, or take the relay to the lab
  before it wipes itself (4:00). Verified, published, or wiped: three endings,
  three rewards, and the record remembers which.
- Fails: Christopher dies, the research van is destroyed, Christopher is left
  behind, the technician dies, the relay is destroyed, the van gets away.
- Checkpoints: the posts, the sweeps, the relay, the choice.

## False Positive

SENTINEL, run by Pacific Shield Security, flags three people. When a person's
clock runs out, a private team picks them up.

- **Triage:** three clocks on the HUD, any order; the objective points at the
  most urgent. Two observations each, then a verdict that stops that clock.
- **Marisol** (Garcia): photograph her case, talk to the shopkeeper. Reject.
- **Dex** (Downtown): tail the courier to his drop, close but not crowding,
  then read his manifest. Reject.
- **Ray** (Chinatown): photograph him trying car doors, hear the witness.
  Accept, and the evidence goes to SFPD, not to the private team.
- One person detained is a consequence (reputation, the ending, the record);
  two is a failure. Hurting anyone flagged, or a witness, fails.
- Checkpoints remember who is settled and who was detained.

## Everything Is Connected

Rex Pattern dares the lab to prove him wrong on air.

- **Observations:** a beachfront thermometer (walk up and read it), an ice
  cream queue (photograph it), the police scanner, a lottery board.
- **Correlation board:** four links, each called causes, common cause,
  coincidence or can't tell. Graded live, with a reaction per call.
- **The debate** on Missionary Hill follows the board. Call ice cream a cause
  of crime and Rex broadcasts it; two ice cream vans come after the van, and an
  escape meter shows how long CJ has kept clear. Not a failure: a story.
- Checkpoints include the careless branch.

## The Open Experiment

- **Bracket's visit** in the lab: a quarter of a million for an exclusive
  licence. Christopher says no.
- **Three kits** to a physics teacher, a ham radio club and a science fair
  winner. After the first, Ovid's sedan tails the van; hard knocks crack kits
  (at least one survives). Lose it with the escape meter.
- **The pier:** a deputy commissioner without a sense of humour, then a pulled
  fuse. Catch the saboteur on foot, or run the demo on the van battery.
- **The replication:** one call in per surviving kit. With two or more,
  R.A.I.N. can accept; with one, the careful answer is abstain.
- **The offer:** Bracket offers CJ fifty thousand dollars to talk Christopher
  round. Take it or turn it down; the HQ remembers either way.

## Rewards and reputation

| Mission | Money | Reputation |
|---|---|---|
| 2 | $6,000 verified, $3,500 published, $3,000 wiped, + $25 per evidence point | +8 / +2 / 0 |
| 3 | $4,000 + $1,500 per person filed in time + $25 per point | +3 per filing, -4 per detention |
| 4 | $5,000 + $25 per point | +2 per right link, -3 if the vans came |
| 5 | $8,000 + $1,000 per surviving kit + $25 per point (+ $50,000 if the fee is taken) | +2 per kit, +5 for refusing, +3 for catching the saboteur |
| HQ | $1,500 careful, $600 sloppy, $300 cautious; $250 per mode, $2,000 for the atlas | +6 / +2 / +1 / -5 per conclusion, +5 for the atlas |

Each story mission also awards the game's respect and registers as passed.
