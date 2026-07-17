import { useRef, useEffect } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import { MapControls, PointerLockControls } from "@react-three/drei";
import * as THREE from "three";
import { resolveCollision } from "@/lib/site-colliders";
import { terrainHeight } from "@/lib/terrain";

export type ControlMode = "fly" | "fps" | "cinematic";

// A one-shot request to glide the fly camera to a structure. `ts` makes each
// request unique so clicking the same structure twice re-triggers the flight.
export type FocusRequest = { x: number; z: number; r: number; ts: number };

// The subset of MapControls the focus animation needs (drei registers the
// instance on R3F state via makeDefault).
type OrbitLike = {
  target: THREE.Vector3;
  update: () => void;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
};

function useKeys() {
  const keys = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);
  return keys;
}

const EYE = 1.7;
const BODY = 0.6;

function FpsMover() {
  const { camera } = useThree();
  const keys = useKeys();
  const vel = useRef(new THREE.Vector3());

  useEffect(() => {
    camera.position.set(-6, terrainHeight(-6, 78) + EYE, 78);
    camera.lookAt(30, EYE, 40); // face the tank farm
  }, [camera]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const max = keys.current["ShiftLeft"] ? 20 : 8;
    const dir = new THREE.Vector3();
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));

    if (keys.current["KeyW"]) dir.add(forward);
    if (keys.current["KeyS"]) dir.sub(forward);
    if (keys.current["KeyD"]) dir.add(right);
    if (keys.current["KeyA"]) dir.sub(right);
    if (dir.lengthSq() > 0) dir.normalize().multiplyScalar(max);

    // Exponential approach toward the desired velocity: quick to accelerate,
    // a touch of glide when the keys release — reads as body inertia.
    const k = dir.lengthSq() > 0 ? 10 : 7;
    vel.current.lerp(dir, 1 - Math.exp(-k * dt));

    if (vel.current.lengthSq() > 1e-6) {
      const nx = camera.position.x + vel.current.x * dt;
      const nz = camera.position.z + vel.current.z * dt;
      const [rx, rz] = resolveCollision(nx, nz, BODY);
      camera.position.x = rx;
      camera.position.z = rz;
    }
    camera.position.y = terrainHeight(camera.position.x, camera.position.z) + EYE;
  });

  return <PointerLockControls />;
}

// Home view shared by the Canvas default camera and the fly-mode reset, so
// the opening frame is identical on every load: the camera starts exactly
// here and MapControls' target matches the lookAt, leaving damping nothing
// to settle.
export const HOME_POSITION: [number, number, number] = [-40, 150, 220];
export const HOME_TARGET: [number, number, number] = [0, 0, 20];

