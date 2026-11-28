import { confirmTravelCheckpoint } from "./travelCheckpoint";
import type { Game, GameLayer } from "../Game";
import type { KeyValueStorage } from "../afterhours/progress";
import { GameplayState } from "../core/GameState";
import { AiDriver, type DriverWorld } from "../freeroam/Traffic";
import { RoadNetwork } from "../freeroam/Roads";
import { TRANSPORT_HAULER } from "../freeroam/fleet";
import type { InteractableProvider } from "../interaction/InteractionManager";
import type { Vehicle } from "../vehicles/Vehicle";
import { LAB } from "../world/buildCityWorld";
import { readDailyBreadReport } from "./bakery";
import {
  COURTYARD_SUBJECT,
  EPISODES,
  TRIAGE,
  type Choice,
  type Point,
  type Task,
} from "./cityEpisodes";
import {
  CITY_RECORD_KEY,
  addFirst,
  changeReputation,
  loadCityRecord,
  parseCityRecord,
  postBread,
  strongLog,
  type CityRecord,
} from "./cityRecord";
import { auditResearch, canResearch, MODES, rigReading, type ResearchCase } from "./cityResearch";
import { RESEARCH } from "./cityResearchData";
import type { Verdict } from "./sanFierro";

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
const OFFICE = "city-hq";
const COURIER = {
  kind: "road",
  title: "Follow the courier",
  role: "relay",
  point: { x: -5, z: 53 },
  end: 77,
} as const;

export class CityCampaignLayer implements GameLayer {
  readonly wagon: Vehicle;
  record: CityRecord;
  storageOK: boolean;
  office = false;
  triageFile: number | null = null;
  correction = false;
  feedback = "";
  failure = "";
  elapsed = 0;
  progress = 0;
  clocks: number[] = [];
  selected = 0;
  kits = 3;
  target: Vehicle | null = null;
  busy = false;
  private driver: AiDriver | null = null;
  private driverWorld: DriverWorld | null = null;
  private driverTime = 0;
  private protest: { vehicle: Vehicle; driver: AiDriver } | null = null;
  private stopped = false;
  private closeFor = 0;
  private heardPulse = false;
  courierActive = false;
  private disposed = false;
  private readonly offLayer: () => void;
  private readonly offImpact: () => void;
  private readonly enterFilter: Game["interaction"]["enterFilter"];

  constructor(
    readonly game: Game,
    private readonly storage: KeyValueStorage | null,
    private readonly locks?: Pick<LockManager, "request">,
  ) {
    this.record = loadCityRecord(storage);
    this.storageOK = !!storage;
    this.wagon = game.vehicles.vehicles[0];
    this.enterFilter = game.interaction.enterFilter;
    game.interaction.enterFilter = (v) => v === this.wagon;
    game.interaction.providers.push(this.offer);
    this.offLayer = game.addLayer(this);
    this.offImpact = game.events.on("impact", (e) => {
      const hitWagon = e.vehicleId === this.wagon.id || e.otherVehicleId === this.wagon.id;
      const hitTarget = e.vehicleId === this.target?.id || e.otherVehicleId === this.target?.id;
      if (hitWagon && this.wagon.driven && e.other && e.speed > 5) {
        this.wagon.damage(2 * (e.speed - 5));
        if (this.task?.kind === "road" && this.task.role === "kits" && e.speed > 7)
          this.kits = Math.max(1, this.kits - 1);
      }
      if (this.target && hitTarget && e.other && e.speed > 4) this.target.damage(2 * (e.speed - 4));
    });
    this.restore();
    this.syncBread();
  }

