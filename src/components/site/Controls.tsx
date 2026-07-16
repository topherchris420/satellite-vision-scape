import { useRef, useEffect } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import { MapControls, PointerLockControls } from "@react-three/drei";
import * as THREE from "three";
import { resolveCollision } from "@/lib/site-colliders";
import { terrainHeight } from "@/lib/terrain";

export type ControlMode = "fly" | "fps" | "cinematic";

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

function FlyMover() {
  const { camera } = useThree();
  const keys = useKeys();

  useEffect(() => {
    camera.position.set(-40, 150, 220);
    camera.lookAt(0, 0, 20);
  }, [camera]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const speed = (keys.current["ShiftLeft"] ? 90 : 35) * dt;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));

    if (keys.current["KeyW"]) camera.position.addScaledVector(forward, speed);
    if (keys.current["KeyS"]) camera.position.addScaledVector(forward, -speed);
    if (keys.current["KeyD"]) camera.position.addScaledVector(right, speed);
    if (keys.current["KeyA"]) camera.position.addScaledVector(right, -speed);
    if (keys.current["KeyE"] || keys.current["Space"]) camera.position.y += speed;
    if (keys.current["KeyQ"]) camera.position.y -= speed;
    camera.position.y = Math.max(3, camera.position.y);
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

export function Controls({ mode }: { mode: ControlMode }) {
  if (mode === "fly") return <FlyMover />;
  if (mode === "fps") return <FpsMover />;
  return <CinematicMover />;
}
