/**
 * Featured soundtrack for Pine Gap: After Hours.
 *
 * The recordings are authored work by Christopher Woodyard, released as
 * Indigo People. They are used in this game with the songwriter's
 * permission and are NOT covered by the repository's software licence.
 * The files are served exactly as supplied (byte-identical, never
 * re-encoded); the game streams one track at a time on demand.
 *
 * Durations were measured by decoding each file (Chromium decodeAudioData)
 * and are used only for display before a track's own metadata has loaded.
 *
 * Adding a track: copy the file under `public/music/…` with a URL-safe name
 * and append an entry to `tracks` in album order. Nothing else needs to
 * change — the radio, credits and HUD read everything from this manifest.
 */

export interface SoundtrackTrack {
  /** Stable, URL-safe identifier (also persisted as the radio position). */
  id: string;
  /** 1-based position on the album. */
  number: number;
  /** Display title exactly as published. */
  title: string;
  /** Streamed source, relative to the site root. */
  src: string;
  /** Measured duration in seconds (display fallback). */
  durationSeconds: number;
}

export interface SoundtrackAlbum {
  id: string;
  artist: string;
  album: string;
  /** Songwriting credit, as the songwriter asked it to be given. */
  writtenBy: string;
  artwork: {
    /** Original cover as supplied. */
    original: string;
    /** Optimised 512 px display copy (album view, credits). */
    display: string;
    /** 160 px thumbnail (radio panel). */
    thumbnail: string;
  };
  tracks: readonly SoundtrackTrack[];
}

const BASE = "/music/indigo-people/green-machine";

export const GREEN_MACHINE: SoundtrackAlbum = {
  id: "indigo-people-green-machine",
  artist: "Indigo People",
  album: "Green Machine",
  writtenBy: "Christopher Woodyard",
  artwork: {
    original: `${BASE}/cover.jpg`,
    display: `${BASE}/cover-512.jpg`,
    thumbnail: `${BASE}/cover-160.jpg`,
  },
  tracks: [
    {
      id: "green-machine",
      number: 1,
      title: "Green Machine",
      src: `${BASE}/01-green-machine.mp3`,
      durationSeconds: 44.5,
    },
    {
      id: "antigravity",
      number: 2,
      title: "Antigravity",
      src: `${BASE}/02-antigravity.mp3`,
      durationSeconds: 187.7,
    },
    {
      id: "colour-of-number-9",
      number: 3,
      title: "Colour of Number 9",
      src: `${BASE}/03-colour-of-number-9.mp3`,
      durationSeconds: 192.4,
    },
    {
      id: "dark-matter",
      number: 4,
      title: "Dark Matter",
      src: `${BASE}/04-dark-matter.mp3`,
      durationSeconds: 206.2,
    },
    {
      id: "creators-and-innovators",
      number: 5,
      title: "Creators & Innovators",
      src: `${BASE}/05-creators-and-innovators.mp3`,
      durationSeconds: 207.1,
    },
  ],
};

/** The opening credit and album view use exactly these lines. */
export const SOUNDTRACK_CREDIT = {
  line: `Original music by ${GREEN_MACHINE.writtenBy}`,
  release: `${GREEN_MACHINE.artist} — ${GREEN_MACHINE.album}`,
  full: `Original music written by ${GREEN_MACHINE.writtenBy}, performing as ${GREEN_MACHINE.artist}. Featured album: ${GREEN_MACHINE.album}.`,
} as const;

/** Procedural gameplay music is credited separately and never as part of the album. */
export const PROCEDURAL_SCORE_CREDIT =
  "Antenna puzzle and midnight concert music: procedural score generated in-game for After Hours. Not part of Green Machine and not written by Christopher Woodyard.";

export function trackIndexById(id: string | null | undefined): number {
  const i = GREEN_MACHINE.tracks.findIndex((t) => t.id === id);
  return i >= 0 ? i : 0;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–:––";
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}
