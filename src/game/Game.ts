import * as THREE from "three";
import { CAMERA, EFFECTS, INTERACTION, SIMULATION } from "./config";
import { EventBus } from "./core/EventBus";
import type { GameEvents } from "./core/events";
import { GameplayState } from "./core/GameState";
import { InputState } from "./core/Input";
import { clamp } from "./core/math";
import { ThirdPersonCamera, createCameraFocus } from "./camera/ThirdPersonCamera";
import { CharacterAnimator } from "./player/CharacterAnimator";
import { CharacterVisual } from "./player/CharacterVisual";
import { PlayerController, createMoveIntent } from "./player/PlayerController";
import { Locomotion } from "./player/PlayerState";
import { InteractionManager } from "./interaction/InteractionManager";
import { VehicleController } from "./vehicles/VehicleController";
import { VehicleManager } from "./vehicles/VehicleManager";
import { UTILITY_4X4 } from "./vehicles/VehicleSpec";
import type { Vehicle } from "./vehicles/Vehicle";
import { buildSiteWorld } from "./world/buildSiteWorld";
import type { CollisionWorld } from "./world/CollisionWorld";
import { SURFACE_PROPERTIES, type GroundQuery } from "./world/GroundQuery";
import type { GateSensorTarget } from "./world/BarrierGate";
import { WorldManager } from "./world/WorldManager";
import { PLAYER_SPAWN, VEHICLE_SPAWNS } from "./world/spawns";
import { DustSystem } from "./effects/DustSystem";
import { GameAudio } from "./audio/GameAudio";
import { HudModel } from "./hud/HudModel";

export type TimeOfDay = "day" | "dusk" | "night";

export interface GameOptions {
  /** Build meshes, lights, particles and audio. False for headless tests. */
  visuals: boolean;
  /** Dust sprite texture (browser only). */
  dustSprite?: THREE.Texture | null;
}

export interface FrameOptions {
  /** Advance gameplay (false while paused or in another camera mode). */
  simulate: boolean;
  /** Camera to drive, or null to leave the camera alone. */
  camera: THREE.PerspectiveCamera | null;
  /** Show the pre-deploy establishing orbit instead of the gameplay camera. */
  establishing: boolean;
}

// Suspended dust reads paler than the red ground it rises from.
const DUST_TINT: Record<TimeOfDay, string> = { day: "#dcc4a6", dusk: "#d8b08c", night: "#7a8092" };
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * The playable world. Owns every gameplay system and advances them in a
 * fixed order each rendered frame:
 *
 *   interaction (state machine, prompts)
 *   → fixed-step physics: player, vehicles, barriers (120 Hz, interpolated)
 *   → presentation: vehicles, character, world, effects, camera, audio, HUD
 *
 * The class is renderer-agnostic: React Three Fiber mounts `root` and calls
 * `frame`, while tests drive it headless with `visuals: false`.
 */
export class Game {
  readonly events = new EventBus<GameEvents>();
  readonly input = new InputState();
  readonly root = new THREE.Group();
  readonly collision: CollisionWorld;
  readonly ground: GroundQuery;
  readonly world: WorldManager;
  readonly player: PlayerController;
  readonly animator = new CharacterAnimator();
  readonly character: CharacterVisual | null;
  readonly vehicles: VehicleManager;
  readonly vehicleController = new VehicleController();
  readonly camera: ThirdPersonCamera;
  readonly interaction: InteractionManager;
  readonly dust: DustSystem | null;
  readonly audio: GameAudio | null;
  readonly hud = new HudModel();
  /** World point the gameplay is centred on (shadow frustum, telemetry). */
  readonly focusPoint = new THREE.Vector3();
  focusHeading = 0;

  private accumulator = 0;
  private alpha = 1;
  private timeOfDay: TimeOfDay = "day";
  private readonly focus = createCameraFocus();
  private readonly axes = { x: 0, y: 0 };
  private readonly intent = createMoveIntent();
  private readonly look = { x: 0, y: 0, zoom: 0 };
  private readonly sensorPool: GateSensorTarget[] = [];
  private readonly dustCarry = [0, 0];
  private readonly wheelWorld = new THREE.Vector3();
  private readonly unsubscribers: (() => void)[] = [];

