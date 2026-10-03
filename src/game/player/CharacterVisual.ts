import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { MeshBatcher } from "../core/MeshBatcher";
import type { CharacterPose } from "./CharacterAnimator";

/**
 * Procedural characters on one shared joint rig, so the procedural animator,
 * seating and collision treat every variant alike:
 *
 * - `soldier` — smooth lathe-turned body in AMCU-style camouflage (canvas
 *   colour map plus ripstop normal / roughness maps), sculpted face with
 *   ballistic glasses and comms headset, covered helmet with NVG shroud,
 *   plate carrier with cummerbund and pouches, radio with whip, hydration
 *   carrier, battle belt, knee pads, gloved hands and tan boots with lug
 *   soles. Each joint's parts are merged per material.
 * - `technician` — the After Hours night-shift audio technician (fictional):
 *   loose overshirt over a hoodie, relaxed trousers, trainers, headphones,
 *   a visitor badge on a lanyard and a cable coil slung over one shoulder.
 *   The `staff` palette swaps the headphones for a beanie and a staff badge.
 *
 * Every limb hangs from a joint group so the animator can pose it. The whole
 * visual is replaceable: anything exposing `root`, `applyPose` and
 * `dispose` (e.g. a skinned GLTF wrapper) can stand in for it.
 *
 * Local frame: +Z forward, +X the character's left, origin between the feet.
 */

const PELVIS_HEIGHT = 0.98;

export type CharacterVariant = "soldier" | "technician";
export type TechnicianPalette = "visitor" | "staff";

export interface CharacterOptions {
  variant?: CharacterVariant;
  palette?: TechnicianPalette;
}

type Materials = Record<
  | "uniform"
  | "vest"
  | "boots"
  | "sole"
  | "skin"
  | "gloves"
  | "helmet"
  | "pack"
  | "dark"
  | "lens"
  | "lips"
  | "hair",
  THREE.MeshStandardMaterial
>;

/** Seeded PRNG so every build of the pattern is identical. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * Australian AMCU-style multi-tone camouflage (browser only): a pale sand
 * base under soft tan clouds, olive and red-brown brush blobs, then small
 * dark-brown and cream flecks, drawn wrapped so the texture tiles. The
 * shapes lean vertical, as on the real pattern.
 */
function createCamoTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#b4a584";
  ctx.fillRect(0, 0, size, size);
  const rand = seeded(7331);
  const blob = (x: number, y: number, rx: number, ry: number, rot: number) => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.ellipse(x + ox, y + oy, rx, ry, rot, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };
  // [colour, clusters, blobs per cluster, scale, blur]
  const layers: [string, number, number, number, number][] = [
    ["#a08f6c", 22, 5, 46, 10],
    ["#c2b593", 14, 4, 30, 6],
    ["#7a7650", 18, 5, 26, 2],
    ["#8a6745", 16, 4, 22, 1.5],
    ["#5a6142", 10, 4, 18, 1],
    ["#4a3a2a", 26, 3, 9, 0.5],
    ["#d6cba9", 30, 2, 7, 0.5],
  ];
  for (const [color, clusters, per, scale, blur] of layers) {
    ctx.fillStyle = color;
    ctx.filter = `blur(${blur}px)`;
    for (let c = 0; c < clusters; c++) {
      const cx = rand() * size;
      const cy = rand() * size;
      for (let k = 0; k < per; k++) {
        blob(
          cx + (rand() - 0.5) * scale * 2,
          cy + (rand() - 0.5) * scale * 3,
          scale * (0.35 + rand() * 0.5),
          scale * (0.6 + rand() * 0.9),
          (rand() - 0.5) * 0.9,
        );
      }
    }
  }
  ctx.filter = "none";
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.5, 1.5);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Ripstop fabric detail (browser only): a normal map from a height field of
 * fine weave plus the raised ripstop grid, and a matching roughness map
 * (threads slightly glossier than the gaps). Tiled densely over the garment.
 */
function createFabricMaps(): { normal: THREE.Texture; rough: THREE.Texture } | null {
  if (typeof document === "undefined") return null;
  const n = 128;
  const height = new Float32Array(n * n);
  const rand = seeded(42);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const weave = Math.sin((x / n) * Math.PI * 2 * 32) * Math.sin((y / n) * Math.PI * 2 * 32);
      const rip = x % 32 < 2 || y % 32 < 2 ? 1 : 0;
      height[y * n + x] = weave * 0.35 + rip * 0.8 + (rand() - 0.5) * 0.25;
    }
  }
  const make = () => {
    const c = document.createElement("canvas");
    c.width = c.height = n;
    return c;
  };
  const nc = make();
  const rc = make();
  const nctx = nc.getContext("2d");
  const rctx = rc.getContext("2d");
  if (!nctx || !rctx) return null;
  const nimg = nctx.createImageData(n, n);
  const rimg = rctx.createImageData(n, n);
  const h = (x: number, y: number) => height[((y + n) % n) * n + ((x + n) % n)];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * 0.9;
      const dy = (h(x, y + 1) - h(x, y - 1)) * 0.9;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * n + x) * 4;
      nimg.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 3] = 255;
      const r = 215 - h(x, y) * 30;
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = r;
      rimg.data[i + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  const normal = new THREE.CanvasTexture(nc);
  const rough = new THREE.CanvasTexture(rc);
  for (const t of [normal, rough]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(6, 6);
  }
  return { normal, rough };
}

