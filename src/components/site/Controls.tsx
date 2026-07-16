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

  useEffect(() => {
    camera.position.set(-6, terrainHeight(-6, 78) + EYE, 78);
    camera.lookAt(30, EYE, 40); // face the tank farm
  }, [camera]);

  useFrame((_, delta) => {
    const speed = (keys.current["ShiftLeft"] ? 20 : 8) * Math.min(delta, 0.05);
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

    if (dir.lengthSq() > 0) {
      dir.normalize().multiplyScalar(speed);
      const nx = camera.position.x + dir.x;
      const nz = camera.position.z + dir.z;
      const [rx, rz] = resolveCollision(nx, nz, BODY);
      camera.position.x = rx;
      camera.position.z = rz;
    }
    camera.position.y = terrainHeight(camera.position.x, camera.position.z) + EYE;
  });

  return <PointerLockControls />;
}

function FlyMover({ focus }: { focus?: FocusRequest | null }) {
  const { camera } = useThree();
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;
  const keys = useKeys();
  const anim = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);

  useEffect(() => {
    camera.position.set(-40, 150, 220);
    camera.lookAt(0, 0, 20);
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
        focus.z + dir.z * dist
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

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const speed = (keys.current["ShiftLeft"] ? 90 : 35) * dt;
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

    if (keys.current["KeyW"]) camera.position.addScaledVector(forward, speed);
    if (keys.current["KeyS"]) camera.position.addScaledVector(forward, -speed);
    if (keys.current["KeyD"]) camera.position.addScaledVector(right, speed);
    if (keys.current["KeyA"]) camera.position.addScaledVector(right, -speed);
    if (keys.current["KeyE"] || keys.current["Space"]) camera.position.y += speed;
    if (keys.current["KeyQ"]) camera.position.y -= speed;
    camera.position.y = Math.max(3, camera.position.y);

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
  0.5
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
  0.5
);

function CinematicMover() {
  const { camera } = useThree();
  const t = useRef(0);
  const tmpPos = useRef(new THREE.Vector3());
  const tmpLook = useRef(new THREE.Vector3());

  useFrame((_, delta) => {
    t.current = (t.current + delta * 0.012) % 1;
    CINE_PATH.getPointAt(t.current, tmpPos.current);
    CINE_LOOK.getPointAt(t.current, tmpLook.current);
    camera.position.lerp(tmpPos.current, 0.06);
    camera.lookAt(tmpLook.current);
  });

  return null;
}

export function Controls({ mode, focus }: { mode: ControlMode; focus?: FocusRequest | null }) {
  if (mode === "fly") return <FlyMover focus={focus} />;
  if (mode === "fps") return <FpsMover />;
  return <CinematicMover />;
}