  get episode() {
    return EPISODES[this.record.episode];
  }
  get task(): Task | undefined {
    return this.record.step === null ? undefined : this.episode.tasks[this.record.step];
  }
  get complete() {
    return this.record.episode === EPISODES.length;
  }
  get modal() {
    return (
      this.office ||
      this.triageFile !== null ||
      !!this.failure ||
      this.task?.kind === "dialog" ||
      this.task?.kind === "choice" ||
      this.task?.kind === "bakery"
    );
  }
  get driving() {
    return this.game.interaction.state === GameplayState.Driving;
  }
  get position() {
    return this.game.interaction.driven?.physics ?? this.game.player.position;
  }
  get destination(): Point {
    const task = this.task;
    if (!task) return LAB;
    if (task.kind === "triage") {
      if (this.selected === 1 && this.courierActive && this.target) return this.target.physics;
      return this.triageStation(Math.max(0, this.selected));
    }
    if (task.kind === "road" && this.driver) {
      return task.role === "escape" || task.role === "broadcast" || task.role === "kits"
        ? { x: task.point.x, z: task.end }
        : this.target!.physics;
    }
    return "point" in task ? task.point : LAB;
  }
  get prompt() {
    return this.game.interaction.prompt?.label;
  }
  get gap() {
    return distance(this.position, this.destination);
  }
  get photoAimed() {
    const task = this.task;
    if (task?.kind !== "photo") return false;
    const { x, z } = this.game.player.position;
    const point = this.subject!;
    const dx = point.x - x,
      dz = point.z - z;
    const heading = this.game.camera.yaw;
    const minimum = this.courtyard ? 0.98 : 0.84;
    return Math.sin(heading) * dx + Math.cos(heading) * dz >= minimum * Math.hypot(dx, dz);
  }
  get subject(): Point | null {
    const task = this.task;
    if (task?.kind !== "photo") return null;
    return this.courtyard ? COURTYARD_SUBJECT : { x: task.point.x, z: task.point.z + 7 };
  }
  get courtyard() {
    return this.record.episode === 0 && this.task?.kind === "photo";
  }
  get escapeDeadline() {
    const task = this.task;
    return task?.kind === "road" && task.role === "escort" && !this.driver
      ? Math.max(0, 34 - this.elapsed)
      : null;
  }

  // The immutable checkpoint revision also serializes writes from two open HQ tabs.
  private commit(update: (record: CityRecord) => void, after?: () => void) {
    if (this.busy || this.disposed) return;
    this.busy = true;
    const write = () => {
      if (this.disposed) return;
      try {
        const latest = loadCityRecord(this.storage);
        if (latest.revision > this.record.revision) {
          this.record = latest;
          this.restore();
          return;
        }
        const next = structuredClone(this.record);
        update(next);
        next.revision++;
        try {
          this.storage?.setItem(CITY_RECORD_KEY, JSON.stringify(next));
        } catch {
          this.storageOK = false;
        }
        this.record = next;
      } finally {
        this.busy = false;
      }
      after?.();
    };
    if (this.storage && this.locks)
      void this.locks.request(CITY_RECORD_KEY, write).catch(() => {
        if (this.busy) write();
      });
    else write();
  }

  sync() {
    const latest = loadCityRecord(this.storage);
    if (latest.revision > this.record.revision) {
      this.record = latest;
      this.restore();
      this.syncBread();
    }
  }

  syncBread() {
    if (this.task?.kind !== "bakery") return;
    const report = readDailyBreadReport((key) => this.storage?.getItem(key) ?? null);
    if (report) this.advance((r) => postBread(r, report));
  }

  private next(r: CityRecord) {
    if (r.step === null) return;
    const tasks = EPISODES[r.episode].tasks;
    let step = r.step + 1;
    if (tasks[step]?.kind === "road" && r.episode === 3 && r.first.ice !== "causes") {
      r.outcomes.debate = "quiet";
      step++;
    }
    if (
      r.episode === 4 &&
      r.first.power === "battery" &&
      tasks[step]?.title === "Recover the fuse at the pier desk"
    )
      step++;
    if (step < tasks.length) r.step = step;
    else {
      r.episode++;
      r.step = null;
      changeReputation(r, 3);
      r.news = EPISODES[r.episode - 1].title + " filed at Vers3Dynamics.";
    }
  }

