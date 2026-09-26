import { z } from "zod";
import { GREEN_MACHINE } from "./soundtrack";

/**
 * Progression and preferences for After Hours, persisted in versioned,
 * validated local storage.
 *
 *   coffee available → coffee completed → channel discovered
 *     → terminals tuned (0–4) → concert unlocked → concert completed
 *
 * Only safe checkpoints are stored: a running coffee timer or an
 * interrupted finale is never restored — the mission comes back as
 * available (or completed) and the concert as unlocked.
 */

export const STORAGE_KEY = "pine-gap.after-hours";
export const SAVE_VERSION = 1;

export const LAYER_IDS = ["rhythm", "bass", "harmony", "melody"] as const;
export type LayerId = (typeof LAYER_IDS)[number];
export type CharacterKind = "soldier" | "technician";
export const STATION_IDS = ["indigo", "numbers", "f420"] as const;
export type StationId = (typeof STATION_IDS)[number];

export interface CoffeeRecord {
  percent: number;
  seconds: number;
  score: number;
}

export interface Progress {
  coffeeCompleted: boolean;
  bestCoffee: CoffeeRecord | null;
  channelDiscovered: boolean;
  terminals: Record<LayerId, boolean>;
  concertCompleted: boolean;
}

export interface Preferences {
  /** Radio / music level 0..1, independent of sound effects. */
  musicVolume: number;
  /** Altered Signal presentation strength 0..1. */
  effectIntensity: number;
  reducedMotion: boolean;
  /** No stylistic processing on the album and no ambient layer. */
  cleanAudio: boolean;
  /** Altered Signal on when unlocked (can be switched off at any time). */
  alteredSignal: boolean;
  /** Text / arrow guidance to signals, independent of visual effects. */
  signalOverlay: boolean;
  character: CharacterKind;
  stationId: StationId;
  trackId: string;
  /** Seconds into `trackId`; restored where appropriate. */
  trackPosition: number;
}

export interface SaveData {
  version: typeof SAVE_VERSION;
  progress: Progress;
  preferences: Preferences;
}

export type Stage = "coffee" | "channel" | "terminals" | "concert" | "complete";

export function defaultProgress(): Progress {
  return {
    coffeeCompleted: false,
    bestCoffee: null,
    channelDiscovered: false,
    terminals: { rhythm: false, bass: false, harmony: false, melody: false },
    concertCompleted: false,
  };
}

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

export function defaultPreferences(): Preferences {
  return {
    musicVolume: 0.7,
    effectIntensity: 0.65,
    reducedMotion: prefersReducedMotion(),
    cleanAudio: false,
    alteredSignal: true,
    signalOverlay: true,
    character: "technician",
    stationId: "indigo",
    trackId: GREEN_MACHINE.tracks[0].id,
    trackPosition: 0,
  };
}

export function defaultSave(): SaveData {
  return { version: SAVE_VERSION, progress: defaultProgress(), preferences: defaultPreferences() };
}

export function terminalsTuned(p: Progress): number {
  return LAYER_IDS.filter((id) => p.terminals[id]).length;
}

export function concertUnlocked(p: Progress): boolean {
  return p.channelDiscovered && terminalsTuned(p) === LAYER_IDS.length;
}

export function stageOf(p: Progress): Stage {
  if (!p.coffeeCompleted) return "coffee";
  if (!p.channelDiscovered) return "channel";
  if (!concertUnlocked(p)) return "terminals";
  if (!p.concertCompleted) return "concert";
  return "complete";
}

// --- Validation ----------------------------------------------------------------
// Each field falls back to its default on its own, so one damaged value does
// not wipe the rest of a player's progress.

const unit = (fallback: number) => z.number().finite().min(0).max(1).catch(fallback);
const flag = (fallback: boolean) => z.boolean().catch(fallback);

