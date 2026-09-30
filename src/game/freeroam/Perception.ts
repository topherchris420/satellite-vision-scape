import { CollisionLayer } from "../world/colliders";
import type { CollisionWorld } from "../world/CollisionWorld";
import type { GroundQuery } from "../world/GroundQuery";

/**
 * What can be seen from where. One implementation serves pedestrians and
 * guards noticing the player and the observation an agent is given, so
 * nobody — human, agent or NPC — sees through a building.
 *
 * Sight is blocked by structures, props (poles, trees), vehicles and the
 * ground itself. Fences and boom barriers are see-through. Range depends on
 * the light and on any dust in the air.
 */

const SIGHT_MASK = CollisionLayer.Structure | CollisionLayer.Prop | CollisionLayer.Vehicle;
/** Terrain is sampled this often along a line of sight (metres). */
const TERRAIN_STEP = 3.5;

/** How far a person can pick out a standing figure, by light (metres). */
export const VISION_RANGE = { day: 210, dusk: 140, night: 85 } as const;
/** Anything this close is noticed whichever way it is looking (peripheral awareness). */
export const PERIPHERAL_RANGE = 7;
/** Horizontal field of view of the camera, half-angle in radians (≈ 100° across). */
export const VIEW_HALF_ANGLE = (50 * Math.PI) / 180;

export class Perception {
  /** 1 clear air … 0.4 thick dust (Free Roam's environment events). */
  clarity = 1;

  constructor(
    private readonly collision: CollisionWorld,
    private readonly ground: GroundQuery,
  ) {}

  visionRange(timeOfDay: keyof typeof VISION_RANGE): number {
    return VISION_RANGE[timeOfDay] * this.clarity;
  }

  /**
   * Is the straight line between two points free of anything opaque? `ignore`
   * is a collider owner to disregard (the vehicle the observer sits in).
   */
  lineOfSight(
    ox: number,
    oy: number,
    oz: number,
    tx: number,
    ty: number,
    tz: number,
    ignore: unknown = null,
  ): boolean {
    const dx = tx - ox;
    const dy = ty - oy;
    const dz = tz - oz;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.5) return true;
    const ux = dx / distance;
    const uy = dy / distance;
    const uz = dz / distance;
    const free = this.collision.raycast(ox, oy, oz, ux, uy, uz, distance - 0.3, 0.04, SIGHT_MASK, ignore);
    if (free < distance - 0.6) return false;
    // The ground itself: a ridge hides what is behind it.
    for (let t = TERRAIN_STEP; t < distance - 1; t += TERRAIN_STEP) {
      const x = ox + ux * t;
      const z = oz + uz * t;
      if (oy + uy * t < this.ground.heightAt(x, z) - 0.05) return false;
    }
    return true;
  }
}
