import * as THREE from "three";
import type { VehicleVariant } from "./VehicleSpec";

/**
 * Materials shared by every vehicle (trim, glass, rubber…) are created once;
 * paint, canvas and lamp lenses are per vehicle because their colour or
 * emissive state differs. The library owns everything and disposes it.
 */
export class VehicleMaterialLibrary {
  readonly trim = new THREE.MeshStandardMaterial({
    color: "#26272a",
    roughness: 0.78,
    metalness: 0.2,
  });
  readonly liner = new THREE.MeshStandardMaterial({
    color: "#1c1c1d",
    roughness: 0.95,
    side: THREE.DoubleSide,
  });
  readonly metal = new THREE.MeshStandardMaterial({
    color: "#6f7274",
    roughness: 0.4,
    metalness: 0.75,
  });
  readonly rubber = new THREE.MeshStandardMaterial({ color: "#191918", roughness: 0.92 });
  readonly interior = new THREE.MeshStandardMaterial({ color: "#2d2e2b", roughness: 0.9 });
  readonly glass = new THREE.MeshStandardMaterial({
    color: "#1d2a31",
    roughness: 0.06,
    metalness: 0.3,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    envMapIntensity: 1.4,
  });
  readonly amber = new THREE.MeshStandardMaterial({
    color: "#8a5a14",
    emissive: "#ff9a2a",
    emissiveIntensity: 0.15,
    roughness: 0.3,
  });
  readonly rim = new THREE.MeshStandardMaterial({
    color: "#3b3d36",
    roughness: 0.55,
    metalness: 0.45,
  });
  private readonly owned: THREE.Material[] = [];
  private readonly geometries = new Map<string, THREE.BufferGeometry>();

  /** Geometry shared by every vehicle (e.g. wheels), built once on first use. */
  sharedGeometry(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let g = this.geometries.get(key);
    if (!g) {
      g = build();
      this.geometries.set(key, g);
    }
    return g;
  }

  paint(variant: VehicleVariant): THREE.MeshStandardMaterial {
    return this.own(
      new THREE.MeshStandardMaterial({ color: variant.paint, roughness: 0.74, metalness: 0.12 }),
    );
  }

  canvas(variant: VehicleVariant): THREE.MeshStandardMaterial {
    return this.own(new THREE.MeshStandardMaterial({ color: variant.canvas, roughness: 1 }));
  }

  headlamp(): THREE.MeshStandardMaterial {
    return this.own(
      new THREE.MeshStandardMaterial({
        color: "#d9dcd6",
        emissive: "#fff3d6",
        emissiveIntensity: 0,
        roughness: 0.15,
        metalness: 0.2,
      }),
    );
  }

  taillamp(): THREE.MeshStandardMaterial {
    return this.own(
      new THREE.MeshStandardMaterial({
        color: "#6e1411",
        emissive: "#ff2a1a",
        emissiveIntensity: 0.1,
        roughness: 0.3,
      }),
    );
  }

  private own<T extends THREE.Material>(m: T): T {
    this.owned.push(m);
    return m;
  }

  dispose(): void {
    for (const m of [
      this.trim,
      this.liner,
      this.metal,
      this.rubber,
      this.interior,
      this.glass,
      this.amber,
      this.rim,
      ...this.owned,
    ]) {
      m.dispose();
    }
    this.owned.length = 0;
    for (const g of this.geometries.values()) g.dispose();
    this.geometries.clear();
  }
}
