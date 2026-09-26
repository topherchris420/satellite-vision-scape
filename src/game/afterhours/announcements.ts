/**
 * Occasional, dry radio announcements triggered by what the player does.
 * Each line has its own cooldown and there is a shared minimum gap, so the
 * radio stays mostly quiet.
 */

export type AnnouncementId =
  | "collisions"
  | "barrier"
  | "topSpeed"
  | "idle"
  | "coffeeLow"
  | "offRoad";

export const ANNOUNCEMENTS: Record<
  AnnouncementId,
  { speaker: string; text: string; cooldown: number }
> = {
  collisions: {
    speaker: "Transport",
    text: "Transport advises that the vehicle is wider than your confidence.",
    cooldown: 240,
  },
  barrier: {
    speaker: "Facilities",
    text: "Facilities thanks you for operating the barrier by hand. It was unaware this was possible.",
    cooldown: 600,
  },
  topSpeed: {
    speaker: "Transport",
    text: "Transport notes the utility vehicle was not designed to reach orbit.",
    cooldown: 420,
  },
  idle: {
    speaker: "Night desk",
    text: "Night desk confirms you are still there. Nobody asked.",
    cooldown: 900,
  },
  coffeeLow: {
    speaker: "Catering",
    text: "Catering reminds staff that coffee is a beverage, not a floor finish.",
    cooldown: 300,
  },
  offRoad: {
    speaker: "Transport",
    text: "Transport would like the desert returned in its original condition.",
    cooldown: 600,
  },
};

export const ANNOUNCER = {
  /** Minimum seconds between any two announcements. */
  globalGap: 45,
  /** Impacts within this window count towards the collision line. */
  collisionWindow: 20,
  collisionCount: 3,
} as const;

export class Announcer {
  private time = 0;
  private lastAny = -Infinity;
  private readonly last = new Map<AnnouncementId, number>();
  private readonly impacts: number[] = [];

  update(dt: number): void {
    this.time += dt;
  }

  /** The line if it may be spoken now (and records it), otherwise null. */
  request(id: AnnouncementId): { speaker: string; text: string } | null {
    const line = ANNOUNCEMENTS[id];
    if (this.time - this.lastAny < ANNOUNCER.globalGap) return null;
    if (this.time - (this.last.get(id) ?? -Infinity) < line.cooldown) return null;
    this.lastAny = this.time;
    this.last.set(id, this.time);
    return { speaker: line.speaker, text: line.text };
  }

  /** Record a driving impact; true once enough happen close together. */
  impact(): boolean {
    this.impacts.push(this.time);
    while (this.impacts.length && this.time - this.impacts[0] > ANNOUNCER.collisionWindow)
      this.impacts.shift();
    if (this.impacts.length >= ANNOUNCER.collisionCount) {
      this.impacts.length = 0;
      return true;
    }
    return false;
  }
}