  private advance(change?: (r: CityRecord) => void) {
    this.commit(
      (r) => {
        change?.(r);
        this.next(r);
      },
      () => {
        this.beginTask();
        if (!this.task) this.office = true;
        this.syncBread();
      },
    );
  }

  /** Cross-page mission links must not discard a checkpoint held only in memory. */
  async confirmTravel(requireWrite = true) {
    if (this.busy) return false;
    const confirm = () =>
      confirmTravelCheckpoint(
        this.storage,
        CITY_RECORD_KEY,
        this.record,
        parseCityRecord,
        (r) => r.revision,
        JSON.stringify,
        requireWrite,
      );
    this.busy = true;
    try {
      this.storageOK =
        this.locks && this.storage ? await this.locks.request(CITY_RECORD_KEY, confirm) : confirm();
    } catch {
      this.storageOK = false;
    } finally {
      this.busy = false;
    }
    return this.storageOK;
  }

  startEpisode() {
    if (this.task || this.complete) return;
    this.commit(
      (r) => {
        r.step = 0;
      },
      () => {
        this.office = false;
        this.restore();
      },
    );
  }

  continueDialog() {
    if (this.task?.kind === "dialog") this.advance();
  }

  choose(value: Choice) {
    const task = this.task;
    if (task?.kind !== "choice" || !task.choices.includes(value)) return;
    const recordChoice = (r: CityRecord) => {
      const answer =
        task.id === "replication" ? (r.outcomes.kits >= 2 ? "accept" : "abstain") : task.answer;
      addFirst(r, task.id, value, answer);
      if (task.id === "relay" && value === "publish") r.outcomes.relay = "published";
      if (task.id === "fee") changeReputation(r, value === "refuse" ? 5 : -5);
      if (task.id === "power" && value === "trace") changeReputation(r, 3);
    };
    if (task.teach && value !== task.answer) {
      this.commit(recordChoice, () => {
        this.correction = true;
        this.feedback =
          "Your first answer is saved. Recheck the observations before you submit a correction.";
      });
      return;
    }
    this.advance(recordChoice);
  }

  triageStation(index: number): Point {
    return index === 1 && this.record.outcomes.triage[index].observed > 0
      ? { x: -5, z: COURIER.end }
      : TRIAGE[index].point;
  }

  private clearTraffic() {
    this.courierActive = false;
    if (this.target) this.game.vehicles.despawn(this.target);
    if (this.protest) this.game.vehicles.despawn(this.protest.vehicle);
    this.protest = null;
    this.target = null;
    this.driver = null;
    this.driverWorld = null;
  }

  private beginTask() {
    this.clearTraffic();
    this.failure = "";
    const task = this.task;
    this.correction =
      task?.kind === "choice" &&
      !!task.teach &&
      !!this.record.first[task.id] &&
      this.record.first[task.id] !== task.answer;
    if (this.correction)
      this.feedback =
        "Your first answer is saved. Recheck the observations before you submit a correction.";
    this.triageFile = null;
    this.elapsed = 0;
    this.progress = 0;
    this.driverTime = 0;
    this.stopped = false;
    this.closeFor = 0;
    this.heardPulse = false;
    this.clocks = this.record.outcomes.triage.map((person) => person.left);
    this.kits = this.record.outcomes.kits;
    this.selected = this.urgent();
  }

  private restore() {
    this.feedback = "";
    this.beginTask();
    const task = this.task;
    const target = task && "point" in task ? task.point.z : task?.kind === "triage" ? 30 : 0;
    const z = Math.max(-10, Math.min(235, target - (task?.kind === "road" ? 7 : 2)));
    const yaw = task?.kind === "drive" && task.point.z === 0 ? Math.PI : 0;
    this.game.resetForScenario({ x: -6.6, z, yaw });
    this.wagon.place(-4, z + (yaw ? -4 : 4), yaw);
    this.office = task === undefined;
  }

