import {
  CONFIDENCE_CHOICES,
  ENDINGS,
  EVIDENCE,
  EVIDENCE_ORDER,
  FIELD_NOTES,
  gradeVerdict,
  type Audit,
  type Confidence,
  type DocumentId,
  type EndingId,
  type EvidenceId,
  type PostId,
  type Verdict,
} from "./story";

/**
 * The case file: everything the hidden case remembers, and the rules that
 * move it on. Plain data, no rendering and no clock, so the same steps give
 * the same file every time. Saved under its own key, apart from After Hours
 * and Free Roam progress.
 */

export const CASE_STORAGE_KEY = "99sure.hidden.v1";

export type CaseStage = "briefing" | "investigating" | "closed";

export interface CaseData {
  v: 1;
  /** The signal has been found and the transmission accepted at least once. */
  found: boolean;
  stage: CaseStage;
  collected: EvidenceId[];
  weighed: EvidenceId[];
  bearings: PostId[];
  /** Conversation topics already asked ("mara:where", "tobin:data"…). */
  asked: string[];
  documents: DocumentId[];
  ending: EndingId | null;
  confidence: Confidence | null;
  verdict: Verdict | null;
  /** Every ending reached across replays. */
  endingsSeen: EndingId[];
  /** Verdicts handed in (a "not yet" sends the case back out). */
  attempts: number;
}

export function emptyCase(): CaseData {
  return {
    v: 1,
    found: false,
    stage: "briefing",
    collected: [],
    weighed: [],
    bearings: [],
    asked: [],
    documents: [],
    ending: null,
    confidence: null,
    verdict: null,
    endingsSeen: [],
    attempts: 0,
  };
}

const EVIDENCE_IDS = new Set<string>(EVIDENCE_ORDER);
const DOC_IDS = new Set<string>(FIELD_NOTES.map((d) => d.id));
const ENDING_IDS = new Set<string>(Object.keys(ENDINGS));

function list<T extends string>(value: unknown, allowed: Set<string> | ((s: string) => boolean)): T[] {
  if (!Array.isArray(value)) return [];
  const ok = typeof allowed === "function" ? allowed : (s: string) => allowed.has(s);
  const out: T[] = [];
  for (const v of value) if (typeof v === "string" && ok(v) && !out.includes(v as T)) out.push(v as T);
  return out;
}

/** Read a saved case, keeping whatever is valid and dropping the rest. */
export function parseCase(text: string | null): CaseData {
  const base = emptyCase();
  if (!text) return base;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return base;
  }
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return base;
  const stage: CaseStage =
    r.stage === "investigating" || r.stage === "closed" || r.stage === "briefing" ? r.stage : "briefing";
  const ending = typeof r.ending === "string" && ENDING_IDS.has(r.ending) ? (r.ending as EndingId) : null;
  const confidence = CONFIDENCE_CHOICES.find((c) => c === r.confidence) ?? null;
  const verdict = r.verdict === "accept" || r.verdict === "reject" || r.verdict === "abstain" ? r.verdict : null;
  const collected = list<EvidenceId>(r.collected, EVIDENCE_IDS);
  return {
    v: 1,
    found: r.found === true,
    // A closed case needs an ending to show; without one it is still open.
    stage: stage === "closed" && !ending ? "investigating" : stage,
    collected,
    weighed: list<EvidenceId>(r.weighed, (s) => collected.includes(s as EvidenceId)),
    bearings: list<PostId>(r.bearings, (s) => s === "a" || s === "b"),
    asked: list<string>(r.asked, (s) => /^[a-z]+:[a-z-]+$/.test(s)).slice(0, 32),
    documents: list<DocumentId>(r.documents, DOC_IDS),
    ending,
    confidence,
    verdict,
    endingsSeen: list<EndingId>(r.endingsSeen, ENDING_IDS),
    attempts: typeof r.attempts === "number" && r.attempts >= 0 ? Math.min(999, Math.floor(r.attempts)) : 0,
  };
}

