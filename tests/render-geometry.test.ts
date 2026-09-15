import { describe, expect, test } from 'bun:test';
import { createGroundApron, createRadomePanelLines, createRadomeShell } from '../src/lib/site-geometry';
import { terrainHeight } from '../src/lib/terrain';
import { RADOME_SHELL_LIFT } from '../src/lib/site-layout';

describe('Exterior rendering geometry', () => {
  test('panel joints follow the shell and stop at its base', () => {
    const geometry = createRadomePanelLines(19);
    const p = geometry.getAttribute('position');
    expect(p.count % 2).toBe(0);
    for (let i = 0; i < p.count; i++) {
      expect(p.getY(i)).toBeGreaterThanOrEqual(-RADOME_SHELL_LIFT * 19 - .00001);
      expect(Math.hypot(p.getX(i), p.getY(i), p.getZ(i))).toBeCloseTo(19.02, 2);
    }
    geometry.dispose();
  });
  test('apron stays on sloping terrain and has upward faces', () => {
    const center: [number, number] = [170, -80];
    const elevation = terrainHeight(...center);
    const geometry = createGroundApron(center, 26, elevation);
    const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      expect(p.getY(i) + elevation).toBeCloseTo(terrainHeight(center[0] + p.getX(i), center[1] + p.getZ(i)) + .045, 4);
      expect(Math.hypot(p.getX(i), p.getZ(i))).toBeLessThanOrEqual(26.00001);
    }
    const index = geometry.index!;
    for (let i = 0; i < index.count; i++) expect(n.getY(index.getX(i))).toBeGreaterThan(0);
    geometry.dispose();
  });
  test('every shell LOD meets the foundation and has finite UVs and unit normals', () => {
    for (const detail of [7, 11, 15]) {
      const geometry = createRadomeShell(19, detail);
      const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
      let minY = Infinity;
      for (let i = 0; i < p.count; i++) {
        minY = Math.min(minY, p.getY(i));
        expect(p.getY(i)).toBeGreaterThanOrEqual(-RADOME_SHELL_LIFT * 19 - .00001);
        expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 5);
        expect(Number.isFinite(uv.getX(i)) && Number.isFinite(uv.getY(i))).toBe(true);
      }
      expect(minY).toBeCloseTo(-RADOME_SHELL_LIFT * 19, 4);
      geometry.dispose();
    }
  });
});
