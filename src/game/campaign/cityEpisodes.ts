import type { Verdict } from "./sanFierro";

export type Point = { x: number; z: number };
export type LinkVerdict = "causes" | "common cause" | "coincidence" | "can't tell";
export type Choice =
  | Verdict
  | LinkVerdict
  | "verify"
  | "publish"
  | "battery"
  | "trace"
  | "refuse"
  | "take";
export type Task =
  | { kind: "dialog"; title: string; text: string }
  | { kind: "walk" | "photo" | "reading"; title: string; point: Point; evidence: string }
  | { kind: "drive"; title: string; point: Point }
  | { kind: "bakery"; title: string }
  | {
      kind: "road";
      title: string;
      role: "escape" | "escort" | "relay" | "broadcast" | "kits";
      point: Point;
      end: number;
    }
  | { kind: "triage"; title: string }
  | {
      kind: "choice";
      title: string;
      claim: string;
      id: string;
      choices: readonly Choice[];
      answer?: Choice;
      teach?: boolean;
    };

export const COURTYARD_SUBJECT = { x: -10, z: 82 };

export const verdicts = ["accept", "reject", "abstain"] as const;
const links = ["causes", "common cause", "coincidence", "can't tell"] as const;
const at = (z: number, x = -5): Point => ({ x, z });
const dialog = (title: string, text: string): Task => ({ kind: "dialog", title, text });
const visit = (
  kind: "walk" | "photo" | "reading",
  title: string,
  z: number,
  evidence: string,
): Task => ({ kind, title, point: at(z), evidence });
const drive = (title: string, z: number): Task => ({ kind: "drive", title, point: at(z) });
const road = (
  role: Extract<Task, { kind: "road" }>["role"],
  title: string,
  start: number,
  end: number,
): Task => ({ kind: "road", role, title, point: at(start), end });
const claim = (id: number, title: string, text: string, answer: Verdict, teach = false): Task => ({
  kind: "choice",
  id: String(id),
  title,
  claim: text,
  choices: verdicts,
  answer,
  teach,
});

