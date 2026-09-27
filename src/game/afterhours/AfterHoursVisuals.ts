import * as THREE from "three";
import { CharacterAnimator } from "../player/CharacterAnimator";
import { CharacterVisual } from "../player/CharacterVisual";
import { domes, RADOME, RADOME_SHELL_SIN } from "@/lib/site-layout";
import { BEAT_SECONDS } from "./composition";
import type { ConcertMix } from "./concert";
import type { MissionState } from "./coffee";
import type { LayerId } from "./progress";
import {
  COFFEE_CART,
  DELIVERY,
  LISTENING_POINT,
  RECORD_ZERO,
  TERMINAL_SITES,
  type Site,
} from "./sites";

/**
 * Scene objects for After Hours. Everything here is fictional dressing,
 * drawn with unlit (mostly additive) materials and no lights, colliders or
 * shadows beyond the two small props, so the cost is a bounded number of
 * draw calls and nothing touches the reconstruction's geometry.
 */

export interface VisualState {
  active: boolean;
  time: number;
  reducedMotion: boolean;
  /** Altered Signal strength 0..1. */
  altered: number;
  missionState: MissionState;
  terminalsRevealed: boolean;
  locked: Record<LayerId, boolean>;
  sessionLayer: LayerId | null;
  sessionAlignment: number;
  listeningVisible: boolean;
  recordZeroVisible: boolean;
  concertRunning: boolean;
  concertBar: number;
  concertMix: ConcertMix | null;
  waypoint: Site | null;
  playerX: number;
  playerZ: number;
  night: boolean;
}

export type VisualQuality = "low" | "medium" | "high" | "ultra";

const TEAL = new THREE.Color("#3fd0c9");
const DEEP_TEAL = new THREE.Color("#0b5d63");
const VIOLET = new THREE.Color("#8f6bd8");
const AMBER = new THREE.Color("#f5b851");
const LAYER_COLOR: Record<LayerId, THREE.Color> = {
  rhythm: new THREE.Color("#f5b851"),
  bass: new THREE.Color("#3fd0c9"),
  harmony: new THREE.Color("#a58be8"),
  melody: new THREE.Color("#f28f6b"),
};
const TRACE_POINTS = 36;
const TRACE_LENGTH = 70;
const STAR_ARCS = { low: 0, medium: 160, high: 260, ultra: 320 } as const;
const ACCENT_DOMES = ["68-A", "85-A", "99-C", "10-A"];

function additive(color: THREE.Color, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });
}

function labelTexture(title: string, subtitle: string): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#06282b";
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = "#3fd0c9";
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, 248, 120);
  ctx.fillStyle = "#e8fbf9";
  ctx.font = "bold 34px monospace";
  ctx.textAlign = "center";
  ctx.fillText(title, 128, 58);
  ctx.fillStyle = "#f5b851";
  ctx.font = "15px monospace";
  ctx.fillText(subtitle, 128, 92);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Soft round sprite so trace points read as glows, not squares. */