function createMaterials(): Materials {
  const camo = createCamoTexture();
  const fabric = createFabricMaps();
  const cloth = (color: string, map: THREE.Texture | null, roughness: number) =>
    new THREE.MeshStandardMaterial({
      color: map ? "#ffffff" : color,
      map,
      roughness,
      normalMap: fabric?.normal ?? null,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughnessMap: fabric?.rough ?? null,
    });
  const helmet = cloth("#8d7f60", camo, 0.95);
  helmet.color.set(camo ? "#d8d0bf" : "#8d7f60");
  return {
    uniform: cloth("#a49673", camo, 0.95),
    vest: cloth("#6e6249", null, 0.95),
    pack: cloth("#5f5a42", null, 0.95),
    helmet,
    boots: new THREE.MeshStandardMaterial({ color: "#8b7356", roughness: 0.9 }),
    sole: new THREE.MeshStandardMaterial({ color: "#2a2521", roughness: 0.85 }),
    skin: new THREE.MeshPhysicalMaterial({
      color: "#b98463",
      roughness: 0.55,
      sheen: 0.4,
      sheenColor: new THREE.Color("#d9826a"),
      sheenRoughness: 0.6,
    }),
    gloves: new THREE.MeshStandardMaterial({ color: "#4f4636", roughness: 0.82 }),
    dark: new THREE.MeshStandardMaterial({ color: "#1d1f22", roughness: 0.42, metalness: 0.35 }),
    lens: new THREE.MeshStandardMaterial({
      color: "#0c0d0e",
      roughness: 0.06,
      metalness: 0.6,
      envMapIntensity: 2,
    }),
    lips: new THREE.MeshStandardMaterial({ color: "#8a5546", roughness: 0.6 }),
    hair: new THREE.MeshStandardMaterial({ color: "#2e231b", roughness: 0.95 }),
  };
}

/** Canvas texture for the lanyard badge (browser only). */
function createBadgeTexture(label: string, stripe: string): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#f3f0e6";
  ctx.fillRect(0, 0, 64, 96);
  ctx.fillStyle = stripe;
  ctx.fillRect(0, 0, 64, 26);
  ctx.fillStyle = "#1b2426";
  ctx.fillRect(10, 36, 24, 28);
  ctx.fillStyle = "#f3f0e6";
  ctx.font = "bold 13px monospace";
  ctx.textAlign = "center";
  ctx.fillText(label, 32, 18);
  ctx.fillStyle = "#1b2426";
  ctx.fillRect(38, 40, 18, 3);
  ctx.fillRect(38, 48, 14, 3);
  ctx.fillRect(10, 74, 44, 3);
  ctx.fillRect(10, 82, 30, 3);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

type TechMaterials = Record<
  | "shirt"
  | "hoodie"
  | "trousers"
  | "shoes"
  | "sole"
  | "skin"
  | "hair"
  | "phones"
  | "accent"
  | "badge"
  | "lanyard"
  | "bag"
  | "cable"
  | "beanie",
  THREE.MeshStandardMaterial
>;