export function serialiseCase(data: CaseData): string {
  return JSON.stringify(data);
}

export interface Objective {
  id: "witness" | "bearings" | "crossing" | "logger" | "verdict";
  label: string;
  done: boolean;
  optional?: boolean;
}

/** What the player has left to do, in the order the HUD lists it. */
export function objectives(data: CaseData): Objective[] {
  const has = (id: EvidenceId) => data.collected.includes(id);
  const out: Objective[] = [
    { id: "witness", label: "Hear Mara Quill's side", done: has("witness") },
    {
      id: "bearings",
      label: `Take a bearing at both survey posts (${data.bearings.length}/2)`,
      done: data.bearings.length >= 2,
    },
  ];
  if (data.bearings.length >= 2 || has("sonde"))
    out.push({ id: "crossing", label: "Find what sits where the bearings cross", done: has("sonde") });
  out.push(
    { id: "logger", label: "Read truck U-2's engine logger", done: has("logger") },
    { id: "verdict", label: "Hand in a verdict at the van", done: data.stage === "closed" },
  );
  return out;
}

/** The three observations R.A.I.N. asked for are all in. */
export function observationsComplete(data: CaseData): boolean {
  const has = (id: EvidenceId) => data.collected.includes(id);
  return has("witness") && has("logger") && (has("sonde") || has("bearings"));
}

// --- Steps ------------------------------------------------------------------------
// Each returns true when it changed the file.

export function markFound(data: CaseData): boolean {
  if (data.found) return false;
  data.found = true;
  return true;
}

export function beginInvestigation(data: CaseData): boolean {
  if (data.stage !== "briefing") return false;
  data.stage = "investigating";
  return true;
}

export function collect(data: CaseData, id: EvidenceId): boolean {
  if (data.collected.includes(id)) return false;
  data.collected.push(id);
  // New evidence starts on the board as weighed, except the re-run, which the
  // player has to choose to count.
  if (id !== "rerun" && !data.weighed.includes(id)) data.weighed.push(id);
  return true;
}

export function logBearing(data: CaseData, post: PostId): boolean {
  if (data.bearings.includes(post)) return false;
  data.bearings.push(post);
  if (data.bearings.length >= 2) collect(data, "bearings");
  return true;
}

export function ask(data: CaseData, key: string): boolean {
  if (data.asked.includes(key)) return false;
  data.asked.push(key);
  return true;
}

export function readDocument(data: CaseData, id: DocumentId): boolean {
  if (data.documents.includes(id)) return false;
  data.documents.push(id);
  return true;
}

export function toggleWeighed(data: CaseData, id: EvidenceId): boolean {
  if (!data.collected.includes(id)) return false;
  const at = data.weighed.indexOf(id);
  if (at >= 0) data.weighed.splice(at, 1);
  else data.weighed.push(id);
  return true;
}

/**
 * Hand in a verdict. "Not yet" (abstaining on thin evidence) leaves the case
 * open; every other ending closes it.
 */
export function submitVerdict(data: CaseData, verdict: Verdict, confidence: Confidence): Audit {
  const audit = gradeVerdict({ verdict, weighed: data.weighed, confidence });
  data.attempts += 1;
  data.verdict = verdict;
  data.confidence = confidence;
  data.ending = audit.ending;
  if (!data.endingsSeen.includes(audit.ending)) data.endingsSeen.push(audit.ending);
  data.stage = ENDINGS[audit.ending].closes ? "closed" : "investigating";
  return audit;
}

/** Start the case again from the briefing, keeping the notes and endings found. */
export function replayCase(data: CaseData): void {
  const keep = { documents: data.documents, endingsSeen: data.endingsSeen, attempts: data.attempts };
  Object.assign(data, emptyCase(), { found: true }, keep);
}

/** The audit for the verdict on file, if any. */
export function auditOnFile(data: CaseData): Audit | null {
  if (!data.verdict || !data.confidence) return null;
  return gradeVerdict({ verdict: data.verdict, weighed: data.weighed, confidence: data.confidence });
}
