import { describe, expect, test } from "bun:test";
import { ControlArbiter } from "../src/agent/control";
import { CAMERA } from "../src/game/config";
import { GameplayState } from "../src/game/core/GameState";
import { InputState } from "../src/game/core/Input";
import {
  ActionBus,
  createActionState,
  stateToActions,
  type ActionState,
} from "../src/game/freeroam/ActionBus";
import { AvatarController } from "../src/game/freeroam/AvatarController";
import { HumanActionSource } from "../src/game/freeroam/HumanActionSource";
import {
  ACTION_TYPES,
  CONTROL_LIMITS,
  GameActionSchema,
  parseGameAction,
  type GameAction,
} from "../src/lib/freeroam/contracts";

/**
 * The shared action interface. A person's keys and an agent's behaviours are
 * expressed in one vocabulary, meet on one bus, and reach the world through
 * one controller. These tests pin that contract.
 */

const DT = 1 / 60;

function resolve(bus: ActionBus, dt = DT): ActionState {
  return bus.resolve(dt, createActionState());
}

describe("GameAction contract", () => {
  test("every documented action parses, and nothing else does", () => {
    const valid: GameAction[] = [
      { type: "MOVE", forward: 1, strafe: -0.5 },
      { type: "LOOK", yaw: 0.1, pitch: -0.05 },
      { type: "SPRINT", active: true },
      { type: "JUMP" },
      { type: "AIM", active: false },
      { type: "FIRE" },
      { type: "INTERACT" },
      { type: "ENTER_VEHICLE" },
      { type: "EXIT_VEHICLE" },
      { type: "ACCELERATE", amount: 0.7 },
      { type: "BRAKE", amount: 1 },
      { type: "STEER", amount: -1 },
      { type: "HANDBRAKE", active: true },
      { type: "HEADLIGHTS" },
      { type: "WAIT" },
    ];
    expect(new Set(valid.map((a) => a.type))).toEqual(new Set(ACTION_TYPES));
    for (const action of valid) expect(parseGameAction(action)).toEqual(action);
  });

  test("malformed actions are refused rather than repaired", () => {
    const bad: unknown[] = [
      { type: "TELEPORT", x: 1, z: 2 },
      { type: "MOVE", forward: 2, strafe: 0 },
      { type: "MOVE", forward: 0 },
      { type: "MOVE", forward: NaN, strafe: 0 },
      { type: "LOOK", yaw: 9, pitch: 0 },
      { type: "ACCELERATE", amount: -0.1 },
      { type: "STEER", amount: 1.01 },
      { type: "FIRE", targetId: "ped-1" },
      { type: "SPRINT", active: "yes" },
      { type: "JUMP", extra: true },
      "MOVE",
      null,
      42,
    ];
    for (const value of bad) expect(GameActionSchema.safeParse(value).success).toBe(false);
  });

  test("there is no action that names a position, a velocity or a target", () => {
    // FIRE(targetId) would let an agent skip aiming; positions would be teleports.
    const shape = GameActionSchema.options.map((o) => Object.keys(o.shape).sort());
    for (const keys of shape) {
      for (const forbidden of ["x", "y", "z", "position", "velocity", "target", "targetId", "id"])
        expect(keys).not.toContain(forbidden);
    }
  });
});