  retry() {
    if (this.failure) this.restore();
  }

  private urgent() {
    return this.record.outcomes.triage.reduce(
      (best, person, i) =>
        person.result === null && (best < 0 || this.clocks[i] < this.clocks[best]) ? i : best,
      -1,
    );
  }

  private saveTriage(update: (r: CityRecord) => void) {
    this.commit(
      (r) => {
        r.outcomes.triage.forEach((person, i) => {
          if (!person.result) person.left = Math.max(0, this.clocks[i]);
        });
        update(r);
        if (r.outcomes.triage.every((person) => person.result !== null)) this.next(r);
      },
      () => {
        this.triageFile = null;
        this.selected = this.urgent();
        if (this.task?.kind !== "triage") this.beginTask();
      },
    );
  }

  fileTriage(value: Verdict) {
    const index = this.triageFile;
    if (this.task?.kind !== "triage" || index === null) return;
    this.saveTriage((r) => {
      r.outcomes.triage[index].result = value;
      changeReputation(r, value === TRIAGE[index].answer ? 3 : -2);
    });
  }

  private offer: InteractableProvider = (x, _y, z) => {
    if (this.modal || this.busy) return null;
    if (!this.task) {
      const gap = distance({ x, z }, LAB);
      return gap <= 5
        ? {
            id: OFFICE,
            label: "Open Vers3Dynamics HQ",
            distance: gap,
            priority: true,
            act: () => {
              this.office = true;
            },
          }
        : null;
    }
    const task = this.task;
    if (task.kind === "triage") {
      const index = TRIAGE.findIndex(
        (_person, i) =>
          this.record.outcomes.triage[i].result === null &&
          this.clocks[i] > 0 &&
          distance({ x, z }, this.triageStation(i)) < 4,
      );
      if (index < 0) return null;
      const person = TRIAGE[index],
        observed = this.record.outcomes.triage[index].observed;
      if (index === 1 && this.courierActive) return null;
      const station = this.triageStation(index);
      return {
        id: "triage",
        label:
          observed === 2
            ? "Review " + person.name + "'s file"
            : "Record " + person.name + " observation " + (observed + 1),
        distance: distance({ x, z }, station),
        priority: true,
        act: () => {
          if (observed === 2) this.triageFile = index;
          else if (index === 1 && observed === 0) {
            this.startRoad(COURIER);
            this.courierActive = true;
            this.selected = 1;
            this.progress = 0;
          } else {
            this.feedback = person.evidence[observed];
            this.saveTriage((r) => {
              r.outcomes.triage[index].observed++;
            });
          }
        },
      };
    }
    if (task.kind !== "walk" && task.kind !== "photo") return null;
    const gap = distance({ x, z }, task.point);
    if (gap > 4.2 || (task.kind === "photo" && !this.photoAimed)) return null;
    return {
      id: "field",
      label: task.kind === "photo" ? "Record the framed observation" : task.title,
      distance: gap,
      priority: true,
      act: () => this.logEvidence(task.evidence),
    };
  };

  private logEvidence(evidence: string) {
    this.feedback = evidence;
    this.game.audio?.radioCall();
    this.advance((r) => {
      r.notes.push(evidence);
    });
  }