  constructor(options: GameOptions) {
    this.root.name = "game";
    const site = buildSiteWorld();
    this.collision = site.collision;
    this.ground = site.ground;
    this.world = new WorldManager(
      site.gateSites,
      this.collision,
      this.ground,
      this.events,
      options.visuals,
    );
    this.player = new PlayerController(this.collision, this.ground, this.events);
    this.character = options.visuals ? new CharacterVisual() : null;
    this.vehicles = new VehicleManager({
      ground: this.ground,
      collision: this.collision,
      events: this.events,
      visuals: options.visuals,
    });
    this.camera = new ThirdPersonCamera(this.collision, this.ground);
    this.interaction = new InteractionManager({
      player: this.player,
      vehicles: this.vehicles,
      world: this.world,
      collision: this.collision,
      ground: this.ground,
      events: this.events,
    });
    this.dust = options.visuals
      ? new DustSystem(EFFECTS.dustPoolSize, options.dustSprite ?? null)
      : null;
    this.audio = options.visuals ? new GameAudio() : null;

    for (const spawn of VEHICLE_SPAWNS) {
      const vehicle = this.vehicles.spawn(UTILITY_4X4, spawn.variant, spawn.x, spawn.z, spawn.yaw);
      // Parked in gear with the handbrake on, so a shunted vehicle is held.
      this.vehicleController.applyParked(vehicle.controls);
    }
    this.player.teleport(PLAYER_SPAWN.x, PLAYER_SPAWN.z, PLAYER_SPAWN.yaw);
    this.player.interpolate(1);
    this.updateFocus();
    this.camera.snapBehind(this.focus);

    this.root.add(this.world.root, this.vehicles.root);
    if (this.character) this.root.add(this.character.root);
    if (this.dust) this.root.add(this.dust.points);
    this.wireEvents();
  }