describe("action bus arbitration", () => {
  test("HUMAN accepts only the person; agent and assist actions are dropped and counted", () => {
    const bus = new ActionBus();
    bus.mode = "HUMAN";
    bus.submit("human", [{ type: "MOVE", forward: 1, strafe: 0 }]);
    bus.submit("agent", [{ type: "MOVE", forward: -1, strafe: 0 }, { type: "JUMP" }]);
    bus.submit("assist", [{ type: "STEER", amount: 0.2 }]);
    const s = resolve(bus);
    expect(s.forward).toBe(1);
    expect(s.jump).toBe(false);
    expect(bus.stats.droppedSource).toBe(3);
  });

  test("JEV accepts only the agent: a person's queued actions never reach the avatar", () => {
    const bus = new ActionBus();
    bus.mode = "JEV";
    bus.submit("human", [{ type: "FIRE" }, { type: "MOVE", forward: 1, strafe: 1 }]);
    bus.submit("agent", [{ type: "MOVE", forward: 0.5, strafe: 0 }]);
    const s = resolve(bus);
    expect(s.forward).toBe(0.5);
    expect(s.strafe).toBe(0);
    expect(s.fire).toBe(false);
  });

  test("a replay accepts only the recorded stream, whatever the mode", () => {
    const bus = new ActionBus();
    bus.mode = "HUMAN";
    bus.replaying = true;
    bus.submit("human", [{ type: "JUMP" }]);
    bus.submit("replay", [{ type: "FIRE" }]);
    const s = resolve(bus);
    expect(s.jump).toBe(false);
    expect(s.fire).toBe(true);
  });

  test("ASSIST keeps the person primary and only lets an assist nudge, within bounds", () => {
    const bus = new ActionBus();
    bus.mode = "ASSIST";
    bus.submit("human", [
      { type: "AIM", active: true },
      { type: "STEER", amount: 0.1 },
      { type: "LOOK", yaw: 0.01, pitch: 0 },
    ]);
    bus.submit("assist", [
      // Forbidden for an assist: it corrects, it does not act.
      { type: "FIRE" },
      { type: "JUMP" },
      { type: "MOVE", forward: 1, strafe: 0 },
      { type: "BRAKE", amount: 1 },
      // Allowed, and bounded.
      { type: "LOOK", yaw: 0.5, pitch: 0.5 },
      { type: "STEER", amount: 1 },
    ]);
    const s = resolve(bus);
    expect(s.fire).toBe(false);
    expect(s.jump).toBe(false);
    expect(s.forward).toBe(0);
    expect(s.brake).toBe(0);
    const cap = CONTROL_LIMITS.assist.maxLookRate * DT;
    expect(s.lookYaw).toBeCloseTo(0.01 + cap, 4);
    expect(s.lookPitch).toBeCloseTo(cap, 4);
    expect(s.steer).toBeGreaterThan(0.1);
    expect(s.steer).toBeLessThanOrEqual(0.1 + CONTROL_LIMITS.assist.maxSteer + 1e-9);
    expect(bus.stats.droppedAssist).toBe(4);
  });

  test("an assist cannot nudge the camera unless the person is aiming", () => {
    const bus = new ActionBus();
    bus.mode = "ASSIST";
    bus.submit("human", [{ type: "MOVE", forward: 1, strafe: 0 }]);
    bus.submit("assist", [{ type: "LOOK", yaw: 0.2, pitch: 0 }]);
    expect(resolve(bus).lookYaw).toBe(0);
  });

  test("an assist's steering fades as the person steers harder", () => {
    const gentle = new ActionBus();
    gentle.mode = "ASSIST";
    gentle.submit("human", [{ type: "STEER", amount: 0 }]);
    gentle.submit("assist", [{ type: "STEER", amount: 1 }]);
    const hard = new ActionBus();
    hard.mode = "ASSIST";
    hard.submit("human", [{ type: "STEER", amount: 0.9 }]);
    hard.submit("assist", [{ type: "STEER", amount: 1 }]);
    const a = resolve(gentle).steer;
    const b = resolve(hard).steer - 0.9;
    expect(a).toBeCloseTo(CONTROL_LIMITS.assist.maxSteer, 3);
    expect(b).toBeLessThan(a / 2);
  });

  test("the camera turn-rate limit is the same for every source", () => {
    for (const [mode, source] of [
      ["HUMAN", "human"],
      ["JEV", "agent"],
    ] as const) {
      const bus = new ActionBus();
      bus.mode = mode;
      bus.submit(source, [{ type: "LOOK", yaw: 3, pitch: -3 }]);
      const s = resolve(bus);
      const limit = CONTROL_LIMITS.maxLookRate * DT;
      expect(s.lookYaw).toBeCloseTo(limit, 4);
      expect(s.lookPitch).toBeCloseTo(-limit, 4);
    }
  });

  test("controls are quantised, so what the avatar receives is exactly what a trace records", () => {
    const bus = new ActionBus();
    bus.mode = "JEV";
    bus.submit("agent", [
      { type: "MOVE", forward: 0.123456789, strafe: -0.987654321 },
      { type: "LOOK", yaw: 0.0123456789, pitch: 0 },
    ]);
    const s = resolve(bus);
    expect(s.forward).toBe(0.123);
    expect(s.strafe).toBe(-0.988);
    expect(s.lookYaw).toBe(0.01235);
    // Round trip: state → canonical actions → replay → the same state.
    const actions = stateToActions(s);
    const replay = new ActionBus();
    replay.replaying = true;
    replay.submit("replay", actions);
    expect(resolve(replay)).toEqual(s);
  });

  test("the queues are emptied by every resolve: nothing leaks into the next frame", () => {
    const bus = new ActionBus();
    bus.mode = "JEV";
    bus.submit("agent", [{ type: "JUMP" }]);
    expect(resolve(bus).jump).toBe(true);
    expect(resolve(bus).jump).toBe(false);
  });
});