function glowSprite(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (!g) return null;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

interface TerminalVisual {
  layer: LayerId;
  group: THREE.Group;
  screen: THREE.MeshBasicMaterial;
  beam: THREE.Mesh;
  beamMaterial: THREE.MeshBasicMaterial;
  ring: THREE.MeshBasicMaterial;
  x: number;
  z: number;
  y: number;
}

export class AfterHoursVisuals {
  readonly root = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly cart = new THREE.Group();
  private readonly cartCup: THREE.Object3D;
  private readonly npc: CharacterVisual;
  private readonly npcAnimator = new CharacterAnimator();
  private readonly terminals: TerminalVisual[] = [];
  private readonly listening = new THREE.Group();
  private readonly recordZero = new THREE.Group();
  private readonly recordScreen: THREE.MeshStandardMaterial;
  private readonly listeningMaterial: THREE.MeshBasicMaterial;
  private readonly waypoint = new THREE.Group();
  private readonly waypointMaterial: THREE.MeshBasicMaterial;
  private readonly traces: THREE.Points;
  private readonly traceMaterial: THREE.PointsMaterial;
  private readonly tracePositions: Float32Array;
  private readonly traceColors: Float32Array;
  private readonly stars: THREE.LineSegments;
  private readonly starMaterial: THREE.LineBasicMaterial;
  private readonly accents: THREE.Mesh[] = [];
  private readonly accentMaterial: THREE.MeshBasicMaterial;
  private readonly sky: THREE.Mesh;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private quality: VisualQuality = "high";
  private traceTimer = 0;

  constructor(private readonly heightAt: (x: number, z: number) => number) {
    this.root.name = "after-hours";
    this.root.visible = false;

    // --- Coffee cart -----------------------------------------------------------------
    const cart = this.cart;
    cart.position.set(COFFEE_CART.x, heightAt(COFFEE_CART.x, COFFEE_CART.z), COFFEE_CART.z);
    cart.rotation.y = COFFEE_CART.yaw;
    const steel = this.mat(
      new THREE.MeshStandardMaterial({ color: "#9aa3a8", roughness: 0.45, metalness: 0.6 }),
    );
    const panel = this.mat(new THREE.MeshStandardMaterial({ color: "#0b5d63", roughness: 0.7 }));
    const canvas = this.mat(
      new THREE.MeshStandardMaterial({ color: "#d9cdb2", roughness: 0.9, side: THREE.DoubleSide }),
    );
    const lamp = this.mat(
      new THREE.MeshStandardMaterial({
        color: "#ffd9a0",
        emissive: "#ffb65c",
        emissiveIntensity: 2.2,
      }),
    );
    const body = new THREE.Mesh(this.geo(new THREE.BoxGeometry(1.4, 0.9, 0.7)), panel);
    body.position.y = 0.65;
    const top = new THREE.Mesh(this.geo(new THREE.BoxGeometry(1.5, 0.05, 0.8)), steel);
    top.position.y = 1.12;
    const canopy = new THREE.Mesh(this.geo(new THREE.BoxGeometry(1.7, 0.04, 1.0)), canvas);
    canopy.position.y = 2.05;
    for (const x of [-0.7, 0.7]) {
      const pole = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.02, 0.02, 0.95, 6)), steel);
      pole.position.set(x, 1.58, -0.35);
      cart.add(pole);
    }
    const bulb = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.07, 10, 8)), lamp);
    bulb.position.set(0, 1.95, 0);
    for (const x of [-0.5, 0.5]) {
      const wheel = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.18, 0.18, 0.08, 14)),
        steel,
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.18, 0.36);
      cart.add(wheel);
    }
    const urn = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.16, 0.18, 0.42, 14)), steel);
    urn.position.set(-0.4, 1.35, 0);
    const cup = new THREE.Group();
    const paper = this.mat(new THREE.MeshStandardMaterial({ color: "#efe7d6", roughness: 0.8 }));
    const lid = this.mat(new THREE.MeshStandardMaterial({ color: "#3b2a20" }));
    const cupBody = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.042, 0.032, 0.11, 12)),
      paper,
    );
    const cupLid = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.045, 0.045, 0.018, 12)),
      lid,
    );
    cupLid.position.y = 0.062;
    cup.add(cupBody, cupLid);
    cup.position.set(0.25, 1.2, 0.1);
    this.cartCup = cup;
    for (const m of [body, top, canopy, urn]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    cart.add(body, top, canopy, bulb, urn, cup);
    this.root.add(cart);

    // A small unlisted work station; the chair is present throughout the shift.
    const archive = this.recordZero;
    archive.position.set(RECORD_ZERO.x, heightAt(RECORD_ZERO.x, RECORD_ZERO.z), RECORD_ZERO.z);
    archive.rotation.y = RECORD_ZERO.yaw;
    const timber = this.mat(new THREE.MeshStandardMaterial({ color: "#343634", roughness: 0.92 }));
    const frame = this.mat(new THREE.MeshStandardMaterial({ color: "#242d2e", roughness: 0.75 }));
    const wall = this.mat(
      new THREE.MeshStandardMaterial({ color: "#575c55", roughness: 1, side: THREE.DoubleSide }),
    );
    const part = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      material: THREE.Material,
    ) => {
      const mesh = new THREE.Mesh(this.geo(new THREE.BoxGeometry(w, h, d)), material);
      mesh.position.set(x, y, z);
      archive.add(mesh);
    };
    // Open doorway toward the path. No colliders or invisible walls are added.
    part(5, 0.12, 4, 0, 0.04, 0, wall);
    part(5, 2.6, 0.14, 0, 1.3, -2, wall);
    part(0.14, 2.6, 4, -2.5, 1.3, 0, wall);
    part(0.14, 2.6, 4, 2.5, 1.3, 0, wall);
    part(5, 0.14, 4, 0, 2.68, 0, frame);
    part(2.2, 0.12, 0.85, 0, 0.9, -1.35, timber);
    for (const x of [-0.95, 0.95]) part(0.1, 0.85, 0.1, x, 0.46, -1.5, frame);
    part(0.55, 0.1, 0.52, 0, 0.48, 0.2, frame);
    part(0.55, 0.62, 0.1, 0, 0.78, 0.46, frame);
    part(0.07, 0.42, 0.07, 0, 0.24, 0.2, frame);
    part(0.48, 0.06, 0.48, 0, 0.06, 0.2, frame);
    part(0.52, 0.4, 0.12, 0, 1.22, -1.6, frame);
    this.recordScreen = this.mat(
      new THREE.MeshStandardMaterial({
        color: "#081719",
        emissive: "#68b4ab",
        emissiveIntensity: 0,
      }),
    );
    part(0.43, 0.3, 0.01, 0, 1.22, -1.53, this.recordScreen);
    this.root.add(archive);

    // --- Night-shift technician waiting at the north antenna hut -------------------------
    this.npc = new CharacterVisual({ variant: "technician", palette: "staff" });
    this.npc.root.name = "after-hours-technician";
    this.npc.root.position.set(DELIVERY.x, heightAt(DELIVERY.x, DELIVERY.z), DELIVERY.z);
    this.npc.root.rotation.y = DELIVERY.yaw;
    this.root.add(this.npc.root);

    // --- Tuning terminals ------------------------------------------------------------------
    const leg = this.geo(new THREE.CylinderGeometry(0.015, 0.02, 1.15, 5));
    const caseGeo = this.geo(new THREE.BoxGeometry(0.56, 0.38, 0.12));
    const screenGeo = this.geo(new THREE.PlaneGeometry(0.48, 0.3));
    const mast = this.geo(new THREE.CylinderGeometry(0.008, 0.008, 0.9, 4));
    const beamGeo = this.geo(new THREE.CylinderGeometry(0.35, 0.35, 60, 10, 1, true));
    const ringGeo = this.geo(new THREE.RingGeometry(1.1, 1.3, 40));
    const dark = this.mat(
      new THREE.MeshStandardMaterial({ color: "#1d2326", roughness: 0.6, metalness: 0.3 }),
    );
    for (const site of TERMINAL_SITES) {
      const g = new THREE.Group();
      const y = heightAt(site.x, site.z);
      g.position.set(site.x, y, site.z);
      g.rotation.y = site.yaw;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const l = new THREE.Mesh(leg, dark);
        l.position.set(Math.sin(a) * 0.22, 0.55, Math.cos(a) * 0.22);
        l.rotation.set(Math.cos(a) * 0.2, 0, -Math.sin(a) * 0.2);
        g.add(l);
      }
      const box = new THREE.Mesh(caseGeo, dark);
      box.position.y = 1.2;
      box.rotation.x = -0.35;
      box.castShadow = true;
      const tex = labelTexture(site.layer.toUpperCase(), `TERMINAL · ${site.antenna}`);
      if (tex) this.textures.push(tex);
      const screen = this.mat(
        new THREE.MeshBasicMaterial({ color: "#ffffff", map: tex, fog: false }),
      );
      const face = new THREE.Mesh(screenGeo, screen);
      face.position.set(0, 1.2 + Math.sin(0.35) * 0.062, Math.cos(0.35) * 0.062);
      face.rotation.x = -0.35;
      const antenna = new THREE.Mesh(mast, dark);
      antenna.position.set(0.22, 1.8, -0.02);
      const beamMaterial = this.mat(additive(LAYER_COLOR[site.layer], 0));
      const beam = new THREE.Mesh(beamGeo, beamMaterial);
      beam.position.y = 30;
      beam.visible = false;
      const ring = this.mat(additive(LAYER_COLOR[site.layer], 0.5));
      const ground = new THREE.Mesh(ringGeo, ring);
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = 0.06;
      g.add(box, face, antenna, beam, ground);
      g.visible = false;
      this.root.add(g);
      this.terminals.push({
        layer: site.layer,
        group: g,
        screen,
        beam,
        beamMaterial,
        ring,
        x: site.x,
        z: site.z,
        y,
      });
    }

    // --- Listening point ---------------------------------------------------------------------
    const lp = LISTENING_POINT;
    this.listening.position.set(lp.x, heightAt(lp.x, lp.z), lp.z);
    this.listeningMaterial = this.mat(additive(AMBER, 0.6));
    const lpRing = new THREE.Mesh(
      this.geo(new THREE.RingGeometry(2.6, 2.9, 56)),
      this.listeningMaterial,
    );
    lpRing.rotation.x = -Math.PI / 2;
    lpRing.position.y = 0.06;
    const lpPost = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 8)), dark);
    lpPost.position.y = 0.65;
    const lpLamp = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.09, 10, 8)),
      this.listeningMaterial,
    );
    lpLamp.position.y = 1.36;
    this.listening.add(lpRing, lpPost, lpLamp);
    this.listening.visible = false;
    this.root.add(this.listening);

    // --- Waypoint beacon ----------------------------------------------------------------------
    this.waypointMaterial = this.mat(additive(AMBER, 0.22));
    const column = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.5, 0.5, 40, 12, 1, true)),
      this.waypointMaterial,
    );
    column.position.y = 20;
    const base = new THREE.Mesh(
      this.geo(new THREE.RingGeometry(1.6, 1.9, 40)),
      this.waypointMaterial,
    );
    base.rotation.x = -Math.PI / 2;
    base.position.y = 0.07;
    this.waypoint.add(column, base);
    this.waypoint.visible = false;
    this.root.add(this.waypoint);

    // --- Signal traces (Altered Signal) ----------------------------------------------------------
    const count = TRACE_POINTS * TERMINAL_SITES.length;
    this.tracePositions = new Float32Array(count * 3);
    this.traceColors = new Float32Array(count * 3);
    const traceGeo = this.geo(new THREE.BufferGeometry());
    traceGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(this.tracePositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    traceGeo.setAttribute("color", new THREE.BufferAttribute(this.traceColors, 3));
    traceGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.traceMaterial = this.mat(
      new THREE.PointsMaterial({
        size: 0.7,
        map: glowSprite(),
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    ) as THREE.PointsMaterial;
    if (this.traceMaterial.map) this.textures.push(this.traceMaterial.map);
    this.traces = new THREE.Points(traceGeo, this.traceMaterial);
    this.traces.frustumCulled = false;
    this.traces.visible = false;
    this.root.add(this.traces);
    let k = 0;
    for (const site of TERMINAL_SITES) {
      const c = LAYER_COLOR[site.layer];
      for (let i = 0; i < TRACE_POINTS; i++, k += 3) {
        this.traceColors[k] = c.r;
        this.traceColors[k + 1] = c.g;
        this.traceColors[k + 2] = c.b;
      }
    }

    // --- Star arcs (a lightweight star-trail equivalent) -------------------------------------------
    const arcs = STAR_ARCS.ultra;
    const segs = 5;
    const starPositions = new Float32Array(arcs * segs * 2 * 3);
    let seed = 20931;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let s = 0;
    for (let i = 0; i < arcs; i++) {
      // Around the south celestial pole (−Z is grid north; the pole sits low in the south).
      const r = 400 + rand() * 1900;
      const a0 = rand() * Math.PI * 2;
      const span = 0.03 + rand() * 0.06;
      for (let j = 0; j < segs; j++) {
        for (const t of [j, j + 1]) {
          const a = a0 + (span * t) / segs;
          starPositions[s++] = Math.cos(a) * r;
          starPositions[s++] = Math.sin(a) * r;
          starPositions[s++] = 0;
        }
      }
    }
    const starGeo = this.geo(new THREE.BufferGeometry());
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    this.starMaterial = this.mat(
      new THREE.LineBasicMaterial({
        color: "#dfe8ff",
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    ) as THREE.LineBasicMaterial;
    this.stars = new THREE.LineSegments(starGeo, this.starMaterial);
    this.stars.frustumCulled = false;
    // Centre the disc on the south celestial pole (~24° above the southern
    // horizon at this latitude; +Z is south) with its axis pointing at it.
    const pole = (23.8 * Math.PI) / 180;
    this.stars.position.set(0, Math.sin(pole) * 3000, Math.cos(pole) * 3000);
    this.stars.rotation.x = -pole;
    this.stars.visible = false;
    this.root.add(this.stars);

    // --- Concert accents: rings at four radome bases and a sky band ------------------------------------
    this.accentMaterial = this.mat(additive(TEAL, 0));
    for (const id of ACCENT_DOMES) {
      const d = domes.find((x) => x.sourceId === id);
      if (!d) continue;
      const r = d.radius * RADOME_SHELL_SIN + 0.8;
      const ring = new THREE.Mesh(
        this.geo(new THREE.TorusGeometry(r, 0.12, 6, 64)),
        this.accentMaterial,
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(
        d.pos[0],
        heightAt(d.pos[0], d.pos[1]) + RADOME.plinthHeight + 0.3,
        d.pos[1],
      );
      ring.visible = false;
      this.accents.push(ring);
      this.root.add(ring);
    }
    this.skyMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uTeal: { value: TEAL.clone() },
        uViolet: { value: VIOLET.clone() },
        uAmber: { value: AMBER.clone() },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uIntensity;
        uniform vec3 uTeal;
        uniform vec3 uViolet;
        uniform vec3 uAmber;
        varying vec2 vUv;
        void main() {
          float h = vUv.y;
          float band = smoothstep(0.0, 0.35, h) * (1.0 - smoothstep(0.55, 1.0, h));
          float wave = 0.5 + 0.5 * sin(vUv.x * 18.0 + uTime * 0.25 + sin(vUv.x * 5.0 - uTime * 0.1) * 2.0);
          vec3 col = mix(uTeal, uViolet, wave);
          col = mix(col, uAmber, smoothstep(0.7, 1.0, wave) * 0.35);
          gl_FragColor = vec4(col * band * (0.35 + 0.65 * wave) * uIntensity * 0.22, 1.0);
        }`,
    });
    this.materials.push(this.skyMaterial);
    this.sky = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(1600, 1600, 520, 48, 1, true)),
      this.skyMaterial,
    );
    this.sky.position.set(LISTENING_POINT.x, 330, LISTENING_POINT.z);
    this.sky.visible = false;
    this.sky.frustumCulled = false;
    this.root.add(this.sky);
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  setQuality(quality: VisualQuality): void {
    this.quality = quality;
    const arcs = STAR_ARCS[quality];
    this.stars.geometry.setDrawRange(0, arcs * 5 * 2);
  }

  update(dt: number, s: VisualState): void {
    this.root.visible = s.active;
    if (!s.active) return;
    this.recordScreen.emissiveIntensity = s.recordZeroVisible ? 0.24 : 0;
    const t = s.time;
    const breathe = s.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.9);

    // Props.
    this.cartCup.visible = s.missionState !== "active";
    this.npc.setCarrying(s.missionState === "completed");
    const npcNear = Math.hypot(DELIVERY.x - s.playerX, DELIVERY.z - s.playerZ) < 160;
    if (npcNear) {
      const pose = this.npcAnimator.update(dt, {
        speed: 0,
        grounded: true,
        airTime: 0,
        verticalVelocity: 0,
        turnRate: 0,
        seatWeight: 0,
        steer: 0,
        carry: s.missionState === "completed" ? 1 : 0,
        style: "technician",
      });
      this.npc.applyPose(pose);
    }

    // Terminals.
    const concert = s.concertRunning ? s.concertMix : null;
    const beatPhase = s.reducedMotion ? 0 : (((s.concertBar * 4) % 1) + 1) % 1;
    const beatPulse = Math.exp(-beatPhase * 5);
    for (const tv of this.terminals) {
      tv.group.visible = s.terminalsRevealed;
      if (!s.terminalsRevealed) continue;
      const locked = s.locked[tv.layer];
      const tuning = s.sessionLayer === tv.layer;
      tv.screen.color
        .copy(locked ? AMBER : TEAL)
        .lerp(DEEP_TEAL, locked ? 0 : 0.25 * (1 - breathe));
      tv.ring.opacity = tuning
        ? 0.35 + 0.5 * s.sessionAlignment
        : locked
          ? 0.55
          : 0.25 + 0.2 * breathe;
      let beam = 0;
      if (concert) {
        const level = concert[tv.layer];
        beam = concert.beams * (0.35 + 0.65 * level) * (0.6 + 0.4 * beatPulse);
      } else if (s.altered > 0 && !locked) {
        beam = s.altered * (0.25 + 0.15 * breathe);
      } else if (locked && s.altered > 0) {
        beam = s.altered * 0.12;
      }
      tv.beam.visible = beam > 0.01;
      tv.beamMaterial.opacity = Math.min(0.85, beam);
    }

    // Listening point and waypoint.
    this.listening.visible = s.listeningVisible;
    this.listeningMaterial.opacity = s.concertRunning
      ? 0.5 + 0.4 * beatPulse
      : 0.35 + 0.35 * breathe;
    const w = s.waypoint;
    this.waypoint.visible = w !== null && !s.concertRunning;
    if (w) {
      this.waypoint.position.set(w.x, this.heightAt(w.x, w.z), w.z);
      this.waypointMaterial.opacity = 0.14 + 0.1 * breathe;
    }

    // Altered Signal: traces from the player towards each untuned terminal.
    const showTraces = s.altered > 0.02 && s.terminalsRevealed && !s.concertRunning;
    this.traces.visible = showTraces;
    this.traceMaterial.opacity = Math.min(1, s.altered * 1.2);
    this.traceTimer -= dt;
    if (showTraces && this.traceTimer <= 0) {
      this.traceTimer = 1 / 20;
      this.writeTraces(s);
    }
    const starsOn = s.altered > 0.02 && s.night && this.quality !== "low";
    this.stars.visible = starsOn;
    this.starMaterial.opacity = s.altered * 0.55;
    if (starsOn && !s.reducedMotion) this.stars.rotation.z += dt * 0.004;

    // Concert accents driven by the musical timeline.
    const accent = concert ? concert.bass * (0.3 + 0.7 * beatPulse) : 0;
    for (const ring of this.accents) ring.visible = accent > 0.01;
    this.accentMaterial.opacity = Math.min(0.9, accent);
    const sky = concert ? concert.sky : 0;
    this.sky.visible = sky > 0.01;
    this.skyMaterial.uniforms.uIntensity.value = sky;
    this.skyMaterial.uniforms.uTime.value = s.reducedMotion ? 0 : s.concertBar * 4 * BEAT_SECONDS;
  }

  private writeTraces(s: VisualState): void {
    const pos = this.tracePositions;
    const flow = s.reducedMotion ? 0 : (s.time * 0.6) % 1;
    let k = 0;
    for (const tv of this.terminals) {
      const dx = tv.x - s.playerX;
      const dz = tv.z - s.playerZ;
      const d = Math.hypot(dx, dz);
      const hide = s.locked[tv.layer] || d < 3;
      const len = Math.min(TRACE_LENGTH, d - 2);
      for (let i = 0; i < TRACE_POINTS; i++, k += 3) {
        if (hide) {
          pos[k] = pos[k + 1] = pos[k + 2] = 0;
          pos[k + 1] = -1000;
          continue;
        }
        const u = (i + flow) / TRACE_POINTS;
        const along = 2 + u * len;
        const x = s.playerX + (dx / d) * along;
        const z = s.playerZ + (dz / d) * along;
        pos[k] = x;
        pos[k + 1] = this.heightAt(x, z) + 0.35 + Math.sin(u * Math.PI) * 0.6;
        pos[k + 2] = z;
      }
    }
    (this.traces.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.npc.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.root.removeFromParent();
  }
}
