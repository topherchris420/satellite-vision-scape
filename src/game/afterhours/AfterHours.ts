import * as THREE from "three";
import type { TimeOfDay } from "../Game";
import { AfterHoursAudio, type CueSound } from "../audio/AfterHoursAudio";
import type { GameAudio } from "../audio/GameAudio";
import { createScoreTargets } from "../audio/ProceduralScore";
import type { RadioAudioFrame, RadioPlaybackStatus } from "../audio/RadioAudio";
import type { ThirdPersonCamera } from "../camera/ThirdPersonCamera";
import { clamp, damp, headingOf, smoothstep } from "../core/math";
import type { EventBus } from "../core/EventBus";
import type { GameEvents } from "../core/events";
import { GameplayState } from "../core/GameState";
import type { InputState } from "../core/Input";
import type { InteractionManager, InteractionOffer } from "../interaction/InteractionManager";
import type { PlayerController } from "../player/PlayerController";
import { Locomotion } from "../player/PlayerState";
import type { Vehicle } from "../vehicles/Vehicle";
import type { VehicleManager } from "../vehicles/VehicleManager";
import { VEHICLE_SPAWNS } from "../world/spawns";
import {
  AfterHoursHud,
  type AfterHoursSnapshot,
  type Caption,
  type CaptionKind,
} from "./AfterHoursHud";
import { Announcer, type AnnouncementId } from "./announcements";
import { COFFEE, CoffeeMission, type Carrier } from "./coffee";
import { BEAT_SECONDS } from "./composition";
import { CONCERT, ConcertLogic } from "./concert";
import { NumbersStation } from "./numbers";
import {
  LAYER_IDS,
  ProgressStore,
  concertUnlocked,
  stageOf,
  terminalsTuned,
  type CharacterKind,
  type KeyValueStorage,
  type LayerId,
  type Preferences,
  type StationId,
} from "./progress";
import { LAYERS, TuningSession } from "./puzzle";
import { RadioLogic, type RadioEvent } from "./radio";
import {
  COFFEE_CART,
  DELIVERY,
  LISTENING_POINT,
  RECORD_ZERO,
  RANGES,
  TERMINAL_SITES,
  type Site,
} from "./sites";
import { GREEN_MACHINE, trackIndexById } from "./soundtrack";
import type { AfterHoursVisuals, VisualState } from "./AfterHoursVisuals";

/** What After Hours needs from the game (implemented by `Game`). */
export interface AfterHoursHost {
  readonly events: EventBus<GameEvents>;
  readonly interaction: InteractionManager;
  readonly player: PlayerController;
  readonly vehicles: VehicleManager;
  readonly camera: ThirdPersonCamera;
  readonly audio: GameAudio | null;
  readonly root: THREE.Group;
  readonly timeOfDay: TimeOfDay;
  setCharacterKind(kind: CharacterKind): void;
  setCarrying(carrying: boolean): void;
  setDustTint(color: string | null): void;
  lockMovement(owner: string, locked: boolean): void;
  controlSource(): "human" | "agent";
}

export type RadioCommand =
  "power" | "next" | "previous" | "station" | "volumeUp" | "volumeDown" | "retry";

/** Values read every frame by the React post-processing grade (no React state). */
export interface AfterHoursPresentation {
  /** 0 … 1 Altered Signal strength after intensity and easing. */
  altered: number;
  reducedMotion: boolean;
  time: number;
  /** Concert sky accent 0 … 1. */
  concertSky: number;
}

interface Session {
  layer: LayerId;
  tuning: TuningSession;
  /** Seconds left showing "Locked" before the terminal closes itself. */
  closing: number;
  /** The frame the session opened (its E press must not also close it). */
  fresh: boolean;
}

const LOCK_OWNER = "tuning-terminal";
/** Radio controls work in the cab or standing beside the owning vehicle. */
const RADIO_REACH = 12;
/** Radio captions (idents, numbers) are shown within earshot. */
const RADIO_EARSHOT = 45;
const LAVENDER_DUST = "#bfaee6";
const CAPTION_MIN = 2.6;
/** Queued captions older than this (s) are dropped rather than shown late. */
const CAPTION_STALE = 12;
const CINEMATIC_TARGET = new THREE.Vector3(-62, 14, -70);
export const RECORD_ZERO_URL = "https://the-idea-that-never-was.ciao-chris.chatgpt.site";

/**
 * Pine Gap: After Hours — the fictional night-shift expansion layered on
 * the playable reconstruction. Owns the progression store, the vehicle
 * radio, the coffee mission, Frequency 420, the antenna puzzle and the
 * midnight concert, and presents them through its own HUD store, audio
 * rig and scene objects. Nothing here alters movement, vehicle physics,
 * collision or the surveyed site data.
 */
export class AfterHours {
  readonly store: ProgressStore;
  readonly radio = new RadioLogic();
  readonly mission = new CoffeeMission();
  readonly numbers = new NumbersStation();
  readonly concert = new ConcertLogic();
  readonly announcer = new Announcer();
  readonly hud: AfterHoursHud;
  readonly presentation: AfterHoursPresentation = {
    altered: 0,
    reducedMotion: false,
    time: 0,
    concertSky: 0,
  };
  /** Scene objects (props, markers, effects); null when headless. */
  visuals: AfterHoursVisuals | null = null;
  rig: AfterHoursAudio | null = null;

  active = false;
  session: Session | null = null;
  cinematic = false;
  /** Heard "four two zero" on the Numbers Station this visit. */
  heardClue = false;
  recordZeroOpen = false;
  private recordZeroObserver: "human" | "agent" = "human";

  private viewerActive = true;
  private paused = false;
  private time = 0;
  private dirty = true;
  private captionSeq = 0;
  private caption: (Caption & { until: number; priority: number }) | null = null;
  private readonly captionQueue: (Caption & {
    duration: number;
    priority: number;
    queuedAt?: number;
  })[] = [];
  private credit: { id: number; reason: "opening" | "return"; until: number } | null = null;
  private radioFade = 1;
  private radioStatus: RadioPlaybackStatus | "silent" = "silent";
  private radioErrors = 0;
  private concertStartAudio = 0;
  private concertSimTime = 0;
  private positionSave = 0;
  private idleTime = 0;
  private topSpeedTime = 0;
  private offRoadTime = 0;
  private readoutTimer = 0;
  private overlayTimer = 0;
  private waveTimer = 0;
  private readonly unsubscribers: (() => void)[] = [];
  private readonly offer: InteractionOffer = {
    label: "",
    distance: 0,
    priority: true,
    act: () => undefined,
  };
  private readonly scoreTargets = createScoreTargets();
  private readonly radioFrame: RadioAudioFrame = {
    playAlbum: false,
    trackSrc: GREEN_MACHINE.tracks[0].src,
    seek: 0,
    albumLevel: 0,
    numbersLevel: 0,
    signalLevel: 0,
    staticLevel: 0,
    power: false,
    duck: 1,
    volume: 0.7,
    cabin: 0,
    door: 0,
    x: 0,
    y: 0,
    z: 0,
    fx: 0,
    time: 0,
  };
  private readonly visualState: VisualState;
  private readonly cinematicPosition = new THREE.Vector3();
  private readonly cinematicLook = new THREE.Vector3();
  private readonly cinematicMatrix = new THREE.Matrix4();
  private readonly cinematicQuaternion = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private cinematicAngle = 0;
  private cinematicBlend = 0;
  private lastCamera: THREE.PerspectiveCamera | null = null;
  private ownerHome: { id: string; x: number; z: number; yaw: number } | null = null;

