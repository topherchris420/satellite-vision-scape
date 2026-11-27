import { RandomStream } from "../../lib/freeroam/rng";
import { Attention } from "../freeroam/Attention";
import { createAimSample, Sidearm } from "../freeroam/Weapons";
import { GameplayState } from "../core/GameState";
import type { InputState } from "../core/Input";
import type { Game, GameLayer } from "../Game";
import type { KeyValueStorage } from "../afterhours/progress";
import { AiDriver, type DriverWorld } from "../freeroam/Traffic";
import { RoadNetwork } from "../freeroam/Roads";
import { TRANSPORT_HAULER } from "../freeroam/fleet";
import type { InteractableProvider } from "../interaction/InteractionManager";
import { BAKERY, CITY_DISTRICT, DELIVERY_ROUTE, LAB, SHELTER } from "../world/buildCityWorld";
import type { Vehicle } from "../vehicles/Vehicle";
import {
  BAKERY_KEY,
  bakeryStep,
  fileAnswer,
  freshTail,
  parseBakery,
  sampleDelivery,
  type BakerySave,
} from "./bakery";
import type { Verdict } from "./sanFierro";

export type CityPhase =
  | "meet"
  | "briefing"
  | "board"
  | "tail"
  | "interview"
  | "receipt"
  | "return"
  | "report"
  | "filed"
  | "failed";
const distance = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

const CHECKPOINT_PHASE = {
  briefing: "meet",
  departure: "board",
  return: "return",
  report: "report",
  filed: "filed",
} as const satisfies Record<BakerySave["checkpoint"], CityPhase>;

export class CityStoryLayer implements GameLayer {
  readonly wagon: Vehicle;
  readonly van: Vehicle;
  readonly driver: AiDriver;
  readonly tail = freshTail();
  phase: CityPhase = "meet";
  record: BakerySave;
  arrived = false;
  failure = "";
  storageOK: boolean;
  readonly attention = new Attention();
  readonly sidearm = new Sidearm(new RandomStream(642));
  private readonly aim = createAimSample();
  elapsed = 0;
  health = 100;
  lastShot = -Infinity;
  get cash() {
    return this.record.checkpoint === "filed" ? 400 : 350;
  }
  // Six city HUD stars span the full continuous attention meter.
  get wanted() {
    return Math.min(6, Math.ceil(this.attention.meter));
  }
  get clock() {
    const minutes = (6 * 60 + 42 + Math.floor(this.elapsed / 3)) % 1440;
    return [Math.floor(minutes / 60), minutes % 60]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
  }
  get canEquip() {
    return (
      this.game.interaction.state === GameplayState.OnFoot &&
      ["meet", "board", "tail", "interview", "return"].includes(this.phase)
    );
  }
  toggleEquipment() {
    if (this.canEquip) this.game.storySidearmDrawn = !this.game.storySidearmDrawn;
  }
  private fire() {
    if (!this.canEquip || !this.game.storySidearmDrawn) return;
    const { player, camera, collision, ground } = this.game;
    const result = this.sidearm.fire(
      { collision, ground, people: [] },
      {
        ...player.position,
        yaw: camera.yaw,
        pitch: camera.pitch,
        grounded: player.grounded,
        speed: player.speed,
        aiming: true,
      },
      this.elapsed,
      "human",
      this.aim,
    );
    if (!result.fired) return;
    this.lastShot = this.elapsed;
    this.game.audio?.impact(6);
    this.attention.report("gunshot", true, player.position.x, player.position.z, this.elapsed);
    this.attention.seen(player.position.x, player.position.z, this.elapsed);
    if (result.hit.vehicle === this.van && this.phase === "tail") this.van.damage(12);
  }
  update(_dt: number, input: InputState) {
    if (!this.canEquip) this.game.storySidearmDrawn = false;
    if (input.wasPressed("fire") || input.virtual.fire) this.fire();
  }
  private disposed = false;
  private driverTime = 0;
  private readonly world: DriverWorld;
  private readonly removeLayer: () => void;
  private readonly removeImpact: () => void;
  private readonly previousFilter: Game["interaction"]["enterFilter"];

