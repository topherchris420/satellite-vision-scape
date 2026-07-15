import { useRef, useEffect } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import { MapControls, PointerLockControls } from "@react-three/drei";
import * as THREE from "three";

export type ControlMode = "fly" | "fps";

function useKeys() {
  const keys = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const down = (e: KeyboardEvent) => { keys.current[e.code] = true; };
    const up = (e: KeyboardEvent) => { keys.current[e.code] = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);
  return keys;
}

function FpsMover() {
  const { camera } = useThree();
  const keys = useKeys();
  const velocity = useRef(new THREE.Vector3());

  useEffect(() => {
    camera.position.set(0, 1.7, 60);
  }, [camera]);

  useFrame((_, delta) => {
    const speed = (keys.current["ShiftLeft"] ? 20 : 8) * delta;
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
      velocity.current.copy(dir);
      camera.position.add(velocity.current);
    }
    camera.position.y = 1.7;
  });

  return <PointerLockControls />;
}

function FlyMover() {
  const { camera } = useThree();
  const keys = useKeys();

  useEffect(() => {
    camera.position.set(0, 120, 180);
    camera.lookAt(0, 0, 0);
  }, [camera]);

  useFrame((_, delta) => {
    const speed = (keys.current["ShiftLeft"] ? 80 : 30) * delta;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));

    if (keys.current["KeyW"]) camera.position.addScaledVector(forward, speed);
    if (keys.current["KeyS"]) camera.position.addScaledVector(forward, -speed);
    if (keys.current["KeyD"]) camera.position.addScaledVector(right, speed);
    if (keys.current["KeyA"]) camera.position.addScaledVector(right, -speed);
    if (keys.current["KeyE"] || keys.current["Space"]) camera.position.y += speed;
    if (keys.current["KeyQ"]) camera.position.y -= speed;
    camera.position.y = Math.max(2, camera.position.y);
  });

  return <MapControls makeDefault enableDamping dampingFactor={0.1} maxPolarAngle={Math.PI / 2 - 0.05} />;
}

export function Controls({ mode }: { mode: ControlMode }) {
  return mode === "fly" ? <FlyMover /> : <FpsMover />;
}
