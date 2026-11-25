import * as THREE from "three";
import type { Game, GameLayer } from "../Game";
import type { InputState } from "../core/Input";
import { GameplayState } from "../core/GameState";
import type { InteractionOffer } from "../interaction/InteractionManager";
import type { KeyValueStorage } from "../afterhours/progress";
import {
  CASE_STORAGE_KEY,
  auditOnFile,
  ask,
  beginInvestigation,
  collect,
  logBearing,
  markFound,
  mergeCase,
  objectives,
  observationsComplete,
  parseCase,
  readDocument,
  replayCase,
  serialiseCase,
  submitVerdict,
  toggleWeighed,
  type CaseData,
} from "./caseFile";
import { CaseHudStore, type BoardCard, type CaseCaption, type CasePanel, type CaseSnapshot } from "./caseHud";
import { HiddenCaseVisuals, type PersonPose } from "./HiddenCaseVisuals";
import {
  BEARING_SETTLE,
  BRIEFING,
  CHRISTOPHER,
  CHRISTOPHER_HINTS,
  ENDINGS,
  EVIDENCE,
  EVIDENCE_ORDER,
  FIELD_NOTES,
  FLAGGED_VEHICLE,
  MARA_OPENING,
  MARA_PACE,
  MARA_PAUSE,
  MARA_ROUTE,
  MARA_TOPICS,
  POSTS,
  POST_BEARINGS,
  RADIO,
  RANGES,
  SONDE,
  TOBIN,
  TOBIN_OPENING,
  TOBIN_TOPICS,
  VAN,
  VAN_BOARD,
  VAN_STAND,
  crossing,
  type Confidence,
  type DocumentId,
  type EvidenceId,
  type PostId,
  type SpeakerId,
  type Topic,
  type Verdict,
} from "./story";

const TITLE_SECONDS = 6.5;
const MOVEMENT_OWNER = "hidden-case";
const TITLE_OWNER = "hidden-case-title";

interface QueuedLine {
  speaker: SpeakerId;
  text: string;
  seconds: number;
}

type Who = "mara" | "tobin";

/**
 * The hidden case, run as a layer on the live game. Loaded only after the
 * visitor accepts the transmission, so an ordinary visit never downloads it.
 * It adds people, props and prompts on top of the reconstruction and reads
 * the player's position; it never changes movement, vehicle physics,
 * collision or the surveyed site data, and it stops After Hours or Free Roam
 * before it starts, because all three share the avatar.
 */
export class HiddenCase implements GameLayer {
  readonly data: CaseData;
  readonly hud: CaseHudStore;
  readonly visuals: HiddenCaseVisuals | null;
  active = false;
  /** Asked to free the mouse while a panel is up (the HUD recaptures it from a click). */
  onPointer: ((free: boolean) => void) | null = null;

  private removeLayer: (() => void) | null = null;
  private time = 0;
  private titleLeft = 0;
  private caption: (CaseCaption & { left: number }) | null = null;
  private readonly queue: QueuedLine[] = [];
  private captionSeq = 0;
  private toast: { id: number; text: string; left: number } | null = null;
  private panel: CasePanel | null = null;
  private dialogWho: Who | null = null;
  private auditNotes: string[] = [];
  private settle: { post: PostId; progress: number; x: number; z: number; moved: boolean } | null = null;
  private maraClock = 0;
  private sondeNearSaid = false;
  private carrier = 0;
  private flaggedDrivenThisVisit = false;
  private crossingPoint: { x: number; z: number } | null = null;
  private crossingShown: number | null = null;
  private dirty = true;
  /** The file text this tab last read or wrote, to notice another tab's save. */
  private lastText: string | null = null;
  /** Whether play is on screen (switching to a survey view hides the case's props). */
  private viewing = true;
  private readonly offer: InteractionOffer = { label: "", distance: 0, priority: true, act: () => undefined };
  private readonly poses: Record<"christopher" | "mara" | "tobin", PersonPose> = {
    christopher: { x: CHRISTOPHER.x, z: CHRISTOPHER.z, yaw: CHRISTOPHER.yaw, speed: 0 },
    mara: { x: MARA_ROUTE[0].x, z: MARA_ROUTE[0].z, yaw: MARA_ROUTE[0].yaw, speed: 0 },
    tobin: { x: TOBIN.x, z: TOBIN.z, yaw: TOBIN.yaw, speed: 0 },
  };
  private readonly loggerAt = new THREE.Vector3();
  private readonly camTarget = new THREE.Vector3();
  private orbit = 0;
  private audio: CaseAudio | null = null;