function schemas() {
  const d = defaultPreferences();
  const coffeeRecord = z
    .object({
      percent: z.number().finite().min(0).max(100),
      seconds: z
        .number()
        .finite()
        .min(0)
        .max(24 * 3600),
      score: z.number().finite().min(0),
    })
    .nullable()
    .catch(null);
  const progress = z
    .object({
      coffeeCompleted: flag(false),
      bestCoffee: coffeeRecord.optional().transform((v) => v ?? null),
      channelDiscovered: flag(false),
      terminals: z
        .object({
          rhythm: flag(false),
          bass: flag(false),
          harmony: flag(false),
          melody: flag(false),
        })
        .catch(defaultProgress().terminals),
      concertCompleted: flag(false),
    })
    .catch(defaultProgress());
  const trackIds = GREEN_MACHINE.tracks.map((t) => t.id);
  const preferences = z
    .object({
      musicVolume: unit(d.musicVolume),
      effectIntensity: unit(d.effectIntensity),
      reducedMotion: flag(d.reducedMotion),
      cleanAudio: flag(d.cleanAudio),
      alteredSignal: flag(d.alteredSignal),
      signalOverlay: flag(d.signalOverlay),
      character: z.enum(["soldier", "technician"]).catch(d.character),
      stationId: z.enum(STATION_IDS).catch(d.stationId),
      trackId: z
        .string()
        .refine((id) => trackIds.includes(id))
        .catch(d.trackId),
      trackPosition: z.number().finite().min(0).max(3600).catch(0),
    })
    .catch(d);
  return { progress, preferences };
}

/** Normalise progress so it never claims an impossible combination. */
function consistent(p: Progress): Progress {
  const out = { ...p, terminals: { ...p.terminals } };
  // Later stages imply earlier ones (a hand-edited or partially damaged save
  // should never skip the mystery or show a concert with no terminals).
  if (!out.coffeeCompleted) out.channelDiscovered = false;
  if (!out.channelDiscovered) {
    for (const id of LAYER_IDS) out.terminals[id] = false;
  }
  if (!concertUnlocked(out)) out.concertCompleted = false;
  return out;
}

export type LoadOutcome =
  | "fresh" // nothing stored yet
  | "loaded" // stored data was valid
  | "repaired" // some fields were invalid and fell back to defaults
  | "reset-invalid" // unreadable data; defaults used
  | "reset-outdated" // unknown or older version; defaults used
  | "unavailable"; // storage cannot be used; progress lasts for this visit only

/** Parse stored text into save data, reporting how it was recovered. */
export function parseSave(raw: string | null): { data: SaveData; outcome: LoadOutcome } {
  if (raw === null) return { data: defaultSave(), outcome: "fresh" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { data: defaultSave(), outcome: "reset-invalid" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { data: defaultSave(), outcome: "reset-invalid" };
  }
  const record = json as Record<string, unknown>;
  if (record.version !== SAVE_VERSION) {
    return { data: defaultSave(), outcome: "reset-outdated" };
  }
  const { progress, preferences } = schemas();
  const parsedProgress = consistent(progress.parse(record.progress));
  const parsedPreferences = preferences.parse(record.preferences);
  const data: SaveData = {
    version: SAVE_VERSION,
    progress: parsedProgress,
    preferences: parsedPreferences,
  };
  const clean =
    JSON.stringify({ progress: parsedProgress, preferences: parsedPreferences }) ===
    JSON.stringify({ progress: record.progress, preferences: record.preferences });
  return { data, outcome: clean ? "loaded" : "repaired" };
}

// --- Storage ---------------------------------------------------------------------

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage when it is present and writable, otherwise null. */
export function browserStorage(): KeyValueStorage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const probe = `${STORAGE_KEY}.probe`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Loads, saves and resets After Hours data. Every storage call is guarded:
 * quota errors, disabled storage and private modes degrade to an in-memory
 * session instead of breaking the game.
 */
export class ProgressStore {
  data: SaveData;
  readonly outcome: LoadOutcome;
  private available: boolean;

  constructor(private readonly storage: KeyValueStorage | null) {
    this.available = storage !== null;
    if (!storage) {
      this.data = defaultSave();
      this.outcome = "unavailable";
      return;
    }
    let raw: string | null = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      this.available = false;
    }
    const parsed = parseSave(raw);
    this.data = parsed.data;
    this.outcome = this.available ? parsed.outcome : "unavailable";
  }

  get persistent(): boolean {
    return this.available;
  }

  save(): boolean {
    if (!this.storage || !this.available) return false;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      return true;
    } catch {
      return false;
    }
  }

  /** Clear progress; preferences survive a reset unless `everything`. */
  reset(everything = false): SaveData {
    const preferences = everything ? defaultPreferences() : this.data.preferences;
    this.data = { version: SAVE_VERSION, progress: defaultProgress(), preferences };
    if (everything && this.storage && this.available) {
      try {
        this.storage.removeItem(STORAGE_KEY);
      } catch {
        // Nothing further to do; the in-memory state is already reset.
      }
    }
    this.save();
    return this.data;
  }
}
