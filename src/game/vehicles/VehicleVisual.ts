import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { MeshBatcher } from "../core/MeshBatcher";
import { easeInOutCubic } from "../core/math";
import type { VehicleMaterialLibrary } from "./VehicleMaterials";
import type { VehiclePhysics } from "./VehiclePhysics";
import type { VehicleSpec, VehicleVariant } from "./VehicleSpec";

/**
 * Procedural right-hand-drive military 4×4 utility vehicle: extruded side
 * skins with true wheel arches, hinged doors with glazing, a visible cab
 * interior (seats, dash, steering wheel), bull bar, snorkel, roof rack, radio
 * whip, spare wheel and either a canvas canopy or a hardtop rear body.
 *
 * Static parts are merged per material by MeshBatcher; only doors, wheels and
 * the steering wheel remain separate because they move. The class exposes the
 * same surface a GLTF-backed visual would need (root, update, setLights,
 * dispose), so a production model can replace it without touching physics.
 */

type Vec3 = readonly [number, number, number];

interface WheelRig {
  mount: THREE.Group;
  steer: THREE.Group;
  spin: THREE.Group;
}

const SKIN_THICKNESS = 0.05;
const SKIN_OUTER_X = 0.98;
const SILL_Y = 0.55;
const BELT_Y = 1.12;
const ARCH_RADIUS = 0.54;
const REAR_DOOR_EDGE_Z = -0.06;

function archAngle(tyreRadius: number): number {
  // Angle at which the arch circle meets the sill line.
  return Math.asin((SILL_Y - tyreRadius) / ARCH_RADIUS);
}

/** Tyre (rubber, tread blocks, rim holes) and rim geometries; axle along X, face +X. */
function buildWheelGeometries(spec: VehicleSpec, lib: VehicleMaterialLibrary) {
  const r = spec.tyreRadius;
  const hw = spec.tyreWidth / 2;
  const tyre = lib.sharedGeometry("wheel-tyre", () => {
    const profile = [
      [r * 0.64, -hw * 0.92],
      [r * 0.9, -hw],
      [r * 0.975, -hw * 0.9],
      [r, -hw * 0.66],
      [r, hw * 0.66],
      [r * 0.975, hw * 0.9],
      [r * 0.9, hw],
      [r * 0.64, hw * 0.92],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const lathe = new THREE.LatheGeometry(profile, 30);
    lathe.rotateZ(-Math.PI / 2);
    const batch = new MeshBatcher();
    const scratch: THREE.BufferGeometry[] = [lathe];
    const placeholder = new THREE.MeshBasicMaterial();
    batch.addMatrix(lathe, placeholder, new THREE.Matrix4());
    const block = new THREE.BoxGeometry(hw * 0.78, 0.034, 0.075);
    scratch.push(block);
    const blocks = 20;
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < blocks; k++) {
        const theta = ((k + row * 0.5) / blocks) * Math.PI * 2;
        batch.add(
          block,
          placeholder,
          // Blocks stand 17 mm proud of the carcass so their tops sit exactly
          // on the rolling radius (no sinking into the ground).
          [
            (row === 0 ? -1 : 1) * hw * 0.42,
            Math.cos(theta) * (r - 0.017),
            Math.sin(theta) * (r - 0.017),
          ],
          [theta, 0, row === 0 ? 0.18 : -0.18],
        );
      }
    }
    const hole = new THREE.CylinderGeometry(0.034, 0.034, 0.035, 10);
    hole.rotateZ(Math.PI / 2);
    scratch.push(hole);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      batch.add(hole, placeholder, [hw * 0.62, Math.cos(a) * 0.15, Math.sin(a) * 0.15]);
    }
    const holder = new THREE.Group();
    const [merged] = batch.build(holder);
    for (const g of scratch) g.dispose();
    placeholder.dispose();
    return merged;
  });
  const rim = lib.sharedGeometry("wheel-rim", () => {
    const batch = new MeshBatcher();
    const placeholder = new THREE.MeshBasicMaterial();
    const scratch: THREE.BufferGeometry[] = [];
    const part = (g: THREE.BufferGeometry, pos: Vec3) => {
      g.rotateZ(Math.PI / 2);
      scratch.push(g);
      batch.add(g, placeholder, pos);
    };
    part(
      new THREE.CylinderGeometry(r * 0.6, r * 0.6, spec.tyreWidth * 0.72, 22, 1, true),
      [0, 0, 0],
    );
    part(new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.03, 22), [hw * 0.5, 0, 0]);
    part(new THREE.CylinderGeometry(0.075, 0.088, 0.07, 14), [hw * 0.72, 0, 0]);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      part(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 6), [
        hw * 0.95,
        Math.cos(a) * 0.052,
        Math.sin(a) * 0.052,
      ]);
    }
    const holder = new THREE.Group();
    const [merged] = batch.build(holder);
    for (const g of scratch) g.dispose();
    placeholder.dispose();
    return merged;
  });
  return { tyre, rim };
}

