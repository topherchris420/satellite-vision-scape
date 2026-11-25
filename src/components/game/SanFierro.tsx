import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { buildings, canMove, CAR, collectEvidence, evidence, HQ, readCampaign, saveCampaign, submitVerdict, type Campaign, type Verdict } from "@/game/campaign/sanFierro";

type Point = { x: number; z: number };
const near = (a: Point, b: Point, radius = 3) => Math.hypot(a.x - b.x, a.z - b.z) < radius;
type Interaction = "hq" | "car" | (typeof evidence)[number]["id"] | null;
const movementKeys = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

function District({ keys, position, car, driving, onNear, campaign }: {
  keys: MutableRefObject<Set<string>>;
  position: MutableRefObject<Point>;
  car: MutableRefObject<Point>;
  driving: boolean;
  onNear: (id: Interaction) => void;
  campaign: Campaign;
}) {
  const avatar = useRef<THREE.Group>(null);
  const vehicle = useRef<THREE.Group>(null);
  const last = useRef<Interaction>(null);
  const cameraTarget = useRef(new THREE.Vector3());
  useFrame(({ camera }, dt) => {
    const k = keys.current;
    let x = Number(k.has("KeyD") || k.has("ArrowRight")) - Number(k.has("KeyA") || k.has("ArrowLeft"));
    let z = Number(k.has("KeyS") || k.has("ArrowDown")) - Number(k.has("KeyW") || k.has("ArrowUp"));
    const length = Math.hypot(x, z);
    if (length) {
      x /= length; z /= length;
      const p = position.current;
      const step = Math.min(dt, 0.05) * (driving ? 13 : 6);
      const radius = driving ? 1.5 : 0.65;
      if (canMove(p.x + x * step, p.z, radius)) p.x += x * step;
      if (canMove(p.x, p.z + z * step, radius)) p.z += z * step;
      if (avatar.current) avatar.current.rotation.y = Math.atan2(x, z);
      if (driving && vehicle.current) vehicle.current.rotation.y = Math.atan2(x, z);
    }
    const p = position.current;
    if (driving) car.current = { ...p };
    avatar.current?.position.set(p.x, 0, p.z);
    vehicle.current?.position.set(car.current.x, 0, car.current.z);
    cameraTarget.current.set(p.x, 13, p.z + 17);
    camera.position.lerp(cameraTarget.current, 1 - Math.exp(-dt * 8));
    camera.lookAt(p.x, 0.8, p.z - 3);
    const e = evidence.find((v) => !campaign.collected.includes(v.id) && near(p, v));
    const id: Interaction = driving ? "car" : e?.id ?? (near(p, HQ) ? "hq" : near(p, car.current) ? "car" : null);
    if (id !== last.current) { last.current = id; onNear(id); }
  });
  return <>
    <color attach="background" args={["#a5bac5"]} />
    <fog attach="fog" args={["#a5bac5", 55, 125]} />
    <ambientLight intensity={1.4} />
    <directionalLight position={[12, 35, -10]} intensity={2} />
    <mesh rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[100, 100]} /><meshStandardMaterial color="#42474a" /></mesh>
    {buildings.map((b, i) => <group key={i} position={[b.x, 0, b.z]}>
      <mesh position={[0, 0.12, 0]}><boxGeometry args={[19, 0.24, 19]} /><meshStandardMaterial color="#9a9384" /></mesh>
      <mesh position={[0, b.h / 2, 0]}><boxGeometry args={[b.w, b.h, b.d]} /><meshStandardMaterial color={["#a78b73", "#c5b7a2", "#7e9297", "#b8a88f"][i % 4]} /></mesh>
      <mesh position={[0, b.h + 0.15, 0]}><boxGeometry args={[b.w + 0.35, 0.3, b.d + 0.35]} /><meshStandardMaterial color="#4c5052" /></mesh>
      {[-4, 0, 4].map((x) => <mesh key={x} position={[x, b.h * 0.65, b.d / 2 + 0.03]}><boxGeometry args={[2, 1.7, 0.08]} /><meshStandardMaterial color="#293e47" roughness={0.35} /></mesh>)}
    </group>)}
    {[-24, 0, 24].flatMap((v) => [-36, -18, 6, 18, 36].map((t) => <group key={v + ":" + t}>
      <mesh position={[v, 0.025, t]}><boxGeometry args={[0.16, 0.03, 3]} /><meshBasicMaterial color="#d5b76b" /></mesh>
      <mesh position={[t, 0.025, v]}><boxGeometry args={[3, 0.03, 0.16]} /><meshBasicMaterial color="#d5b76b" /></mesh>
    </group>))}
    <group position={[HQ.x, 0, HQ.z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}><ringGeometry args={[2.2, 2.5, 32]} /><meshBasicMaterial color="#40d9ca" /></mesh>
      <mesh position={[0, 2.5, 0]}><octahedronGeometry args={[0.8]} /><meshBasicMaterial color="#40d9ca" /></mesh>
    </group>
    {evidence.filter((e) => !campaign.collected.includes(e.id)).map((e) => <group key={e.id} position={[e.x, 0, e.z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}><ringGeometry args={[2, 2.3, 32]} /><meshBasicMaterial color="#ffbd55" /></mesh>
      <mesh position={[0, 2.3, 0]}><octahedronGeometry args={[0.7]} /><meshBasicMaterial color="#ffbd55" /></mesh>
    </group>)}
    <group ref={avatar} visible={!driving}>
      <mesh position={[0, 1.05, 0]}><capsuleGeometry args={[0.35, 0.8, 4, 8]} /><meshStandardMaterial color="#23394d" /></mesh>
      <mesh position={[0, 1.8, 0]}><sphereGeometry args={[0.27, 12, 8]} /><meshStandardMaterial color="#865e43" /></mesh>
    </group>
    <group ref={vehicle}>
      <mesh position={[0, 0.65, 0]}><boxGeometry args={[1.8, 0.65, 3.5]} /><meshStandardMaterial color="#7c3834" /></mesh>
      <mesh position={[0, 1.13, 0.15]}><boxGeometry args={[1.55, 0.55, 1.65]} /><meshStandardMaterial color="#304c58" /></mesh>
      {[-0.9, 0.9].flatMap((x) => [-1.1, 1.1].map((z) => <mesh key={x + ":" + z} position={[x, 0.35, z]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.36, 0.36, 0.24, 12]} /><meshStandardMaterial color="#202326" /></mesh>))}
    </group>
  </>;
}