  constructor(
    private readonly game: Game,
    private readonly storage: KeyValueStorage | null,
    visuals: boolean,
  ) {
    this.lastText = this.readStored();
    this.data = parseCase(this.lastText);
    this.hud = new CaseHudStore(this.buildSnapshot());
    this.visuals = visuals ? new HiddenCaseVisuals((x, z) => game.ground.heightAt(x, z)) : null;
    if (this.visuals) game.root.add(this.visuals.root);
    if (this.data.bearings.length >= 2) this.crossingPoint = this.computeCrossing();
  }

  // --- Lifecycle ------------------------------------------------------------------

  /** Start or resume the case at the van (from the click that accepted it). */
  start(): void {
    if (this.active) return;
    const g = this.game;
    if (g.freeRoam.active) g.roam.stop();
    if (g.afterHours.active) g.afterHours.stop();
    this.syncFromStorage();
    markFound(this.data);
    g.resetForScenario(VAN_STAND);
    this.removeLayer = g.addLayer(this);
    if (!g.interaction.providers.includes(this.provide)) g.interaction.providers.push(this.provide);
    this.active = true;
    this.visuals?.setActive(this.viewing);
    this.flaggedDrivenThisVisit = false;
    this.sondeNearSaid = this.data.collected.includes("sonde");
    this.ensureAudio();
    if (this.data.stage === "briefing") {
      this.titleLeft = TITLE_SECONDS;
      g.lockMovement(TITLE_OWNER, true);
      this.orbit = 0;
      this.queue.length = 0;
      for (const line of BRIEFING) this.queue.push({ ...line });
    } else if (this.data.stage === "closed") {
      this.say("christopher", CHRISTOPHER_HINTS.closed, 5);
    } else {
      this.say("rain", "Back on the ground. The board kept everything you brought in.", 4);
      this.say("christopher", this.hint(), 5);
    }
    this.save();
    this.dirty = true;
    this.publish();
  }

  /** Leave the case (its file is saved). */
  stop(): void {
    if (!this.active) return;
    const g = this.game;
    this.removeLayer?.();
    this.removeLayer = null;
    const at = g.interaction.providers.indexOf(this.provide);
    if (at >= 0) g.interaction.providers.splice(at, 1);
    g.lockMovement(MOVEMENT_OWNER, false);
    g.lockMovement(TITLE_OWNER, false);
    this.visuals?.setActive(false);
    this.active = false;
    this.titleLeft = 0;
    this.panel = null;
    this.dialogWho = null;
    this.settle = null;
    this.caption = null;
    this.queue.length = 0;
    this.audio?.carrier(0);
    this.save();
    this.dirty = true;
    this.publish();
  }

  /** Show or hide the case's props with play (a survey view shows Pine Gap alone). */
  setViewing(viewing: boolean): void {
    this.viewing = viewing;
    this.visuals?.setActive(this.active && viewing);
  }

  dispose(): void {
    this.stop();
    this.audio?.dispose();
    this.visuals?.dispose();
  }

  // --- Layer hooks ------------------------------------------------------------------

  update(dt: number, input: InputState): void {
    if (!this.active) return;
    this.time += dt;
    if (this.titleLeft > 0) {
      this.titleLeft -= dt;
      // E or Space skips the card.
      if (this.titleLeft < TITLE_SECONDS - 1.5 && (input.wasPressed("interact") || input.wasPressed("jump")))
        this.titleLeft = 0;
      if (this.titleLeft <= 0) this.endTitle();
    }
    if (this.toast) {
      this.toast.left -= dt;
      if (this.toast.left <= 0) {
        this.toast = null;
        this.dirty = true;
      }
    }
    if (!this.audio) this.ensureAudio();
    this.advanceCaptions(dt);
    this.updatePeople(dt);
    this.updateBearing(dt);
    this.updateField();
    this.publish();
  }