export class VehicleVisual {
  readonly root = new THREE.Group();
  /** Point the headlight spot hangs from (body frame). */
  readonly headlightAnchor = new THREE.Object3D();
  readonly headlightTarget = new THREE.Object3D();
  private readonly wheels: WheelRig[] = [];
  private readonly doors: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly steeringWheel = new THREE.Group();
  private readonly paint: THREE.MeshStandardMaterial;
  private readonly canvas: THREE.MeshStandardMaterial;
  private readonly headlamp: THREE.MeshStandardMaterial;
  private readonly taillamp: THREE.MeshStandardMaterial;
  private readonly owned: THREE.BufferGeometry[] = [];
  private readonly scratch: THREE.BufferGeometry[] = [];

  constructor(
    private readonly spec: VehicleSpec,
    readonly variant: VehicleVariant,
    private readonly lib: VehicleMaterialLibrary,
  ) {
    this.paint = lib.paint(variant);
    this.canvas = lib.canvas(variant);
    this.headlamp = lib.headlamp();
    this.taillamp = lib.taillamp();
    this.root.name = `vehicle-${variant.callsign}`;
    this.root.rotation.order = "YXZ";
    this.buildBody();
    this.buildDoors();
    this.buildSteeringWheel();
    this.buildWheels();
    this.headlightAnchor.position.set(0, 0.92, spec.headlightZ + 0.05);
    this.headlightTarget.position.set(0, 0.2, spec.headlightZ + 18);
    this.root.add(this.headlightAnchor, this.headlightTarget);
    for (const g of this.scratch) g.dispose();
    this.scratch.length = 0;
  }

  /** Temporary primitive; disposed once the batch is merged. */
  private tmp<T extends THREE.BufferGeometry>(g: T): T {
    this.scratch.push(g);
    return g;
  }

  private box(w: number, h: number, d: number, radius = 0): THREE.BufferGeometry {
    return this.tmp(
      radius > 0 ? new RoundedBoxGeometry(w, h, d, 2, radius) : new THREE.BoxGeometry(w, h, d),
    );
  }

  private cylinder(rt: number, rb: number, h: number, seg = 12): THREE.BufferGeometry {
    return this.tmp(new THREE.CylinderGeometry(rt, rb, h, seg));
  }

