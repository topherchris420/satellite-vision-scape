import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { MeshBatcher } from "../core/MeshBatcher";
import { easeInOutCubic } from "../core/math";
import type { VehicleMaterialLibrary } from "./VehicleMaterials";
import type { VehiclePhysics } from "./VehiclePhysics";
import type { VehicleSpec, VehicleVariant } from "./VehicleSpec";

/**
 * Procedural right-hand-drive military 4×4 utility vehicle in the spirit of a
 * 70-series wagon / long-wheelbase utility: bevelled side skins with true
 * wheel arches and moulded flares, a crowned bonnet with scoop, rounded roof
 * with drip rails, hinged doors with glazing, a visible cab interior (bolstered
 * seats, dash with lit gauges, steering wheel, console), a tubular bull bar
 * with driving lamps, an A-pillar snorkel, roof rack with load, mirrors,
 * chrome-bowl headlamp clusters, vertical tail clusters (tail / brake /
 * indicator / reverse) plus a high stop lamp, number plates, spare wheel and
 * either a canvas canopy or a hardtop rear body.
 *
 * Static parts are merged per material by MeshBatcher; only doors, wheels and
 * the steering wheel remain separate because they move. Lamp halos are
 * additive sprites that stay hidden (no draw call) until the lamp is lit. The
 * class exposes the same surface a GLTF-backed visual would need (root,
 * update, setLights, dispose), so a production model can replace it without
 * touching physics.
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
const BEVEL = 0.014;
const IDENTITY = new THREE.Matrix4();

function archAngle(tyreRadius: number): number {
  // Angle at which the arch circle meets the sill line.
  return Math.asin((SILL_Y - tyreRadius) / ARCH_RADIUS);
}

/** Tyre (carcass, tread blocks, sidewall ribs) and rim geometries; axle along X, face +X. */
function buildWheelGeometries(spec: VehicleSpec, lib: VehicleMaterialLibrary) {
  const r = spec.tyreRadius;
  const hw = spec.tyreWidth / 2;
  const tyre = lib.sharedGeometry("wheel-tyre", () => {
    // Rounded all-terrain carcass: bead → bulging sidewall → square shoulder → tread.
    const profile = [
      [r * 0.63, -hw * 0.86],
      [r * 0.7, -hw * 0.98],
      [r * 0.82, -hw * 1.02],
      [r * 0.92, -hw * 0.99],
      [r * 0.965, -hw * 0.9],
      [r * 0.975, -hw * 0.72],
      [r * 0.975, hw * 0.72],
      [r * 0.965, hw * 0.9],
      [r * 0.92, hw * 0.99],
      [r * 0.82, hw * 1.02],
      [r * 0.7, hw * 0.98],
      [r * 0.63, hw * 0.86],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const lathe = new THREE.LatheGeometry(profile, 40);
    lathe.rotateZ(-Math.PI / 2);
    const batch = new MeshBatcher();
    const scratch: THREE.BufferGeometry[] = [lathe];
    const placeholder = new THREE.MeshBasicMaterial();
    batch.addMatrix(lathe, placeholder, new THREE.Matrix4());
    // Staggered tread blocks: two centre rows and two shoulder rows that wrap
    // onto the sidewall, as on an all-terrain tyre. Block tops sit exactly on
    // the rolling radius (no sinking into the ground).
    const centre = new RoundedBoxGeometry(hw * 0.5, 0.03, 0.085, 1, 0.008);
    const shoulder = new RoundedBoxGeometry(hw * 0.42, 0.034, 0.07, 1, 0.008);
    scratch.push(centre, shoulder);
    const blocks = 22;
    for (let k = 0; k < blocks; k++) {
      const t0 = (k / blocks) * Math.PI * 2;
      const t1 = ((k + 0.5) / blocks) * Math.PI * 2;
      for (const [x, theta, g, rr] of [
        [-hw * 0.3, t0, centre, r - 0.015],
        [hw * 0.3, t1, centre, r - 0.015],
        [-hw * 0.82, t1, shoulder, r - 0.03],
        [hw * 0.82, t0, shoulder, r - 0.03],
      ] as const) {
        batch.add(g, placeholder, [x, Math.cos(theta) * rr, Math.sin(theta) * rr], [theta, 0, 0]);
      }
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
    // Dished steel wheel: barrel, raised outer lip, recessed centre disc with
    // a ring of cooling holes, hub cap and wheel nuts.
    const disc = [
      [r * 0.64, -hw * 0.78],
      [r * 0.63, hw * 0.66],
      [r * 0.66, hw * 0.74],
      [r * 0.64, hw * 0.8],
      [r * 0.6, hw * 0.7],
      [r * 0.48, hw * 0.52],
      [r * 0.44, hw * 0.4],
      [r * 0.3, hw * 0.36],
      [r * 0.22, hw * 0.5],
      [0.0, hw * 0.52],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const lathe = new THREE.LatheGeometry(disc, 36);
    lathe.rotateZ(-Math.PI / 2);
    scratch.push(lathe);
    batch.addMatrix(lathe, placeholder, new THREE.Matrix4());
    const part = (g: THREE.BufferGeometry, pos: Vec3) => {
      g.rotateZ(Math.PI / 2);
      scratch.push(g);
      batch.add(g, placeholder, pos);
    };
    part(new THREE.CylinderGeometry(0.07, 0.085, 0.07, 16), [hw * 0.58, 0, 0]);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      part(new THREE.CylinderGeometry(0.014, 0.016, 0.035, 6), [
        hw * 0.58,
        Math.cos(a) * 0.105,
        Math.sin(a) * 0.105,
      ]);
    }
    const holder = new THREE.Group();
    const [merged] = batch.build(holder);
    for (const g of scratch) g.dispose();
    placeholder.dispose();
    return merged;
  });
  // Dark recesses read as holes punched through the disc.
  const holes = lib.sharedGeometry("wheel-holes", () => {
    const batch = new MeshBatcher();
    const placeholder = new THREE.MeshBasicMaterial();
    const hole = new THREE.CylinderGeometry(0.03, 0.03, 0.012, 12);
    hole.rotateZ(Math.PI / 2);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      batch.add(hole, placeholder, [hw * 0.47, Math.cos(a) * r * 0.37, Math.sin(a) * r * 0.37]);
    }
    const holder = new THREE.Group();
    const [merged] = batch.build(holder);
    hole.dispose();
    placeholder.dispose();
    return merged;
  });
  return { tyre, rim, holes };
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
  private readonly brakelamp: THREE.MeshStandardMaterial;
  private readonly plate: THREE.MeshStandardMaterial;
  private readonly headGlow: THREE.SpriteMaterial;
  private readonly tailGlow: THREE.SpriteMaterial;
  private readonly brakeGlow: THREE.SpriteMaterial;
  private readonly headSprites: THREE.Sprite[] = [];
  private readonly tailSprites: THREE.Sprite[] = [];
  private readonly brakeSprites: THREE.Sprite[] = [];
  private lightState = -1;
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
    this.brakelamp = lib.taillamp();
    const digits = variant.callsign.replace(/\D/g, "").padStart(2, "0");
    this.plate = lib.plate(`ARMY ${digits}·${((variant.paint.charCodeAt(2) * 37) % 900) + 100}`);
    this.headGlow = lib.glow("#fff1d2");
    this.tailGlow = lib.glow("#ff2a14");
    this.brakeGlow = lib.glow("#ff2a14");
    this.root.name = `vehicle-${variant.callsign}`;
    this.root.rotation.order = "YXZ";
    this.buildBody();
    this.buildLamps();
    this.buildDoors();
    this.buildSteeringWheel();
    this.buildWheels();
    this.headlightAnchor.position.set(0, 0.92, spec.headlightZ + 0.05);
    this.headlightTarget.position.set(0, 0.2, spec.headlightZ + 18);
    this.root.add(this.headlightAnchor, this.headlightTarget);
    for (const g of this.scratch) g.dispose();
    this.scratch.length = 0;
    this.setLights(false, false);
  }

  /** Temporary primitive; disposed once the batch is merged. */
  private tmp<T extends THREE.BufferGeometry>(g: T): T {
    this.scratch.push(g);
    return g;
  }

  private box(w: number, h: number, d: number, radius = 0, seg = 2): THREE.BufferGeometry {
    return this.tmp(
      radius > 0 ? new RoundedBoxGeometry(w, h, d, seg, radius) : new THREE.BoxGeometry(w, h, d),
    );
  }

  private cylinder(rt: number, rb: number, h: number, seg = 12): THREE.BufferGeometry {
    return this.tmp(new THREE.CylinderGeometry(rt, rb, h, seg));
  }

  /** Bent tube through body-frame points (bull bar hoops, snorkel, grab rails). */
  private tube(points: Vec3[], radius: number, radial = 8): THREE.BufferGeometry {
    const curve = new THREE.CatmullRomCurve3(
      points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      false,
      "centripetal",
    );
    return this.tmp(new THREE.TubeGeometry(curve, points.length * 8, radius, radial, false));
  }

  /** Extrude a (z, y) profile outward along X from `x0` by `depth`, with rounded edges. */
  private sideExtrusion(
    shape: THREE.Shape,
    x0: number,
    depth: number,
    bevel = BEVEL,
  ): THREE.BufferGeometry {
    const core = Math.max(0.004, depth - bevel * 2);
    const g = this.tmp(
      new THREE.ExtrudeGeometry(shape, {
        depth: core,
        bevelEnabled: bevel > 0,
        bevelThickness: bevel,
        bevelSize: bevel * 0.8,
        bevelSegments: 2,
        curveSegments: 14,
      }),
    );
    // Shape (u, v, w) → body (x = -w, y = v, z = u), then shift to [x0, x0 + depth].
    g.rotateY(-Math.PI / 2);
    g.translate(x0 + core + bevel, 0, 0);
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
      rear.moveTo(-2.26, SILL_Y);
      rear.lineTo(s.rearAxle - archReach, SILL_Y);
      rear.absarc(s.rearAxle, s.tyreRadius, ARCH_RADIUS, Math.PI - phi, phi, true);
      rear.lineTo(REAR_DOOR_EDGE_Z, SILL_Y);
      rear.lineTo(REAR_DOOR_EDGE_Z, BELT_Y);
      rear.lineTo(-2.26, BELT_Y);
      rear.closePath();
      b.addMatrix(this.sideExtrusion(rear, x0, SKIN_THICKNESS), paint, new THREE.Matrix4());
      const front = new THREE.Shape();
      front.moveTo(s.doors.hingeZ, SILL_Y);
      front.lineTo(s.frontAxle - archReach, SILL_Y);
      front.absarc(s.frontAxle, s.tyreRadius, ARCH_RADIUS, Math.PI - phi, phi, true);
      front.lineTo(2.24, SILL_Y);
      front.quadraticCurveTo(2.29, SILL_Y, 2.29, SILL_Y + 0.06);
      front.lineTo(2.29, 1.05);
      front.quadraticCurveTo(2.28, 1.1, 2.22, 1.1);
      front.lineTo(s.doors.hingeZ, 1.14);
      front.closePath();
      b.addMatrix(this.sideExtrusion(front, x0, SKIN_THICKNESS), paint, new THREE.Matrix4());
    }

    // Front wing tops: a rounded shoulder that rolls the side skin into the
    // bonnet line, and the rear body's capping rail.
    for (const side of [1, -1]) {
      b.add(this.box(0.2, 0.07, 1.38, 0.03, 3), paint, [side * 0.89, 1.115, 1.6], [0.018, 0, 0]);
      b.add(this.box(0.1, 0.06, 2.2, 0.025, 3), paint, [side * 0.935, BELT_Y, -1.16]);
      // Black rubbing strip along the flank.
      b.add(this.box(0.03, 0.05, 0.8, 0.012), lib.trim, [
        side * (SKIN_OUTER_X + 0.012),
        0.86,
        -0.5,
      ]);
    }

    // Wheel wells, moulded flares, chassis rails, diffs and axles.
    const well = this.tmp(new THREE.CylinderGeometry(0.56, 0.56, 0.3, 18, 1, true, 0, Math.PI));
    well.rotateZ(Math.PI / 2);
    const flare = this.tmp(new THREE.TorusGeometry(0.585, 0.05, 6, 24, Math.PI));
    for (const z of [s.frontAxle, s.rearAxle]) {
      for (const side of [1, -1]) {
        b.add(well, lib.liner, [side * 0.785, s.tyreRadius, z]);
        b.add(
          flare,
          lib.trim,
          [side * (SKIN_OUTER_X + 0.01), s.tyreRadius, z],
          [0, Math.PI / 2, 0],
          [1, 1, 1.9],
        );
        // Flare foot plates down to the sill.
        for (const dz of [-0.585, 0.585])
          b.add(this.box(0.08, 0.12, 0.1, 0.02), lib.trim, [
            side * 0.99,
            s.tyreRadius + 0.02,
            z + dz,
          ]);
      }
      const axle = this.cylinder(0.06, 0.06, s.track - 0.2);
      b.add(axle, lib.metal, [0, s.tyreRadius, z], [0, 0, Math.PI / 2]);
      b.add(this.tmp(new THREE.SphereGeometry(0.15, 14, 10)), lib.trim, [0.1, s.tyreRadius, z]);
      // Leaf springs / dampers.
      for (const side of [1, -1]) {
        b.add(this.box(0.07, 0.05, 1.0, 0.015), lib.trim, [side * 0.45, s.tyreRadius + 0.1, z]);
        b.add(
          this.cylinder(0.03, 0.03, 0.34, 8),
          lib.metal,
          [side * 0.6, s.tyreRadius + 0.18, z + 0.12],
          [0.3, 0, 0],
        );
      }
    }
    for (const side of [1, -1]) b.add(this.box(0.1, 0.14, 4.2), lib.trim, [side * 0.45, 0.47, 0]);
    b.add(this.box(0.9, 0.1, 0.7), lib.trim, [0, 0.42, 1.95]);
    b.addMatrix(
      this.tube(
        [
          [-0.55, 0.42, -1.2],
          [-0.6, 0.4, -2.0],
          [-0.62, 0.36, -2.32],
        ],
        0.035,
      ),
      lib.metal,
      IDENTITY,
    );
    // Side steps / rock sliders under the doors.
    for (const side of [1, -1]) {
      b.add(this.box(0.16, 0.05, 1.2, 0.02), lib.trim, [side * 0.96, 0.46, 0.25]);
      for (const z of [-0.2, 0.7]) b.add(this.box(0.1, 0.1, 0.05), lib.trim, [side * 0.9, 0.5, z]);
    }

    // Engine bay block and crowned bonnet with a V8 scoop.
    b.add(this.box(1.24, 0.52, 1.36), lib.interior, [0, 0.84, 1.61]);
    b.add(this.box(1.62, 0.08, 1.38, 0.035, 3), paint, [0, 1.14, 1.61], [0.018, 0, 0]);
    b.add(this.box(1.3, 0.04, 1.3, 0.02, 2), paint, [0, 1.18, 1.62], [0.018, 0, 0]);
    b.add(this.box(0.62, 0.07, 0.46, 0.03, 3), paint, [0, 1.22, 1.38], [0.03, 0, 0]);
    b.add(this.box(0.5, 0.04, 0.03), lib.trim, [0, 1.225, 1.62]);
    // Windscreen washer jets and wiper arms.
    for (const side of [1, -1]) {
      b.add(this.box(0.03, 0.02, 0.03), lib.trim, [side * 0.25, 1.215, 1.0]);
      b.add(
        this.box(0.55, 0.012, 0.02),
        lib.trim,
        [side * 0.33 - 0.05, 1.2, 0.965],
        [0, 0, side * 0.12],
      );
    }

    // Front fascia, horizontal-slat grille, bumper.
    b.add(this.box(1.92, 0.56, 0.06, 0.025), paint, [0, 0.83, 2.28]);
    b.add(this.box(1.0, 0.34, 0.04, 0.015), lib.trim, [0, 0.9, 2.31]);
    for (let k = 0; k < 5; k++)
      b.add(this.box(0.96, 0.028, 0.03, 0.01), lib.metal, [0, 0.78 + k * 0.058, 2.335]);
    b.add(this.box(0.24, 0.05, 0.02, 0.01), lib.chrome, [0, 1.02, 2.34]);
    b.add(this.box(1.98, 0.18, 0.18, 0.04), lib.trim, [0, 0.6, 2.36]);

    // Tubular bull bar: centre hoop, wing hoops, uprights and driving lamps.
    const bar = 0.032;
    b.addMatrix(
      this.tube(
        [
          [-0.46, 0.62, 2.48],
          [-0.46, 1.08, 2.5],
          [-0.3, 1.2, 2.5],
          [0.3, 1.2, 2.5],
          [0.46, 1.08, 2.5],
          [0.46, 0.62, 2.48],
        ],
        bar,
      ),
      lib.trim,
      IDENTITY,
    );
    for (const side of [1, -1]) {
      b.addMatrix(
        this.tube(
          [
            [side * 0.46, 1.0, 2.5],
            [side * 0.72, 0.98, 2.47],
            [side * 0.9, 0.9, 2.38],
            [side * 0.95, 0.7, 2.32],
          ],
          bar * 0.85,
        ),
        lib.trim,
        IDENTITY,
      );
      b.add(this.box(0.14, 0.12, 0.14, 0.02), lib.trim, [side * 0.46, 0.6, 2.45]);
      b.add(this.box(0.1, 0.06, 0.12), lib.metal, [side * 0.55, 0.5, 2.43]);
    }
    b.addMatrix(
      this.tube(
        [
          [-0.46, 0.96, 2.5],
          [0.46, 0.96, 2.5],
        ],
        bar * 0.8,
      ),
      lib.trim,
      IDENTITY,
    );
    b.addMatrix(
      this.tube(
        [
          [-0.46, 0.76, 2.5],
          [0.46, 0.76, 2.5],
        ],
        bar * 0.8,
      ),
      lib.trim,
      IDENTITY,
    );
    b.add(this.box(0.92, 0.2, 0.01), lib.trim, [0, 0.66, 2.51]);
    // Front number plate on the bull bar's lower pan.
    b.add(this.box(0.44, 0.11, 0.008), this.plate, [0, 0.67, 2.52]);
    // Recovery points.
    for (const side of [1, -1])
      b.add(
        this.tmp(new THREE.TorusGeometry(0.035, 0.012, 6, 12)),
        lib.metal,
        [side * 0.62, 0.52, 2.47],
        [Math.PI / 2, 0, 0],
      );

    // Cab: floor, dash, console, seats, bulkhead, pillars, roof, windscreen.
    b.add(this.box(1.84, 0.06, 1.58), lib.interior, [0, 0.54, 0.14]);
    b.add(this.box(1.8, 0.24, 0.3, 0.06, 3), lib.interior, [0, 1.15, 0.78]);
    b.add(this.box(1.8, 0.52, 0.06), lib.interior, [0, 0.83, 0.92]);
    // Instrument binnacle with lit gauges in front of the driver.
    const dx = s.seats.driver[0];
    b.add(this.box(0.42, 0.14, 0.16, 0.04, 3), lib.interior, [dx, 1.3, 0.72]);
    for (const gx of [-0.1, 0.1])
      b.add(
        this.cylinder(0.055, 0.055, 0.01, 18),
        lib.gauge,
        [dx + gx, 1.3, 0.638],
        [Math.PI / 2 - 0.25, 0, 0],
      );
    b.add(this.box(0.3, 0.12, 0.02), lib.gauge, [0.02, 1.16, 0.625]);
    b.add(this.box(0.24, 0.32, 0.62, 0.04), lib.interior, [0, 0.72, 0.2]);
    for (const [gx, gz, tilt] of [
      [0.03, 0.42, 0.2],
      [-0.06, 0.36, 0.1],
    ] as const) {
      b.add(this.cylinder(0.008, 0.01, 0.26, 6), lib.metal, [gx, 0.98, gz], [tilt, 0, 0]);
      b.add(this.tmp(new THREE.SphereGeometry(0.025, 10, 8)), lib.seal, [gx, 1.11, gz + 0.03]);
    }
    const [, seatY, seatZ] = s.seats.driver;
    for (const x of [s.seats.driver[0], s.seats.passenger[0]]) {
      b.add(this.box(0.4, 0.28, 0.4, 0.03), lib.interior, [x, 0.71, seatZ]);
      // Bolstered cushion, backrest and headrest.
      b.add(this.box(0.5, 0.13, 0.5, 0.05, 3), lib.upholstery, [x, seatY - 0.14, seatZ + 0.02]);
      for (const bx of [-0.22, 0.22])
        b.add(this.box(0.08, 0.1, 0.46, 0.035, 3), lib.upholstery, [
          x + bx,
          seatY - 0.08,
          seatZ + 0.02,
        ]);
      b.add(
        this.box(0.48, 0.64, 0.12, 0.05, 3),
        lib.upholstery,
        [x, seatY + 0.2, seatZ - 0.3],
        [-0.16, 0, 0],
      );
      for (const bx of [-0.22, 0.22])
        b.add(
          this.box(0.08, 0.56, 0.12, 0.035, 3),
          lib.upholstery,
          [x + bx, seatY + 0.18, seatZ - 0.27],
          [-0.16, 0, 0],
        );
      b.add(
        this.box(0.26, 0.16, 0.1, 0.04, 3),
        lib.upholstery,
        [x, seatY + 0.64, seatZ - 0.38],
        [-0.12, 0, 0],
      );
    }
    b.add(this.box(1.9, 1.4, 0.05), paint, [0, 1.27, -0.64]);
    b.add(this.box(1.2, 0.32, 0.012), lib.glass, [0, 1.63, -0.67]);
    for (const side of [1, -1]) {
      b.add(this.box(0.05, 0.84, 0.07), paint, [side * 0.955, 1.54, REAR_DOOR_EDGE_Z - 0.04]);
      // Cab quarter panel and quarter glass behind the door.
      b.add(this.box(0.05, 0.84, 0.54, 0.012), paint, [side * 0.955, 1.54, -0.37]);
      b.add(this.box(0.012, 0.38, 0.32), lib.glass, [side * 0.984, 1.62, -0.37]);
      b.add(this.box(0.016, 0.42, 0.36, 0.006), lib.seal, [side * 0.978, 1.62, -0.37]);
      b.add(this.box(0.06, 0.83, 0.07, 0.02), paint, [side * 0.95, 1.53, 0.84], [-0.263, 0, 0]);
    }
    // Rounded roof skin with ribs and drip rails.
    b.add(this.box(1.96, 0.09, 1.48, 0.04, 3), paint, [0, 1.99, 0.045]);
    for (const z of [-0.35, 0.05, 0.45])
      b.add(this.box(1.5, 0.02, 0.06, 0.01), paint, [0, 2.04, z]);
    for (const side of [1, -1])
      b.addMatrix(
        this.tube(
          [
            [side * 0.985, 1.95, -0.68],
            [side * 0.985, 1.95, 0.7],
          ],
          0.012,
          6,
        ),
        paint,
        IDENTITY,
      );
    b.add(this.box(1.8, 0.83, 0.012), lib.glass, [0, 1.53, 0.84], [-0.263, 0, 0]);
    // Windscreen rubber surround.
    b.add(this.box(1.86, 0.05, 0.05, 0.02), lib.seal, [0, 1.93, 0.735]);
    b.add(this.box(1.86, 0.05, 0.12, 0.02), lib.seal, [0, 1.15, 0.99]);
    const column = this.cylinder(0.03, 0.035, 0.42, 8);
    b.add(column, lib.seal, [s.seats.driver[0], 1.18, 0.6], [0.45 + Math.PI / 2, 0, 0]);
    // Rear-view mirror.
    b.add(this.box(0.24, 0.07, 0.02, 0.01), lib.seal, [0, 1.84, 0.68]);

    // Door mirrors: arm, rounded housing and mirror glass facing rearward.
    for (const side of [1, -1]) {
      b.addMatrix(
        this.tube(
          [
            [side * 0.97, 1.2, 0.86],
            [side * 1.06, 1.24, 0.86],
            [side * 1.1, 1.3, 0.87],
          ],
          0.014,
          6,
        ),
        lib.trim,
        IDENTITY,
      );
      b.add(this.box(0.08, 0.24, 0.13, 0.03, 3), lib.trim, [side * 1.12, 1.38, 0.88]);
      b.add(this.box(0.065, 0.21, 0.01, 0.004), lib.chrome, [side * 1.12, 1.38, 0.814]);
    }

    // Snorkel on the passenger A-pillar with a forward-facing ram head.
    b.addMatrix(
      this.tube(
        [
          [0.99, 1.02, 1.02],
          [1.03, 1.15, 0.99],
          [1.03, 1.55, 0.89],
          [1.02, 1.9, 0.79],
          [1.0, 2.02, 0.79],
        ],
        0.055,
        12,
      ),
      lib.seal,
      IDENTITY,
    );
    b.add(this.box(0.16, 0.15, 0.24, 0.05, 3), lib.seal, [1.0, 2.05, 0.86]);
    b.add(this.box(0.12, 0.08, 0.02, 0.01), lib.trim, [1.0, 2.04, 0.985]);
    for (const y of [1.3, 1.75])
      b.add(this.box(0.05, 0.04, 0.05), lib.metal, [1.0, y, 0.93 - (y - 1.3) * 0.24]);

    // Roof rack: tubular frame, slats, swag roll, jerry cans; radio whip.
    for (const side of [1, -1]) {
      b.addMatrix(
        this.tube(
          [
            [side * 0.82, 2.1, -0.62],
            [side * 0.82, 2.1, 0.66],
          ],
          0.02,
          6,
        ),
        lib.trim,
        IDENTITY,
      );
      for (const z of [-0.6, 0.64])
        b.add(this.box(0.05, 0.08, 0.05), lib.trim, [side * 0.84, 2.06, z]);
    }
    for (const z of [-0.5, -0.25, 0.05, 0.3, 0.6])
      b.add(this.box(1.64, 0.025, 0.04, 0.008), lib.trim, [0, 2.11, z]);
    b.addMatrix(
      this.tube(
        [
          [-0.82, 2.1, 0.66],
          [-0.6, 2.12, 0.7],
          [0.6, 2.12, 0.7],
          [0.82, 2.1, 0.66],
        ],
        0.02,
        6,
      ),
      lib.trim,
      IDENTITY,
    );
    b.add(this.cylinder(0.12, 0.12, 1.2, 14), this.canvas, [0, 2.25, -0.38], [0, 0, Math.PI / 2]);
    for (const x of [-0.4, 0.4])
      b.add(
        this.tmp(new THREE.TorusGeometry(0.124, 0.008, 4, 16)),
        lib.trim,
        [x, 2.25, -0.38],
        [0, Math.PI / 2, 0],
      );
    for (const x of [-0.22, 0.22]) {
      b.add(this.box(0.17, 0.34, 0.24, 0.025), this.canvas, [x + 0.35, 2.29, 0.32]);
      b.add(this.box(0.04, 0.04, 0.12), lib.metal, [x + 0.35, 2.48, 0.32]);
    }
    b.add(this.box(0.08, 0.05, 0.08), lib.trim, [0.86, 2.06, -0.55]);
    b.add(this.cylinder(0.006, 0.011, 2.3, 5), lib.seal, [0.86, 3.2, -0.55]);
    b.add(this.cylinder(0.02, 0.02, 0.08, 8), lib.metal, [0.86, 2.1, -0.55]);

    // Rear body: tray block, tailgate, bumper, tow hitch, jerry cans, mud flaps.
    b.add(this.box(1.24, 0.52, 1.62), lib.interior, [0, 0.84, -1.47]);
    b.add(this.box(1.9, 0.58, 0.06, 0.025), paint, [0, 0.835, -2.28]);
    b.add(this.box(0.18, 0.04, 0.03, 0.01), lib.trim, [0, 1.0, -2.32]);
    b.add(this.box(1.98, 0.17, 0.16, 0.04), lib.trim, [0, 0.6, -2.35]);
    b.add(this.box(0.1, 0.08, 0.24), lib.metal, [0, 0.55, -2.48]);
    b.add(this.tmp(new THREE.SphereGeometry(0.04, 10, 8)), lib.metal, [0, 0.62, -2.58]);
    b.add(this.box(0.44, 0.11, 0.008), this.plate, [-0.5, 0.6, -2.435], [0, Math.PI, 0]);
    for (const side of [1, -1]) {
      b.add(this.box(0.12, 0.34, 0.24, 0.02), this.canvas, [side * 0.57, 1.0, -2.44]);
      b.add(this.box(0.13, 0.04, 0.26, 0.01), lib.trim, [side * 0.57, 1.12, -2.44]);
    }
    for (const side of [1, -1])
      b.add(this.box(0.26, 0.3, 0.02), lib.seal, [side * 0.81, 0.34, s.rearAxle - 0.52]);

    if (this.variant.rear === "canopy") {
      b.add(this.box(1.9, 0.06, 1.62), paint, [0, 1.13, -1.47]);
      b.add(this.box(1.88, 0.9, 1.6, 0.14, 4), this.canvas, [0, 1.6, -1.47]);
      for (const z of [-0.8, -1.47, -2.14])
        b.add(this.box(1.92, 0.92, 0.035, 0.1, 3), lib.trim, [0, 1.6, z]);
    } else {
      b.add(this.box(1.92, 0.88, 1.62, 0.08, 3), paint, [0, 1.56, -1.47]);
      for (const side of [1, -1]) {
        b.add(this.box(0.012, 0.36, 0.95), lib.glass, [side * 0.965, 1.66, -1.3]);
        b.add(this.box(0.014, 0.4, 0.99, 0.006), lib.seal, [side * 0.96, 1.66, -1.3]);
      }
      b.add(this.box(1.3, 0.36, 0.012), lib.glass, [0, 1.66, -2.29]);
      b.add(this.box(1.34, 0.4, 0.014, 0.006), lib.seal, [0, 1.66, -2.285]);
      for (const side of [1, -1])
        b.addMatrix(
          this.tube(
            [
              [side * 0.8, 2.04, -0.75],
              [side * 0.8, 2.04, -2.15],
            ],
            0.018,
            6,
          ),
          lib.trim,
          IDENTITY,
        );
    }

    this.owned.push(...b.build(this.root));

    // Spare wheel on the tailgate, reusing the shared wheel meshes.
    const { tyre, rim, holes } = buildWheelGeometries(s, lib);
    const spare = new THREE.Group();
    spare.position.set(0, 1.08, -2.47);
    spare.rotation.y = Math.PI / 2; // rim face (+X) turned to face rearward (-Z)
    spare.add(
      new THREE.Mesh(tyre, lib.rubber),
      new THREE.Mesh(rim, lib.rim),
      new THREE.Mesh(holes, lib.liner),
    );
    for (const m of spare.children as THREE.Mesh[]) m.castShadow = true;
    this.root.add(spare);
  }

  /** Headlamp, indicator, tail, brake and reverse clusters plus their halos. */
  private buildLamps(): void {
    const lib = this.lib;
    const b = new MeshBatcher();
    // Round headlamps: chrome bowl, domed lens, black bezel; indicator below.
    const bowl = this.cylinder(0.1, 0.085, 0.05, 24);
    const lens = this.tmp(new THREE.SphereGeometry(0.13, 24, 8, 0, Math.PI * 2, 0, 0.76));
    const bezel = this.tmp(new THREE.TorusGeometry(0.1, 0.016, 8, 28));
    for (const side of [1, -1]) {
      const x = side * 0.66;
      b.add(bowl, lib.chrome, [x, 0.92, 2.3], [Math.PI / 2, 0, 0]);
      b.add(lens, this.headlamp, [x, 0.92, 2.231], [Math.PI / 2, 0, 0]);
      b.add(bezel, lib.trim, [x, 0.92, 2.325]);
      b.add(this.box(0.16, 0.06, 0.03, 0.012), lib.amber, [x, 0.77, 2.315]);
      b.add(this.box(0.04, 0.07, 0.12, 0.01), lib.amber, [side * 0.985, 0.95, 2.05]);
      // Driving lamps on the bull bar.
      b.add(
        this.cylinder(0.075, 0.06, 0.08, 18),
        lib.trim,
        [side * 0.3, 1.27, 2.5],
        [Math.PI / 2, 0, 0],
      );
      b.add(
        this.cylinder(0.062, 0.062, 0.012, 18),
        this.headlamp,
        [side * 0.3, 1.27, 2.545],
        [Math.PI / 2, 0, 0],
      );
      b.add(this.box(0.03, 0.06, 0.03), lib.trim, [side * 0.3, 1.22, 2.5]);
    }
    // Vertical tail clusters at the rear corners: tail, brake, indicator, reverse.
    for (const side of [1, -1]) {
      const x = side * 0.84;
      b.add(this.box(0.16, 0.36, 0.035, 0.012), lib.seal, [x, 0.86, -2.31]);
      b.add(this.box(0.13, 0.09, 0.03, 0.01), this.taillamp, [x, 0.98, -2.325]);
      b.add(this.box(0.13, 0.08, 0.03, 0.01), this.brakelamp, [x, 0.89, -2.325]);
      b.add(this.box(0.13, 0.065, 0.03, 0.01), lib.amber, [x, 0.81, -2.325]);
      b.add(this.box(0.13, 0.05, 0.03, 0.01), lib.reverse, [x, 0.745, -2.325]);
      b.add(this.box(0.06, 0.03, 0.02), lib.amber, [side * 0.99, 0.62, -2.2]);
    }
    // High-mounted stop lamp.
    const hy = this.variant.rear === "canopy" ? 1.97 : 1.93;
    b.add(this.box(0.36, 0.05, 0.04, 0.012), this.brakelamp, [0, hy, -2.3]);
    this.owned.push(...b.build(this.root, { castShadow: false }));

    // Halos: hidden until lit, so they cost nothing parked or by day.
    const sprite = (m: THREE.SpriteMaterial, list: THREE.Sprite[], pos: Vec3, size: number) => {
      const sp = new THREE.Sprite(m);
      sp.position.set(pos[0], pos[1], pos[2]);
      sp.scale.setScalar(size);
      sp.visible = false;
      sp.renderOrder = 3;
      list.push(sp);
      this.root.add(sp);
    };
    for (const side of [1, -1]) {
      sprite(this.headGlow, this.headSprites, [side * 0.66, 0.92, 2.36], 0.85);
      sprite(this.tailGlow, this.tailSprites, [side * 0.84, 0.98, -2.36], 0.42);
      sprite(this.brakeGlow, this.brakeSprites, [side * 0.84, 0.89, -2.36], 0.65);
    }
    sprite(this.brakeGlow, this.brakeSprites, [0, hy, -2.35], 0.5);
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
      panel.moveTo(-L + 0.015, SILL_Y + 0.03);
      panel.lineTo(-0.015, SILL_Y + 0.03);
      panel.lineTo(-0.015, BELT_Y);
      panel.lineTo(-L + 0.015, BELT_Y);
      panel.closePath();
      const frame = new THREE.Shape();
      frame.moveTo(-L + 0.015, BELT_Y);
      frame.lineTo(-0.015, BELT_Y);
      frame.lineTo(-0.2, 1.86);
      frame.lineTo(-L + 0.015, 1.86);
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
        this.sideExtrusion(frame, -half, SKIN_THICKNESS * 0.8, 0.008),
        this.paint,
        new THREE.Matrix4(),
      );
      b.addMatrix(this.sideExtrusion(glass, -0.006, 0.012, 0), lib.glass, new THREE.Matrix4());
      // Handle, keyhole, rubbing strip, window seal and inner trim card.
      b.add(this.box(0.03, 0.04, 0.17, 0.012), lib.trim, [sign * (half + 0.014), 1.0, -L + 0.2]);
      b.add(this.box(0.02, 0.05, 0.02, 0.008), lib.chrome, [sign * (half + 0.012), 1.0, -L + 0.33]);
      b.add(this.box(0.03, 0.05, L - 0.06, 0.012), lib.trim, [sign * (half + 0.012), 0.86, -L / 2]);
      b.add(this.box(0.03, 0.02, L - 0.12), lib.seal, [
        sign * (half + 0.005),
        BELT_Y + 0.03,
        -L / 2 - 0.03,
      ]);
      b.add(this.box(0.02, 0.5, 0.02), lib.seal, [0, 1.46, -0.03]);
      b.add(this.box(0.03, 0.48, L - 0.1, 0.012), lib.interior, [
        -sign * (half + 0.014),
        0.86,
        -L / 2,
      ]);
      b.add(this.box(0.05, 0.04, 0.3, 0.015), lib.interior, [-sign * (half + 0.04), 1.0, -L / 2]);
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
    b.add(this.tmp(new THREE.TorusGeometry(0.19, 0.022, 10, 32)), lib.seal, [0, 0, 0]);
    b.add(this.cylinder(0.06, 0.07, 0.06, 16), lib.seal, [0, 0, 0.01], [Math.PI / 2, 0, 0]);
    for (const a of [-Math.PI / 2, Math.PI / 6 - 0.2, (5 * Math.PI) / 6 + 0.2]) {
      b.add(
        this.box(0.15, 0.032, 0.018, 0.008),
        lib.seal,
        [Math.cos(a) * 0.11, Math.sin(a) * 0.11, 0],
        [0, 0, a],
      );
    }
    this.owned.push(...b.build(this.steeringWheel, { castShadow: false }));
  }

  private buildWheels(): void {
    const s = this.spec;
    const { tyre, rim, holes } = buildWheelGeometries(s, this.lib);
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
      const h = new THREE.Mesh(holes, this.lib.liner);
      t.castShadow = r.castShadow = true;
      t.receiveShadow = r.receiveShadow = true;
      face.add(t, r, h);
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
    const state = (headlights ? 1 : 0) | (braking ? 2 : 0);
    if (state === this.lightState) return;
    this.lightState = state;
    this.headlamp.emissiveIntensity = headlights ? 3.2 : 0;
    this.taillamp.emissiveIntensity = headlights ? 1.6 : 0.03;
    this.brakelamp.emissiveIntensity = braking ? 4.5 : headlights ? 1.2 : 0.03;
    this.headGlow.opacity = 0.9;
    this.tailGlow.opacity = 0.55;
    this.brakeGlow.opacity = braking ? 0.95 : 0.4;
    for (const sp of this.headSprites) sp.visible = headlights;
    for (const sp of this.tailSprites) sp.visible = headlights;
    for (const sp of this.brakeSprites) sp.visible = braking || headlights;
  }

  dispose(): void {
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    this.root.removeFromParent();
  }
}
