/**
 * Case 01 of 99.9% SURE, set on the Pine Gap reconstruction.
 *
 * Everything here is fiction: the classifier, the carrier, the people, the
 * truck's log and the radiosonde. Nothing describes the real facility, its
 * work or anyone who works there. Props stand on open ground beside roads
 * and add no colliders, so movement, vehicle physics and collision are the
 * same as in the plain reconstruction. Positions are site metres (X east,
 * Z south), chosen with the layout's clearance in mind.
 *
 * This module is plain data with no rendering, so the rules can be tested
 * headless.
 */

export interface Spot {
  x: number;
  z: number;
  /** Facing (radians, 0 = +Z). */
  yaw: number;
}

export const SPEAKERS = {
  rain: "R.A.I.N.",
  ines: "Ines Calder · R.A.I.N.",
  mara: "Mara Quill",
  tobin: "Tobin Hale · SureThing",
  certain: "CERTAIN-PG",
} as const;
export type SpeakerId = keyof typeof SPEAKERS;

/** The R.A.I.N. field van and where the player stands to use it. */
export const VAN: Spot = { x: -130, z: 182, yaw: Math.PI / 2 };
/** The evidence board under the awning, on the van's north side. */
export const VAN_BOARD = { x: -130.2, z: 179.6 } as const;
export const VAN_STAND: Spot = { x: -128.6, z: 177.4, yaw: 0 };
export const INES: Spot = { x: -132.2, z: 179.0, yaw: 0.6 };

/** Mara walks a cable inspection between these two points, pausing at each. */
export const MARA_ROUTE: readonly Spot[] = [
  { x: -128, z: 138, yaw: Math.PI },
  { x: -128, z: 84, yaw: 0 },
];
export const MARA_PACE = 1.25;
export const MARA_PAUSE = 7;

/** The SureThing contractor waits beside the flagged truck. */
export const TOBIN: Spot = { x: -62.5, z: 160.5, yaw: -2.3 };

/** Two survey posts, far enough apart that their bearings make a point. */
export const POSTS = {
  a: { x: 60, z: -120, yaw: 0, label: "East survey post" },
  b: { x: -120, z: 40, yaw: 0, label: "West survey post" },
} as const;
export type PostId = keyof typeof POSTS;

/** A fallen weather-balloon radiosonde, still keyed on the carrier. */
export const SONDE: Spot = { x: -68, z: -348, yaw: 0.8 };

/** Index of the flagged truck in the parked fleet (the lot 2 utility 4x4). */
export const FLAGGED_VEHICLE = 0;

export const RANGES = {
  talk: 2.6,
  van: 3.2,
  post: 2.2,
  /** How far the player may drift while a bearing settles. */
  postDrift: 1.4,
  sonde: 2.8,
  sondeNotice: 26,
  logger: 2.4,
  document: 2,
} as const;

/** Seconds of standing still for a bearing to settle. */
export const BEARING_SETTLE = 3.5;