  present(dt: number): void {
    if (!this.active || !this.visuals) return;
    const truck = this.game.vehicles.vehicles[FLAGGED_VEHICLE];
    this.visuals.update(dt, {
      time: this.time,
      christopher: this.poses.christopher,
      mara: this.poses.mara,
      tobin: this.poses.tobin,
      bearings: this.data.bearings,
      crossing: this.crossingPoint,
      sondeFound: this.data.collected.includes("sonde"),
      carrier: this.carrier,
      documentsRead: this.data.documents,
      boardOpen: this.data.stage === "investigating",
      loggerAt: truck ? truck.bodyToWorld(0.45, 0.75, -2.47, this.loggerAt) : null,
      loggerRead: this.data.collected.includes("logger"),
      reducedMotion: false,
    });
  }

  cinematic(dt: number, camera: THREE.PerspectiveCamera): boolean {
    if (!this.active) return false;
    const ending = this.panel?.kind === "ending";
    if (this.titleLeft <= 0 && !ending) return false;
    this.orbit += dt * (ending ? 0.06 : 0.11);
    const radius = ending ? 34 : 15;
    const height = ending ? 16 : 4.2;
    const y = this.game.ground.heightAt(VAN.x, VAN.z);
    const angle = 2.2 + this.orbit;
    camera.position.set(VAN.x + Math.sin(angle) * radius, y + height, VAN.z + Math.cos(angle) * radius);
    this.camTarget.set(VAN.x, y + 1.6, VAN.z);
    camera.lookAt(this.camTarget);
    return true;
  }

  // --- What the player can use ------------------------------------------------------

  private readonly provide = (x: number, _y: number, z: number): InteractionOffer | null => {
    if (!this.active || this.titleLeft > 0 || this.panel) return null;
    let best: { label: string; distance: number; act: () => void; id: string } | null = null;
    const consider = (id: string, px: number, pz: number, range: number, label: string, act: () => void) => {
      const d = Math.hypot(px - x, pz - z);
      if (d > range || (best && d >= best.distance)) return;
      best = { id, label, distance: d, act };
    };
    const has = (id: EvidenceId) => this.data.collected.includes(id);

    consider(
      "case:board",
      VAN_BOARD.x,
      VAN_BOARD.z,
      RANGES.van,
      this.data.stage === "closed" ? "Read the verdict" : "Open the evidence board",
      () => this.openBoard(),
    );
    const c = this.poses.christopher;
    consider("case:christopher", c.x, c.z, RANGES.talk, "Talk to Christopher", () => this.talkToChristopher());
    const m = this.poses.mara;
    consider("case:mara", m.x, m.z, RANGES.talk, "Talk to Mara Quill", () => this.openDialog("mara"));
    const t = this.poses.tobin;
    consider("case:tobin", t.x, t.z, RANGES.talk, "Talk to the SureThing rep", () => this.openDialog("tobin"));
    for (const id of ["a", "b"] as PostId[]) {
      if (this.data.bearings.includes(id) || this.settle?.post === id) continue;
      const p = POSTS[id];
      consider(`case:post-${id}`, p.x, p.z, RANGES.post, "Take a bearing (then hold still)", () =>
        this.beginBearing(id),
      );
    }
    if (!has("sonde"))
      consider("case:sonde", SONDE.x, SONDE.z, RANGES.sonde, "Examine the payload", () => this.examineSonde());
    const truck = this.game.vehicles.vehicles[FLAGGED_VEHICLE];
    if (truck && !truck.driven && !has("logger")) {
      const p = truck.physics;
      const rx = p.x - Math.sin(p.yaw) * 2.7;
      const rz = p.z - Math.cos(p.yaw) * 2.7;
      consider("case:logger", rx, rz, RANGES.logger, "Read the engine logger", () => this.readLogger());
    }
    for (const note of FIELD_NOTES) {
      if (this.data.documents.includes(note.id)) continue;
      consider(`case:note-${note.id}`, note.at.x, note.at.z, RANGES.document, "Read the field note", () =>
        this.openNote(note.id),
      );
    }
    const chosen = best as { label: string; distance: number; act: () => void; id: string } | null;
    if (!chosen) return null;
    this.offer.id = chosen.id;
    this.offer.label = chosen.label;
    this.offer.distance = chosen.distance;
    this.offer.act = chosen.act;
    return this.offer;
  };