  constructor(
    private readonly host: AfterHoursHost,
    storage: KeyValueStorage | null,
    createVisuals: ((ah: AfterHours) => AfterHoursVisuals) | null = null,
  ) {
    this.store = new ProgressStore(storage);
    const p = this.store.data.progress;
    const prefs = this.store.data.preferences;
    this.radio.f420Transmitting = p.coffeeCompleted;
    this.radio.f420Discovered = p.channelDiscovered;
    this.radio.volume = prefs.musicVolume;
    this.radio.restore(prefs.stationId, trackIndexById(prefs.trackId), prefs.trackPosition);
    this.radio.onEvent = (e) => this.onRadioEvent(e);
    this.mission.onEvent = (e) => {
      this.dirty = true;
      if (e.type === "completed") this.onDelivered();
      if (e.type === "failed") this.onMissionFailed(e.reason);
    };
    this.presentation.reducedMotion = prefs.reducedMotion;
    this.updateNumbersScript();
    this.hud = new AfterHoursHud(this.buildSnapshot());
    this.visualState = createVisualState();
    this.host.interaction.providers.push(this.provide);
    this.wireEvents();
    if (createVisuals) {
      this.visuals = createVisuals(this);
      host.root.add(this.visuals.root);
    }
    // The audio rig is built as soon as the shared context exists.
    if (host.audio) this.unsubscribers.push(host.audio.onUnlock(() => this.ensureRig()));
  }

  get progress() {
    return this.store.data.progress;
  }

  get preferences(): Preferences {
    return this.store.data.preferences;
  }

  get alteredUnlocked(): boolean {
    return this.progress.channelDiscovered;
  }

  /** Altered Signal is presented right now. */
  get alteredOn(): boolean {
    return (
      this.active &&
      this.viewerActive &&
      this.alteredUnlocked &&
      this.preferences.alteredSignal &&
      this.preferences.effectIntensity > 0
    );
  }

  get timeOverride(): TimeOfDay | null {
    return this.active && this.concert.state === "running" ? "night" : null;
  }

  get movementLocked(): boolean {
    return this.session !== null;
  }

  private ensureRig(): void {
    if (this.rig || !this.host.audio?.context || !this.host.audio.musicBus) return;
    try {
      this.rig = new AfterHoursAudio(this.host.audio);
    } catch (error) {
      console.error("After Hours audio unavailable", error);
      this.rig = null;
      return;
    }
    const radio = this.rig.radio;
    radio.onStatus = (status) => {
      this.radioStatus = status;
      if (status === "playing") this.radioErrors = 0;
      this.dirty = true;
    };
    radio.onEnded = () => this.radio.nextTrack(true);
    radio.onError = (kind) => this.onRadioError(kind);
    radio.setSuspended(this.paused);
    this.dirty = true;
  }

  private wireEvents(): void {
    const on = <K extends keyof GameEvents>(type: K, fn: (e: GameEvents[K]) => void) =>
      this.unsubscribers.push(this.host.events.on(type, fn));
    on("vehicleEnter", (e) => {
      if (!this.active) return;
      this.mission.spill.detach();
      if (this.radio.ownerId !== e.vehicleId) this.radio.claim(e.vehicleId);
      this.dirty = true;
    });
    on("vehicleExit", () => {
      this.dirty = true;
    });
    on("impact", (e) => {
      if (!this.active) return;
      const v = this.host.interaction.vehicle;
      if (!v || e.vehicleId !== v.id || this.host.interaction.cameraMode !== "vehicle") return;
      this.mission.impact(e.speed);
      if (e.speed > 2 && this.announcer.impact()) this.announce("collisions");
    });
    on("land", (e) => {
      if (this.active && this.host.interaction.state === GameplayState.OnFoot)
        this.mission.land(e.speed);
    });
    on("gateMove", (e) => {
      if (!this.active || !e.raising) return;
      const p = this.host.player.position;
      if (
        this.host.interaction.state === GameplayState.OnFoot &&
        Math.hypot(e.x - p.x, e.z - p.z) < 3.4
      ) {
        this.announce("barrier");
      }
    });
  }

  // --- Session lifecycle ----------------------------------------------------------

  /** Begin (or resume) After Hours at the saved checkpoint. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.ensureRig();
    this.host.setCharacterKind(this.preferences.character);
    const p = this.progress;
    // The radio lives in the vehicle parked nearest the player.
    const pos = this.host.player.position;
    const owner =
      (this.radio.ownerId &&
        this.host.vehicles.vehicles.find((v) => v.id === this.radio.ownerId)) ||
      this.nearestVehicle(pos.x, pos.z);
    if (owner) {
      this.radio.claim(owner.id);
      const home = VEHICLE_SPAWNS.find((s) => s.variant.callsign === owner.id);
      if (home) this.ownerHome = { id: owner.id, x: home.x, z: home.z, yaw: home.yaw };
    }
    this.radio.selectStation(this.preferences.stationId);
    this.radio.setPower(true);
    this.radioFade = 0;
    this.showCredit("opening");
    const stage = stageOf(p);
    if (stage === "coffee") {
      this.say(
        "Night desk",
        "Evening, visitor. The technician at the north antenna hut has requested coffee. The cart is by the south hall.",
        "story",
        7,
      );
    } else {
      this.say(
        "Night desk",
        "Welcome back, visitor. Your clearance has not been revoked. Yet.",
        "story",
        5,
      );
    }
    this.dirty = true;
  }

  /** Leave After Hours for free exploration, restoring every presentation change. */
  stop(): void {
    if (!this.active) return;
    this.closeSession();
    this.closeRecordZero();
    if (this.concert.state === "running") this.finishConcert(false);
    this.mission.abort();
    this.setCinematic(false);
    this.active = false;
    this.caption = null;
    this.captionQueue.length = 0;
    this.credit = null;
    this.host.setCarrying(false);
    this.host.setDustTint(null);
    this.presentation.altered = 0;
    this.savePosition();
    this.dirty = true;
  }

  /** Viewer modes (Explore, Tour, Plan) are factual: no fiction is presented. */
  setViewerActive(on: boolean): void {
    if (this.viewerActive === on) return;
    this.viewerActive = on;
    if (!on) {
      this.closeRecordZero();
      this.closeSession();
      if (this.concert.state === "running") this.finishConcert(false);
      this.setCinematic(false);
      this.host.setDustTint(null);
      this.presentation.altered = 0;
    }
    this.dirty = true;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.rig?.setSuspended(paused);
    if (paused) this.savePosition();
  }

  // --- Public commands (HUD buttons, touch) -------------------------------------------

  radioCommand(command: RadioCommand): void {
    if (!this.active) return;
    if (command === "retry") {
      this.rig?.radio.retry();
      this.radioErrors = 0;
      return;
    }
    if (command !== "volumeUp" && command !== "volumeDown" && !this.reachRadio()) return;
    const status = this.rig?.radio.status;
    if (command === "power" && (status === "blocked" || status === "error") && this.radio.power) {
      // The browser refused playback (or the stream failed): this press retries.
      this.rig?.radio.retry();
      this.radioErrors = 0;
      return;
    }
    // Any radio button is a user gesture: a refused playback may retry.
    this.rig?.radio.retry();
    switch (command) {
      case "power":
        this.radio.togglePower();
        break;
      case "next":
        if (this.radio.station?.kind === "album") this.radio.nextTrack(false);
        else this.radio.selectStation("indigo");
        break;
      case "previous":
        if (this.radio.station?.kind === "album") this.radio.previousTrack();
        else this.radio.selectStation("indigo");
        break;
      case "station":
        this.radio.cycleStation(1);
        this.rig?.cue("radio");
        break;
      case "volumeUp":
        this.setPreference("musicVolume", Math.min(1, this.preferences.musicVolume + 0.1));
        break;
      case "volumeDown":
        this.setPreference("musicVolume", Math.max(0, this.preferences.musicVolume - 0.1));
        break;
    }
    this.dirty = true;
  }

  /** Tune straight to a preset (the HUD's station chips). Switches the radio on. */
  tuneToStation(id: StationId): void {
    if (!this.active || !this.reachRadio()) return;
    this.rig?.radio.retry();
    if (this.radio.station?.id === id && this.radio.strength > 0.5 && this.radio.power) return;
    this.radio.selectStation(id);
    this.rig?.cue("radio");
    this.dirty = true;
  }

  /** Play an album track from the track list, tuning to the album if needed. */
  playTrack(index: number): void {
    if (!this.active || !this.reachRadio()) return;
    this.rig?.radio.retry();
    if (this.radio.station?.kind !== "album" || !this.radio.power)
      this.radio.selectStation("indigo");
    this.radio.setTrack(index, false);
    this.dirty = true;
  }