export function SanFierro() {
  const [campaign, setCampaign] = useState(readCampaign);
  const [interaction, setInteraction] = useState<Interaction>("hq");
  const [driving, setDriving] = useState(false);
  const [message, setMessage] = useState("CERTAIN has flagged a family vehicle. R.A.I.N. needs independent evidence.");
  const [storageOK, setStorageOK] = useState(true);
  const keys = useRef(new Set<string>());
  const position = useRef<Point>({ ...HQ });
  const car = useRef<Point>({ ...CAR });
  function update(next: Campaign) {
    setCampaign(next);
    setStorageOK(saveCampaign(next));
  }
  function interact() {
    if (interaction === "car") {
      if (!driving && !canMove(car.current.x, car.current.z, 1.5)) return;
      if (!driving) position.current = { ...car.current };
      setDriving(!driving);
      setMessage(driving ? "On foot." : "Vehicle ready. Use the same movement controls.");
    } else if (interaction === "hq") {
      setMessage(campaign.collected.length === evidence.length ? "Review the three independent observations and submit a verdict." : "Christopher: Visit the three amber markers. Do not confuse confidence with evidence.");
    } else if (interaction) {
      const item = evidence.find((e) => e.id === interaction);
      if (item && !campaign.collected.includes(item.id)) {
        update(collectEvidence(campaign, item.id));
        setMessage(item.detail);
      }
    }
  }
  const action = useRef(interact);
  useEffect(() => { action.current = interact; });
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (movementKeys.includes(e.code)) { e.preventDefault(); keys.current.add(e.code); }
      if (e.code === "KeyE" && !e.repeat) action.current();
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const clear = () => keys.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);
  const ready = campaign.collected.length === evidence.length;
  return <main className="relative h-[100dvh] overflow-hidden bg-[#1c292f] text-white">
    <Canvas camera={{ position: [0, 13, 17], fov: 55 }} dpr={[1, 1.5]} fallback={<p className="p-6">WebGL is required. <a href="/">Return to Pine Gap.</a></p>}>
      <District keys={keys} position={position} car={car} driving={driving} campaign={campaign} onNear={setInteraction} />
    </Canvas>
    <section className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3 sm:p-5">
      <div className="max-w-[65%] rounded-lg bg-black/75 p-3">
        <p className="text-[10px] uppercase tracking-widest text-teal-300">99.9% SURE · San Fierro prototype</p>
        <h1 className="text-lg font-bold">The CERTAIN case</h1>
        <p className="text-xs text-white/80">{message}</p>
        <p className="mt-2 text-xs text-amber-200">Evidence {campaign.collected.length}/3 · {ready ? "Return to HQ (teal)" : "Visit amber markers"}</p>
        {!storageOK && <p className="text-xs text-red-200">Browser storage unavailable; progress is temporary.</p>}
      </div>
      <a href="/" className="pointer-events-auto rounded-lg bg-black/75 px-3 py-2 text-xs">Pine Gap ↗</a>
    </section>
    <aside className="absolute right-3 top-36 max-w-[45%] rounded-lg bg-black/75 p-2 text-[10px] sm:text-xs">
      <svg viewBox="-48 -48 96 96" className="h-24 w-24 sm:h-32 sm:w-32" aria-label="District map">
        <rect x="-48" y="-48" width="96" height="96" fill="#394147" />
        {buildings.map((b, i) => <rect key={i} x={b.x - 7.5} y={b.z - 7.5} width="15" height="15" fill="#92908a" />)}
        <circle cx="0" cy="0" r="3" fill="#40d9ca" />
        {evidence.filter((e) => !campaign.collected.includes(e.id)).map((e) => <circle key={e.id} cx={e.x} cy={e.z} r="3" fill="#ffbd55" />)}
      </svg>
      <p>Teal: HQ · Amber: evidence</p>
    </aside>
    <section className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-3 sm:p-5">
      <div className="grid grid-cols-3 gap-1 touch-none" aria-label="Movement controls">
        {(["", "KeyW", "", "KeyA", "KeyS", "KeyD"] as const).map((code, i) => code ? <button key={i} aria-label={{ KeyW: "Forward", KeyA: "Left", KeyS: "Back", KeyD: "Right" }[code]} className="h-12 w-12 rounded-lg bg-black/75 text-xl" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); keys.current.add(code); }} onPointerUp={() => keys.current.delete(code)} onPointerCancel={() => keys.current.delete(code)} onLostPointerCapture={() => keys.current.delete(code)}>{{ KeyW: "↑", KeyA: "←", KeyS: "↓", KeyD: "→" }[code]}</button> : <span key={i} />)}
      </div>
      <div className="max-w-[55%] rounded-lg bg-black/80 p-3 text-xs">
        {campaign.verdict ? <>
          <p className="font-bold text-teal-300">Case recorded: {campaign.verdict}</p>
          <p className="my-2">R.A.I.N. has retained your conclusion. Continue to Pine Gap.</p>
          <a href="/" className="inline-block rounded bg-teal-300 px-3 py-2 font-bold text-black">Chapter II: Pine Gap</a>
        </> : <>
          {ready && interaction === "hq" ? <><p className="mb-2">CERTAIN claims the vehicle is implicated. Does the evidence justify the claim?</p><div className="flex flex-wrap gap-1">{(["accept", "reject", "abstain"] as Verdict[]).map((v) => <button key={v} className="rounded bg-white/15 px-2 py-2 capitalize" onClick={() => { update(submitVerdict(campaign, v)); setMessage(v === "accept" ? "R.A.I.N.: confidence is not independent corroboration." : "R.A.I.N.: keep the uncertainty in your record."); }}>{v}</button>)}</div></> : <button disabled={!interaction} className="rounded bg-teal-300 px-4 py-3 font-bold text-black disabled:opacity-40" onClick={interact}>{interaction === "car" ? (driving ? "Exit vehicle" : "Enter vehicle") : interaction === "hq" ? "Speak to Christopher" : interaction ? "Collect evidence" : "Approach marker"} (E)</button>}
        </>}
        <p className="mt-2 text-white/60">WASD / arrows · E interact · touch controls</p>
      </div>
    </section>
  </main>;
}