  // --- Actions (from prompts and from the HUD) --------------------------------------

  private talkToChristopher(): void {
    this.say("christopher", this.hint(), 5.5);
  }

  private hint(): string {
    const d = this.data;
    if (d.stage === "closed") return CHRISTOPHER_HINTS.closed;
    if (observationsComplete(d) && d.collected.includes("sonde")) return CHRISTOPHER_HINTS.ready;
    if (d.bearings.length >= 2 && !d.collected.includes("sonde")) return CHRISTOPHER_HINTS.bearings;
    if (d.collected.length > 0) return CHRISTOPHER_HINTS.some;
    return CHRISTOPHER_HINTS.start;
  }

  openDialog(who: Who): void {
    if (!this.active) return;
    this.dialogWho = who;
    const opening = who === "mara" ? MARA_OPENING : TOBIN_OPENING;
    this.openPanel(this.dialogPanel(who, opening));
  }

  private dialogPanel(who: Who, line: string): CasePanel {
    const topics = who === "mara" ? MARA_TOPICS : TOBIN_TOPICS;
    return {
      kind: "dialog",
      speaker: who,
      line,
      options: [
        ...topics.map((t) => ({ id: t.id, label: t.ask, asked: this.data.asked.includes(`${who}:${t.id}`) })),
        { id: "leave", label: "That's all for now.", asked: false },
      ],
    };
  }

  /** Pick a line in the open conversation. */
  choose(optionId: string): void {
    const who = this.dialogWho;
    if (!who || this.panel?.kind !== "dialog") return;
    if (optionId === "leave") {
      this.closePanel();
      return;
    }
    const topics: readonly Topic[] = who === "mara" ? MARA_TOPICS : TOBIN_TOPICS;
    const topic = topics.find((t) => t.id === optionId);
    if (!topic) return;
    ask(this.data, `${who}:${topic.id}`);
    if (topic.gives) this.gain(topic.gives);
    this.panel = this.dialogPanel(who, topic.answer);
    this.save();
    this.dirty = true;
    this.publish();
  }

  private beginBearing(post: PostId): void {
    const p = this.game.player.position;
    this.settle = { post, progress: 0, x: p.x, z: p.z, moved: false };
    this.audio?.chirp(0.4);
    this.dirty = true;
  }

  private examineSonde(): void {
    if (this.gain("sonde")) this.say("rain", RADIO.sonde, 6);
  }

  private readLogger(): void {
    if (!this.gain("logger")) return;
    this.say(
      "rain",
      this.flaggedDrivenThisVisit
        ? "The last ignition on that log is yours, a few minutes ago. Before you, nothing since 21:50."
        : RADIO.logger,
      5.5,
    );
  }

  openNote(id: DocumentId): void {
    const note = FIELD_NOTES.find((n) => n.id === id);
    if (!note || !this.active) return;
    const first = readDocument(this.data, id);
    this.openPanel({ kind: "note", id, title: note.title, body: note.body });
    if (first) {
      this.audio?.chime();
      this.showToast(`Field note ${this.data.documents.length}/${FIELD_NOTES.length}: ${note.title}`);
      if (this.data.documents.length === FIELD_NOTES.length) this.say("rain", RADIO.allDocs, 4.5);
    }
    this.save();
  }

  openBoard(): void {
    if (!this.active) return;
    if (this.data.stage === "closed") {
      this.auditNotes = auditOnFile(this.data)?.notes ?? [];
      this.openPanel({ kind: "ending" });
      return;
    }
    this.openPanel({ kind: "board" });
    if (!this.data.asked.includes("van:board")) {
      ask(this.data, "van:board");
      this.save();
    }
  }

  openFile(): void {
    if (!this.active || this.titleLeft > 0) return;
    // A panel holds the player still on foot, but not a truck: read the file parked and out.
    if (this.game.vehicles.vehicles.some((v) => v.driven)) {
      this.showToast("Step out of the vehicle to read the case file.");
      this.publish();
      return;
    }
    this.openPanel({ kind: "file" });
  }

