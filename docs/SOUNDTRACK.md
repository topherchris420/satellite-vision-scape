# Soundtrack — Indigo People, *Green Machine*

**Original music written by Christopher Woodyard, performing as Indigo People.
Featured album: *Green Machine*.**

The recordings and the cover art are the songwriter's work, used in *Pine
Gap: After Hours* with his permission. They are **not** covered by this
repository's software licence, and no other licence is granted for them.
Reuse outside this game needs the songwriter's permission.

## Files

Served from `public/music/indigo-people/green-machine/`. The MP3s are
byte-identical to the supplied recordings (not re-encoded, tags untouched).

| # | Title | File | Duration | SHA-256 |
| -: | :--- | :--- | -: | :--- |
| 1 | Green Machine | `01-green-machine.mp3` | 0:44.5 | `937e4a14…c7be` |
| 2 | Antigravity | `02-antigravity.mp3` | 3:07.7 | `d847740e…89ba` |
| 3 | Colour of Number 9 | `03-colour-of-number-9.mp3` | 3:12.4 | `24ff9825…2fbe` |
| 4 | Dark Matter | `04-dark-matter.mp3` | 3:26.2 | `2c77ef8d…5cbc` |
| 5 | Creators & Innovators | `05-creators-and-innovators.mp3` | 3:27.1 | `8fe99ac5…8634` |

- All five are MPEG-1 Layer III, 320 kbit/s CBR, 44.1 kHz joint stereo, with
  ID3v2.3 tags (title, artist, album, track number) that match the manifest.
- Durations were measured by decoding each file in Chromium
  (`decodeAudioData`); the frame counts agree within the encoder padding.
- `cover.jpg` is the supplied 1103 × 1103 cover; `cover-512.jpg` (display)
  and `cover-160.jpg` (radio thumbnail) are resized copies made for the
  interface. Only these images are ever shown in the game.

Measured levels (whole-file, both channels) were used only to choose the
radio's headroom — every track peaks within 0.2 dB of full scale, with RMS
between −20 and −15 dBFS — so the radio chain trims the album by 6 dB and the
master bus ends in a limiter. No per-track normalisation is applied: the
album's own relative levels are kept.

> **Note on embedded artwork.** Tracks 1 and 3 embed the same painting as
> the supplied cover. Tracks 2, 4 and 5 embed different ID3 images (a
> portrait photograph and images carrying "Vers3Dynamics", "Animorphs" and
> "Scholastic" text). The game never displays embedded artwork, but because
> the files are served unmodified those images travel with them. If that is
> not intended for a public deployment, strip or replace the `APIC` frames
> (this changes only the tags, not the audio) before publishing.

## How the game uses it

- **Streaming on demand.** One `HTMLAudioElement` with `preload="none"`
  plays the current track only; nothing is requested before After Hours
  starts, and the next track is fetched when it is selected.
- **One graph.** The element feeds the game's single `AudioContext` through
  one `MediaElementAudioSourceNode`, created once. Volume, the in-cab /
  outside mix, distance attenuation and door muffling are applied there.
- **Optional effect.** Only when Altered Signal is on and *Clean audio* is
  off, a slow, shallow high-shelf (at most −2.5 dB above 3.5 kHz, 16 s
  period) is applied during playback. It is removed instantly when either
  setting changes. Source files are never modified.
- **Nothing is layered over the album.** The procedural puzzle / concert
  score and the ambient layer never play while the album is audible, and the
  radio ducks during terminal tuning.

## Credits shown in the game

- Opening soundtrack credit (and again after the concert):
  *Original music by Christopher Woodyard* · *Indigo People — Green Machine*.
- Album view (tap the cover on the radio): album, artist, *Music written by
  Christopher Woodyard*, track list.
- Credits screen (pause → After Hours → Credits): the full credit line
  above, the track list and this permission note.

## The procedural score is separate

The antenna-puzzle and midnight-concert music is generated in-game
(`src/game/afterhours/composition.ts`, `src/game/audio/ProceduralScore.ts`).
It is not part of *Green Machine*, is not written by Christopher Woodyard and
is not derived from the recordings (no stems were extracted or invented).

## Adding a track

1. Copy the file to `public/music/…` with a lowercase, URL-safe name.
2. Append an entry to `GREEN_MACHINE.tracks` in
   `src/game/afterhours/soundtrack.ts`: a stable `id`, the album `number`,
   the exact `title`, the `src` path and the measured `durationSeconds`.
3. That is all: the radio, album view, credits and saved radio position read
   from the manifest. `tests/after-hours-logic.test.ts` checks that every
   manifest file exists and that paths stay URL-safe.