function createTechMaterials(palette: TechnicianPalette): TechMaterials {
  const staff = palette === "staff";
  return {
    shirt: new THREE.MeshStandardMaterial({ color: staff ? "#5d6368" : "#3f5b52", roughness: 0.9 }),
    hoodie: new THREE.MeshStandardMaterial({
      color: staff ? "#2f3a44" : "#c9b89a",
      roughness: 0.95,
    }),
    trousers: new THREE.MeshStandardMaterial({
      color: staff ? "#23303b" : "#34363a",
      roughness: 0.9,
    }),
    shoes: new THREE.MeshStandardMaterial({ color: staff ? "#3b3631" : "#dcd6c8", roughness: 0.7 }),
    sole: new THREE.MeshStandardMaterial({ color: "#2a2a2a", roughness: 0.8 }),
    skin: new THREE.MeshStandardMaterial({ color: staff ? "#8d5f45" : "#c79a7b", roughness: 0.7 }),
    hair: new THREE.MeshStandardMaterial({ color: staff ? "#1d1a18" : "#3a2a1f", roughness: 0.85 }),
    phones: new THREE.MeshStandardMaterial({ color: "#1c1e21", roughness: 0.45, metalness: 0.3 }),
    accent: new THREE.MeshStandardMaterial({
      color: "#e8a33d",
      roughness: 0.4,
      emissive: "#e8a33d",
      emissiveIntensity: 0.35,
    }),
    badge: new THREE.MeshStandardMaterial({
      color: "#ffffff",
      map: createBadgeTexture(staff ? "STAFF" : "VISITOR", staff ? "#b9791f" : "#0b5d63"),
      roughness: 0.6,
    }),
    lanyard: new THREE.MeshStandardMaterial({
      color: staff ? "#b9791f" : "#0b5d63",
      roughness: 0.8,
    }),
    bag: new THREE.MeshStandardMaterial({ color: "#6d6250", roughness: 0.95 }),
    cable: new THREE.MeshStandardMaterial({ color: "#151515", roughness: 0.5 }),
    beanie: new THREE.MeshStandardMaterial({ color: "#8a3b2e", roughness: 0.95 }),
  };
}

export class CharacterVisual {
  readonly root = new THREE.Group();
  readonly variant: CharacterVariant;
  private readonly body = new THREE.Group();
  private readonly pelvis = new THREE.Group();
  private readonly spine = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly hips: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly knees: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly ankles: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly shoulders: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly elbows: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly materials: THREE.MeshStandardMaterial[];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly cup = new THREE.Group();
  private readonly sidearm = new THREE.Group();

  constructor(options: CharacterOptions = {}) {
    this.variant = options.variant ?? "soldier";
    this.root.name = "player-character";
    this.root.add(this.body);
    this.body.add(this.pelvis);
    this.pelvis.position.y = PELVIS_HEIGHT;
    if (this.variant === "technician") {
      const m = createTechMaterials(options.palette ?? "visitor");
      this.materials = Object.values(m);
      this.buildTechnician(m, options.palette ?? "visitor");
    } else {
      const m = createMaterials();
      this.materials = Object.values(m);
      this.build(m);
    }
    this.buildCup();
    this.buildSidearm();
  }