  toggleWeigh(id: EvidenceId): void {
    if (this.data.stage !== "investigating") return;
    if (toggleWeighed(this.data, id)) {
      this.save();
      this.dirty = true;
      this.publish();
    }
  }

  submit(verdict: Verdict, confidence: Confidence): void {
    if (!this.active || this.data.stage !== "investigating" || this.panel?.kind !== "board") return;
    const audit = submitVerdict(this.data, verdict, confidence);
    this.auditNotes = audit.notes;
    this.orbit = 0;
    this.panel = { kind: "ending" };
    this.audio?.chirp(1);
    this.save();
    this.dirty = true;
    this.publish();
  }

  /** Start again from the briefing (field notes and endings seen are kept). */
  replay(): void {
    if (!this.active) return;
    replayCase(this.data);
    this.crossingPoint = null;
    this.save();
    this.stop();
    this.start();
  }

  closePanel(): void {
    if (!this.panel) return;
    this.panel = null;
    this.dialogWho = null;
    this.game.lockMovement(MOVEMENT_OWNER, false);
    this.onPointer?.(false);
    this.dirty = true;
    this.publish();
  }

  private openPanel(panel: CasePanel): void {
    this.panel = panel;
    this.settle = null;
    this.game.lockMovement(MOVEMENT_OWNER, true);
    this.game.input.releaseAll();
    this.onPointer?.(true);
    this.dirty = true;
    this.publish();
  }

  // --- Per-frame -----------------------------------------------------------------------

  private endTitle(): void {
    this.titleLeft = 0;
    this.game.lockMovement(TITLE_OWNER, false);
    beginInvestigation(this.data);
    this.save();
    this.dirty = true;
  }

  private updatePeople(dt: number): void {
    const p = this.game.player.position;
    const talking = this.panel?.kind === "dialog" ? this.dialogWho : null;
    // Mara walks her cable run unless she is talking to you.
    const mara = this.poses.mara;
    if (talking === "mara") {
      mara.speed = 0;
      mara.yaw = Math.atan2(p.x - mara.x, p.z - mara.z);
    } else {
      this.maraClock += dt;
      routePose(this.maraClock, mara);
    }
    for (const who of ["christopher", "tobin"] as const) {
      const pose = this.poses[who];
      const home = who === "christopher" ? CHRISTOPHER : TOBIN;
      const near = Math.hypot(p.x - pose.x, p.z - pose.z) < 9;
      const want = near ? Math.atan2(p.x - pose.x, p.z - pose.z) : home.yaw;
      pose.yaw = turnTowards(pose.yaw, want, dt * 3);
      pose.speed = 0;
    }
  }

  private updateBearing(dt: number): void {
    const s = this.settle;
    if (!s) return;
    const g = this.game;
    const p = g.player.position;
    const post = POSTS[s.post];
    if (Math.hypot(p.x - post.x, p.z - post.z) > RANGES.post + 2.5 || g.interaction.state !== GameplayState.OnFoot) {
      this.settle = null;
      this.showToast("Bearing abandoned. Come back to the post and try again.");
      this.dirty = true;
      return;
    }
    const drifted = Math.hypot(p.x - s.x, p.z - s.z) > RANGES.postDrift || g.player.speed > 0.35;
    if (drifted) {
      if (!s.moved || s.progress > 0) this.dirty = true;
      s.moved = true;
      s.progress = 0;
      s.x = p.x;
      s.z = p.z;
      return;
    }
    const before = Math.floor(s.progress * 20);
    s.progress = Math.min(1, s.progress + dt / BEARING_SETTLE);
    if (Math.floor(s.progress * 20) !== before) this.dirty = true;
    if (s.progress < 1) return;
    this.settle = null;
    logBearing(this.data, s.post);
    this.audio?.chime();
    this.showToast(`${POSTS[s.post].label}: carrier bearing ${POST_BEARINGS[s.post]}°`);
    if (this.data.bearings.length >= 2) {
      this.crossingPoint = this.computeCrossing();
      this.showToast("Two bearings logged. The lines cross north of the halls.");
      this.say("rain", RADIO.bothBearings, 6);
    } else {
      this.say("rain", RADIO.firstBearing, 4.5);
    }
    this.save();
    this.dirty = true;
  }

