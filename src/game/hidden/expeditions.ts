/** Fictional portable experiments. Positions are local scene metres, never survey records. */
export interface FieldChoice {
  label: string;
  result: string;
  supported?: boolean;
}
export interface FieldStation {
  id: string;
  place: string;
  x: number;
  z: number;
  prompt: string;
  choices: readonly FieldChoice[];
  optional?: boolean;
  after?: string;
}
export interface Expedition {
  id: string;
  title: string;
  briefing: string;
  stations: readonly FieldStation[];
  question: string;
  verdicts: readonly FieldChoice[];
}

// Each crate is set up on open ground beside an existing fictional field prop.
const west = { place: "West bench", x: -124, z: 43 };
const east = { place: "East bench", x: 56, z: -119 };
const scrub = { place: "Balloon hollow", x: -72, z: -343 };
const camp = { place: "Camp bench", x: -122, z: 166 };
const yard = { place: "Red dust bench", x: -93, z: 121 };
export const EXPEDITIONS: readonly Expedition[] = [
  {
    id: "ghost",
    title: "Ghost Frequency",
    briefing:
      "Seven ticks on a clock radio. Rex Pattern calls it a voice. Ines packed a second receiver and a lamp that makes a convincing ghost of its own.",
    stations: [
      {
        ...west,
        id: "lamp",
        prompt: "A work lamp buzzes over the tape. Which trace will you keep?",
        choices: [
          {
            label: "Cut power to the lamp",
            result: "The buzz dies. Seven faint, evenly spaced ticks remain.",
            supported: true,
          },
          {
            label: "Record the loudest peak",
            result:
              "The peak is broad. The recording contains the lamp and anything underneath it.",
          },
        ],
      },
      {
        ...east,
        id: "relay",
        after: "lamp",
        prompt: "Ines unplugs the field repeater for one interval. Compare the two channels.",
        choices: [
          {
            label: "Listen to the independent receiver",
            result:
              "Seven ticks, silence during the unplugged interval, then seven ticks. Its clock ran independently.",
            supported: true,
          },
          {
            label: "Replay Rex’s broadcast",
            result:
              "Seven ticks, even during the silent interval. Rex was looping last night’s tape.",
          },
        ],
      },
      {
        ...scrub,
        id: "tape",
        optional: true,
        prompt: "A backup cassette lies under the strap on the payload box.",
        choices: [
          {
            label: "Read the pencilled timecode",
            result: "The seven pulses predate Rex’s first broadcast by four hours.",
            supported: true,
          },
        ],
      },
    ],
    question: "Rex has a minute of airtime left. What goes out?",
    verdicts: [
      {
        label: "Air the controlled repeater test",
        result:
          "Rex plays the interval of silence twice. This time his listeners hear what went missing.",
        supported: true,
      },
      {
        label: "Release the loudest tape",
        result: "The lamp becomes famous. When the batteries die, the seven ticks carry on.",
      },
    ],
  },
  {
    id: "false",
    title: "False Positive",
    briefing:
      "Pacific Shield’s SENTINEL sent three flags from a staged volunteer exercise. Marisol, Dex and Ray each asked to see the record. Visit their interview benches in any order.",
    stations: [
      {
        ...camp,
        id: "marisol",
        prompt:
          "Marisol opens a long case. Inside is a tenor sax. Her rehearsal sheet matches the take recorded by a second microphone.",
        choices: [
          {
            label: "Clear the flag",
            result: "Marisol gets her rehearsal slot back.",
            supported: true,
          },
          { label: "Retain the flag", result: "The instrument case stays on her record." },
        ],
      },
      {
        ...west,
        id: "dex",
        prompt:
          "Dex made the same trip four times. Four separate lab receipts match four numbered sample jars in the courier manifest.",
        choices: [
          { label: "Retain the flag", result: "A routine delivery is filed as suspicious." },
          {
            label: "Clear the flag",
            result: "The courier receipts are attached to Dex’s file.",
            supported: true,
          },
        ],
      },
      {
        ...yard,
        id: "ray",
        prompt:
          "Ray admits trying the wrong volunteer locker. A second volunteer marked the time. Neither saw what Ray intended.",
        choices: [
          {
            label: "Record the observed act only",
            result:
              "Ray signs the observation and disputes the prediction. Both statements remain on file.",
            supported: true,
          },
          {
            label: "Certify the prediction",
            result: "A locker handle becomes evidence of a future act.",
          },
        ],
      },
    ],
    question: "The three slips go back to the volunteers. What goes to Pacific Shield?",
    verdicts: [
      {
        label: "Send individual findings with their sources",
        result:
          "The volunteers can challenge each finding. Pacific Shield must answer them separately.",
        supported: true,
      },
      {
        label: "Send one score for the group",
        result:
          "A flattering average travels faster than three people’s names. Their appeals stall.",
      },
    ],
  },
  {
    id: "link",
    title: "Everything Is Connected",
    briefing:
      "Rex has drawn a line from the heat to the ice cart to the first-aid queue. He wants Christopher on the evening show. His chart has one day missing.",
    stations: [
      {
        ...east,
        id: "heat",
        prompt: "The daily counts rise together. The field thermometer has an hourly strip.",
        choices: [
          {
            label: "Match hours at the same temperature",
            result: "At 38 °C, the first-aid queue is the same with or without the cart.",
            supported: true,
          },
          {
            label: "Compare the two busiest days",
            result:
              "Both days were hot and the cart sold out. The two causes still travel together.",
          },
        ],
      },
      {
        ...west,
        id: "cart",
        prompt:
          "The driver’s book is open on the day Rex omitted. The axle broke before opening time.",
        choices: [
          {
            label: "Match the repair docket to the clinic tally",
            result: "No sales. Twelve heat cases. A warm day without ice cream breaks Rex’s chain.",
            supported: true,
          },
          {
            label: "Copy the sales graph",
            result: "Your graph has the same missing day as the one on air.",
          },
        ],
      },
      {
        ...camp,
        id: "moon",
        optional: true,
        prompt:
          "Rex’s lunar calendar is stapled to the rig. Only winning draw dates have been circled.",
        choices: [
          {
            label: "Unfold the losing dates",
            result: "The other weeks contain every phase of the moon.",
            supported: true,
          },
        ],
      },
    ],
    question: "The red studio light comes on. How would you draw the arrows?",
    verdicts: [
      {
        label: "Heat points to both queues",
        result: "Rex erases one arrow and draws two. Ines sends the clinic a shade canopy.",
        supported: true,
      },
      {
        label: "The ice cart causes heat illness",
        result:
          "The cart closes on Thursday. By noon the first-aid queue extends past its empty pitch.",
      },
    ],
  },
  {
    id: "open",
    title: "The Open Experiment",
    briefing:
      "Three groups have brass plates, sand and a sealed drive setting. Deliver the trial in any order. Bracket will buy exclusive rights if the same figure appears twice.",
    stations: [
      {
        ...west,
        id: "plate-a",
        prompt:
          "Kit A rattles at 96 Hz. The envelope asks for a blinded comparison with the drive disconnected.",
        choices: [
          {
            label: "Alternate coded live and sham runs",
            result:
              "The grains form two clean nodal lines on all three live runs and none on sham.",
            supported: true,
          },
          {
            label: "Photograph the clearest figure",
            result: "One sharp figure. Its envelope is unmarked.",
          },
        ],
      },
      {
        ...east,
        id: "plate-b",
        prompt:
          "Kit B sounds flat. A retaining screw has loosened in transit. The technician offers to retune it off the record.",
        choices: [
          {
            label: "Log the repair and repeat the blinded pair",
            result: "After the logged repair, the two nodal lines return on live runs only.",
            supported: true,
          },
          {
            label: "Keep the unlabelled retake",
            result: "The retake looks identical. Its conditions cannot be reconstructed.",
          },
        ],
      },
      {
        ...scrub,
        id: "plate-c",
        optional: true,
        prompt: "The third crew used a thicker plate. Their first sweep shows three lines.",
        choices: [
          {
            label: "Archive the discrepant run",
            result: "A thicker plate moves the resonance. The claim now has a boundary.",
            supported: true,
          },
        ],
      },
    ],
    question: "Bracket places a contract beside the sand. Who gets to repeat this?",
    verdicts: [
      {
        label: "Open the notebooks and methods",
        result:
          "At dawn a fourth crew asks for the screw torque. Someone has already started repeating your work.",
        supported: true,
      },
      {
        label: "Sign the exclusive licence",
        result:
          "Bracket prints the best figure on the cover. The notebooks stay in a locked drawer.",
      },
      {
        label: "Withhold the claim and invite another trial",
        result: "The headline waits. Three fresh envelopes are on their way.",
      },
    ],
  },
];
export interface FieldRun {
  /** Index within EXPEDITIONS. A run starts when the player accepts the next transmission. */
  chapter: number;
  records: Record<string, number>;
  verdict: number | null;
}
export function freshRun(chapter: number): FieldRun {
  return { chapter, records: {}, verdict: null };
}
export function canFile(run: FieldRun): boolean {
  return EXPEDITIONS[run.chapter].stations.every(
    (s) => s.optional || Object.hasOwn(run.records, s.id),
  );
}
export function availableStations(run: FieldRun): readonly FieldStation[] {
  if (run.verdict !== null) return [];
  return EXPEDITIONS[run.chapter].stations.filter(
    (s) => !Object.hasOwn(run.records, s.id) && (!s.after || Object.hasOwn(run.records, s.after)),
  );
}
function choiceIndex(value: unknown, length: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < length;
}
export function parseRuns(value: unknown): FieldRun[] {
  if (!Array.isArray(value)) return [];
  const runs: FieldRun[] = [];
  for (const [chapter, mission] of EXPEDITIONS.entries()) {
    const raw = value[chapter];
    if (!raw || raw.chapter !== chapter) break;
    const run = freshRun(chapter);
    for (const station of mission.stations) {
      const answer: unknown = raw.records?.[station.id];
      if (
        choiceIndex(answer, station.choices.length) &&
        (!station.after || Object.hasOwn(run.records, station.after))
      )
        run.records[station.id] = answer;
    }
    if (canFile(run) && choiceIndex(raw.verdict, mission.verdicts.length))
      run.verdict = raw.verdict;
    runs.push(run);
    if (run.verdict === null) break;
  }
  return runs;
}
/** A filed record is sealed. Prefer the already-stored answer on concurrent submissions. */
export function mergeRuns(local: FieldRun[], stored: FieldRun[]): FieldRun[] {
  const merged = Array.from({ length: Math.max(local.length, stored.length) }, (_, i) => {
    const a = local[i],
      b = stored[i];
    if (!a || !b) return a ?? b;
    if (b.verdict !== null) return b;
    if (a.verdict !== null) return a;
    return { ...a, records: { ...a.records, ...b.records } };
  });
  return parseRuns(merged);
}
export function fieldEnding(runs: FieldRun[]): string {
  const last = runs.at(-1);
  if (!last || last.verdict === null) return "";
  const mission = EXPEDITIONS[last.chapter];
  const controlled = mission.stations
    .filter((s) => !s.optional)
    .every((s) => s.choices[last.records[s.id]]?.supported);
  const verdict = mission.verdicts[last.verdict];
  if (last.chapter < 3)
    return (
      verdict.result +
      (verdict.supported && !controlled
        ? " Ines attaches a correction: the conclusion outran the experiment."
        : "")
    );
  if (last.verdict === 1) return verdict.result;
  if (last.verdict === 2)
    return (
      verdict.result +
      (!controlled
        ? " The missing controls are on the new trial sheet."
        : " The earlier replications go with them.")
    );
  if (!controlled)
    return "The notebooks are open. A reader spots the missing control before lunch. Your first public result is a correction.";
  const careful = runs
    .slice(0, 3)
    .filter(
      (r) =>
        r.verdict !== null &&
        EXPEDITIONS[r.chapter].verdicts[r.verdict].supported &&
        EXPEDITIONS[r.chapter].stations.every(
          (s) => s.optional || s.choices[r.records[s.id]]?.supported,
        ),
    ).length;
  return (
    verdict.result +
    (careful >= 2
      ? " Marisol offers to record the next plate so anyone can hear it."
      : " The volunteers request an independent observer before the next run.")
  );
}

/** The field instruments use an illustrative resonant response, in local dial units. */
export function instrumentFor(station: string) {
  if (station === "lamp")
    return {
      label: "Receiver tuning",
      unit: "kHz IF",
      low: 40,
      high: 64,
      center: 54,
      hint: "Sweep the intermediate-frequency dial until the seven-pulse trace resolves.",
    };
  if (station.startsWith("plate-"))
    return {
      label: "Plate drive",
      unit: "Hz",
      low: 80,
      high: 112,
      center: station === "plate-c" ? 104 : 96,
      hint: "Sweep the drive until the nodal pattern holds steady.",
    };
  return null;
}

export function responseAt(value: number, center: number) {
  return 1 / (1 + ((value - center) / 3) ** 2);
}