function FlyMover({ focus }: { focus?: FocusRequest | null }) {
  const { camera } = useThree();
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;
  const keys = useKeys();
  const anim = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);

  useEffect(() => {
    camera.position.set(...HOME_POSITION);
    camera.lookAt(...HOME_TARGET);
  }, [camera]);

  // Turn a focus request into a glide destination: keep the camera's current
  // bearing to the structure, back off proportionally to its size.
  useEffect(() => {
    if (!focus) return;
    const dir = new THREE.Vector3(camera.position.x - focus.x, 0, camera.position.z - focus.z);
    if (dir.lengthSq() < 1) dir.set(0.7, 0, 0.7);
    dir.normalize();
    const dist = Math.max(38, focus.r * 6.5);
    anim.current = {
      pos: new THREE.Vector3(
        focus.x + dir.x * dist,
        Math.max(16, focus.r * 3.2),
        focus.z + dir.z * dist,
      ),
      target: new THREE.Vector3(focus.x, Math.max(4, focus.r * 1.2), focus.z),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.ts]);

  // A manual drag cancels the glide so the user is never fighting the camera.
  useEffect(() => {
    if (!controls) return;
    const cancel = () => {
      anim.current = null;
    };
    controls.addEventListener("start", cancel);
    return () => controls.removeEventListener("start", cancel);
  }, [controls]);

  const vel = useRef(new THREE.Vector3());

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const max = keys.current["ShiftLeft"] ? 90 : 35;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));

    const moving =
      keys.current["KeyW"] ||
      keys.current["KeyS"] ||
      keys.current["KeyA"] ||
      keys.current["KeyD"] ||
      keys.current["KeyQ"] ||
      keys.current["KeyE"] ||
      keys.current["Space"];
    if (moving) anim.current = null;

    // Desired velocity from input, then an exponential approach toward it —
    // the camera banks into motion and glides to a stop instead of snapping.
    const want = new THREE.Vector3();
    if (keys.current["KeyW"]) want.add(forward);
    if (keys.current["KeyS"]) want.sub(forward);
    if (keys.current["KeyD"]) want.add(right);
    if (keys.current["KeyA"]) want.sub(right);
    if (keys.current["KeyE"] || keys.current["Space"]) want.y += 1;
    if (keys.current["KeyQ"]) want.y -= 1;
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(max);

    const k = want.lengthSq() > 0 ? 8 : 5;
    vel.current.lerp(want, 1 - Math.exp(-k * dt));
    if (vel.current.lengthSq() > 1e-6) {
      camera.position.addScaledVector(vel.current, dt);
    }
    camera.position.y = Math.max(3, camera.position.y);

    // Field-of-view trim on [ / ] — tighter for a sat-lens look, wider for
    // an overview sweep.
    if (keys.current["BracketLeft"] || keys.current["BracketRight"]) {
      const persp = camera as THREE.PerspectiveCamera;
      persp.fov = THREE.MathUtils.clamp(
        persp.fov + (keys.current["BracketRight"] ? 1 : -1) * 30 * dt,
        28,
        85,
      );
      persp.updateProjectionMatrix();
    }

    if (anim.current && controls) {
      camera.position.lerp(anim.current.pos, 0.06);
      controls.target.lerp(anim.current.target, 0.08);
      controls.update();
      if (camera.position.distanceTo(anim.current.pos) < 0.8) anim.current = null;
    }
  });

  return (
    <MapControls
      makeDefault
      target={HOME_TARGET}
      enableDamping
      dampingFactor={0.1}
      maxPolarAngle={Math.PI / 2 - 0.03}
      maxDistance={900}
    />
  );
}

// Cinematic fly-through: a looping Catmull-Rom spline over the whole site.
const CINE_PATH = new THREE.CatmullRomCurve3(
  [
    [-60, 90, 230],
    [80, 70, 170],
    [150, 55, 70],
    [130, 45, -60],
    [40, 40, -110],
    [-90, 55, -120],
    [-150, 70, 0],
    [-120, 60, 120],
    [-10, 40, 90],
    [90, 45, 90],
    [60, 80, 200],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  true,
  "catmullrom",
  0.5,
);
const CINE_LOOK = new THREE.CatmullRomCurve3(
  [
    [-10, 10, 40],
    [30, 8, 40],
    [60, 6, 30],
    [30, 6, 20],
    [0, 6, 20],
    [-30, 8, 20],
    [-20, 10, 30],
    [-10, 8, 60],
    [10, 6, 60],
    [30, 6, 60],
    [10, 8, 60],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  true,
  "catmullrom",
  0.5,
);

function CinematicMover() {
  const { camera } = useThree();
  const t = useRef(0);
  const tmpPos = useRef(new THREE.Vector3());
  const tmpLook = useRef(new THREE.Vector3());

  // The automated pass slowly breathes the lens; restore the default FOV
  // when the user takes back control.
  useEffect(() => {
    const persp = camera as THREE.PerspectiveCamera;
    const prevFov = persp.fov;
    return () => {
      persp.fov = prevFov;
      persp.updateProjectionMatrix();
    };
  }, [camera]);

  useFrame(({ clock }, delta) => {
    t.current = (t.current + delta * 0.012) % 1;
    CINE_PATH.getPointAt(t.current, tmpPos.current);
    CINE_LOOK.getPointAt(t.current, tmpLook.current);
    camera.position.lerp(tmpPos.current, 0.06);
    camera.lookAt(tmpLook.current);
    const persp = camera as THREE.PerspectiveCamera;
    persp.fov = 52 + Math.sin(clock.elapsedTime * 0.12) * 5;
    persp.updateProjectionMatrix();
  });

  return null;
}

export function Controls({ mode, focus }: { mode: ControlMode; focus?: FocusRequest | null }) {
  if (mode === "fly") return <FlyMover focus={focus} />;
  if (mode === "fps") return <FpsMover />;
  return <CinematicMover />;
}