  private geometry<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private part(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /**
   * The soldier: smooth lathe-turned body (torso, limbs, boots) under layered
   * gear — plate carrier with cummerbund, mag / radio / utility pouches,
   * hydration carrier, battle belt, knee pads, gloves and a covered helmet with
   * NVG shroud and comms headset. Each joint's parts are merged per material,
   * so the whole figure is a few dozen draw calls at most.
   */
  private build(m: Materials): void {
    const temp: THREE.BufferGeometry[] = [];
    const t = <T extends THREE.BufferGeometry>(g: T): T => {
      temp.push(g);
      return g;
    };
    const rbox = (w: number, h: number, d: number, r: number) =>
      t(new RoundedBoxGeometry(w, h, d, 2, r));
    const sphere = (r: number, ws = 16, hs = 12) => t(new THREE.SphereGeometry(r, ws, hs));
    const lathe = (profile: readonly (readonly [number, number])[], seg = 18) =>
      t(
        new THREE.LatheGeometry(
          profile.map(([r, y]) => new THREE.Vector2(r, y)),
          seg,
        ),
      );
    const batches: [THREE.Object3D, MeshBatcher][] = [];
    const batch = (parent: THREE.Object3D) => {
      const b = new MeshBatcher();
      batches.push([parent, b]);
      return b;
    };

    // Pelvis: hips, seat of the trousers, battle belt with pouches.
    const pb = batch(this.pelvis);
    pb.add(
      lathe([
        [0.001, -0.12],
        [0.1, -0.115],
        [0.155, -0.07],
        [0.172, 0.0],
        [0.165, 0.09],
        [0.158, 0.12],
        [0.001, 0.12],
      ]),
      m.uniform,
      [0, 0, 0],
      [0, 0, 0],
      [1, 1, 0.66],
    );
    pb.add(
      lathe(
        [
          [0.172, 0.04],
          [0.178, 0.05],
          [0.178, 0.1],
          [0.17, 0.11],
        ],
        22,
      ),
      m.vest,
      [0, 0, 0],
      [0, 0, 0],
      [1.02, 1, 0.7],
    );
    pb.add(rbox(0.06, 0.05, 0.02, 0.008), m.dark, [0, 0.075, 0.125]);
    for (const [x, z, w] of [
      [0.15, 0.06, 0.07],
      [-0.15, 0.06, 0.07],
      [0.12, -0.09, 0.09],
      [-0.12, -0.09, 0.09],
    ] as const)
      pb.add(rbox(w, 0.1, 0.06, 0.015), m.vest, [x, 0.04, z], [0, Math.atan2(x, z), 0]);

    // Torso, plate carrier, pouches, radio and hydration carrier.
    this.spine.position.y = 0.08;
    this.pelvis.add(this.spine);
    const sb = batch(this.spine);
    sb.add(
      lathe(
        [
          [0.001, -0.02],
          [0.152, -0.02],
          [0.158, 0.08],
          [0.172, 0.2],
          [0.182, 0.32],
          [0.178, 0.4],
          [0.15, 0.47],
          [0.09, 0.51],
          [0.055, 0.53],
          [0.001, 0.53],
        ],
        22,
      ),
      m.uniform,
      [0, 0, 0],
      [0, 0, 0],
      [1.06, 1, 0.66],
    );
    // Front and back plates, cummerbund and shoulder straps.
    sb.add(rbox(0.3, 0.33, 0.06, 0.025), m.vest, [0, 0.28, 0.105], [-0.04, 0, 0]);
    sb.add(rbox(0.3, 0.36, 0.045, 0.02), m.vest, [0, 0.29, -0.095], [0.05, 0, 0]);
    sb.add(
      lathe(
        [
          [0.18, 0.09],
          [0.19, 0.1],
          [0.195, 0.2],
          [0.188, 0.24],
        ],
        22,
      ),
      m.vest,
      [0, 0, 0],
      [0, 0, 0],
      [1.08, 1, 0.68],
    );
    for (const x of [-0.11, 0.11]) {
      sb.add(rbox(0.075, 0.05, 0.25, 0.02), m.vest, [x, 0.475, 0.0], [0, 0, x > 0 ? -0.25 : 0.25]);
    }
    // Triple mag pouch, admin pouch, radio pouch with radio and whip, IFAK.
    for (const x of [-0.09, 0, 0.09]) {
      sb.add(rbox(0.08, 0.12, 0.05, 0.014), m.vest, [x, 0.2, 0.155]);
      sb.add(rbox(0.082, 0.03, 0.055, 0.01), m.vest, [x, 0.265, 0.157]);
    }
    sb.add(rbox(0.16, 0.08, 0.035, 0.012), m.pack, [0, 0.36, 0.148]);
    sb.add(rbox(0.07, 0.13, 0.06, 0.015), m.vest, [0.175, 0.32, 0.03], [0, 0.5, 0]);
    sb.add(rbox(0.05, 0.1, 0.035, 0.008), m.dark, [0.18, 0.4, 0.03], [0, 0.5, 0]);
    sb.add(
      t(new THREE.CylinderGeometry(0.004, 0.007, 0.42, 5)),
      m.dark,
      [0.19, 0.64, 0.02],
      [0, 0, -0.1],
    );
    sb.add(rbox(0.08, 0.1, 0.05, 0.015), m.vest, [-0.17, 0.22, 0.04], [0, -0.5, 0]);
    sb.add(rbox(0.2, 0.3, 0.055, 0.025), m.pack, [0, 0.3, -0.14]);
    sb.add(
      t(new THREE.CylinderGeometry(0.008, 0.008, 0.34, 6)),
      m.dark,
      [0.09, 0.42, -0.08],
      [0.3, 0, -0.5],
    );
    // Collar of the shirt.
    sb.add(
      t(new THREE.TorusGeometry(0.062, 0.018, 6, 16)),
      m.uniform,
      [0, 0.515, -0.004],
      [Math.PI / 2 + 0.25, 0, 0],
      [1, 1.1, 1],
    );

    // Neck and head: sculpted skull, jaw, nose, brow, ears, mouth; ballistic
    // glasses, comms headset, covered helmet with NVG shroud and chin strap.
    const neck = new THREE.Group();
    neck.position.y = 0.52;
    this.spine.add(neck);
    batch(neck).add(
      lathe(
        [
          [0.066, -0.02],
          [0.058, 0.04],
          [0.06, 0.1],
        ],
        14,
      ),
      m.skin,
      [0, 0, 0.006],
    );
    this.head.position.y = 0.09;
    neck.add(this.head);
    const hb = batch(this.head);
    hb.add(sphere(0.105, 20, 16), m.skin, [0, 0.08, 0.0], [0, 0, 0], [0.9, 1.04, 1.0]);
    // Close-cropped hair over the back and sides of the skull.
    hb.add(
      t(new THREE.SphereGeometry(0.108, 18, 10, Math.PI * 0.95, Math.PI * 1.1, 0, Math.PI * 0.74)),
      m.hair,
      [0, 0.08, -0.002],
      [0, 0, 0],
      [0.9, 1.04, 1.0],
    );
    hb.add(sphere(0.082, 18, 12), m.skin, [0, 0.02, 0.03], [0, 0, 0], [0.92, 0.82, 1.0]);
    hb.add(sphere(0.024, 10, 8), m.skin, [0, 0.055, 0.112], [0.25, 0, 0], [0.62, 1.35, 1.0]);
    hb.add(sphere(0.012, 8, 6), m.skin, [0, 0.03, 0.12], [0, 0, 0], [1.6, 0.8, 1]);
    hb.add(sphere(0.09, 16, 8), m.skin, [0, 0.1, 0.045], [0, 0, 0], [0.92, 0.22, 0.75]);
    hb.add(rbox(0.036, 0.007, 0.012, 0.003), m.lips, [0, 0.003, 0.104]);
    hb.add(sphere(0.03, 10, 8), m.skin, [0, -0.02, 0.085], [0, 0, 0], [1.2, 0.8, 1]);
    for (const side of [1, -1]) {
      hb.add(sphere(0.03, 10, 8), m.skin, [side * 0.062, 0.035, 0.07], [0, 0, 0], [1, 0.8, 0.8]);
    }
    const glasses = t(new THREE.CylinderGeometry(0.108, 0.104, 0.036, 20, 1, true, -0.95, 1.9));
    hb.add(glasses, m.lens, [0, 0.083, 0.012], [0, 0, 0], [0.93, 1, 1]);
    // Headset ear cups and band (worn under the helmet).
    for (const side of [1, -1]) {
      hb.add(
        t(new THREE.CylinderGeometry(0.033, 0.035, 0.03, 16)),
        m.pack,
        [side * 0.1, 0.065, 0.0],
        [0, 0, Math.PI / 2],
      );
      hb.add(rbox(0.015, 0.08, 0.02, 0.005), m.dark, [side * 0.122, 0.04, 0.03], [0.6, 0, 0]);
    }
    hb.add(
      t(new THREE.TorusGeometry(0.098, 0.007, 4, 18, Math.PI)),
      m.dark,
      [0, 0.07, 0.025],
      [0, 0, Math.PI],
    );
    // Helmet shell with camo cover, rim band, side rails and NVG shroud.
    hb.add(
      t(new THREE.SphereGeometry(0.135, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.53)),
      m.helmet,
      [0, 0.1, -0.008],
      [-0.08, 0, 0],
      [0.95, 0.92, 1.06],
    );
    hb.add(
      lathe(
        [
          [0.131, -0.012],
          [0.136, 0.0],
          [0.131, 0.012],
        ],
        24,
      ),
      m.helmet,
      [0, 0.098, -0.008],
      [-0.08, 0, 0],
      [0.96, 1, 1.07],
    );
    hb.add(rbox(0.07, 0.04, 0.03, 0.01), m.dark, [0, 0.19, 0.115], [-0.5, 0, 0]);
    for (const side of [1, -1])
      hb.add(
        rbox(0.012, 0.03, 0.12, 0.005),
        m.dark,
        [side * 0.127, 0.12, -0.01],
        [0, 0, side * 0.2],
      );
    hb.add(rbox(0.06, 0.03, 0.06, 0.01), m.pack, [0, 0.16, -0.12], [0.6, 0, 0]);
    hb.add(
      t(new THREE.TorusGeometry(0.095, 0.005, 4, 16, Math.PI)),
      m.pack,
      [0, 0.07, 0.04],
      [-0.2, 0, Math.PI],
      [1, 1.1, 1],
    );

    // Arms: deltoid, sleeved upper arm, forearm, gloved hand with fingers and thumb.
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? 1 : -1;
      const shoulder = this.shoulders[side];
      shoulder.position.set(0.215 * sign, 0.44, 0);
      this.spine.add(shoulder);
      const ab = batch(shoulder);
      ab.add(sphere(0.066, 14, 10), m.uniform, [0.005 * sign, -0.01, 0], [0, 0, 0], [1, 1.05, 1.1]);
      ab.add(
        lathe(
          [
            [0.06, -0.02],
            [0.058, -0.09],
            [0.052, -0.18],
            [0.047, -0.25],
            [0.046, -0.29],
          ],
          14,
        ),
        m.uniform,
        [0, 0, 0],
      );
      ab.add(rbox(0.012, 0.06, 0.07, 0.004), m.vest, [0.058 * sign, -0.08, 0]);
      const elbow = this.elbows[side];
      elbow.position.y = -0.285;
      shoulder.add(elbow);
      const eb = batch(elbow);
      eb.add(
        lathe(
          [
            [0.046, 0.01],
            [0.047, -0.05],
            [0.041, -0.14],
            [0.034, -0.21],
            [0.036, -0.235],
          ],
          14,
        ),
        m.uniform,
        [0, 0, 0],
      );
      eb.add(
        lathe(
          [
            [0.036, -0.215],
            [0.034, -0.245],
            [0.031, -0.255],
          ],
          12,
        ),
        m.gloves,
        [0, 0, 0],
      );
      // Palm, curled fingers and thumb.
      eb.add(rbox(0.04, 0.085, 0.075, 0.016), m.gloves, [0, -0.29, 0.008]);
      eb.add(rbox(0.036, 0.06, 0.07, 0.016), m.gloves, [-0.008 * sign, -0.345, 0.02], [0.35, 0, 0]);
      eb.add(
        rbox(0.022, 0.055, 0.024, 0.01),
        m.gloves,
        [-0.012 * sign, -0.29, 0.05],
        [0.5, 0, 0.3 * sign],
      );
    }

    // Legs: thigh with cargo pocket, knee pad, calf, tan boots with soles.
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? 1 : -1;
      const hip = this.hips[side];
      hip.position.set(0.1 * sign, -0.03, 0);
      this.pelvis.add(hip);
      const lb = batch(hip);
      lb.add(
        lathe(
          [
            [0.084, 0.04],
            [0.088, -0.05],
            [0.082, -0.16],
            [0.071, -0.3],
            [0.06, -0.4],
            [0.058, -0.44],
          ],
          16,
        ),
        m.uniform,
        [0, 0, 0],
      );
      lb.add(rbox(0.04, 0.15, 0.11, 0.015), m.uniform, [0.075 * sign, -0.2, 0.0]);
      lb.add(rbox(0.042, 0.035, 0.112, 0.01), m.uniform, [0.077 * sign, -0.13, 0.0]);
      const knee = this.knees[side];
      knee.position.y = -0.43;
      hip.add(knee);
      const kb = batch(knee);
      kb.add(
        lathe(
          [
            [0.06, 0.02],
            [0.058, -0.06],
            [0.06, -0.14],
            [0.05, -0.27],
            [0.046, -0.34],
            [0.05, -0.38],
          ],
          16,
        ),
        m.uniform,
        [0, 0, 0.0],
      );
      kb.add(rbox(0.09, 0.12, 0.04, 0.018), m.vest, [0, -0.02, 0.05], [0.1, 0, 0]);
      kb.add(rbox(0.1, 0.018, 0.1, 0.006), m.vest, [0, -0.06, 0.0]);
      const ankle = this.ankles[side];
      ankle.position.y = -0.44;
      knee.add(ankle);
      const fb = batch(ankle);
      // Boot shaft, foot with toe cap, heel, lug sole and lacing strip.
      fb.add(
        lathe(
          [
            [0.054, 0.12],
            [0.058, 0.06],
            [0.056, 0.0],
            [0.052, -0.04],
          ],
          16,
        ),
        m.boots,
        [0, 0, -0.004],
        [0, 0, 0],
        [1, 1, 1.08],
      );
      fb.add(rbox(0.105, 0.08, 0.22, 0.035), m.boots, [0, -0.03, 0.035]);
      fb.add(sphere(0.054, 14, 10), m.boots, [0, -0.04, 0.13], [0, 0, 0], [1, 0.72, 1.1]);
      fb.add(rbox(0.116, 0.028, 0.29, 0.012), m.sole, [0, -0.066, 0.045]);
      fb.add(rbox(0.11, 0.02, 0.08, 0.008), m.sole, [0, -0.046, -0.055]);
      fb.add(rbox(0.035, 0.12, 0.012, 0.005), m.sole, [0, 0.03, 0.058], [-0.15, 0, 0]);
    }