  constructor(
    readonly game: Game,
    private readonly storage: KeyValueStorage | null,
    private readonly locks?: Pick<LockManager, "request">,
  ) {
    this.storageOK = !!storage;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(BAKERY_KEY) ?? null;
    } catch {
      this.storageOK = false;
    }
    this.record = parseBakery(raw);
    this.wagon = game.vehicles.vehicles[0];
    this.van = game.vehicles.spawn(
      TRANSPORT_HAULER,
      {
        callsign: "DAWN-1",
        paint: "#e4ad50",
        rear: "canopy",
        canvas: "#a4512e",
        roof: "bare",
      },
      BAKERY.x,
      BAKERY.z,
      0,
    );
    const roads = new RoadNetwork(DELIVERY_ROUTE, []);
    this.driver = new AiDriver(this.van, roads, 6.5);
    this.world = {
      collision: game.collision,
      roads,
      vehicles: game.vehicles.vehicles,
      people: [],
      walker: null,
    };
    this.previousFilter = game.interaction.enterFilter;
    game.interaction.enterFilter = (v) => v === this.wagon;
    game.interaction.providers.push(this.offer);
    this.removeLayer = game.addLayer(this);
    this.removeImpact = game.events.on("impact", (event) => {
      if (
        event.other &&
        game.interaction.vehicle === this.wagon &&
        this.wagon.driven &&
        (event.vehicleId === this.wagon.id || event.otherVehicleId === this.wagon.id) &&
        event.speed > 5
      ) {
        this.wagon.damage((event.speed - 5) * 2);
        this.health = Math.max(0, this.health - (event.speed - 5));
        this.attention.report("vehicle_crash", true, event.x, event.z, this.elapsed);
        this.attention.seen(event.x, event.z, this.elapsed);
      }
      if (this.phase !== "tail" || !event.other) return;
      if (event.vehicleId !== this.van.id && event.otherVehicleId !== this.van.id) return;
      // Ignore parking taps. A closing speed of 7 m/s costs 10 of the van's 100 health.
      this.van.damage(Math.max(0, event.speed - 2) * 2);
    });
    this.restore();
  }

  /** Storage events and writes both consult the current value, including first answers. */
  syncSavedProgress(): boolean {
    if (!this.storage || this.disposed) return false;
    let saved: BakerySave;
    try {
      saved = parseBakery(this.storage.getItem(BAKERY_KEY));
      this.storageOK = true;
    } catch {
      this.storageOK = false;
      return false;
    }
    const step = bakeryStep(saved),
      localStep = bakeryStep(this.record);
    if (
      step < localStep ||
      (step === localStep && JSON.stringify(saved) === JSON.stringify(this.record))
    )
      return false;
    this.record = saved;
    this.restore();
    return true;
  }

  private save(record: BakerySave) {
    const before = this.record;
    const commit = () => {
      if (this.disposed || this.record !== before) return;
      try {
        if (this.syncSavedProgress()) return;
        if (this.storageOK)
          this.storage?.setItem(BAKERY_KEY, JSON.stringify({ version: 1, ...record }));
      } catch {
        // The mission can still advance in memory if storage becomes unavailable.
        this.storageOK = false;
      }
      this.record = record;
      this.phase = CHECKPOINT_PHASE[record.checkpoint];
    };
    if (this.storage && this.locks) {
      // Serialize the read and write across same-origin tabs.
      void this.locks.request(BAKERY_KEY, commit).catch(commit);
    } else commit();
  }

  private restore() {
    const checkpoint = this.record.checkpoint;
    this.phase = CHECKPOINT_PHASE[checkpoint];
    const atShelter = checkpoint === "return";
    this.game.resetForScenario(
      atShelter ? { x: SHELTER.x, z: SHELTER.z, yaw: Math.PI } : CITY_DISTRICT.playerSpawn,
    );
    if (atShelter) this.wagon.place(-4, 212, Math.PI);
    this.van.resetState();
    const [x, z] = DELIVERY_ROUTE[DELIVERY_ROUTE.length - 1];
    this.van.place(atShelter ? x : BAKERY.x, atShelter ? z : BAKERY.z, 0);
    this.health = 100;
    this.attention.reset();
    this.sidearm.reset(new RandomStream(642));
    this.game.storySidearmDrawn = false;
    this.lastShot = -Infinity;
    this.driver.reset();
    this.driver.hold();
    this.arrived = atShelter;
    this.driverTime = 0;
    Object.assign(this.tail, freshTail());
    this.failure = "";
  }

  private readonly offer: InteractableProvider = (x, _y, z) => {
    const atLab = this.phase === "meet" || this.phase === "return";
    if (!atLab && this.phase !== "interview") return null;
    const gap = distance({ x, z }, atLab ? LAB : SHELTER);
    if (gap > 5) return null;
    const label =
      this.phase === "meet" ? "Speak to Ines" : atLab ? "File findings" : "Speak to the driver";
    return {
      id: atLab ? "city-lab" : "city-driver",
      label,
      distance: gap,
      priority: true,
      act: () => {
        this.game.input.releaseAll();
        if (this.phase === "meet") this.phase = "briefing";
        else if (this.phase === "interview") this.phase = "receipt";
        else if (this.phase === "return") {
          this.save({ checkpoint: "report", cargo: null });
        }
      },
    };
  };

  acceptBriefing() {
    if (this.phase !== "briefing") return;
    this.save({ checkpoint: "departure" });
  }

  collectReceipt() {
    if (this.phase !== "receipt") return;
    this.save({ checkpoint: "return" });
  }

  answer(id: number, value: Verdict) {
    if (this.phase !== "report") return;
    const next = fileAnswer(this.record, id, value);
    if (next === this.record) return;
    this.save(next);
  }

  retry() {
    if (this.phase === "failed") this.restore();
  }

  get gap() {
    return distance(
      this.game.interaction.driven?.physics ?? this.game.player.position,
      this.van.physics,
    );
  }

  fixedStep(dt: number) {
    this.elapsed += dt;
    this.attention.tick(dt, false, this.elapsed);
    this.sidearm.update(this.elapsed, dt);
    if ((this.wagon.wrecked || this.health <= 0) && this.phase !== "failed") {
      this.failure = "The research wagon cannot finish the run. Restart at your last checkpoint.";
      this.phase = "failed";
      this.driver.hold();
      this.game.input.releaseAll();
      return;
    }
    const inWagon = this.game.interaction.driven === this.wagon;
    if (this.phase === "board" && inWagon) {
      this.phase = "tail";
      const [x, z] = DELIVERY_ROUTE[DELIVERY_ROUTE.length - 1];
      this.driver.pursue(x, z, 1);
      this.driver.waypoints = DELIVERY_ROUTE.slice(1).map(([px, pz]) => ({ x: px, z: pz }));
      this.van.autonomous = true;
    }
    if (this.phase !== "tail") return;
    const van = this.van.physics;
    if (!this.arrived) {
      this.driverTime += dt;
      if (this.driverTime >= 1 / 30) {
        this.world.walker = inWagon ? null : this.game.player.position;
        this.driver.update(this.driverTime, this.world);
        this.driverTime = 0;
      }
      if (Math.hypot(van.x - this.driver.targetX, van.z - this.driver.targetZ) < 5) {
        this.driver.hold();
        if (van.speed < 0.4) {
          this.arrived = true;
          this.van.autonomous = false;
        }
      }
    }
    const result = sampleDelivery(
      this.tail,
      dt,
      this.gap,
      inWagon,
      this.arrived,
      this.wagon.physics.speed < 0.5,
    );
    if (result.lost || this.van.health < 90) {
      this.failure = result.lost
        ? "The delivery van left your observation range."
        : "The delivery was interrupted by a collision.";
      this.phase = "failed";
      this.driver.hold();
      this.game.input.releaseAll();
    } else if (result.complete) this.phase = "interview";
  }

  dispose() {
    this.disposed = true;
    this.game.storySidearmDrawn = false;
    this.removeLayer();
    this.removeImpact();
    const list = this.game.interaction.providers;
    const index = list.indexOf(this.offer);
    if (index >= 0) list.splice(index, 1);
    this.game.interaction.enterFilter = this.previousFilter;
    this.game.vehicles.despawn(this.van);
  }
}