describe("the person, expressed as actions", () => {
  const human = new HumanActionSource();
  const onFoot = { state: GameplayState.OnFoot, promptIsVehicle: false };

  test("WASD on foot is MOVE, Shift is SPRINT, mouse buttons are AIM and FIRE", () => {
    const input = new InputState();
    input.keyDown("KeyW");
    input.keyDown("KeyD");
    input.keyDown("ShiftLeft");
    input.keyDown("Mouse2");
    input.keyDown("Mouse0");
    const out = human.poll(input, onFoot);
    const move = out.find((a) => a.type === "MOVE");
    expect(move).toBeDefined();
    if (move?.type === "MOVE") {
      expect(move.forward).toBeCloseTo(Math.SQRT1_2, 5);
      expect(move.strafe).toBeCloseTo(Math.SQRT1_2, 5);
    }
    expect(out).toContainEqual({ type: "SPRINT", active: true });
    expect(out).toContainEqual({ type: "AIM", active: true });
    expect(out).toContainEqual({ type: "FIRE" });
  });

  test("the on-screen sights and trigger are AIM and FIRE like the mouse buttons, and touching them is the person acting", () => {
    const input = new InputState();
    input.virtual.aim = true;
    input.virtual.fire = true;
    const out = human.poll(input, onFoot);
    expect(out).toContainEqual({ type: "AIM", active: true });
    expect(out).toContainEqual({ type: "FIRE" });
    // A hand on the screen takes the avatar back from Jev, as a key does.
    const arbiter = new ControlArbiter(input);
    expect(arbiter.humanActivity()).toBe(true);
    // A handover clears the latch: sights left up must not read as a takeover on the very next frame.
    arbiter.grant("agent");
    expect(input.virtual.aim).toBe(false);
    expect(arbiter.humanActivity()).toBe(false);
  });

  test("the same keys drive a vehicle: W accelerates, S brakes, A/D steer, Space is the handbrake", () => {
    const driving = { state: GameplayState.Driving, promptIsVehicle: false };
    const press = (...codes: string[]) => {
      const input = new InputState();
      for (const code of codes) input.keyDown(code);
      return human.poll(input, driving);
    };
    expect(press("KeyW")).toContainEqual({ type: "ACCELERATE", amount: 1 });
    expect(press("KeyS")).toContainEqual({ type: "BRAKE", amount: 1 });
    expect(press("KeyA")).toContainEqual({ type: "STEER", amount: -1 });
    expect(press("KeyD")).toContainEqual({ type: "STEER", amount: 1 });
    expect(press("Space")).toContainEqual({ type: "HANDBRAKE", active: true });
    // Keyboard diagonals are normalised by the input layer, as they always were.
    const both = press("KeyW", "KeyA");
    const throttle = both.find((a) => a.type === "ACCELERATE");
    expect(throttle?.type === "ACCELERATE" && throttle.amount).toBeCloseTo(Math.SQRT1_2, 5);
    expect(both.find((a) => a.type === "MOVE")).toBeUndefined();
  });

  test("F (or E) is ENTER_VEHICLE at a door, INTERACT elsewhere, EXIT_VEHICLE at the wheel", () => {
    const at = (state: GameplayState, promptIsVehicle: boolean, code = "KeyF") => {
      const input = new InputState();
      input.keyDown(code);
      return human.poll(input, { state, promptIsVehicle }).filter((a) =>
        ["ENTER_VEHICLE", "INTERACT", "EXIT_VEHICLE"].includes(a.type),
      );
    };
    expect(at(GameplayState.OnFoot, true)).toEqual([{ type: "ENTER_VEHICLE" }]);
    expect(at(GameplayState.OnFoot, false)).toEqual([{ type: "INTERACT" }]);
    expect(at(GameplayState.Driving, false)).toEqual([{ type: "EXIT_VEHICLE" }]);
    expect(at(GameplayState.OnFoot, true, "KeyE")).toEqual([{ type: "ENTER_VEHICLE" }]);
  });

  test("mouse movement is LOOK in radians: right turns right, down looks down", () => {
    const input = new InputState();
    input.addLook(100, 50);
    const look = human.poll(input, onFoot).find((a) => a.type === "LOOK");
    expect(look).toEqual({
      type: "LOOK",
      yaw: 100 * CAMERA.lookSensitivity,
      pitch: -50 * CAMERA.lookSensitivity,
    });
  });

  test("the walk toggle is a shorter stick, not a separate mode", () => {
    const input = new InputState();
    input.keyDown("KeyC");
    input.keyDown("KeyW");
    const move = human.poll(input, onFoot).find((a) => a.type === "MOVE");
    expect(move).toEqual({ type: "MOVE", forward: CONTROL_LIMITS.walkRatio, strafe: 0 });
  });
});