  private computeCrossing(): { x: number; z: number } | null {
    return crossing(POSTS.a, POST_BEARINGS.a, POSTS.b, POST_BEARINGS.b);
  }

  private updateField(): void {
    const g = this.game;
    const f = g.focusPoint;
    const truck = g.vehicles.vehicles[FLAGGED_VEHICLE];
    if (truck?.driven) this.flaggedDrivenThisVisit = true;
    const toSonde = Math.hypot(f.x - SONDE.x, f.z - SONDE.z);
    const listening = this.data.bearings.length > 0 || this.data.collected.includes("sonde");
    this.carrier = listening ? Math.max(0, 1 - toSonde / 320) : Math.max(0, 1 - toSonde / 60);
    this.audio?.carrier(this.panel ? this.carrier * 0.3 : this.carrier);
    if (!this.sondeNearSaid && toSonde < RANGES.sondeNotice) {
      this.sondeNearSaid = true;
      this.say("rain", RADIO.sondeNear, 4.5);
    }
    let shown: number | null = null;
    if (this.crossingPoint && !this.data.collected.includes("sonde")) {
      shown = Math.round(Math.hypot(f.x - this.crossingPoint.x, f.z - this.crossingPoint.z) / 10) * 10;
    }
    if (shown !== this.crossingShown) {
      this.crossingShown = shown;
      this.dirty = true;
    }
  }

  private gain(id: EvidenceId): boolean {
    if (!collect(this.data, id)) return false;
    this.audio?.chime();
    this.showToast(`On the board: ${EVIDENCE[id].title}`);
    if (id === "witness") this.say("rain", RADIO.witness, 4.5);
    if (id === "rerun") this.say("rain", RADIO.rerun, 4);
    if (observationsComplete(this.data) && this.data.collected.includes("sonde"))
      this.say("christopher", CHRISTOPHER_HINTS.ready, 4.5);
    this.save();
    this.dirty = true;
    return true;
  }

  // --- Captions, toasts, snapshot ---------------------------------------------------

  private say(speaker: SpeakerId, text: string, seconds: number): void {
    if (this.queue.length > 4) this.queue.shift();
    this.queue.push({ speaker, text, seconds });
  }

