/**
 * Uniform XZ hash grid for static items. Each item is stored in every cell
 * its bounding box touches; queries dedupe with a per-item stamp so a single
 * reusable output array serves every query without allocation.
 */
export interface GridItem {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Last query stamp that visited this item (dedupe bookkeeping). */
  stamp: number;
}

const KEY_OFFSET = 4096;
const KEY_STRIDE = 8192;

export class SpatialHashGrid<T extends GridItem> {
  private readonly cells = new Map<number, T[]>();
  private readonly inverseCell: number;
  private stamp = 0;

  constructor(readonly cellSize: number) {
    this.inverseCell = 1 / cellSize;
  }

  private key(ix: number, iz: number): number {
    return (ix + KEY_OFFSET) * KEY_STRIDE + (iz + KEY_OFFSET);
  }

  insert(item: T): void {
    const x0 = Math.floor(item.minX * this.inverseCell);
    const x1 = Math.floor(item.maxX * this.inverseCell);
    const z0 = Math.floor(item.minZ * this.inverseCell);
    const z1 = Math.floor(item.maxZ * this.inverseCell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = this.key(ix, iz);
        let bucket = this.cells.get(k);
        if (!bucket) {
          bucket = [];
          this.cells.set(k, bucket);
        }
        bucket.push(item);
      }
    }
  }

  /**
   * Append every item whose bounds overlap the query box to `out`, starting at
   * index `count`. Returns the new count. `accept` filters before insertion.
   */
  query(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    out: T[],
    count: number,
    accept: (item: T) => boolean,
  ): number {
    const stamp = ++this.stamp;
    const x0 = Math.floor(minX * this.inverseCell);
    const x1 = Math.floor(maxX * this.inverseCell);
    const z0 = Math.floor(minZ * this.inverseCell);
    const z1 = Math.floor(maxZ * this.inverseCell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const bucket = this.cells.get(this.key(ix, iz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const item = bucket[i];
          if (item.stamp === stamp) continue;
          item.stamp = stamp;
          if (item.maxX < minX || item.minX > maxX || item.maxZ < minZ || item.minZ > maxZ)
            continue;
          if (!accept(item)) continue;
          out[count++] = item;
        }
      }
    }
    return count;
  }

  clear(): void {
    this.cells.clear();
  }
}
