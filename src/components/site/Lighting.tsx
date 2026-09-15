import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Sky, Stars } from '@react-three/drei';
import * as THREE from 'three';
import { buildings, domes } from '@/lib/site-layout';
import { sampleFootprintGrade } from '@/lib/terrain';

export type TimeOfDay = 'day' | 'dusk' | 'night';
export const LIGHTING = {
  day: { sun: [180, 300, -160] as [number,number,number], color: '#fff5e5', intensity: 3, sky: '#88b3d4', ground: '#aa7855', ambient: .45, fog: '#c3ced0', exposure: 1 },
  dusk: { sun: [-300, 95, -180] as [number,number,number], color: '#ffd19a', intensity: 2.8, sky: '#8dacca', ground: '#996949', ambient: .35, fog: '#c7b4a1', exposure: 1.05 },
  night: { sun: [100, 260, -150] as [number,number,number], color: '#a4bde3', intensity: .32, sky: '#203957', ground: '#161922', ambient: .2, fog: '#101c2a', exposure: 1.1 },
} as const;
function Environment({ time }: { time: TimeOfDay }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    const p = LIGHTING[time];
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128;
    const ctx = canvas.getContext('2d')!; const gradient = ctx.createLinearGradient(0, 0, 0, 128);
    gradient.addColorStop(0, p.sky); gradient.addColorStop(.48, p.fog); gradient.addColorStop(.53, p.ground); gradient.addColorStop(1, p.ground);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 256, 128);
    const texture = new THREE.CanvasTexture(canvas); texture.mapping = THREE.EquirectangularReflectionMapping; texture.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(gl); const renderTarget = pmrem.fromEquirectangular(texture);
    const previous = scene.environment; scene.environment = renderTarget.texture; scene.environmentIntensity = time === 'night' ? .12 : .45; gl.toneMappingExposure = p.exposure;
    return () => { scene.environment = previous; renderTarget.dispose(); texture.dispose(); pmrem.dispose(); };
  }, [gl, scene, time]);
  return null;
}
export function Lighting({ time, highQuality = true }: { time: TimeOfDay; highQuality?: boolean }) {
  const p = LIGHTING[time]; const night = time === 'night';
  const sunPosition = new THREE.Vector3(...p.sun).normalize().multiplyScalar(1800);
  return <>
    {night ? <color attach="background" args={[p.fog]} /> : <Sky distance={12000} sunPosition={p.sun} turbidity={2.8} rayleigh={1.8} mieCoefficient={.003} mieDirectionalG={.82} />}
    {night && <Stars radius={4500} depth={400} count={1800} factor={3} saturation={0} fade speed={0} />}
    <Environment time={time} />
    <hemisphereLight args={[p.sky, p.ground, p.ambient]} />
    <directionalLight position={sunPosition} intensity={p.intensity} color={p.color} castShadow
      shadow-mapSize-width={highQuality ? 4096 : 2048} shadow-mapSize-height={highQuality ? 4096 : 2048}
      shadow-camera-left={-700} shadow-camera-right={700} shadow-camera-top={700} shadow-camera-bottom={-700}
      shadow-camera-near={1} shadow-camera-far={3200} shadow-normalBias={.18} shadow-bias={-.00008} />
    {night && <>
      {buildings.slice(0, 3).map((b, i) => <pointLight key={`building-${i}`} position={[b.pos[0] + b.size[0] / 2 + 2, sampleFootprintGrade(b.pos, b.size).elevation + 5, b.pos[1]]} intensity={120} distance={45} decay={2} color="#ffd397" />)}
      {domes.filter(d => d.radius >= 15).map(d => <pointLight key={d.sourceId} position={[d.pos[0] + d.radius * .8, sampleFootprintGrade(d.pos, d.radius).elevation + 2, d.pos[1] + d.radius * .8]} intensity={110} distance={60} decay={2} color="#ffd5a2" />)}
    </>}
  </>;
}
