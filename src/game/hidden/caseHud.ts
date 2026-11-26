import type { FieldRun } from "./expeditions";
import type { Objective } from "./caseFile";
import type {
  Confidence,
  DocumentId,
  EndingId,
  EvidenceId,
  EvidenceLine,
  PostId,
  SpeakerId,
  Verdict,
} from "./story";

/**
 * What the case shows on screen, as one immutable snapshot that React reads
 * through useSyncExternalStore. The case replaces the snapshot only when
 * something visible changed, so walking around re-renders nothing.
 */

export interface CaseCaption {
  id: number;
  speaker: SpeakerId;
  text: string;
}

export type CasePanel =
  | { kind: "field"; station: string | null; chapter: number }
  | { kind: "receipt"; title: string; text: string }
  | { kind: "dialog"; speaker: SpeakerId; line: string; options: { id: string; label: string; asked: boolean }[] }
  | { kind: "board" }
  | { kind: "note"; id: DocumentId; title: string; body: string }
  | { kind: "file" }
  | { kind: "ending" };

export interface BoardCard {
  id: EvidenceId;
  title: string;
  source: string;
  summary: string;
  line: EvidenceLine;
  weighed: boolean;
}

export interface CaseSnapshot {
  active: boolean;
  /** The title card is up (the camera is circling the van). */
  title: boolean;
  stage: "briefing" | "investigating" | "closed";
  objectives: Objective[];
  expeditions: FieldRun[];
  guidance: string;
  rover: {message: string; autonomous: boolean; complete: boolean; choices: {label: string; target: string}[]} | null;
  calibration: boolean;
  radioEnabled: boolean;
  /** Metres to the bearings' crossing, once both are taken and until it is found. */
  crossingDistance: number | null;
  caption: CaseCaption | null;
  /** A bearing settling at a post: 0 … 1. */
  bearing: { post: PostId; progress: number; moved: boolean } | null;
  panel: CasePanel | null;
  board: BoardCard[];
  verdict: Verdict | null;
  confidence: Confidence | null;
  ending: EndingId | null;
  auditNotes: string[];
  documents: DocumentId[];
  endingsSeen: EndingId[];
  toast: { id: number; text: string } | null;
}

export class CaseHudStore {
  private snapshot: CaseSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(initial: CaseSnapshot) {
    this.snapshot = initial;
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  readonly getSnapshot = (): CaseSnapshot => this.snapshot;

  set(next: CaseSnapshot): void {
    this.snapshot = next;
    for (const fn of this.listeners) fn();
  }
}