describe("the avatar controller", () => {
  function rig(state: GameplayState = GameplayState.OnFoot, promptTarget: string | null = null) {
    const arbiter = new ControlArbiter(new InputState());
    const host = {
      interaction: { state, promptTarget },
      vehicles: { vehicles: [{ id: "UV-1" }] },
    };
    return { arbiter, host, avatar: new AvatarController(arbiter.synthetic, host) };
  }

  test("on foot, actions become the stick, sprint, held aim and key presses gameplay reads", () => {
    const { arbiter, avatar } = rig();
    const s = createActionState();
    s.forward = 0.8;
    s.strafe = -0.3;
    s.sprint = true;
    s.jump = true;
    avatar.apply(s);
    const input = arbiter.synthetic;
    const axes = input.moveAxes({ x: 0, y: 0 });
    // Analog axes inside the unit circle pass through untouched.
    expect(axes.y).toBeCloseTo(0.8, 5);
    expect(axes.x).toBeCloseTo(-0.3, 5);
    expect(input.isDown("sprint")).toBe(true);
    expect(input.wasPressed("jump")).toBe(true);
    s.aim = true;
    avatar.apply(s);
    expect(input.isDown("aim")).toBe(true);
    // Aiming and sprinting exclude each other.
    expect(input.isDown("sprint")).toBe(false);
  });

  test("driving, the pedals and wheel drive the same axes the vehicle controller has always read", () => {
    const { arbiter, avatar } = rig(GameplayState.Driving);
    const s = createActionState();
    s.accelerate = 0.9;
    s.brake = 0.2;
    s.steer = 0.4;
    s.handbrake = true;
    avatar.apply(s);
    const axes = arbiter.synthetic.moveAxes({ x: 0, y: 0 });
    expect(axes.y).toBeGreaterThan(0);
    expect(axes.x).toBeGreaterThan(0);
    expect(arbiter.synthetic.isDown("handbrake")).toBe(true);
  });

  test("actions that mean nothing here are not applied, and are reported", () => {
    const { arbiter, avatar } = rig(GameplayState.OnFoot, null);
    const s = createActionState();
    s.enterVehicle = true;
    s.exitVehicle = true;
    s.steer = 0.5;
    avatar.apply(s);
    expect(arbiter.synthetic.wasPressed("interact")).toBe(false);
    expect(avatar.ignored.map((i) => i.action).sort()).toEqual(
      ["ACCELERATE", "ENTER_VEHICLE", "EXIT_VEHICLE"].sort(),
    );
  });

  test("ENTER_VEHICLE applies at a vehicle door but not at a barrier control", () => {
    const door = rig(GameplayState.OnFoot, "UV-1");
    const s = createActionState();
    s.enterVehicle = true;
    door.avatar.apply(s);
    expect(door.arbiter.synthetic.wasPressed("interact")).toBe(true);
    const gate = rig(GameplayState.OnFoot, "gate:north");
    gate.avatar.apply(s);
    expect(gate.arbiter.synthetic.wasPressed("interact")).toBe(false);
    expect(gate.avatar.ignored[0]?.action).toBe("ENTER_VEHICLE");
  });

  test("EXIT_VEHICLE applies only at the wheel", () => {
    const { arbiter, avatar } = rig(GameplayState.Driving);
    const s = createActionState();
    s.exitVehicle = true;
    avatar.apply(s);
    expect(arbiter.synthetic.wasPressed("interact")).toBe(true);
  });

  test("LOOK reaches the camera as mouse-delta units, exactly like a mouse would", () => {
    const { arbiter, avatar } = rig();
    const s = createActionState();
    s.lookYaw = 0.05;
    s.lookPitch = 0.02;
    avatar.apply(s);
    expect(arbiter.synthetic.lookX).toBeCloseTo(0.05 / CAMERA.lookSensitivity, 6);
    expect(arbiter.synthetic.lookY).toBeCloseTo(-0.02 / CAMERA.lookSensitivity, 6);
  });

  test("with the arbiter routed, gameplay reads the bus channel even for the person", () => {
    const human = new InputState();
    const arbiter = new ControlArbiter(human);
    expect(arbiter.input).toBe(human);
    arbiter.routed = true;
    expect(arbiter.input).toBe(arbiter.synthetic);
    expect(arbiter.source).toBe("human");
    // The person's raw devices are still recorded, for takeover detection.
    human.keyDown("KeyW");
    expect(arbiter.humanActivity()).toBe(true);
  });
});