  private wireEvents(): void {
    const on = <K extends keyof GameEvents>(type: K, fn: (e: GameEvents[K]) => void) =>
      this.unsubscribers.push(this.events.on(type, fn));
    on("message", (e) => this.hud.showMessage(e.text, INTERACTION.messageDuration));
    on("stateChange", (e) => {
      if (e.to === GameplayState.EnteringVehicle) {
        const v = this.interaction.vehicle;
        if (v) v.headlights = this.timeOfDay !== "day";
      }
      if (e.to === GameplayState.OnFoot && e.from === GameplayState.ExitingVehicle) {
        this.vehicleController.reset();
      }
    });
    on("vehicleExit", () => {
      for (const v of this.vehicles.vehicles)
        if (!v.driven) this.vehicleController.applyParked(v.controls);
    });
    on("impact", (e) => {
      if (this.interaction.driven && e.vehicleId === this.interaction.driven.id) {
        this.camera.addShake(e.speed * CAMERA.shake.impactScale);
      }
      this.audio?.impact(e.speed);
      if (this.dust && e.speed > 2) {
        for (let i = 0; i < 6; i++) {
          this.dust.emit(
            e.x,
            e.y - 0.4,
            e.z,
            (Math.random() - 0.5) * 3,
            0.8 + Math.random(),
            (Math.random() - 0.5) * 3,
            1.2,
            1.6,
            0.35,
          );
        }
      }
    });
    on("footstep", (e) => this.audio?.footstep(e.surface, e.intensity));
    on("land", (e) => {
      this.audio?.land(e.surface, e.speed);
      if (this.dust && SURFACE_PROPERTIES[e.surface].dust > 0.5) {
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2;
          this.dust.emit(
            e.x,
            e.y + 0.05,
            e.z,
            Math.cos(a) * 1.1,
            0.25,
            Math.sin(a) * 1.1,
            0.55,
            1,
            0.25,
          );
        }
      }
    });
    on("doorOpen", () => this.audio?.door(true));
    on("doorClose", () => this.audio?.door(false));
    on("gateMove", (e) => {
      if (Math.hypot(e.x - this.focusPoint.x, e.z - this.focusPoint.z) < 60)
        this.audio?.gate(e.raising);
    });
    this.animator.onFootstep = (_foot, speed) => {
      const p = this.player.position;
      const surface = this.player.surface;
      this.events.emit("footstep", {
        x: p.x,
        y: p.y,
        z: p.z,
        surface,
        intensity: clamp(speed / 6.5, 0.2, 1),
      });
      // Running footfalls kick up a little dust on loose ground.
      if (this.dust && speed >= EFFECTS.footDustSpeed && SURFACE_PROPERTIES[surface].dust > 0.5) {
        this.dust.emit(
          p.x,
          p.y + 0.08,
          p.z,
          (Math.random() - 0.5) * 0.6,
          0.35,
          (Math.random() - 0.5) * 0.6,
          0.45,
          0.9,
          0.22,
        );
      }
    };
  }

  setTimeOfDay(time: TimeOfDay): void {
    this.timeOfDay = time;
    this.dust?.setTint(DUST_TINT[time]);
  }

  /** Called from the user gesture that starts play (enables audio). */
  unlockAudio(): void {
    this.audio?.unlock();
  }

  setPaused(paused: boolean): void {
    if (paused) {
      this.audio?.suspend();
      this.input.releaseAll();
    } else {
      this.audio?.resume();
    }
  }

  // --- Frame --------------------------------------------------------------------

  frame(rawDt: number, options: FrameOptions): void {
    const dt = Math.min(rawDt, SIMULATION.maxFrameDelta);
    if (options.simulate) {
      this.handleFrameInput(dt);
      this.accumulator += dt;
      let steps = 0;
      const step = SIMULATION.fixedTimeStep;
      while (this.accumulator >= step && steps < SIMULATION.maxSubSteps) {
        this.fixedStep(step);
        this.accumulator -= step;
        steps++;
      }
      if (steps === SIMULATION.maxSubSteps) this.accumulator = 0;
      this.alpha = this.accumulator / step;
    }
    // The world freezes when not simulating, but the camera keeps animating
    // (intro glides, the establishing orbit) on real frame time.
    this.present(options.simulate ? dt : 0, dt, options);
    this.input.endFrame();
  }

  private handleFrameInput(dt: number): void {
    const input = this.input;
    if (input.wasPressed("mute") && this.audio) {
      this.hud.update({ muted: this.audio.toggleMute() });
    }
    this.interaction.update(dt, input);

    const driven = this.interaction.driven;
    if (driven && input.wasPressed("headlights")) {
      driven.headlights = !driven.headlights;
      this.events.emit("headlights", { on: driven.headlights });
    }

    input.moveAxes(this.axes);
    if (this.interaction.state === GameplayState.OnFoot) {
      // Camera-relative intent: forward is where the camera looks.
      const yaw = this.camera.yaw;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      // Camera right in world XZ is (-cos yaw, sin yaw).
      const dx = fx * this.axes.y - fz * this.axes.x;
      const dz = fz * this.axes.y + fx * this.axes.x;
      const length = Math.hypot(dx, dz);
      const moving = length > 1e-4;
      this.intent.dirX = moving ? dx / length : 0;
      this.intent.dirZ = moving ? dz / length : 0;
      this.intent.magnitude = Math.min(1, length);
      this.intent.sprint = input.isDown("sprint");
      this.intent.walk = input.walkMode && !this.intent.sprint;
      if (input.wasPressed("jump")) this.player.requestJump();
    } else {
      this.intent.magnitude = 0;
    }

    if (driven) {
      this.vehicleController.update(
        dt,
        input,
        this.axes,
        driven.physics.forwardSpeed,
        driven.controls,
      );
    } else if (
      this.interaction.state === GameplayState.ExitingVehicle &&
      this.interaction.vehicle
    ) {
      const v = this.interaction.vehicle;
      if (v.driven) this.vehicleController.applyStop(v.controls);
      else this.vehicleController.applyParked(v.controls);
    }
  }

  private fixedStep(dt: number): void {
    if (this.interaction.playerActive) {
      this.player.fixedStep(dt, this.interaction.overrideIntent ?? this.intent);
    }
    this.vehicles.fixedStep(dt);

    const sensors = this.world.sensors;
    sensors.length = 0;
    this.vehicles.vehicles.forEach((v, i) => {
      if (!v.driven && !v.physics.awake) return;
      const s = (this.sensorPool[i] ??= { x: 0, z: 0, vx: 0, vz: 0, driven: false });
      s.x = v.physics.x;
      s.z = v.physics.z;
      s.vx = v.physics.vx;
      s.vz = v.physics.vz;
      s.driven = v.driven;
      sensors.push(s);
    });
    const walker = this.interaction.state === GameplayState.OnFoot ? this.player.position : null;
    this.world.fixedStep(dt, this.focusPoint.x, this.focusPoint.z, walker);
  }

  // --- Presentation ---------------------------------------------------------------

  private present(dt: number, cameraDt: number, options: FrameOptions): void {
    this.player.interpolate(this.alpha);
    const driven = this.interaction.driven;
    this.vehicles.frameUpdate(dt, this.alpha, driven);
    this.interaction.resolveCharacter();
    this.updateCharacter(dt);
    this.world.frameUpdate(dt);
    this.updateFocus();
    this.emitVehicleDust(dt);
    this.dust?.update(dt);

    if (options.camera) {
      if (options.establishing) {
        this.camera.updateEstablishing(cameraDt, this.focus, options.camera);
      } else {
        this.look.x = options.simulate ? this.input.lookX : 0;
        this.look.y = options.simulate ? this.input.lookY : 0;
        this.look.zoom = options.simulate ? this.input.zoom : 0;
        this.camera.update(cameraDt, this.focus, this.look, options.camera);
      }
      if (this.character) this.character.visible = !this.camera.characterOccluded;
    }

    this.updateAudio();
    this.updateHud(dt);
  }

  private updateCharacter(dt: number): void {
    const scripted = this.interaction.scripted;
    const vehicle = this.interaction.vehicle;
    const pose = this.animator.update(dt, {
      speed: scripted ? this.interaction.scriptedSpeed : this.player.speed,
      grounded: scripted || this.player.grounded,
      airTime: scripted ? 0 : this.player.airTime,
      verticalVelocity: this.player.velocity.y,
      turnRate: scripted ? 0 : this.player.turnRate,
      seatWeight: this.interaction.seatWeight,
      steer: vehicle ? vehicle.controls.steer : 0,
    });
    const c = this.character;
    if (!c) return;
    if (scripted) {
      c.root.position.copy(this.interaction.scriptedPosition);
      c.root.quaternion.copy(this.interaction.scriptedQuaternion);
    } else {
      c.root.position.copy(this.player.renderPosition);
      c.root.quaternion.setFromAxisAngle(Y_AXIS, this.player.renderYaw);
    }
    c.applyPose(pose);
  }

  private updateFocus(): void {
    const f = this.focus;
    const v = this.interaction.vehicle;
    if (this.interaction.cameraMode === "vehicle" && v) {
      const r = v.physics.render;
      f.x = r.x;
      f.y = r.y;
      f.z = r.z;
      f.heading = r.yaw;
      f.speed = v.physics.speed;
      f.forwardSpeed = v.physics.forwardSpeed;
      f.mode = "vehicle";
      f.sprinting = false;
      f.exclude = v;
    } else {
      const src = this.interaction.scripted
        ? this.interaction.scriptedPosition
        : this.player.renderPosition;
      f.x = src.x;
      f.y = src.y;
      f.z = src.z;
      f.heading = this.player.renderYaw;
      f.speed = this.player.speed;
      f.forwardSpeed = this.player.speed;
      f.mode = "foot";
      f.sprinting = this.player.locomotion === Locomotion.Sprint;
      f.exclude = null;
    }
    this.focusPoint.set(f.x, f.y, f.z);
    this.focusHeading = f.heading;
  }

  /** Dust plumes from tyres on loose ground, scaled by speed and slip. */
  private emitVehicleDust(dt: number): void {
    const dust = this.dust;
    if (!dust || dt === 0) return;
    for (const v of this.vehicles.vehicles) {
      if (!v.visual || (!v.driven && !v.physics.awake)) continue;
      const p = v.physics;
      if (p.contact < 0.5) continue;
      const speed = p.speed;
      for (let w = 2; w < 4; w++) {
        const dustiness = SURFACE_PROPERTIES[p.wheelSurface[w]].dust;
        const rate =
          dustiness * EFFECTS.tyreDustRate * (Math.max(0, speed - 1.5) / 10 + p.slip * 0.25);
        this.dustCarry[w - 2] += rate * dt;
        while (this.dustCarry[w - 2] >= 1) {
          this.dustCarry[w - 2] -= 1;
          const [lx, lz] = p.wheelLocal[w];
          v.bodyToWorld(lx * 1.05, 0.15, lz - 0.35, this.wheelWorld);
          dust.emit(
            this.wheelWorld.x + (Math.random() - 0.5) * 0.4,
            this.wheelWorld.y,
            this.wheelWorld.z + (Math.random() - 0.5) * 0.4,
            -p.vx * 0.25 + (Math.random() - 0.5) * 1.2,
            0.5 + Math.random() * 0.8,
            -p.vz * 0.25 + (Math.random() - 0.5) * 1.2,
            1.2 + Math.min(1.4, speed * 0.06),
            1.4 + Math.random() * 1.2,
            0.24 + Math.min(0.28, dustiness * speed * 0.014),
          );
        }
      }
    }
  }

  /** Engine speed estimate 0..1 from the simulated gearbox. */
  private engineRpm(v: Vehicle): number {
    const shifts = v.spec.engine.shiftSpeeds;
    const speed = Math.abs(v.physics.forwardSpeed);
    const gear = Math.max(1, Math.abs(v.physics.gear));
    const lo = shifts[gear - 1] ?? 0;
    const hi = shifts[gear] ?? v.spec.engine.topSpeed;
    const within = clamp((speed - lo) / Math.max(1, hi - lo), 0, 1);
    return clamp(0.18 + within * 0.7 + v.controls.throttle * 0.12, 0, 1);
  }

  private updateAudio(): void {
    const audio = this.audio;
    if (!audio?.ready) return;
    const v = this.interaction.vehicle;
    audio.update({
      engineOn: v?.driven ?? false,
      rpm: v ? this.engineRpm(v) : 0,
      throttle: v?.driven ? v.controls.throttle : 0,
      slip: v?.driven ? v.physics.slip : 0,
      speed: this.focus.speed,
      surface: v ? v.physics.rearSurface : this.player.surface,
    });
  }

  private updateHud(dt: number): void {
    const hud = this.hud;
    const driven = this.interaction.driven;
    hud.update({
      state: this.interaction.state,
      prompt: this.interaction.prompt,
      vehicleLabel: this.interaction.vehicle?.label ?? null,
      headlights: driven?.headlights ?? false,
    });
    hud.tick(dt);
    if (driven) {
      const gear = this.vehicleController.gear;
      hud.writeReadouts(dt, {
        speedKmh: Math.abs(driven.physics.forwardSpeed) * 3.6,
        gear: gear === "D" ? `D${driven.physics.gear}` : gear,
        speedFraction: Math.abs(driven.physics.forwardSpeed) / driven.spec.engine.topSpeed,
      });
    }
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.events.clear();
    this.vehicles.dispose();
    this.world.dispose();
    this.character?.dispose();
    this.dust?.dispose();
    this.audio?.dispose();
    this.root.removeFromParent();
  }
}