  /** True when the player can reach the radio; otherwise explains why not. */
  private reachRadio(): boolean {
    if (this.radioInReach()) return true;
    this.outOfReach();
    return false;
  }

  private outOfReach(): void {
    const owner = this.ownerVehicle();
    this.say(
      "Radio",
      owner
        ? `The radio is in ${owner.id}. Get in, or stand beside it, to reach it.`
        : "No radio in reach.",
      "system",
      2.6,
    );
  }

  setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    const prefs = this.preferences;
    if (prefs[key] === value) return;
    prefs[key] = value;
    if (key === "musicVolume") this.radio.setVolume(value as number);
    if (key === "reducedMotion") this.presentation.reducedMotion = value as boolean;
    if (key === "alteredSignal" && !value) {
      // Immediate off: no fade-out.
      this.presentation.altered = 0;
      this.host.setDustTint(null);
    }
    if (key === "character" && this.active) this.host.setCharacterKind(value as CharacterKind);
    this.store.save();
    this.dirty = true;
  }

  toggleAlteredSignal(): void {
    if (!this.alteredUnlocked) {
      this.say("Receiver", "Nothing to alter yet.", "system", 2);
      return;
    }
    this.setPreference("alteredSignal", !this.preferences.alteredSignal);
    this.say(
      "Receiver",
      this.preferences.alteredSignal ? "Altered Signal on." : "Altered Signal off.",
      "system",
      2,
    );
  }

  /** Reset progression to a fresh night; preferences are kept. */
  resetProgress(): void {
    this.closeSession();
    this.closeRecordZero();
    if (this.concert.state === "running") this.finishConcert(false);
    this.mission.abort();
    if (this.mission.state !== "available") this.mission.retry();
    this.store.reset(false);
    this.radio.f420Transmitting = false;
    this.radio.f420Discovered = false;
    this.radio.holdProgress = 0;
    if (this.radio.station?.id === "f420") this.radio.selectStation("indigo");
    this.heardClue = false;
    this.presentation.altered = 0;
    this.host.setDustTint(null);
    this.updateNumbersScript();
    this.say("Night desk", "Records cleared. Nobody remembers the coffee.", "system", 3);
    this.dirty = true;
  }

  /** Retry the coffee after a failure (also offered at the cart). */
  retryMission(): void {
    if (!this.active || this.mission.state !== "failed") return;
    this.mission.retry();
    const i = this.host.interaction;
    if (i.state === GameplayState.OnFoot) {
      // Back to the cart, and the radio's vehicle back to its bay if nobody is in it.
      const stand = this.cartStand();
      this.host.player.teleport(stand.x, stand.z, stand.yaw);
      const owner = this.ownerVehicle();
      if (owner && !owner.driven && this.ownerHome && owner.id === this.ownerHome.id) {
        owner.place(this.ownerHome.x, this.ownerHome.z, this.ownerHome.yaw);
      }
      this.say(
        "Catering",
        "Another cup has been poured. Try to keep this one in the cup.",
        "story",
        4,
      );
    } else {
      this.say("Catering", "Another cup is waiting at the cart.", "story", 3);
    }
    this.dirty = true;
  }

  leaveTerminal(): void {
    this.closeSession();
  }

  closeRecordZero(): void {
    if (!this.recordZeroOpen) return;
    this.recordZeroOpen = false;
    this.dirty = true;
  }

  /** A second ordinary interaction, or the focused panel button, opens the record. */
  openRecordZero(): void {
    if (
      !this.active ||
      !this.viewerActive ||
      !this.progress.concertCompleted ||
      !this.recordZeroOpen
    )
      return;
    const p = this.host.player.position;
    if (Math.hypot(p.x - RECORD_ZERO.x, p.z - RECORD_ZERO.z) > RANGES.record) return;
    this.host.events.emit("archiveRecordOpened", { id: "zero", x: p.x, z: p.z });
    if (typeof window !== "undefined")
      window.open(RECORD_ZERO_URL, "_blank", "noopener,noreferrer");
    this.closeRecordZero();
  }

  endConcert(): void {
    if (this.concert.state === "running") this.finishConcert(false);
  }

  toggleCinematic(): void {
    if (this.concert.state !== "running") return;
    this.setCinematic(!this.cinematic);
  }

  /**
   * Apply audio state immediately. Called from the click that starts After
   * Hours so playback begins inside the user gesture (strict autoplay
   * policies only allow that).
   */
  kickAudio(): void {
    this.ensureRig();
    this.updateAudio();
  }

  /** Show the album credit again (credits button). */
  showAlbumCredit(): void {
    this.showCredit("return");
  }

  // --- Interaction -------------------------------------------------------------------

  private readonly provide = (x: number, _y: number, z: number): InteractionOffer | null => {
    if (!this.active || !this.viewerActive) return null;
    const offer = this.offer;
    const near = (s: Site, range: number) => {
      const d = Math.hypot(s.x - x, s.z - z);
      return d <= range ? d : -1;
    };
    // Only the completed concert changes this otherwise ordinary corner of the world.
    const record = near(RECORD_ZERO, RANGES.record);
    if (record >= 0 && this.progress.concertCompleted && this.concert.state !== "running") {
      offer.id = "record_zero";
      offer.distance = record;
      offer.priority = true;
      offer.label = this.recordZeroOpen ? "Open the record" : "Inspect the empty chair";
      offer.act = () => {
        if (this.recordZeroOpen) this.openRecordZero();
        else {
          this.recordZeroObserver = this.host.controlSource();
          this.recordZeroOpen = true;
          this.dirty = true;
        }
      };
      return offer;
    }
    // Coffee cart.
    const cart = near(COFFEE_CART, RANGES.cart);
    if (cart >= 0 && this.mission.state !== "active") {
      offer.id = "coffee_cart";
      offer.distance = cart;
      offer.priority = true;
      offer.label =
        this.mission.state === "failed"
          ? "Collect a fresh coffee"
          : this.mission.state === "completed"
            ? "Pour another coffee (replay)"
            : "Collect the coffee";
      offer.act = () => this.collectCoffee();
      return offer;
    }
    const delivery = near(DELIVERY, RANGES.delivery);
    if (delivery >= 0 && this.mission.state === "active") {
      offer.id = "technician";
      offer.distance = delivery;
      offer.priority = true;
      offer.label = "Hand over the coffee";
      offer.act = () => this.mission.deliver();
      return offer;
    }
    if (this.progress.channelDiscovered) {
      for (const t of TERMINAL_SITES) {
        const d = near(t, RANGES.terminal);
        if (d < 0) continue;
        if (this.progress.terminals[t.layer] || this.session) return null;
        offer.id = t.layer;
        offer.distance = d;
        offer.priority = true;
        offer.label = `Tune the ${LAYERS[t.layer].label.toLowerCase()} terminal`;
        const layer = t.layer;
        offer.act = () => this.openSession(layer);
        return offer;
      }
    }
    if (concertUnlocked(this.progress)) {
      const d = near(LISTENING_POINT, RANGES.listening);
      if (d >= 0) {
        offer.id = "listening_point";
        offer.distance = d;
        // Like the cart, the technician and the terminals, beginning the
        // transmission outranks "Enter vehicle": a vehicle parked beside the
        // listening point used to hide the task's final action (found by the
        // decision-latency experiment: agents live-locked, re-arriving forever).
        offer.priority = this.concert.state !== "running";
        if (this.concert.state === "running") {
          offer.label = "End the transmission";
          offer.act = () => this.finishConcert(false);
        } else {
          offer.label = this.progress.concertCompleted
            ? "Replay the midnight transmission"
            : "Begin the midnight transmission";
          offer.act = () => this.startConcert();
        }
        return offer;
      }
    }
    return null;
  };

  private collectCoffee(): void {
    if (this.mission.state === "failed" || this.mission.state === "completed") this.mission.retry();
    if (!this.mission.collect()) return;
    this.cue("pickup");
    this.say(
      "Night desk",
      `Coffee collected. North antenna hut, ${Math.round(COFFEE.timeLimit / 60)} minutes. Brake like it is full.`,
      "story",
      5,
    );
    this.dirty = true;
  }

  private onDelivered(): void {
    const result = this.mission.result;
    if (!result) return;
    this.cue("deliver");
    const p = this.progress;
    const best = p.bestCoffee;
    if (!best || result.score > best.score) {
      p.bestCoffee = {
        percent: result.percent,
        seconds: Math.round(result.seconds),
        score: result.score,
      };
    }
    this.say("Night-shift technician", result.summary, "story", 6.5);
    // The reward (the clue) is granted exactly once.
    if (!p.coffeeCompleted) {
      p.coffeeCompleted = true;
      this.radio.f420Transmitting = true;
      this.updateNumbersScript();
      this.say(
        "Night-shift technician",
        "Thanks. Leave the Numbers Station on in the car. It has been counting to something all night.",
        "story",
        7,
      );
    }
    this.store.save();
    this.dirty = true;
  }

  private onMissionFailed(reason: "timeout" | "spilled"): void {
    this.cue("fail");
    this.say(
      "Night desk",
      reason === "spilled"
        ? "The coffee is now part of the vehicle. A fresh cup waits at the cart."
        : "The coffee has reached ambient temperature. A fresh cup waits at the cart.",
      "story",
      5,
    );
    this.dirty = true;
  }

  private openSession(layer: LayerId): void {
    if (this.session || this.progress.terminals[layer]) return;
    this.session = { layer, tuning: new TuningSession(LAYERS[layer]), closing: -1, fresh: true };
    this.host.lockMovement(LOCK_OWNER, true);
    this.dirty = true;
  }

  private closeSession(): void {
    if (!this.session) return;
    this.session = null;
    this.host.lockMovement(LOCK_OWNER, false);
    this.dirty = true;
  }

  private onLayerLocked(layer: LayerId): void {
    const p = this.progress;
    if (p.terminals[layer]) return;
    p.terminals[layer] = true;
    this.store.save();
    this.cue("lock");
    const n = terminalsTuned(p);
    if (n === LAYER_IDS.length) {
      this.say(
        "Frequency 420",
        "All four layers locked. Something is waiting at the listening point among the radomes.",
        "story",
        6,
      );
    } else {
      this.say("Frequency 420", `${LAYERS[layer].label} layer locked. ${n} of 4.`, "story", 3.5);
    }
    this.dirty = true;
  }

  // --- Concert -----------------------------------------------------------------------

  private startConcert(): void {
    if (!concertUnlocked(this.progress) || this.concert.state === "running") return;
    this.closeSession();
    this.savePosition();
    this.concert.start();
    this.captionQueue.length = 0;
    this.concertSimTime = 0;
    this.concertStartAudio = this.rig ? this.rig.now + 0.12 : 0;
    this.rig?.score.start(this.concertStartAudio);
    this.say("Frequency 420", "Midnight. Transmission beginning.", "story", 4);
    this.dirty = true;
  }

  private finishConcert(completed: boolean): void {
    if (this.concert.state === "running") this.concert.stop();
    this.setCinematic(false);
    this.rig?.score.stop();
    if (completed) {
      const first = !this.progress.concertCompleted;
      this.progress.concertCompleted = true;
      this.store.save();
      this.updateNumbersScript();
      this.say("", CONCERT.finalLine, "final", 6.5);
      if (first) {
        this.say(
          "Receiver",
          "Frequency 420 stays on your preset list. The transmission can be replayed here.",
          "system",
          5,
        );
      }
    } else {
      this.say("Frequency 420", "Transmission interrupted.", "system", 2.6);
    }
    // Back to the player's Indigo People selection, faded in, position kept.
    if (this.active) {
      this.radio.selectStation("indigo");
      this.radioFade = 0;
      if (completed) this.showCredit("return");
    }
    this.dirty = true;
  }

  private setCinematic(on: boolean): void {
    if (this.cinematic === on) return;
    this.cinematic = on;
    if (on) {
      this.cinematicBlend = 0;
      const lp = LISTENING_POINT;
      const cam = this.lastCamera;
      this.cinematicAngle = cam ? headingOf(cam.position.x - lp.x, cam.position.z - lp.z) : 0;
    } else if (this.lastCamera) {
      // Glide back into the gameplay camera from wherever the shot was.
      this.host.camera.beginIntro(this.lastCamera);
    }
    this.dirty = true;
  }

  /** Optional cinematic camera for the concert; returns false when inactive. */
  updateCinematic(dt: number, camera: THREE.PerspectiveCamera): boolean {
    this.lastCamera = camera;
    if (!this.cinematic) return false;
    const lp = LISTENING_POINT;
    if (!this.preferences.reducedMotion) this.cinematicAngle += dt * 0.05;
    const r = 34;
    const a = this.cinematicAngle;
    this.cinematicPosition.set(
      lp.x + Math.sin(a) * r,
      10 + this.concert.mix.sky * 4,
      lp.z + Math.cos(a) * r,
    );
    this.cinematicLook.copy(CINEMATIC_TARGET);
    this.cinematicMatrix.lookAt(this.cinematicPosition, this.cinematicLook, this.up);
    this.cinematicQuaternion.setFromRotationMatrix(this.cinematicMatrix);
    this.cinematicBlend = Math.min(1, this.cinematicBlend + dt / 1.6);
    const e = smoothstep(0, 1, this.cinematicBlend);
    camera.position.lerp(this.cinematicPosition, e < 1 ? e * 0.12 + 0.02 : 1);
    camera.quaternion.slerp(this.cinematicQuaternion, e < 1 ? e * 0.12 + 0.02 : 1);
    if (Math.abs(camera.fov - 50) > 0.01) {
      camera.fov = damp(camera.fov, 50, 2, dt);
      camera.updateProjectionMatrix();
    }
    return true;
  }

  // --- Frame hooks -----------------------------------------------------------------------

  /** Once per simulated frame, after the interaction state machine. */
  update(dt: number, input: InputState): void {
    if (!this.active) return;
    if (this.recordZeroOpen) {
      const p = this.host.player.position;
      if (
        Math.hypot(p.x - RECORD_ZERO.x, p.z - RECORD_ZERO.z) > RANGES.record + 0.5 ||
        input.wasPressed("cancel")
      )
        this.closeRecordZero();
    }
    this.time += dt;
    this.announcer.update(dt);
    this.handleRadioInput(dt, input);
    if (input.wasPressed("alteredSignal")) this.toggleAlteredSignal();
    if (input.wasPressed("retry") && this.mission.state === "failed") this.retryMission();

    // Tuning terminal.
    const s = this.session;
    if (s) {
      if (s.closing >= 0) {
        s.closing -= dt;
        if (s.closing <= 0) this.closeSession();
      } else {
        const axis = clamp(input.moveAxes(this.axes).x + input.virtual.dial, -1, 1);
        // Key presses nudge the dial even when released before this frame.
        if (!s.fresh) {
          const tap = (input.wasPressed("right") ? 1 : 0) - (input.wasPressed("left") ? 1 : 0);
          if (tap !== 0) s.tuning.nudge(tap);
        }
        if (s.tuning.update(dt, axis)) {
          this.onLayerLocked(s.layer);
          s.closing = 1.4;
        }
        if (!s.fresh && (input.wasPressed("interact") || input.wasPressed("cancel")))
          this.closeSession();
      }
      if (this.session) this.session.fresh = false;
    }

    // Concert.
    if (this.concert.state === "running") {
      if (input.wasPressed("cinematic")) this.toggleCinematic();
      else if (input.wasPressed("cancel")) this.finishConcert(false);
      if (this.cinematic) {
        input.moveAxes(this.axes);
        if (Math.hypot(this.axes.x, this.axes.y) > 0.2 || input.lookX !== 0 || input.lookY !== 0)
          this.setCinematic(false);
      }
      this.concertSimTime += dt;
      const position = this.rig
        ? Math.max(0, this.rig.now - this.concertStartAudio)
        : this.concertSimTime;
      if (this.concert.advance(position)) this.finishConcert(true);
    }

    this.radio.f420Transmitting = this.progress.coffeeCompleted;
    this.radio.update(dt, this.rig === null);
    this.radioFade = Math.min(1, this.radioFade + dt / 3.5);

    // Numbers Station transmissions (captioned whenever it is within earshot).
    const numbersOn =
      this.radio.power &&
      this.radio.station?.kind === "numbers" &&
      this.radio.strength > 0.5 &&
      this.radioAudible();
    if (numbersOn) {
      const cue = this.numbers.update(dt);
      if (cue) {
        this.rig?.numbers(cue.pips);
        if (this.radioInEarshot())
          this.say("Numbers Station", cue.line, "numbers", NUMBERS_CAPTION);
        if (this.numbers.script === "clue" && cue.text === "Zero." && !this.heardClue) {
          this.heardClue = true;
          this.dirty = true;
        }
      }
    } else {
      this.numbers.restart();
    }

    this.updateAmbientAnnouncements(dt);
    this.updateCaptions(dt);
    if (this.mission.state === "active" && this.mission.spill.integrity < 45)
      this.announce("coffeeLow");
  }

  private readonly axes = { x: 0, y: 0 };

  private handleRadioInput(dt: number, input: InputState): void {
    const pressed = (a: Parameters<InputState["wasPressed"]>[0]) => input.wasPressed(a);
    if (pressed("radioPower")) this.radioCommand("power");
    if (pressed("radioNext")) this.radioCommand("next");
    if (pressed("radioPrevious")) this.radioCommand("previous");
    if (pressed("radioStation")) this.radioCommand("station");
    if (pressed("volumeUp")) this.radioCommand("volumeUp");
    if (pressed("volumeDown")) this.radioCommand("volumeDown");
    const tapped = (pressed("tuneUp") ? 1 : 0) - (pressed("tuneDown") ? 1 : 0);
    const tune =
      (input.isDown("tuneUp") ? 1 : 0) - (input.isDown("tuneDown") ? 1 : 0) + input.virtual.tune;
    if ((tune !== 0 || tapped !== 0) && !this.radioInReach()) {
      if (tapped !== 0) this.outOfReach();
      this.radio.tuneHold(0, dt);
      return;
    }
    const before = this.radio.station?.id;
    if ((tune !== 0 || tapped !== 0) && !this.radio.power) this.radio.setPower(true);
    // Presses step the dial (even a tap between two frames); holds sweep.
    this.radio.tuneStep(tapped);
    this.radio.tuneHold(tune, dt);
    if (this.radio.station?.id !== before) this.dirty = true;
  }

  /** A tap on an on-screen tuning button (touch); holding then sweeps. */
  tuneTap(direction: number): void {
    if (!this.active) return;
    if (!this.radioInReach()) {
      this.outOfReach();
      return;
    }
    if (!this.radio.power) this.radio.setPower(true);
    this.radio.tuneStep(direction);
    this.dirty = true;
  }

  /** A tap on an on-screen terminal dial button (touch). */
  dialTap(direction: number): void {
    this.session?.tuning.nudge(direction);
  }

  /** Fixed-rate simulation step (coffee spill and timer). */
  fixedStep(dt: number): void {
    if (!this.active || this.mission.state !== "active") return;
    this.mission.fixedStep(dt, this.carrier());
  }

  private carrier(): Carrier {
    const i = this.host.interaction;
    const v = i.vehicle;
    if (v && i.cameraMode === "vehicle" && i.seatWeight > 0.99) {
      const p = v.physics;
      return { kind: "vehicle", vx: p.vx, vz: p.vz, yaw: p.yaw };
    }
    if (i.state === GameplayState.OnFoot) {
      return { kind: "foot", sprinting: this.host.player.locomotion === Locomotion.Sprint };
    }
    return { kind: "transition" };
  }

  /** Every rendered frame (also while paused): audio, visuals, HUD. */
  present(dt: number, camera: THREE.PerspectiveCamera | null): void {
    if (camera) this.lastCamera = camera;
    if (!this.active) {
      // Free exploration: keep the radio silent and the HUD current, nothing else.
      if (this.wasActive) {
        this.wasActive = false;
        this.current = NO_OBJECTIVE;
        this.updateAudio();
        this.updateVisuals(dt);
      }
      if (this.dirty) {
        this.dirty = false;
        this.hud.publish(this.buildSnapshot());
      }
      return;
    }
    if (!this.wasActive) this.wasActive = true;
    this.current = this.objective();
    const alteredTarget = this.alteredOn ? this.preferences.effectIntensity : 0;
    if (alteredTarget === 0) this.presentation.altered = 0;
    else this.presentation.altered = damp(this.presentation.altered, alteredTarget, 1.2, dt);
    this.presentation.time += this.preferences.reducedMotion ? 0 : dt;
    this.presentation.concertSky = this.concert.state === "running" ? this.concert.mix.sky : 0;
    this.host.setDustTint(this.active && this.presentation.altered > 0.2 ? LAVENDER_DUST : null);
    this.host.setCarrying(
      this.active && this.mission.state === "active" && this.host.interaction.seatWeight < 0.5,
    );
    this.updateAudio();
    this.updateVisuals(dt);
    this.readoutTimer -= dt;
    if (this.readoutTimer <= 0) {
      this.readoutTimer = 1 / 12;
      this.writeReadouts(camera);
    }
    this.waveTimer -= dt;
    if (this.session && this.waveTimer <= 0) {
      this.waveTimer = 1 / 24;
      this.drawWaveform();
    }
    if (this.dirty || this.derivedChanged()) {
      this.dirty = false;
      this.hud.publish(this.buildSnapshot());
    }
    // Save the album position every few seconds while it plays.
    this.positionSave -= dt;
    if (this.positionSave <= 0) {
      this.positionSave = 8;
      if (this.active && this.radio.albumTuned) this.savePosition();
    }
  }

  // --- Radio helpers ------------------------------------------------------------------

  private ownerVehicle(): Vehicle | null {
    const id = this.radio.ownerId;
    if (!id) return null;
    return this.host.vehicles.vehicles.find((v) => v.id === id) ?? null;
  }

  private nearestVehicle(x: number, z: number): Vehicle | null {
    let best: Vehicle | null = null;
    let bestD = Infinity;
    for (const v of this.host.vehicles.vehicles) {
      const d = Math.hypot(v.physics.x - x, v.physics.z - z);
      if (d < bestD) {
        best = v;
        bestD = d;
      }
    }
    return best;
  }

  private inCab(): boolean {
    const i = this.host.interaction;
    return i.vehicle !== null && i.vehicle.id === this.radio.ownerId && i.seatWeight > 0.5;
  }

  private distanceToRadio(): number {
    const v = this.ownerVehicle();
    if (!v) return Infinity;
    const p = this.host.player.position;
    return Math.hypot(v.physics.x - p.x, v.physics.z - p.z);
  }

  radioInReach(): boolean {
    return this.inCab() || this.distanceToRadio() <= RADIO_REACH;
  }

  private radioInEarshot(): boolean {
    return this.inCab() || this.distanceToRadio() <= RADIO_EARSHOT;
  }

  /** The radio is producing sound (if the context allows). */
  private radioAudible(): boolean {
    return (
      this.active &&
      this.viewerActive &&
      !this.paused &&
      this.radio.power &&
      this.radio.ownerId !== null &&
      this.concert.state !== "running"
    );
  }

  private onRadioEvent(e: RadioEvent): void {
    this.dirty = true;
    const prefs = this.preferences;
    switch (e.type) {
      case "ident":
        if (!this.active) return;
        prefs.stationId = e.station.id;
        if (this.radioInEarshot()) {
          this.say(
            "Radio",
            e.track
              ? `${e.station.label} · ${e.track.title} — ${GREEN_MACHINE.artist}`
              : e.station.label,
            "radio",
            3,
          );
        }
        this.store.save();
        break;
      case "track":
        prefs.trackId = e.track.id;
        prefs.trackPosition = 0;
        if (this.active && this.radio.albumTuned && this.radioInEarshot()) {
          this.say("Radio", `${e.track.title} — ${GREEN_MACHINE.artist}`, "radio", 3);
        }
        this.store.save();
        break;
      case "owner": {
        const v = this.ownerVehicle();
        if (this.active && e.previous && v && this.radio.power) {
          this.say("Radio", `Radio now playing in ${v.id}.`, "radio", 2.4);
        }
        break;
      }
      case "f420Discovered":
        this.progress.channelDiscovered = true;
        this.store.save();
        this.updateNumbersScript();
        this.cue("discover");
        this.say(
          "Receiver",
          "Frequency 420 acquired. The signal is coming from four antennas. Altered Signal unlocked (O).",
          "story",
          7,
        );
        break;
      case "volume":
        break;
      case "power":
        this.savePosition();
        break;
    }
  }

  private onRadioError(kind: string): void {
    this.radioErrors++;
    this.dirty = true;
    if (this.radioErrors >= GREEN_MACHINE.tracks.length) {
      this.say(
        "Radio",
        "The album could not be loaded. Check the connection and press R to retry.",
        "system",
        5,
      );
      return;
    }
    this.say(
      "Radio",
      kind === "play"
        ? "Playback was interrupted. Skipping ahead."
        : "Signal lost on this track. Skipping ahead.",
      "system",
      3,
    );
    this.radio.nextTrack(true);
    this.rig?.radio.retry();
  }

  private savePosition(): void {
    const prefs = this.preferences;
    prefs.trackId = this.radio.track.id;
    prefs.trackPosition = Math.floor(this.rig ? this.rig.radio.currentTime : this.radio.position);
    this.store.save();
  }

  private updateNumbersScript(): void {
    const p = this.progress;
    this.numbers.setScript(
      p.concertCompleted
        ? "after"
        : p.channelDiscovered
          ? "found"
          : p.coffeeCompleted
            ? "clue"
            : "idle",
    );
  }

  // --- Audio ---------------------------------------------------------------------------

  private updateAudio(): void {
    const rig = this.rig;
    const radio = this.radio;
    if (rig && this.active) {
      // Keep the logic's position in step with the element while the album plays.
      if (rig.radio.status === "playing") radio.syncPosition(rig.radio.currentTime);
    }
    if (!rig) return;
    const f = this.radioFrame;
    const owner = this.ownerVehicle();
    const audible = this.radioAudible() && owner !== null;
    const strength = radio.strength;
    const kind = radio.station?.kind;
    f.power = audible;
    f.playAlbum = audible && kind === "album" && strength > 0.02;
    f.trackSrc = radio.track.src;
    f.seek = radio.seekRequest;
    radio.seekRequest = null;
    f.albumLevel = kind === "album" ? strength : 0;
    f.numbersLevel = kind === "numbers" ? strength : 0;
    f.signalLevel = kind === "signal" ? strength : 0;
    f.staticLevel = audible ? 1 - strength : 0;
    f.duck = this.radioFade * (this.session ? 0.15 : 1);
    f.volume = this.preferences.musicVolume;
    const i = this.host.interaction;
    f.cabin = owner && i.vehicle === owner ? i.seatWeight : 0;
    f.door = owner ? Math.max(owner.doorOpen[0], owner.doorOpen[1]) : 0;
    if (owner) {
      const r = owner.physics.render;
      f.x = r.x;
      f.y = r.y + 1.2;
      f.z = r.z;
    }
    f.fx = this.alteredOn && !this.preferences.cleanAudio ? this.preferences.effectIntensity : 0;
    f.time = this.time;

    // Procedural score: tuning sessions, the concert, or Frequency 420 on the radio.
    const t = this.scoreTargets;
    const concert = this.concert.state === "running" && this.viewerActive;
    const session = this.session && this.viewerActive ? this.session : null;
    const f420 = audible && kind === "signal" && strength > 0.02;
    const scoreActive = this.active && !this.paused && (concert || session !== null || f420);
    const tuned = this.progress.terminals;
    t.volume = this.preferences.musicVolume;
    for (const id of LAYER_IDS) {
      t.detuneCents[id] = 0;
      t.offsetBeats[id] = 0;
    }
    t.drone = 0;
    if (concert) {
      const m = this.concert.mix;
      t.levels.reference = m.reference;
      t.levels.rhythm = m.rhythm;
      t.levels.bass = m.bass;
      t.levels.harmony = m.harmony;
      t.levels.melody = m.melody;
      t.bloom = m.bloom;
      t.direct = 1;
      t.radio = 0;
    } else if (session) {
      const layer = session.layer;
      const tuning = session.tuning;
      for (const id of LAYER_IDS) t.levels[id] = id === layer ? 1 : tuned[id] ? 0.7 : 0;
      const pitch = LAYERS[layer].kind === "pitch";
      t.levels.reference = pitch ? 0.25 : 0.9;
      t.drone = pitch && !tuning.locked ? 1 : 0;
      t.droneOctave = layer === "bass" ? 1 : 2;
      if (pitch) t.detuneCents[layer] = tuning.detuneCents;
      else t.offsetBeats[layer] = tuning.offsetBeats;
      t.bloom = 0.6;
      t.direct = 1;
      t.radio = 0;
    } else {
      let any = false;
      for (const id of LAYER_IDS) {
        t.levels[id] = tuned[id] ? 0.8 : 0;
        any ||= tuned[id];
      }
      t.levels.reference = any ? 0.25 : 0.7;
      t.bloom = 0.5;
      t.direct = 0;
      t.radio = 1;
    }
    const ambient =
      this.alteredOn && !this.preferences.cleanAudio && !f.playAlbum && !scoreActive
        ? this.presentation.altered
        : 0;
    rig.update(f, t, scoreActive, ambient, this.time);
  }

  private cue(kind: CueSound): void {
    this.rig?.cue(kind);
  }

  // --- Captions, credit and announcements ---------------------------------------------

  /** Queue a caption. Story lines outrank radio chatter and announcements. */
  say(speaker: string, text: string, kind: CaptionKind, duration = 3): void {
    const priority = kind === "final" ? 4 : kind === "story" ? 3 : kind === "system" ? 2 : 1;
    const caption = {
      id: ++this.captionSeq,
      speaker,
      text,
      kind,
      duration: Math.max(CAPTION_MIN, duration),
      priority,
    };
    const current = this.caption;
    // Numbers-station lines update in place.
    if (kind === "numbers" && current?.kind === "numbers") {
      this.caption = { ...caption, until: this.time + caption.duration };
      this.dirty = true;
      return;
    }
    const chatter = kind === "radio" || kind === "numbers" || kind === "announcement";
    if (!current || current.until <= this.time) {
      this.caption = { ...caption, until: this.time + caption.duration };
    } else if (priority > current.priority) {
      // More important: show now, and finish the interrupted line afterwards.
      if (current.priority > 1) {
        this.captionQueue.unshift({
          ...current,
          duration: Math.max(1.5, current.until - this.time),
        });
      }
      this.caption = { ...caption, until: this.time + caption.duration };
    } else if (priority === current.priority && chatter) {
      // Radio chatter replaces radio chatter.
      this.caption = { ...caption, until: this.time + caption.duration };
    } else if (!chatter) {
      // Story and system lines play in order.
      this.captionQueue.push({ ...caption, queuedAt: this.time });
      if (this.captionQueue.length > 4) this.captionQueue.shift();
    }
    this.dirty = true;
  }

  private updateCaptions(dt: number): void {
    if (this.caption && this.time >= this.caption.until) {
      // Lines that waited too long are stale; skip them.
      let next = this.captionQueue.shift();
      while (next && next.queuedAt !== undefined && this.time - next.queuedAt > CAPTION_STALE) {
        next = this.captionQueue.shift();
      }
      this.caption = next ? { ...next, until: this.time + next.duration } : null;
      this.dirty = true;
    }
    if (this.credit && this.time >= this.credit.until) {
      this.credit = null;
      this.dirty = true;
    }
  }

  private showCredit(reason: "opening" | "return"): void {
    this.credit = { id: ++this.captionSeq, reason, until: this.time + 7 };
    this.dirty = true;
  }

  private announce(id: AnnouncementId): void {
    if (this.session || this.concert.state === "running") return;
    const line = this.announcer.request(id);
    if (line) this.say(line.speaker, line.text, "announcement", 4.5);
  }

  private updateAmbientAnnouncements(dt: number): void {
    const i = this.host.interaction;
    const driven = i.driven;
    if (driven) {
      const speed = Math.abs(driven.physics.forwardSpeed);
      this.topSpeedTime = speed > driven.spec.engine.topSpeed * 0.9 ? this.topSpeedTime + dt : 0;
      if (this.topSpeedTime > 4) this.announce("topSpeed");
      const loose = driven.physics.rearSurface === "dirt" || driven.physics.rearSurface === "grass";
      this.offRoadTime =
        loose && speed > 16 ? this.offRoadTime + dt : Math.max(0, this.offRoadTime - dt);
      if (this.offRoadTime > 12) this.announce("offRoad");
      this.idleTime = 0;
    } else {
      this.idleTime = this.host.player.speed < 0.1 && !this.session ? this.idleTime + dt : 0;
      if (this.idleTime > 120 && this.host.timeOfDay !== "day") this.announce("idle");
    }
  }

  // --- Objective and waypoint ------------------------------------------------------------

  private objective(): {
    text: string | null;
    hint: string | null;
    target: Site | null;
    label: string | null;
  } {
    if (!this.active) return { text: null, hint: null, target: null, label: null };
    if (this.concert.state === "running") {
      return {
        text: `Midnight transmission · ${this.concert.section.label}`,
        hint: "V cinematic view · X end",
        target: null,
        label: null,
      };
    }
    if (this.session) {
      const layer = LAYERS[this.session.layer];
      return {
        text: `Tune the ${layer.label.toLowerCase()} terminal`,
        hint: "A / D turn the dial · E leave",
        target: null,
        label: null,
      };
    }
    const m = this.mission.state;
    if (m === "active") {
      return {
        text: "Deliver the coffee to the north antenna hut",
        hint: this.host.interaction.driven
          ? "Smooth braking keeps it in the cup"
          : "E enter a vehicle",
        target: DELIVERY,
        label: DELIVERY.label,
      };
    }
    const p = this.progress;
    switch (stageOf(p)) {
      case "coffee":
        return {
          text:
            m === "failed"
              ? "Collect a fresh coffee from the canteen cart"
              : "Collect the coffee from the canteen cart",
          hint: m === "failed" ? "Or use Retry" : null,
          target: this.cartStand(),
          label: COFFEE_CART.label,
        };
      case "channel": {
        const owner = this.ownerVehicle();
        const target = owner
          ? { x: owner.physics.x, z: owner.physics.z, yaw: 0, label: owner.id }
          : null;
        if (!this.heardClue) {
          return {
            text: "Listen to the Numbers Station on the vehicle radio",
            hint: "T next station",
            target: this.inCab() ? null : target,
            label: owner ? `Radio · ${owner.id}` : null,
          };
        }
        return {
          text: "Tune the receiver to 420 and hold it there",
          hint: "[ / ] tune the dial",
          target: this.inCab() ? null : target,
          label: owner ? `Radio · ${owner.id}` : null,
        };
      }
      case "terminals": {
        const n = terminalsTuned(p);
        const next = this.nearestUntuned();
        return {
          text: `Tune the signal terminals · ${n}/4`,
          hint: "Follow the signal traces",
          target: next,
          label: next ? next.label : null,
        };
      }
      case "concert":
        return {
          text: "Go to the listening point among the radomes",
          hint: null,
          target: LISTENING_POINT,
          label: LISTENING_POINT.label,
        };
      case "complete":
        return {
          text: "Frequency 420 is yours",
          hint: "Replay the transmission at the listening point",
          target: null,
          label: null,
        };
    }
  }

  private nearestUntuned(): Site | null {
    const p = this.host.player.position;
    let best: Site | null = null;
    let bestD = Infinity;
    for (const t of TERMINAL_SITES) {
      if (this.progress.terminals[t.layer]) continue;
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  }

  private cartStand(): Site {
    const c = COFFEE_CART;
    // A metre and a half in front of the cart, facing it.
    return {
      x: c.x + Math.sin(c.yaw) * 1.6,
      z: c.z + Math.cos(c.yaw) * 1.6,
      yaw: c.yaw + Math.PI,
      label: c.label,
    };
  }

  private lastObjective = "";
  private wasActive = true;
  private current: ReturnType<AfterHours["objective"]> = {
    text: null,
    hint: null,
    target: null,
    label: null,
  };

  private derivedChanged(): boolean {
    const o = this.current;
    const key = `${o.text}|${o.hint}|${o.label}|${this.radioInReach()}|${this.radio.holdProgress > 0}`;
    if (key === this.lastObjective) return false;
    this.lastObjective = key;
    return true;
  }

  // --- HUD -------------------------------------------------------------------------------

  private buildSnapshot(): AfterHoursSnapshot {
    const p = this.progress;
    const o = this.objective();
    const station = this.radio.station;
    const owner = this.ownerVehicle();
    const c = this.caption;
    const s = this.session;
    return {
      active: this.active,
      stage: stageOf(p),
      objective: o.text,
      hint: o.hint,
      caption: c ? { id: c.id, speaker: c.speaker, text: c.text, kind: c.kind } : null,
      recordZero: { open: this.recordZeroOpen, observer: this.recordZeroObserver },
      credit: this.credit ? { id: this.credit.id, reason: this.credit.reason } : null,
      radio: {
        power: this.radio.power,
        stationId: station && this.radio.strength > 0.5 ? station.id : null,
        stationLabel:
          station && this.radio.strength > 0.5
            ? station.label
            : this.radio.power
              ? "Static"
              : "Off",
        trackIndex: this.radio.trackIndex,
        volume: this.preferences.musicVolume,
        status: this.rig ? this.radioStatus : "silent",
        ownerLabel: owner ? owner.id : null,
        inReach: this.radioInReach(),
        f420Discovered: this.radio.f420Discovered,
        holding: this.radio.holdProgress > 0 && !this.radio.f420Discovered,
      },
      mission: {
        state: this.mission.state,
        carrying: this.mission.state === "active",
        failReason: this.mission.failReason,
        result: this.mission.result,
      },
      tuning: s
        ? {
            layer: s.layer,
            label: LAYERS[s.layer].label,
            kind: LAYERS[s.layer].kind,
            instruction: LAYERS[s.layer].instruction,
            locked: s.tuning.locked,
          }
        : null,
      altered: { unlocked: this.alteredUnlocked, on: this.alteredOn },
      concert: {
        running: this.concert.state === "running",
        cinematic: this.cinematic,
        section: this.concert.state === "running" ? this.concert.section.label : null,
        unlocked: concertUnlocked(p),
        completed: p.concertCompleted,
      },
      terminals: { ...p.terminals },
      terminalsRevealed: p.channelDiscovered,
      preferences: { ...this.preferences },
      character: this.preferences.character,
      timeOverride: this.timeOverride,
      storage: { persistent: this.store.persistent, outcome: this.store.outcome },
      audioAvailable: this.rig !== null,
      waypointLabel: o.label,
    };
  }

  /** Continuous readouts, ~12 Hz, straight to the DOM. */
  private writeReadouts(camera: THREE.PerspectiveCamera | null): void {
    const hud = this.hud;
    if (!hud.bound || !this.active) return;
    const m = this.mission;
    const pct = Math.max(0, Math.round(m.spill.integrity));
    hud.text("coffee-pct", `${pct}%`);
    hud.style("coffee-bar", "transform", `scaleX(${(pct / 100).toFixed(2)})`);
    hud.style("coffee-bar", "attr:data-level", pct >= 60 ? "ok" : pct >= 30 ? "low" : "critical");
    const remaining = Math.max(0, Math.ceil(m.remaining));
    hud.text(
      "coffee-timer",
      `${Math.floor(remaining / 60)}:${(remaining % 60).toString().padStart(2, "0")}`,
    );

    // Receiver dial.
    hud.text("radio-freq", this.radio.frequency.toFixed(1));
    const bars = Math.round(this.radio.strength * 5);
    hud.text("radio-signal", "▮".repeat(bars) + "▯".repeat(5 - bars));
    hud.style("radio-hold", "transform", `scaleX(${this.radio.holdProgress.toFixed(2)})`);
    const dialPct = ((this.radio.frequency - 300) / 150) * 100;
    hud.style("radio-needle", "left", `${dialPct.toFixed(1)}%`);
    const rig = this.rig;
    const t =
      rig && this.radio.station?.kind === "album" ? rig.radio.currentTime : this.radio.position;
    const track = this.radio.track;
    const dur = rig && rig.radio.duration > 0 ? rig.radio.duration : track.durationSeconds;
    hud.text("radio-time", `${fmt(t)} / ${fmt(dur)}`);
    const played = dur > 0 ? Math.min(1, Math.max(0, t / dur)) : 0;
    hud.style("radio-progress", "transform", `scaleX(${played.toFixed(3)})`);
    const level = rig ? Math.min(1, rig.radio.level() * 3.2) : 0;
    hud.style("radio-meter", "transform", `scaleX(${level.toFixed(2)})`);

    // Waypoint.
    const target = this.current.target;
    const p = this.host.player.position;
    const focusX = this.host.interaction.driven ? this.host.interaction.driven.physics.x : p.x;
    const focusZ = this.host.interaction.driven ? this.host.interaction.driven.physics.z : p.z;
    if (target) {
      const d = Math.hypot(target.x - focusX, target.z - focusZ);
      hud.text("waypoint-dist", d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`);
      const bearing = headingOf(target.x - focusX, target.z - focusZ);
      const rel = -(bearing - this.host.camera.yaw);
      hud.style("waypoint-arrow", "transform", `rotate(${((rel * 180) / Math.PI).toFixed(0)}deg)`);
      hud.style(
        "waypoint-map",
        "attr:transform",
        `translate(${target.x.toFixed(1)} ${target.z.toFixed(1)})`,
      );
      hud.style("waypoint-map", "attr:opacity", "1");
    } else {
      hud.text("waypoint-dist", "");
      hud.style("waypoint-map", "attr:opacity", "0");
    }

    // Signal overlay: distance and direction to every untuned terminal.
    this.overlayTimer -= 1;
    if (this.overlayTimer <= 0) {
      this.overlayTimer = 2;
      for (const s of TERMINAL_SITES) {
        const d = Math.hypot(s.x - focusX, s.z - focusZ);
        const rel = -(headingOf(s.x - focusX, s.z - focusZ) - this.host.camera.yaw);
        hud.text(
          `signal-${s.layer}`,
          this.progress.terminals[s.layer] ? "locked" : `${Math.round(d)} m`,
        );
        hud.style(
          `signal-arrow-${s.layer}`,
          "transform",
          `rotate(${((rel * 180) / Math.PI).toFixed(0)}deg)`,
        );
      }
      const lp = LISTENING_POINT;
      const d = Math.hypot(lp.x - focusX, lp.z - focusZ);
      hud.text("signal-listening", `${Math.round(d)} m`);
      hud.style(
        "signal-arrow-listening",
        "transform",
        `rotate(${((-(headingOf(lp.x - focusX, lp.z - focusZ) - this.host.camera.yaw) * 180) / Math.PI).toFixed(0)}deg)`,
      );
    }

    // Terminal dial.
    const s = this.session;
    if (s) {
      hud.style("tuning-dial", "left", `${(s.tuning.dial * 100).toFixed(1)}%`);
      hud.style("tuning-target", "left", `${(s.tuning.layer.target * 100).toFixed(1)}%`);
      hud.style("tuning-align", "transform", `scaleX(${s.tuning.alignment.toFixed(2)})`);
      hud.style("tuning-lock", "transform", `scaleX(${s.tuning.lockProgress.toFixed(2)})`);
      hud.text("tuning-status", s.tuning.status);
      hud.text("tuning-align-pct", `${Math.round(s.tuning.alignment * 100)}%`);
    }
    if (this.concert.state === "running") {
      hud.style("concert-progress", "transform", `scaleX(${this.concert.progress.toFixed(3)})`);
    }
    void camera;
  }

  /** Reference vs player signal, drawn for the terminal overlay (~24 Hz). */
  private drawWaveform(): void {
    const canvas = this.hud.canvas;
    const s = this.session;
    if (!canvas || !s) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const tuning = s.tuning;
    const pitch = tuning.layer.kind === "pitch";
    const phase = this.preferences.reducedMotion ? 0 : this.time;
    const mid = h / 2;
    const line = (color: string, dash: number[], f: (x: number) => number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(dash);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 3) {
        const y = mid - f(x / w) * (h * 0.36);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    const err = tuning.locked ? 0 : clamp(tuning.error / 0.32, -1, 1);
    if (pitch) {
      // Reference sine (solid) and the player's wave (dashed) at a visibly different frequency.
      const cycles = 4;
      line("rgba(255,255,255,0.55)", [], (u) => Math.sin((u * cycles + phase * 0.5) * Math.PI * 2));
      line(
        "#f5b851",
        [6, 4],
        (u) =>
          Math.sin((u * cycles * (1 + err * 0.35) + phase * 0.5) * Math.PI * 2) *
          (0.85 + 0.15 * Math.cos(phase * err * 6)),
      );
    } else {
      // Beat pulses: reference ticks (solid) and the player's pulse (dashed), offset in time.
      const beats = 4;
      const pulse = (u: number, shift: number) => {
        const x = (((u * beats - shift) % 1) + 1) % 1;
        return Math.exp(-x * 14) * 0.95;
      };
      const beatPhase = this.preferences.reducedMotion ? 0 : (this.time / BEAT_SECONDS) % 1;
      line("rgba(255,255,255,0.55)", [], (u) => pulse(u, beatPhase));
      line("#f5b851", [6, 4], (u) => pulse(u, beatPhase + err * 0.5));
    }
    ctx.setLineDash([]);
  }

  // --- Visuals -----------------------------------------------------------------------------

  private updateVisuals(dt: number): void {
    const v = this.visuals;
    if (!v) return;
    const s = this.visualState;
    const p = this.progress;
    s.active = this.active && this.viewerActive;
    s.time = this.presentation.time;
    s.reducedMotion = this.preferences.reducedMotion;
    s.altered = this.presentation.altered;
    s.missionState = this.mission.state;
    s.terminalsRevealed = p.channelDiscovered;
    for (const id of LAYER_IDS) s.locked[id] = p.terminals[id];
    s.sessionLayer = this.session?.layer ?? null;
    s.sessionAlignment = this.session?.tuning.alignment ?? 0;
    s.listeningVisible = concertUnlocked(p);
    s.recordZeroVisible = p.concertCompleted;
    s.concertRunning = this.concert.state === "running" && this.viewerActive;
    s.concertBar = this.concert.bar;
    s.concertMix = this.concert.mix;
    s.waypoint = this.current.target;
    const pl = this.host.player.position;
    s.playerX = pl.x;
    s.playerZ = pl.z;
    s.night = this.host.timeOfDay !== "day" || this.timeOverride === "night";
    v.update(dt, s);
  }

  dispose(): void {
    this.closeSession();
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    const i = this.host.interaction.providers.indexOf(this.provide);
    if (i >= 0) this.host.interaction.providers.splice(i, 1);
    this.rig?.dispose();
    this.rig = null;
    this.visuals?.dispose();
    this.visuals = null;
  }
}

const NUMBERS_CAPTION = 3.2;
const NO_OBJECTIVE = { text: null, hint: null, target: null, label: null };

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export function createVisualState(): VisualState {
  return {
    active: false,
    time: 0,
    reducedMotion: false,
    altered: 0,
    missionState: "available",
    terminalsRevealed: false,
    locked: { rhythm: false, bass: false, harmony: false, melody: false },
    sessionLayer: null,
    sessionAlignment: 0,
    listeningVisible: false,
    recordZeroVisible: false,
    concertRunning: false,
    concertBar: 0,
    concertMix: null,
    waypoint: null,
    playerX: 0,
    playerZ: 0,
    night: false,
  };
}