  private advanceCaptions(dt: number): void {
    // Captions wait while the title card or a panel hides them, so none expires unseen.
    if (this.titleLeft > 0 || this.panel) return;
    if (this.caption) {
      this.caption.left -= dt;
      if (this.caption.left > 0) return;
      this.caption = null;
      this.dirty = true;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.caption = { id: ++this.captionSeq, speaker: next.speaker, text: next.text, left: next.seconds };
    if (next.speaker === "rain" || next.speaker === "certain") this.audio?.chirp(0.7);
    this.dirty = true;
  }

  private showToast(text: string): void {
    this.toast = { id: ++this.captionSeq, text, left: 3.5 };
    this.dirty = true;
  }

  private publish(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.hud.set(this.buildSnapshot());
  }

  private buildSnapshot(): CaseSnapshot {
    const d = this.data;
    const board: BoardCard[] = EVIDENCE_ORDER.filter((id) => d.collected.includes(id)).map((id) => ({
      ...EVIDENCE[id],
      weighed: d.weighed.includes(id),
    }));
    return {
      active: this.active,
      title: this.titleLeft > 0,
      stage: d.stage,
      objectives: objectives(d),
      crossingDistance: this.crossingShown,
      caption: this.caption ? { id: this.caption.id, speaker: this.caption.speaker, text: this.caption.text } : null,
      bearing: this.settle ? { post: this.settle.post, progress: this.settle.progress, moved: this.settle.moved } : null,
      panel: this.panel,
      board,
      verdict: d.verdict,
      confidence: d.confidence,
      ending: d.ending,
      auditNotes: this.auditNotes,
      documents: [...d.documents],
      endingsSeen: [...d.endingsSeen],
      toast: this.toast ? { id: this.toast.id, text: this.toast.text } : null,
    };
  }

  private readStored(): string | null {
    try {
      return this.storage?.getItem(CASE_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fold in a save another tab made since this one last read or wrote, so a
   * stale tab never overwrites newer progress.
   */
  private syncFromStorage(): void {
    const stored = this.readStored();
    if (stored === null || stored === this.lastText) return;
    Object.assign(this.data, mergeCase(this.data, parseCase(stored)));
    this.lastText = stored;
    this.crossingPoint = this.data.bearings.length >= 2 ? this.computeCrossing() : null;
    this.dirty = true;
  }

  private save(): void {
    this.syncFromStorage();
    const text = serialiseCase(this.data);
    try {
      this.storage?.setItem(CASE_STORAGE_KEY, text);
      this.lastText = text;
    } catch {
      // Storage full or blocked: the case still plays, it just won't be there next visit.
    }
  }

  private ensureAudio(): void {
    if (this.audio || !this.game.audio) return;
    const ctx = this.game.audio.context;
    const bus = this.game.audio.sfxBus;
    if (ctx && bus) this.audio = new CaseAudio(ctx, bus);
  }

  /** The ending on file, for the HUD. */
  get endingInfo() {
    return this.data.ending ? ENDINGS[this.data.ending] : null;
  }
}

/** Mara's position on her inspection run at time `t` (deterministic). */
export function routePose(t: number, out: PersonPose): PersonPose {
  const [a, b] = MARA_ROUTE;
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const walk = length / MARA_PACE;
  const leg = walk + MARA_PAUSE;
  const phase = ((t % (leg * 2)) + leg * 2) % (leg * 2);
  const outbound = phase < leg;
  const local = outbound ? phase : phase - leg;
  const from = outbound ? a : b;
  const to = outbound ? b : a;
  const k = Math.min(1, local / walk);
  out.x = from.x + (to.x - from.x) * k;
  out.z = from.z + (to.z - from.z) * k;
  const heading = Math.atan2(to.x - from.x, to.z - from.z);
  if (local < walk) {
    out.speed = MARA_PACE;
    out.yaw = heading;
  } else {
    // Paused at the end of the run, checking a cable box.
    out.speed = 0;
    out.yaw = heading + Math.PI * 0.5;
  }
  return out;
}

function turnTowards(from: number, to: number, step: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + Math.max(-step, Math.min(step, d));
}

/**
 * Procedural sounds for the case: a radio squelch when R.A.I.N. speaks, a
 * soft chime for new evidence, and the carrier itself, a thin warbling tone
 * that grows as you close on its source.
 */
class CaseAudio {
  private readonly tone: OscillatorNode;
  private readonly wobble: OscillatorNode;
  private readonly toneGain: GainNode;

  constructor(
    private readonly ctx: AudioContext,
    private readonly bus: AudioNode,
  ) {
    this.tone = ctx.createOscillator();
    this.tone.type = "sine";
    this.tone.frequency.value = 1420.4 / 2;
    this.wobble = ctx.createOscillator();
    this.wobble.frequency.value = 5.3;
    const depth = ctx.createGain();
    depth.gain.value = 9;
    this.wobble.connect(depth).connect(this.tone.frequency);
    this.toneGain = ctx.createGain();
    this.toneGain.gain.value = 0;
    this.tone.connect(this.toneGain).connect(bus);
    this.tone.start();
    this.wobble.start();
  }

  carrier(level: number): void {
    this.toneGain.gain.setTargetAtTime(0.035 * level * level, this.ctx.currentTime, 0.3);
  }

  chirp(level: number): void {
    const t = this.ctx.currentTime;
    for (const [f, at] of [
      [1180, 0],
      [880, 0.07],
    ] as const) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = "square";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + at);
      g.gain.linearRampToValueAtTime(0.025 * level, t + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.08);
      o.connect(g).connect(this.bus);
      o.start(t + at);
      o.stop(t + at + 0.1);
    }
  }

  chime(): void {
    const t = this.ctx.currentTime;
    [660, 990].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.09);
      g.gain.linearRampToValueAtTime(0.05, t + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.6);
      o.connect(g).connect(this.bus);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.65);
    });
  }

  dispose(): void {
    try {
      this.tone.stop();
      this.wobble.stop();
    } catch {
      // Already stopped.
    }
    this.toneGain.disconnect();
  }
}