  private startRoad(task: Extract<Task, { kind: "road" }>) {
    const following = task.role === "escort" || task.role === "relay";
    const z = task.point.z + (following ? 18 : -15);
    const color =
      task.role === "escort" ? "#b8bec1" : task.role === "relay" ? "#c78a56" : "#805c83";
    this.target = this.game.vehicles.spawn(
      TRANSPORT_HAULER,
      {
        callsign: "CITY-TRAFFIC",
        paint: color,
        canvas: color,
        rear: "canopy",
        roof: "bare",
      },
      3,
      z,
      0,
    );
    const roads = new RoadNetwork(
      [
        [3, z],
        [3, task.end],
      ],
      [],
    );
    this.driver = new AiDriver(this.target, roads, following ? 4.9 : 7.4);
    this.driver.pursue(3, task.end, 0.9);
    this.target.autonomous = true;
    if (task.role === "broadcast") {
      const vehicle = this.game.vehicles.spawn(
        TRANSPORT_HAULER,
        {
          callsign: "CITY-PROTEST",
          paint: "#a998c5",
          canvas: "#735e99",
          rear: "canopy",
          roof: "bare",
        },
        8,
        z - 7,
        0,
      );
      const driver = new AiDriver(
        vehicle,
        new RoadNetwork(
          [
            [8, z - 7],
            [8, task.end],
          ],
          [],
        ),
        7.2,
      );
      driver.pursue(8, task.end, 2);
      vehicle.autonomous = true;
      this.protest = { vehicle, driver };
    }
    this.driverWorld = {
      collision: this.game.collision,
      roads,
      vehicles: this.game.vehicles.vehicles,
      people: [],
      walker: null,
    };
    this.elapsed = 0;
  }

  private guideTraffic(task: Extract<Task, { kind: "road" }>, dt: number) {
    const target = this.target!,
      driver = this.driver!;
    this.driverTime += dt;
    if (this.driverTime >= 1 / 30) {
      this.driverWorld!.walker = this.driving ? null : this.game.player.position;
      driver.update(this.driverTime, this.driverWorld!);
      this.protest?.driver.update(this.driverTime, this.driverWorld!);
      this.driverTime = 0;
    }
    if (!this.stopped && Math.abs(target.physics.z - task.end) < 4.5) {
      driver.hold();
      if (target.physics.speed < 0.45) this.stopped = true;
    }
  }

  private roadStep(task: Extract<Task, { kind: "road" }>, dt: number) {
    if (!this.driver) {
      if (this.driving && this.gap < 9) this.startRoad(task);
      else if (task.role === "escort" && this.elapsed > 34)
        this.failure = "Dispatch reached the family first. Retry from the response checkpoint.";
      return;
    }
    const target = this.target!;
    this.guideTraffic(task, dt);
    const gap = distance(this.position, target.physics);
    const following = task.role === "escort" || task.role === "relay";
    if (following) {
      if (this.driving && gap >= 5 && gap < 35) this.progress += dt;
      if (gap > 95 || target.health < 70 || this.elapsed > 80)
        this.failure = "The escorted vehicle could not finish safely. Retry this checkpoint.";
      if (
        !this.failure &&
        this.stopped &&
        this.driving &&
        gap < 26 &&
        this.progress >= (task.role === "escort" ? (strongLog(this.record) ? 5 : 9) : 3)
      )
        this.advance();
      return;
    }
    this.closeFor = gap < 9 ? this.closeFor + dt : 0;
    if (this.elapsed > 65 || this.closeFor > 7)
      this.failure = "The pursuer caught up. Retry the drive and keep moving.";
    if (!this.failure && this.driving && this.position.z >= task.end - 2 && gap > 6) {
      this.advance((r) => {
        if (task.role === "kits") r.outcomes.kits = this.kits;
        if (task.role === "broadcast") r.outcomes.debate = "pursuit";
      });
    }
  }