  /** Extrude a (z, y) profile outward along X from `x0` by `depth`. */
  private sideExtrusion(shape: THREE.Shape, x0: number, depth: number): THREE.BufferGeometry {
    const g = this.tmp(
      new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 12 }),
    );
    // Shape (u, v, w) → body (x = -w, y = v, z = u), then shift to [x0, x0 + depth].
    g.rotateY(-Math.PI / 2);
    g.translate(x0 + depth, 0, 0);
    return g;
  }

  private buildBody(): void {
    const s = this.spec;
    const lib = this.lib;
    const b = new MeshBatcher();
    const paint = this.paint;
    const phi = archAngle(s.tyreRadius);
    const archReach = ARCH_RADIUS * Math.cos(phi);

    // Side skins with wheel arches; the door opening is left clear.
    for (const x0 of [SKIN_OUTER_X - SKIN_THICKNESS, -SKIN_OUTER_X]) {
      const rear = new THREE.Shape();
      rear.moveTo(-2.3, SILL_Y);
      rear.lineTo(s.rearAxle - archReach, SILL_Y);
      rear.absarc(s.rearAxle, s.tyreRadius, ARCH_RADIUS, Math.PI - phi, phi, true);
      rear.lineTo(REAR_DOOR_EDGE_Z, SILL_Y);
      rear.lineTo(REAR_DOOR_EDGE_Z, BELT_Y);
      rear.lineTo(-2.3, BELT_Y);
      rear.closePath();
      b.addMatrix(this.sideExtrusion(rear, x0, SKIN_THICKNESS), paint, new THREE.Matrix4());
      const front = new THREE.Shape();
      front.moveTo(s.doors.hingeZ, SILL_Y);
      front.lineTo(s.frontAxle - archReach, SILL_Y);
      front.absarc(s.frontAxle, s.tyreRadius, ARCH_RADIUS, Math.PI - phi, phi, true);
      front.lineTo(2.3, SILL_Y);
      front.lineTo(2.3, 1.1);
      front.lineTo(s.doors.hingeZ, 1.14);
      front.closePath();
      b.addMatrix(this.sideExtrusion(front, x0, SKIN_THICKNESS), paint, new THREE.Matrix4());
    }

    // Wheel wells, flares, rails and axles.
    const well = this.tmp(new THREE.CylinderGeometry(0.56, 0.56, 0.3, 16, 1, true, 0, Math.PI));
    well.rotateZ(Math.PI / 2);
    const flare = this.tmp(new THREE.TorusGeometry(0.56, 0.045, 6, 20, Math.PI));
    for (const z of [s.frontAxle, s.rearAxle]) {
      for (const side of [1, -1]) {
        b.add(well, lib.liner, [side * 0.785, s.tyreRadius, z]);
        b.add(
          flare,
          lib.trim,
          [side * (SKIN_OUTER_X + 0.005), s.tyreRadius, z],
          [0, Math.PI / 2, 0],
          [1, 1, 2.3],
        );
      }
      const axle = this.cylinder(0.06, 0.06, s.track - 0.2);
      b.add(axle, lib.metal, [0, s.tyreRadius, z], [0, 0, Math.PI / 2]);
      b.add(this.tmp(new THREE.SphereGeometry(0.14, 12, 8)), lib.trim, [0.1, s.tyreRadius, z]);
    }
    for (const side of [1, -1]) b.add(this.box(0.1, 0.14, 4.2), lib.trim, [side * 0.45, 0.43, 0]);
    b.add(this.box(0.9, 0.1, 0.7), lib.trim, [0, 0.42, 1.95]);
    b.add(this.cylinder(0.035, 0.035, 0.5), lib.metal, [-0.55, 0.42, -2.2], [Math.PI / 2, 0, 0]);

    // Engine bay block and bonnet.
    b.add(this.box(1.24, 0.52, 1.36), lib.interior, [0, 0.84, 1.61]);
    b.add(this.box(1.9, 0.07, 1.38, 0.025), paint, [0, 1.14, 1.61], [0.018, 0, 0]);
    b.add(this.box(0.5, 0.03, 0.4), lib.trim, [0, 1.18, 1.35]);

    // Front fascia, grille, lamps, bumper and bull bar.
    b.add(this.box(1.92, 0.56, 0.05), paint, [0, 0.83, 2.285]);
    b.add(this.box(0.86, 0.36, 0.04), lib.trim, [0, 0.88, 2.31]);
    for (let k = -3; k <= 3; k++)
      b.add(this.box(0.035, 0.32, 0.03), lib.metal, [k * 0.11, 0.88, 2.33]);
    const lens = this.cylinder(0.085, 0.085, 0.05, 18);
    const bezel = this.cylinder(0.108, 0.108, 0.045, 18);
    for (const side of [1, -1]) {
      b.add(bezel, lib.trim, [side * 0.66, 0.92, 2.31], [Math.PI / 2, 0, 0]);
      b.add(lens, this.headlamp, [side * 0.66, 0.92, 2.33], [Math.PI / 2, 0, 0]);
      b.add(this.box(0.11, 0.05, 0.03), lib.amber, [side * 0.66, 0.78, 2.315]);
    }
    b.add(this.box(1.98, 0.17, 0.16), lib.trim, [0, 0.6, 2.36]);
    const tube = this.cylinder(0.034, 0.034, 1, 10);
    for (const side of [1, -1]) {
      b.add(tube, lib.trim, [side * 0.42, 0.9, 2.47], [0, 0, 0], [1, 0.62, 1]);
      b.add(tube, lib.trim, [side * 0.78, 0.84, 2.44], [0.3, 0, 0], [1, 0.36, 1]);
      b.add(this.box(0.07, 0.06, 0.12), lib.metal, [side * 0.55, 0.5, 2.43]);
    }
    b.add(tube, lib.trim, [0, 1.2, 2.47], [0, 0, Math.PI / 2], [1, 0.9, 1]);
    b.add(tube, lib.trim, [0, 0.98, 2.47], [0, 0, Math.PI / 2], [1, 1.6, 1]);

    // Cab: floor, dash, seats, pillars, roof, windscreen.
    b.add(this.box(1.84, 0.06, 1.58), lib.interior, [0, 0.54, 0.14]);
    b.add(this.box(1.8, 0.3, 0.26), lib.interior, [0, 1.14, 0.8]);
    b.add(this.box(1.8, 0.52, 0.06), lib.interior, [0, 0.83, 0.92]);
    b.add(this.box(0.36, 0.12, 0.14), lib.trim, [s.seats.driver[0], 1.31, 0.72]);
    b.add(this.box(0.22, 0.3, 0.6), lib.interior, [0, 0.72, 0.2]);
    const [, seatY, seatZ] = s.seats.driver;
    for (const x of [s.seats.driver[0], s.seats.passenger[0]]) {
      b.add(this.box(0.4, 0.3, 0.4), lib.trim, [x, 0.7, seatZ]);
      b.add(this.box(0.5, 0.13, 0.5, 0.04), lib.interior, [x, seatY - 0.14, seatZ + 0.02]);
      b.add(
        this.box(0.5, 0.64, 0.11, 0.04),
        lib.interior,
        [x, seatY + 0.2, seatZ - 0.3],
        [-0.16, 0, 0],
      );
    }
    b.add(this.box(1.9, 1.4, 0.05), paint, [0, 1.27, -0.64]);
    b.add(this.box(1.2, 0.32, 0.012), lib.glass, [0, 1.63, -0.67]);
    for (const side of [1, -1]) {
      b.add(this.box(0.05, 0.84, 0.07), paint, [side * 0.955, 1.54, REAR_DOOR_EDGE_Z - 0.04]);
      // Cab quarter panel and quarter glass behind the door.
      b.add(this.box(0.05, 0.84, 0.54), paint, [side * 0.955, 1.54, -0.37]);
      b.add(this.box(0.012, 0.38, 0.32), lib.glass, [side * 0.984, 1.62, -0.37]);
      b.add(this.box(0.06, 0.83, 0.07), paint, [side * 0.95, 1.53, 0.84], [-0.263, 0, 0]);
      b.add(this.box(0.08, 0.08, 1.24), lib.trim, [side * 0.975, 0.5, 0.42]);
    }
    b.add(this.box(1.96, 0.08, 1.46, 0.03), paint, [0, 1.99, 0.045]);
    b.add(this.box(1.8, 0.83, 0.012), lib.glass, [0, 1.53, 0.84], [-0.263, 0, 0]);
    b.add(this.box(1.9, 0.05, 0.06), lib.trim, [0, 1.93, 0.735]);
    b.add(this.box(1.86, 0.05, 0.12), lib.trim, [0, 1.15, 0.99]);
    for (const side of [1, -1])
      b.add(this.box(0.5, 0.012, 0.02), lib.trim, [side * 0.35, 1.19, 0.96], [0, 0, side * 0.1]);
    const column = this.cylinder(0.03, 0.035, 0.42, 8);
    b.add(column, lib.trim, [s.seats.driver[0], 1.18, 0.6], [0.45 + Math.PI / 2, 0, 0]);

    // Mirrors, snorkel (passenger side), roof rack and radio whip.
    for (const side of [1, -1]) {
      b.add(this.box(0.14, 0.03, 0.03), lib.trim, [side * 1.03, 1.28, 0.86]);
      b.add(this.box(0.04, 0.17, 0.11), lib.trim, [side * 1.1, 1.3, 0.86]);
    }
    b.add(this.cylinder(0.055, 0.055, 0.86), lib.trim, [1.02, 1.5, 0.99]);
    b.add(this.cylinder(0.05, 0.05, 0.14), lib.trim, [0.96, 1.07, 0.99], [0, 0, Math.PI / 2]);
    b.add(this.box(0.14, 0.14, 0.2, 0.03), lib.trim, [1.02, 1.96, 1.02]);
    for (const side of [1, -1])
      b.add(this.box(0.04, 0.04, 1.3), lib.trim, [side * 0.8, 2.08, 0.05]);
    for (const z of [-0.5, 0.05, 0.6]) b.add(this.box(1.64, 0.035, 0.04), lib.trim, [0, 2.08, z]);
    b.add(this.box(0.08, 0.05, 0.08), lib.trim, [0.86, 2.06, -0.55]);
    b.add(this.cylinder(0.006, 0.011, 2.3, 5), lib.trim, [0.86, 3.2, -0.55]);

    // Rear body: tray block, tailgate, lamps, bumper, spare wheel, jerry cans.
    b.add(this.box(1.24, 0.52, 1.62), lib.interior, [0, 0.84, -1.47]);
    b.add(this.box(1.9, 0.58, 0.05), paint, [0, 0.835, -2.285]);
    for (const side of [1, -1])
      b.add(this.box(0.13, 0.2, 0.03), this.taillamp, [side * 0.8, 0.88, -2.315]);
    b.add(this.box(1.96, 0.16, 0.14), lib.trim, [0, 0.6, -2.35]);
    b.add(this.box(0.1, 0.08, 0.2), lib.metal, [0, 0.55, -2.46]);
    for (const side of [1, -1])
      b.add(this.box(0.12, 0.34, 0.24, 0.02), this.canvas, [side * 0.72, 1.0, -2.44]);
    for (const side of [1, -1])
      b.add(this.box(0.26, 0.3, 0.02), lib.rubber, [side * 0.81, 0.34, s.rearAxle - 0.52]);

    if (this.variant.rear === "canopy") {
      b.add(this.box(1.9, 0.06, 1.62), paint, [0, 1.13, -1.47]);
      b.add(this.box(1.88, 0.9, 1.6, 0.12), this.canvas, [0, 1.6, -1.47]);
      for (const z of [-0.8, -1.47, -2.14])
        b.add(this.box(1.92, 0.92, 0.035, 0.1), lib.trim, [0, 1.6, z]);
    } else {
      b.add(this.box(1.92, 0.88, 1.62, 0.06), paint, [0, 1.56, -1.47]);
      for (const side of [1, -1])
        b.add(this.box(0.012, 0.36, 0.95), lib.glass, [side * 0.965, 1.66, -1.3]);
      b.add(this.box(1.3, 0.36, 0.012), lib.glass, [0, 1.66, -2.29]);
      for (const side of [1, -1])
        b.add(this.box(0.04, 0.04, 1.4), lib.trim, [side * 0.8, 2.04, -1.45]);
    }

    this.owned.push(...b.build(this.root));

    // Spare wheel on the tailgate, reusing the shared wheel meshes.
    const { tyre, rim } = buildWheelGeometries(s, lib);
    const spare = new THREE.Group();
    spare.position.set(0, 1.08, -2.47);
    spare.rotation.y = Math.PI / 2; // rim face (+X) turned to face rearward (-Z)
    spare.add(new THREE.Mesh(tyre, lib.rubber), new THREE.Mesh(rim, lib.rim));
    for (const m of spare.children as THREE.Mesh[]) m.castShadow = true;
    this.root.add(spare);
  }

  private buildDoors(): void {
    const s = this.spec;
    const lib = this.lib;
    const L = s.doors.length;
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? 1 : -1;
      const door = this.doors[side];
      door.position.set(sign * (SKIN_OUTER_X - SKIN_THICKNESS / 2), 0, s.doors.hingeZ);
      this.root.add(door);
      const b = new MeshBatcher();
      // Profiles are authored relative to the hinge (z' = z - hingeZ ≤ 0).
      const panel = new THREE.Shape();
      panel.moveTo(-L + 0.01, SILL_Y + 0.02);
      panel.lineTo(-0.01, SILL_Y + 0.02);
      panel.lineTo(-0.01, BELT_Y);
      panel.lineTo(-L + 0.01, BELT_Y);
      panel.closePath();
      const frame = new THREE.Shape();
      frame.moveTo(-L + 0.01, BELT_Y);
      frame.lineTo(-0.01, BELT_Y);
      frame.lineTo(-0.2, 1.86);
      frame.lineTo(-L + 0.01, 1.86);
      frame.closePath();
      const window = new THREE.Path();
      window.moveTo(-L + 0.07, BELT_Y + 0.05);
      window.lineTo(-0.08, BELT_Y + 0.05);
      window.lineTo(-0.23, 1.8);
      window.lineTo(-L + 0.07, 1.8);
      window.closePath();
      frame.holes.push(window);
      const glass = new THREE.Shape(window.getPoints());
      const half = SKIN_THICKNESS / 2;
      b.addMatrix(
        this.sideExtrusion(panel, -half, SKIN_THICKNESS),
        this.paint,
        new THREE.Matrix4(),
      );
      b.addMatrix(
        this.sideExtrusion(frame, -half, SKIN_THICKNESS * 0.8),
        this.paint,
        new THREE.Matrix4(),
      );
      b.addMatrix(this.sideExtrusion(glass, -0.006, 0.012), lib.glass, new THREE.Matrix4());
      b.add(this.box(0.03, 0.035, 0.16), lib.trim, [sign * (half + 0.012), 1.0, -L + 0.2]);
      b.add(this.box(0.02, 0.5, 0.02), lib.trim, [0, 1.46, -0.03]);
      this.owned.push(...b.build(door));
    }
  }

  private buildSteeringWheel(): void {
    const lib = this.lib;
    const [x] = this.spec.seats.driver;
    // The column rakes the wheel back; steering spins it about its own axis.
    const tilt = new THREE.Group();
    tilt.rotation.x = 0.45;
    tilt.position.set(x, 1.3, 0.42);
    tilt.add(this.steeringWheel);
    this.root.add(tilt);
    const b = new MeshBatcher();
    b.add(this.tmp(new THREE.TorusGeometry(0.19, 0.022, 8, 24)), lib.trim, [0, 0, 0]);
    b.add(this.cylinder(0.05, 0.05, 0.05, 12), lib.trim, [0, 0, 0], [Math.PI / 2, 0, 0]);
    for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
      b.add(
        this.box(0.17, 0.025, 0.018),
        lib.trim,
        [Math.cos(a) * 0.1, Math.sin(a) * 0.1, 0],
        [0, 0, a],
      );
    }
    this.owned.push(...b.build(this.steeringWheel, { castShadow: false }));
  }

  private buildWheels(): void {
    const s = this.spec;
    const { tyre, rim } = buildWheelGeometries(s, this.lib);
    const positions: [number, number][] = [
      [s.track / 2, s.frontAxle],
      [-s.track / 2, s.frontAxle],
      [s.track / 2, s.rearAxle],
      [-s.track / 2, s.rearAxle],
    ];
    positions.forEach(([x, z], i) => {
      const mount = new THREE.Group();
      mount.position.set(x, s.tyreRadius, z);
      const steer = new THREE.Group();
      const spin = new THREE.Group();
      const face = new THREE.Group();
      // Right-side wheels are turned round so the rim faces outward.
      if (x < 0) face.rotation.y = Math.PI;
      const t = new THREE.Mesh(tyre, this.lib.rubber);
      const r = new THREE.Mesh(rim, this.lib.rim);
      t.castShadow = r.castShadow = true;
      t.receiveShadow = r.receiveShadow = true;
      face.add(t, r);
      spin.add(face);
      steer.add(spin);
      mount.add(steer);
      this.root.add(mount);
      this.wheels[i] = { mount, steer, spin };
    });
  }

  /**
   * Sync the visual to the physics' interpolated pose. `doorOpen` holds the
   * opening fraction of the left and right doors.
   */
  update(physics: VehiclePhysics, doorOpen: readonly [number, number]): void {
    const r = physics.render;
    this.root.position.set(r.x, r.y, r.z);
    this.root.rotation.set(-r.pitch, r.yaw, r.roll);
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.mount.position.y = this.spec.tyreRadius + physics.wheelOffset[i];
      if (i < 2) w.steer.rotation.y = physics.steerAngle;
      w.spin.rotation.x = physics.wheelSpin[i];
    }
    const open = this.spec.doors.openAngle;
    this.doors[0].rotation.y = -open * easeInOutCubic(doorOpen[0]);
    this.doors[1].rotation.y = open * easeInOutCubic(doorOpen[1]);
    this.steeringWheel.rotation.z = -physics.steerAngle * this.spec.steering.wheelRatio;
  }

  setLights(headlights: boolean, braking: boolean): void {
    this.headlamp.emissiveIntensity = headlights ? 2.4 : 0;
    this.taillamp.emissiveIntensity = braking ? 2.8 : headlights ? 0.9 : 0.1;
  }

  dispose(): void {
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    this.root.removeFromParent();
  }
}