/** Compass bearing (degrees, clockwise from north = −Z) from a post to a point. */
export function bearingDegrees(from: { x: number; z: number }, to: { x: number; z: number }): number {
  const east = to.x - from.x;
  const north = -(to.z - from.z);
  const deg = (Math.atan2(east, north) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Where two bearing rays from the posts meet (null when parallel). */
export function crossing(
  a: { x: number; z: number },
  bearingA: number,
  b: { x: number; z: number },
  bearingB: number,
): { x: number; z: number } | null {
  const ra = (bearingA * Math.PI) / 180;
  const rb = (bearingB * Math.PI) / 180;
  const ax = Math.sin(ra);
  const az = -Math.cos(ra);
  const bx = Math.sin(rb);
  const bz = -Math.cos(rb);
  const det = ax * bz - az * bx;
  if (Math.abs(det) < 1e-6) return null;
  const t = ((b.x - a.x) * bz - (b.z - a.z) * bx) / det;
  return { x: a.x + ax * t, z: a.z + az * t };
}

/** The bearing each post reads: towards the radiosonde, not the truck. */
export const POST_BEARINGS: Record<PostId, number> = {
  a: Math.round(bearingDegrees(POSTS.a, SONDE)),
  b: Math.round(bearingDegrees(POSTS.b, SONDE)),
};

// --- Evidence ------------------------------------------------------------------

export type EvidenceId = "witness" | "bearings" | "sonde" | "logger" | "rerun";
/** Independent lines of evidence: two cards on one line count once. */
export type EvidenceLine = "testimony" | "location" | "record" | "echo";

export interface EvidenceCard {
  id: EvidenceId;
  title: string;
  source: string;
  summary: string;
  line: EvidenceLine;
}

export const CLAIM = {
  title: "CERTAIN-PG attribution · 99.9%",
  source: "SureThing classifier, overnight run",
  summary:
    "An unlisted carrier was keyed between 02:00 and 05:30. CERTAIN-PG attributes it to utility truck U-2 and to the technician on its sign-out sheet, Mara Quill.",
} as const;

export const EVIDENCE: Record<EvidenceId, EvidenceCard> = {
  witness: {
    id: "witness",
    title: "Mara Quill's account",
    source: "Spoken to in person",
    summary:
      "Signed in at the north antenna hut from 02:10 to 05:40 for a battery swap. Walked there. U-2's keys stayed on the board.",
    line: "testimony",
  },
  bearings: {
    id: "bearings",
    title: "Two bearings on the carrier",
    source: "Taken at the east and west survey posts",
    summary: `${POST_BEARINGS.a}° from the east post, ${POST_BEARINGS.b}° from the west. The lines cross about half a kilometre north of the halls, nowhere near lot 2.`,
    line: "location",
  },
  sonde: {
    id: "sonde",
    title: "A fallen radiosonde",
    source: "Found where the bearings cross",
    summary:
      "A weather-balloon payload came down in the scrub. Its transmitter is stuck keyed on the unlisted carrier. It has been sending since about 02:00.",
    line: "location",
  },
  logger: {
    id: "logger",
    title: "U-2 engine logger",
    source: "Read from the truck in lot 2",
    summary:
      "Ignition off at 21:50, next on at 06:15. The truck did not move overnight, and its radio was never powered.",
    line: "record",
  },
  rerun: {
    id: "rerun",
    title: "SureThing re-run · 99.97%",
    source: "Tobin Hale, SureThing field rep",
    summary:
      "SureThing ran CERTAIN-PG again on the same overnight sensor feed. Confidence went up to 99.97%.",
    line: "echo",
  },
};

export const EVIDENCE_ORDER: readonly EvidenceId[] = ["witness", "bearings", "sonde", "logger", "rerun"];

// --- Verdicts and endings ------------------------------------------------------

export type Verdict = "accept" | "reject" | "abstain";
export const CONFIDENCE_CHOICES = [60, 80, 95, 99.9] as const;
export type Confidence = (typeof CONFIDENCE_CHOICES)[number];

export type EndingId = "quiet-correction" | "wrong-reasons" | "confidently-wrong" | "long-pause" | "not-yet";

export interface Ending {
  id: EndingId;
  title: string;
  /** What happened afterwards, in two or three sentences. */
  epilogue: string;
  /** R.A.I.N.'s last word on it. */
  rain: string;
  /** Closing the case (false sends the player back into the field). */
  closes: boolean;
}

export const ENDINGS: Record<EndingId, Ending> = {
  "quiet-correction": {
    id: "quiet-correction",
    title: "The Quiet Correction",
    epilogue:
      "The flag on U-2 is withdrawn before the morning meeting. Mara never hears her name was on it. The radiosonde goes back to the weather bureau with a note about its stuck key.",
    rain: "Nobody will thank you, because nothing happened. That is what a correction looks like when it is done in time.",
    closes: true,
  },
  "wrong-reasons": {
    id: "wrong-reasons",
    title: "Right for the Wrong Reasons",
    epilogue:
      "The flag is withdrawn, but the note on the case file has one line of support under it. When CERTAIN-PG flags the next truck, nobody can say why this one was different.",
    rain: "You were right. You could not show it. Next time the machine will be wrong in a way that looks just like this, and you will need more than a feeling.",
    closes: true,
  },
  "confidently-wrong": {
    id: "confidently-wrong",
    title: "Confidently Wrong",
    epilogue:
      "U-2 is pulled from service and Mara is stood down pending review. At 09:00 the carrier is still keyed, from half a kilometre north. A retraction goes out at noon, with her name in it.",
    rain: "The machine was 99.9% sure, and you put your name beside it. One mistake, signed twice. The carrier never moved.",
    closes: true,
  },
  "long-pause": {
    id: "long-pause",
    title: "The Long Pause",
    epilogue:
      "With no verdict, the flag stays live for a week. Mara works under it. The evidence that would have cleared her was already in the van.",
    rain: "Doubt is a tool, not a place to live. You had what you needed. Not deciding was a decision too.",
    closes: true,
  },
  "not-yet": {
    id: "not-yet",
    title: "Not Yet",
    epilogue: "You hold the verdict and go back out. The flag stays, for now, and the van keeps the board open.",
    rain: "Honest. You don't know yet, so don't pretend. Go and find out what would change your mind.",
    closes: false,
  },
};

export interface VerdictInput {
  verdict: Verdict;
  /** Cards the player chose to weigh. */
  weighed: readonly EvidenceId[];
  confidence: Confidence;
}

export interface Audit {
  ending: EndingId;
  /** Independent lines of evidence the verdict rested on. */
  lines: number;
  /** One short note per point R.A.I.N. wants to make, in order. */
  notes: string[];
}

/** The independent lines among the weighed cards (the re-run adds none). */
export function independentLines(weighed: readonly EvidenceId[]): EvidenceLine[] {
  const lines = new Set<EvidenceLine>();
  for (const id of weighed) {
    const line = EVIDENCE[id]?.line;
    if (line && line !== "echo") lines.add(line);
  }
  return [...lines];
}

/**
 * Grade a verdict. The truck did not do it: rejecting the attribution on two
 * or more independent lines is the careful answer. The re-run is the same
 * sensor feed asked twice, so it never counts as a line of its own.
 */
export function gradeVerdict(input: VerdictInput): Audit {
  const lines = independentLines(input.weighed).length;
  const echo = input.weighed.includes("rerun");
  const notes: string[] = [];
  let ending: EndingId;
  if (input.verdict === "accept") ending = "confidently-wrong";
  else if (input.verdict === "reject") ending = lines >= 2 ? "quiet-correction" : "wrong-reasons";
  else ending = lines >= 2 ? "long-pause" : "not-yet";

  if (echo)
    notes.push(
      "The re-run read the same sensor feed as the first run. Asking one instrument twice is one observation, not two.",
    );
  if (lines === 0) notes.push("Nothing you weighed came from outside the classifier itself.");
  else if (input.verdict === "accept")
    notes.push(
      `Every line you weighed points away from U-2 (${describeLines(input.weighed)}). The verdict went against your own evidence.`,
    );
  else if (lines === 1) notes.push("One independent line of evidence. Enough to doubt, not enough to show.");
  else notes.push(`${lines} independent lines of evidence: ${describeLines(input.weighed)}.`);
  if (input.confidence === 99.9)
    notes.push(
      input.verdict === "accept"
        ? "You matched the machine's number exactly. That is agreement, not checking."
        : "You said 99.9% too. Careful: that is the number that started this.",
    );
  else if (input.verdict === "accept")
    notes.push(`${input.confidence}% sure of a claim nothing you found supports.`);
  else if (input.verdict === "reject" && lines >= 2 && input.confidence >= 80)
    notes.push(`${input.confidence}% on that evidence is a fair number to put your name to.`);
  else if (input.verdict === "reject" && lines < 2 && input.confidence >= 95)
    notes.push(`${input.confidence}% is more certainty than one line can carry.`);
  return { ending, lines, notes };
}

function describeLines(weighed: readonly EvidenceId[]): string {
  const names: Record<EvidenceLine, string> = {
    testimony: "what Mara told you",
    location: "where the carrier really is",
    record: "the truck's own log",
    echo: "the re-run",
  };
  return independentLines(weighed)
    .map((l) => names[l])
    .join(", ");
}

// --- Conversations -------------------------------------------------------------

export interface Topic {
  id: string;
  /** What the player asks. */
  ask: string;
  /** The answer, one or two sentences. */
  answer: string;
  /** Asking this collects a card. */
  gives?: EvidenceId;
}

export const MARA_OPENING = "You're from the van? Someone said my name is on a list.";
export const MARA_TOPICS: readonly Topic[] = [
  {
    id: "where",
    ask: "Where were you last night?",
    answer:
      "North antenna hut, swapping batteries. Signed in at 02:10, out at 05:40. The sheet is on the hut door if you want it.",
    gives: "witness",
  },
  {
    id: "truck",
    ask: "Did you take truck U-2?",
    answer: "I walked. It's three hundred metres and the night was clear. U-2's keys were on the board when I left.",
    gives: "witness",
  },
  {
    id: "number",
    ask: "The system says it's 99.9% you.",
    answer: "Then it should come and tell me what I did. I'd like to know too.",
  },
];

export const TOBIN_OPENING = "You're the one second-guessing our model? Save yourself the walk.";
export const TOBIN_TOPICS: readonly Topic[] = [
  {
    id: "rerun",
    ask: "What has SureThing found?",
    answer: "We re-ran CERTAIN-PG this morning. 99.97%. It went up. Put that on your board.",
    gives: "rerun",
  },
  {
    id: "data",
    ask: "What did the re-run use?",
    answer: "The same overnight sensor feed, obviously. Same model, fresh pass. That's what a re-run is.",
  },
  {
    id: "wrong",
    ask: "How often is it wrong?",
    answer: "On validation? One in a thousand. Out here, nobody's counted. That's not my department.",
  },
];

export const INES_HINTS = {
  start:
    "Three things would settle this: what Mara says, where the carrier really is, and what U-2's own log shows. Any order.",
  some: "Keep going. The board takes whatever you bring back, and so does the verdict.",
  bearings: "You have the crossing. Drive out and see what's sitting there.",
  ready: "That's every line I can think of. The board is open when you are.",
  closed: "Case closed. The desert's still yours to walk, and the notes are still out there.",
} as const;

// --- Opening and radio ---------------------------------------------------------

export interface Line {
  speaker: SpeakerId;
  text: string;
  /** Seconds on screen. */
  seconds: number;
}

export const TITLE = {
  title: "99.9% SURE",
  subtitle: "The machine has already made up its mind. Have you?",
} as const;

export const BRIEFING: readonly Line[] = [
  { speaker: "ines", text: "You made it, Christopher. This is the van, and that's the board.", seconds: 4.5 },
  { speaker: "certain", text: "Attribution: utility truck U-2, operator M. Quill. Confidence 99.9%.", seconds: 5 },
  {
    speaker: "rain",
    text: "Before anyone acts on that, find out what would change your mind. Then go and look for it.",
    seconds: 5.5,
  },
  { speaker: "ines", text: INES_HINTS.start, seconds: 6 },
];

export const RADIO = {
  firstBearing: "One bearing is a line. Take the other post and you'll have a point.",
  bothBearings:
    "Two bearings. They cross about half a kilometre north of the halls, out in the scrub. Nowhere near the truck.",
  sondeNear: "Carrier's strong here. Whatever is sending, you're standing next to it.",
  sonde: "A radiosonde. Balloons drift for hours, and this one came down with its key stuck. That's your carrier.",
  logger: "If U-2 was out all night, its own logger would say so. It doesn't.",
  witness: "Testimony is evidence too. Not proof, but a line you can check against the others.",
  rerun: "Notice what that re-run actually is before you count it.",
  allDocs: "All five notes. You read the margins too. That is the job.",
  board: "Weigh what you trust, set aside what you don't, then say how sure you are.",
} as const;

// --- Field notes (optional) ----------------------------------------------------

export type DocumentId = "calibration" | "base-rates" | "echo" | "bearings" | "change-mind";

export interface FieldNote {
  id: DocumentId;
  title: string;
  body: string;
  at: { x: number; z: number };
}

export const FIELD_NOTES: readonly FieldNote[] = [
  {
    id: "calibration",
    title: "On 99.9%",
    body: "A number like 99.9% is a claim about the world and about the model that made it. Ask: of all the times it said 99.9, how often was it right? If nobody has counted, the number is a mood.",
    at: { x: -126.6, z: 179.4 },
  },
  {
    id: "base-rates",
    title: "Base rates",
    body: "Say one carrier in ten thousand is worth worrying about. A test that is 99.9% accurate still flags about ten harmless sources for every real one. The rarer the thing, the more of the flags are wrong.",
    at: { x: -90, z: 120 },
  },
  {
    id: "echo",
    title: "The echo",
    body: "Asking the same instrument twice gives you one observation, not two. Evidence adds up only when the sources could have disagreed and didn't.",
    at: { x: -114, z: 47 },
  },
  {
    id: "bearings",
    title: "Two bearings",
    body: "One bearing is a line. Two bearings from different places make a point. The wider the angle between them, the smaller the patch of ground they leave you to search.",
    at: { x: 55, z: -114 },
  },
  {
    id: "change-mind",
    title: "What would change my mind",
    body: "Before you decide, write down what you would expect to see if you were wrong. Then go and look for exactly that. If you can't name it, you aren't deciding yet.",
    at: { x: -75, z: -341 },
  },
];

/** The rest of the campaign, shown honestly as not yet received. */
export const LATER_CASES: readonly { title: string; line: string }[] = [
  { title: "Ghost Frequency", line: "A signal that only appears when someone is listening for it." },
  { title: "False Positive", line: "CERTAIN-PG flags a person, not a truck." },
  { title: "Everything Is Connected", line: "Every clue fits. That is the problem." },
  { title: "The Open Experiment", line: "R.A.I.N. asks you to test the machine in public." },
];