    for (const [parent, b] of batches) this.geometries.push(...b.build(parent));
    for (const g of temp) g.dispose();
  }

  /**
   * The technician: same joints and limb lengths as the soldier, different
   * clothes and silhouette (headphones or beanie, badge, cable coil, bag).
   */
  private buildTechnician(m: TechMaterials, palette: TechnicianPalette): void {
    const box = (w: number, h: number, d: number, r: number) =>
      this.geometry(new RoundedBoxGeometry(w, h, d, 2, r));
    const capsule = (r: number, len: number) =>
      this.geometry(new THREE.CapsuleGeometry(r, len, 4, 10));
    const staff = palette === "staff";

    // Pelvis: loose trousers and an untucked overshirt hem.
    this.part(this.pelvis, box(0.35, 0.18, 0.22, 0.07), m.trousers, 0, 0, 0);
    this.part(this.pelvis, box(0.4, 0.12, 0.26, 0.05), m.shirt, 0, 0.1, 0.005);

    // Torso: hoodie under an open overshirt, hood bunched behind the neck.
    this.spine.position.y = 0.08;
    this.pelvis.add(this.spine);
    this.part(this.spine, box(0.36, 0.47, 0.22, 0.09), m.hoodie, 0, 0.25, 0);
    this.part(this.spine, box(0.12, 0.44, 0.235, 0.05), m.shirt, 0.135, 0.25, 0.002);
    this.part(this.spine, box(0.12, 0.44, 0.235, 0.05), m.shirt, -0.135, 0.25, 0.002);
    this.part(this.spine, box(0.36, 0.3, 0.1, 0.05), m.shirt, 0, 0.3, -0.08);
    const hood = this.part(
      this.spine,
      this.geometry(new THREE.TorusGeometry(0.1, 0.045, 8, 16)),
      m.hoodie,
      0,
      0.5,
      -0.07,
    );
    hood.rotation.x = Math.PI / 2.3;

    // Lanyard and badge.
    const strap = this.geometry(new THREE.BoxGeometry(0.018, 0.2, 0.01));
    for (const x of [-0.045, 0.045]) {
      const s = this.part(this.spine, strap, m.lanyard, x, 0.38, 0.118);
      s.rotation.z = x > 0 ? 0.22 : -0.22;
    }
    this.part(
      this.spine,
      this.geometry(new THREE.BoxGeometry(0.07, 0.1, 0.008)),
      m.badge,
      0,
      0.24,
      0.124,
    );

    // Cable coil over the left shoulder and a canvas bag on the right hip.
    if (!staff) {
      const coil = this.part(
        this.spine,
        this.geometry(new THREE.TorusGeometry(0.2, 0.014, 6, 28)),
        m.cable,
        0.02,
        0.3,
        0,
      );
      coil.rotation.set(0.1, Math.PI / 2, 0.55);
      this.part(this.pelvis, box(0.08, 0.22, 0.2, 0.03), m.bag, -0.22, -0.05, -0.02);
      const strapBag = this.part(
        this.spine,
        this.geometry(new THREE.BoxGeometry(0.03, 0.66, 0.012)),
        m.bag,
        0.02,
        0.2,
        0.12,
      );
      strapBag.rotation.z = 0.62;
    }

    // Neck, head, hair and headphones (or a beanie for the staff palette).
    const neck = new THREE.Group();
    neck.position.y = 0.52;
    this.spine.add(neck);
    this.part(
      neck,
      this.geometry(new THREE.CylinderGeometry(0.05, 0.056, 0.11, 10)),
      m.skin,
      0,
      0.03,
      0,
    );
    this.head.position.y = 0.09;
    neck.add(this.head);
    const skull = this.part(
      this.head,
      this.geometry(new THREE.SphereGeometry(0.105, 16, 12)),
      m.skin,
      0,
      0.075,
      0.012,
    );
    skull.scale.set(0.92, 1.08, 1);
    if (staff) {
      this.part(
        this.head,
        this.geometry(new THREE.SphereGeometry(0.118, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55)),
        m.beanie,
        0,
        0.1,
        -0.004,
      );
      this.part(
        this.head,
        this.geometry(new THREE.CylinderGeometry(0.12, 0.12, 0.04, 16)),
        m.beanie,
        0,
        0.1,
        -0.004,
      );
    } else {
      const hair = this.part(
        this.head,
        this.geometry(new THREE.SphereGeometry(0.114, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5)),
        m.hair,
        0,
        0.095,
        -0.012,
      );
      hair.scale.set(1.02, 1.12, 1.05);
      // Over-ear headphones: a band over the crown and two cups.
      const band = this.part(
        this.head,
        this.geometry(new THREE.TorusGeometry(0.128, 0.013, 6, 18, Math.PI)),
        m.phones,
        0,
        0.095,
        0,
      );
      band.rotation.y = Math.PI / 2;
      const cupGeometry = this.geometry(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 14));
      const ringGeometry = this.geometry(new THREE.TorusGeometry(0.05, 0.007, 6, 14));
      for (const side of [1, -1]) {
        const earCup = this.part(this.head, cupGeometry, m.phones, side * 0.118, 0.07, 0.005);
        earCup.rotation.z = Math.PI / 2;
        const ring = this.part(this.head, ringGeometry, m.accent, side * 0.14, 0.07, 0.005);
        ring.rotation.y = Math.PI / 2;
      }
    }

    // Arms: rolled overshirt sleeves, hoodie cuffs, bare hands.
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? 1 : -1;
      const shoulder = this.shoulders[side];
      shoulder.position.set(0.205 * sign, 0.44, 0);
      this.spine.add(shoulder);
      this.part(shoulder, capsule(0.058, 0.19), m.shirt, 0, -0.13, 0);
      const elbow = this.elbows[side];
      elbow.position.y = -0.285;
      shoulder.add(elbow);
      this.part(elbow, capsule(0.046, 0.15), m.hoodie, 0, -0.11, 0);
      const hand = this.part(
        elbow,
        this.geometry(new THREE.SphereGeometry(0.046, 10, 8)),
        m.skin,
        0,
        -0.262,
        0.005,
      );
      hand.scale.set(0.85, 1.15, 0.7);
    }

    // Legs: relaxed trousers and trainers.
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? 1 : -1;
      const hip = this.hips[side];
      hip.position.set(0.1 * sign, -0.03, 0);
      this.pelvis.add(hip);
      this.part(hip, capsule(0.078, 0.27), m.trousers, 0, -0.2, 0);
      const knee = this.knees[side];
      knee.position.y = -0.43;
      hip.add(knee);
      this.part(knee, capsule(0.066, 0.28), m.trousers, 0, -0.2, 0);
      const ankle = this.ankles[side];
      ankle.position.y = -0.44;
      knee.add(ankle);
      this.part(ankle, box(0.105, 0.09, 0.26, 0.04), m.shoes, 0, -0.02, 0.045);
      this.part(ankle, box(0.11, 0.03, 0.27, 0.012), m.sole, 0, -0.065, 0.045);
    }
  }

  /** Coffee cup held in the right hand (hidden until carried). */
  private buildCup(): void {
    const paper = new THREE.MeshStandardMaterial({ color: "#efe7d6", roughness: 0.8 });
    const lid = new THREE.MeshStandardMaterial({ color: "#3b2a20", roughness: 0.6 });
    this.materials.push(paper, lid);
    const body = new THREE.Mesh(
      this.geometry(new THREE.CylinderGeometry(0.042, 0.032, 0.11, 12)),
      paper,
    );
    const top = new THREE.Mesh(
      this.geometry(new THREE.CylinderGeometry(0.045, 0.045, 0.018, 12)),
      lid,
    );
    top.position.y = 0.062;
    body.castShadow = true;
    this.cup.add(body, top);
    this.cup.position.set(0, -0.3, 0.07);
    this.cup.visible = false;
    this.elbows[1].add(this.cup);
  }

  setCarrying(carrying: boolean): void {
    this.cup.visible = carrying;
  }

  /**
   * A small dark sidearm in the right hand (Free Roam). The barrel runs down
   * the forearm, so with the arm raised it points where the arm points, and
   * hanging at the side it points at the ground, as a lowered pistol does.
   */
  private buildSidearm(): void {
    const metal = new THREE.MeshStandardMaterial({
      color: "#20242a",
      roughness: 0.4,
      metalness: 0.55,
    });
    const grip = new THREE.MeshStandardMaterial({ color: "#3a2f28", roughness: 0.8 });
    this.materials.push(metal, grip);
    const slide = new THREE.Mesh(this.geometry(new THREE.BoxGeometry(0.034, 0.2, 0.044)), metal);
    slide.position.set(0, -0.09, 0.016);
    const handle = new THREE.Mesh(this.geometry(new THREE.BoxGeometry(0.032, 0.05, 0.078)), grip);
    handle.position.set(0, 0.0, -0.012);
    handle.rotation.x = -0.18;
    slide.castShadow = handle.castShadow = true;
    this.sidearm.add(slide, handle);
    this.sidearm.position.set(0, -0.3, 0.05);
    this.sidearm.visible = false;
    this.elbows[1].add(this.sidearm);
  }

  setSidearm(drawn: boolean): void {
    this.sidearm.visible = drawn;
  }

  applyPose(pose: CharacterPose): void {
    this.body.rotation.z = pose.bank;
    this.pelvis.position.y = PELVIS_HEIGHT + pose.hipsY;
    this.pelvis.rotation.set(0, pose.pelvisYaw, pose.pelvisRoll);
    this.spine.rotation.set(pose.spinePitch, pose.spineYaw, 0);
    this.head.rotation.x = pose.headPitch;
    // Limbs hang along -Y: a negative X rotation swings them forward.
    this.hips[0].rotation.set(-pose.lHip, 0, pose.lHipOut);
    this.hips[1].rotation.set(-pose.rHip, 0, pose.rHipOut);
    this.knees[0].rotation.x = pose.lKnee;
    this.knees[1].rotation.x = pose.rKnee;
    this.ankles[0].rotation.x = pose.lAnkle;
    this.ankles[1].rotation.x = pose.rAnkle;
    this.shoulders[0].rotation.set(-pose.lArm, 0, pose.lArmOut);
    this.shoulders[1].rotation.set(-pose.rArm, 0, pose.rArmOut);
    this.elbows[0].rotation.x = -pose.lElbow;
    this.elbows[1].rotation.x = -pose.rElbow;
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const mat of this.materials) {
      mat.map?.dispose();
      mat.normalMap?.dispose();
      mat.roughnessMap?.dispose();
      mat.dispose();
    }
    this.root.removeFromParent();
  }
}

/** Height of the pelvis joint above the feet; seat anchors target this. */
export const CHARACTER_PELVIS_HEIGHT = PELVIS_HEIGHT;