/** Stable claim IDs 0–9 match the authored mission. Daily Bread supplies IDs 3 and 4. */
export const EPISODES: readonly { title: string; description: string; tasks: readonly Task[] }[] = [
  {
    title: "99.9% SURE",
    description:
      "CERTAIN has flagged Christopher. Bring an independent record to the public hearing.",
    tasks: [
      dialog(
        "An alert outside the lab",
        "Ines: CERTAIN flagged you from a camera across the street. A patrol is circling. Get the wagon to our pull-off without making contact.",
      ),
      road("escape", "Drive clear of the patrol", 8, 47),
      visit(
        "walk",
        "Meet Ines at the pull-off",
        48,
        "A time-stamped workbench log puts Christopher inside the lab during the reported incident. The alert relied on clothing and proximity.",
      ),
      claim(0, "Christopher's file", "Christopher was at the reported incident.", "reject", true),
      dialog(
        "The courtyard class",
        "Ines: CERTAIN saw people moving in unison. Frame the class from three marked positions. Look toward the practice mats and the community noticeboard beside the avenue.",
      ),
      visit(
        "photo",
        "Frame the class from the entry",
        61,
        "Wide photograph: a slow warm-up, no equipment beyond mats.",
      ),
      visit(
        "photo",
        "Frame the class from the walkway",
        68,
        "Side photograph: the Harbor Community noticeboard identifies a morning tai chi class open to everyone.",
      ),
      visit(
        "photo",
        "Frame the instructor from the rail",
        75,
        "Close photograph: the instructor guides a slow sequence. The image says nothing about their plans.",
      ),
      claim(1, "The courtyard class", "The group is conducting paramilitary training.", "reject"),
      claim(2, "The instructor", "The instructor is a flight risk.", "abstain"),
      { kind: "bakery", title: "Daily Bread" },
      dialog(
        "Comparison readings",
        "Christopher: A strong reading near machinery can mean the machinery is close. Keep the wagon still on each marked pad until its log fills.",
      ),
      visit(
        "reading",
        "Park at pad A",
        90,
        "Pad A: pronounced 60 Hz hum beside an operating generator.",
      ),
      visit("reading", "Park at pad B", 111, "Pad B: clean baseline away from the generator."),
      visit(
        "reading",
        "Park at pad C",
        129,
        "Pad C: weaker hum at an intermediate distance. It falls with distance and has no patterned modulation.",
      ),
      claim(5, "The industrial signal", "Someone is deliberately jamming local signals.", "reject"),
      claim(6, "The radar forecast", "The port radar will fail tonight.", "abstain"),
      dialog(
        "A family in the alert queue",
        "Ines: Dispatch is about to stop a family on the waterfront. Reach the silver van before the clock runs out. Stay close enough to upload the record. Dispatch checks a strong log sooner.",
      ),
      road("escort", "Reach and escort the family", 135, 188),
      visit(
        "walk",
        "Meet Ines at the public hearing",
        193,
        "A seat camera and the owner's statement identify a man reaching into his own pocket. There is no theft report.",
      ),
      claim(7, "Public claim 1", "The person in the aisle stole a wallet.", "reject", true),
      visit(
        "walk",
        "Read the weather feed",
        193,
        "Neither side collected weather measurements. The sky was clear when the forecast was read out.",
      ),
      claim(8, "Public claim 2", "It will rain here at 4:15 p.m.", "abstain", true),
      visit(
        "walk",
        "Compare the two door counts",
        193,
        "Camera count: 214. Independent entry counter: 211. Posted limit: 150.",
      ),
      claim(9, "Public claim 3", "The room exceeds its posted capacity.", "accept", true),
      dialog(
        "The public registry",
        "The presenter cuts the feed. Christopher sends the logs and corrections to the public registry. Ines: The lab is ours to use now. Bring the wagon home.",
      ),
      drive("Return the wagon to Vers3Dynamics", 0),
      visit("walk", "Check in at the lab", 0, "Vers3Dynamics HQ opens to independent research."),
    ],
  },
  {
    title: "Ghost Frequency",
    description: "Separate a patterned transmission from a loud sign and a reflected echo.",
    tasks: [
      dialog(
        "Seven pulses",
        "Ines: Radio Free Harbor heard a seven-pulse signal at 166.25 MHz. The loudest places on the dial may be telling us the least.",
      ),
      visit(
        "reading",
        "Take a wagon bearing at the first post",
        54,
        "West bearing: strong carrier and no repeatable pulse sequence.",
      ),
      visit(
        "reading",
        "Take a wagon bearing at the second post",
        74,
        "East bearing: both lines intersect at the sign. A near-field check records only steady buzz.",
      ),
      claim(20, "The neon sign", "The sign is the source of the seven-pulse carrier.", "reject"),
      visit(
        "photo",
        "Aim the receiver at the bridge echo",
        88,
        "The bridge bearing carries seven pulses delayed by the same interval on every sweep.",
      ),
      claim(21, "The bridge echo", "The bridge is transmitting the carrier.", "reject"),
      visit(
        "photo",
        "Sweep north from the esplanade",
        101,
        "Direct bearing: clean, undelayed pulses point to a field relay.",
      ),
      road("relay", "Follow the relay technician to the pull-off", 113, 153),
      visit(
        "walk",
        "Collect the switched-off relay",
        155,
        "The technician signs the relay out to Christopher for an independent check.",
      ),
      {
        kind: "choice",
        id: "relay",
        title: "The relay recording",
        claim: "Publish the recording now, or bring the live buffer to the lab for a control test?",
        choices: ["verify", "publish"],
      },
      drive("Return to Vers3Dynamics", 0),
      visit(
        "walk",
        "Log the relay result at HQ",
        0,
        "HQ records whether the signal was verified, published early, or lost before verification.",
      ),
    ],
  },
  {
    title: "False Positive",
    description:
      "Three simultaneous alerts. Decide from two observations per person while their clocks run.",
    tasks: [
      dialog(
        "Three clocks",
        "SENTINEL sent three flags to a private team. Pick any order. Each person needs two observations and a verdict. One detention goes on the record. Two force a retry.",
      ),
      { kind: "triage", title: "Investigate the three flags" },
      drive("Bring the case files to Vers3Dynamics", 0),
      visit(
        "walk",
        "File the triage report",
        0,
        "The public log records findings and any detention without treating either as proof.",
      ),
    ],
  },
  {
    title: "Everything Is Connected",
    description: "Build a causal account from four records and defend it on air.",
    tasks: [
      dialog(
        "Rex's challenge",
        "Rex Pattern: If sales and crime rise together, the ice cream must be doing something. Christopher: Let's check the actual records before we go live.",
      ),
      visit(
        "walk",
        "Read the esplanade thermometer",
        48,
        "Temperature rose by 10 degrees. In a controlled trial, ice cream purchases doubled.",
      ),
      visit(
        "photo",
        "Frame the ice cream queue",
        69,
        "The queue and police calls grew on hotter days, including hot days when the vans were absent.",
      ),
      visit(
        "walk",
        "Compare the dispatch log",
        91,
        "The crime series moved before the lottery draw. Across later draws, no relationship repeated.",
      ),
      visit(
        "walk",
        "Read the lottery board",
        104,
        "A lottery win and a receiver fault occurred on the same day once. No relevant comparison was collected.",
      ),
      ...[
        ["ice", "Ice cream sales and crime", "common cause"],
        ["heat", "Heat and ice cream sales", "causes"],
        ["draw", "Lottery draws and police calls", "coincidence"],
        ["fault", "The lottery win and the receiver fault", "can't tell"],
      ].map(
        ([id, title, answer]): Task => ({
          kind: "choice",
          id,
          title,
          claim: "Which link best fits the observed evidence?",
          choices: links,
          answer: answer as LinkVerdict,
        }),
      ),
      visit(
        "walk",
        "Meet Rex at the live broadcast",
        106,
        "Rex reads Christopher's classification on air. The public record keeps the original call.",
      ),
      road("broadcast", "Drive clear of the protest vans", 112, 157),
      drive("Return to Vers3Dynamics", 0),
      visit(
        "walk",
        "File the broadcast log",
        0,
        "The city log records whether the debate ended quietly or sent protest vans after the wagon.",
      ),
    ],
  },
  {
    title: "The Open Experiment",
    description:
      "Deliver independent kits, recover the demonstration and decide who can use the results.",
    tasks: [
      dialog(
        "An exclusive licence",
        "Bracket offers the lab an exclusive deal. Ines has already arranged three independent replications. Take one kit to each team. Hard impacts damage the kits still in the wagon.",
      ),
      visit(
        "reading",
        "Deliver the teacher's kit",
        42,
        "The physics class signs for the first kit.",
      ),
      road("kits", "Bring the two remaining kits through the waterfront", 46, 91),
      visit(
        "reading",
        "Deliver the radio club's kit",
        95,
        "The radio club signs for the second kit if it survived the drive.",
      ),
      visit(
        "reading",
        "Deliver the fair team's kit",
        120,
        "The science fair team checks the last kit on arrival.",
      ),
      visit(
        "walk",
        "Inspect the dead demonstration",
        125,
        "A fuse is missing from the pier cabinet. The van battery can power one more run.",
      ),
      {
        kind: "choice",
        id: "power",
        title: "Recover the demonstration",
        claim:
          "Follow the runner on foot and recover the fuse, or power the demonstration from the wagon?",
        choices: ["trace", "battery"],
      },
      visit(
        "walk",
        "Recover the fuse at the pier desk",
        144,
        "The attendant returns the missing fuse. The demonstration runs from shore power.",
      ),
      visit(
        "walk",
        "Listen to the replication calls",
        125,
        "The lab files one independently returned result per working kit.",
      ),
      {
        kind: "choice",
        id: "replication",
        title: "Independent replication",
        claim: "Do the returned results establish that the effect reproduces independently?",
        choices: verdicts,
      },
      {
        kind: "choice",
        id: "fee",
        title: "Bracket's private offer",
        claim: "Take a private fee to delay release, or refuse and keep the registry open?",
        choices: ["take", "refuse"],
      },
      drive("Bring the final report to Vers3Dynamics", 0),
      visit(
        "walk",
        "Sign the city dossier at HQ",
        0,
        "Ines files the city dossier and opens a field relay to Pine Gap.",
      ),
    ],
  },
];

export const TRIAGE = [
  {
    name: "Marisol",
    seconds: 72,
    point: at(38),
    claim: "Marisol is carrying stolen goods.",
    evidence: [
      "A photograph shows a service tag on the case.",
      "The shopkeeper matches the tag to a repair receipt.",
    ],
    answer: "reject",
  },
  {
    name: "Dex",
    seconds: 86,
    point: at(60),
    claim: "Dex is collecting illicit cargo.",
    evidence: [
      "The drop is an ordinary courier handover.",
      "The signed manifest lists replacement fan belts.",
    ],
    answer: "reject",
  },
  {
    name: "Ray",
    seconds: 100,
    point: at(84),
    claim: "Ray tried to open parked cars without permission.",
    evidence: [
      "Two frames show Ray testing three parked doors.",
      "The owner identifies the car and confirms Ray had no permission.",
    ],
    answer: "accept",
  },
] as const;