  fixedStep(dt: number) {
    const task = this.task;
    if (!task || this.modal || this.busy) return;
    this.elapsed += dt;
    if (this.wagon.wrecked) {
      this.failure = "The research wagon is disabled. Retry the checkpoint.";
      return;
    }
    if (task.kind === "road") this.roadStep(task, dt);
    if (task.kind === "photo") {
      const framed =
        !this.driving && this.gap < 4.2 && this.photoAimed && this.game.player.speed < 0.65;
      this.progress = framed ? Math.min(2.5, this.progress + dt) : 0;
      if (framed && this.record.episode === 1 && !this.heardPulse) {
        this.heardPulse = true;
        this.game.audio?.radioCall(7);
      }
      if (!framed) this.heardPulse = false;
      if (!this.courtyard && this.progress >= 2.5) this.logEvidence(task.evidence);
    }
    if (task.kind === "reading") {
      this.progress =
        this.driving && this.gap < 5 && this.wagon.physics.speed < 0.55 ? this.progress + dt : 0;
      if (this.progress >= 4) this.logEvidence(task.evidence);
    }
    if (task.kind === "drive" && this.driving && this.gap < 7 && this.wagon.physics.speed < 0.65) {
      this.advance((r) => {
        if (r.episode === 1 && r.first.relay === "verify")
          r.outcomes.relay = this.elapsed <= 240 ? "verified" : "wiped";
      });
    }
    if (task.kind === "triage") {
      const expired: number[] = [];
      this.record.outcomes.triage.forEach((person, i) => {
        if (person.result !== null) return;
        this.clocks[i] = Math.max(0, this.clocks[i] - dt);
        if (this.clocks[i] <= 0) expired.push(i);
      });
      if (expired.length === 0) {
        if (this.courierActive) {
          this.guideTraffic(COURIER, dt);
          const gap = distance(this.position, this.target!.physics);
          if (gap >= 5 && gap <= 20) this.progress += dt;
          if (this.stopped && gap < 17 && this.progress >= 2) {
            this.feedback = TRIAGE[1].evidence[0];
            this.clearTraffic();
            this.saveTriage((r) => {
              r.outcomes.triage[1].observed = 1;
            });
          }
        }
        return;
      }
      if (
        expired.length +
          this.record.outcomes.triage.filter((person) => person.result === "detained").length >=
        2
      ) {
        this.failure = "Two people were detained. Retry from the last saved triage decision.";
        return;
      }
      if (expired[0] === 1) this.clearTraffic();
      this.saveTriage((r) => {
        r.outcomes.triage[expired[0]].result = "detained";
        changeReputation(r, -4);
      });
    }
  }

  researchAvailable(c: ResearchCase) {
    return canResearch(c, this.record.episode, Object.keys(this.record.research).length);
  }
  fileResearch(c: ResearchCase, cards: number[], trial: number | null, verdict: Verdict) {
    if (
      !this.office ||
      !this.researchAvailable(c) ||
      this.record.research[c.id]?.audit === "careful"
    )
      return;
    const audit = auditResearch(c, cards, trial, verdict);
    this.commit((r) => {
      const grant = { careful: 1500, sloppy: 600, cautious: 300, retracted: 0 };
      const previous = r.research[c.id];
      const paid = previous?.grant ?? 0;
      r.research[c.id] = { audit, verdict, grant: Math.max(paid, grant[audit]) };
      r.researchFunds += Math.max(0, grant[audit] - paid);
      r.news = audit === "careful" ? c.news.good : c.news.bad;
      changeReputation(r, { careful: 6, sloppy: 2, retracted: -5, cautious: 1 }[audit]);
    });
  }
  logRig(hz: number, on: boolean) {
    if (!this.office || this.record.episode < 1) return;
    const sample = rigReading(hz, on);
    if (sample.kind === "mode" && !this.record.modes.includes(sample.hz)) {
      this.commit((r) => {
        r.modes.push(sample.hz);
        r.researchFunds += 250;
        if (r.modes.length === MODES.length) {
          r.researchFunds += 2000;
          changeReputation(r, 5);
          r.news = "Cymatics atlas complete. Six modes are now on the public record.";
        }
      });
    }
    if (sample.kind === "control" && !this.record.control)
      this.commit((r) => {
        r.control = true;
        r.researchFunds += 300;
        changeReputation(r, 3);
      });
  }

  dispose() {
    this.disposed = true;
    this.offLayer();
    this.offImpact();
    this.clearTraffic();
    const list = this.game.interaction.providers;
    const index = list.indexOf(this.offer);
    if (index >= 0) list.splice(index, 1);
    this.game.interaction.enterFilter = this.enterFilter;
  }
}
