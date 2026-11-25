"""Original procedural lab score for 99.9% SURE. No third-party recordings.

Run from any directory: python tools/lab_score.py --out path/to/lab.mp3
Requires ffmpeg for MP3 encoding; synthesis itself uses only the standard library.
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import wave

RATE = 44100
BAR = 4.0
BARS = 12
DURATION = BAR * BARS
TAU = 2 * math.pi
# D minor add9, Bb major7, G minor9 and A suspended. Original arrangement.
CHORDS = ((50, 57, 64, 65), (46, 53, 57, 62), (43, 53, 57, 58), (45, 52, 57, 62))
PATTERN = (0, 2, 1, 3, 2, 1, 3, 1)


def hz(note):
    return 440 * 2 ** ((note - 69) / 12)


def envelope(t, length, attack, release):
    if not 0 <= t < length:
        return 0.0
    return min(1.0, t / attack, (length - t) / release)


def tone(t, note):
    phase = TAU * hz(note) * t
    return (math.sin(phase) + 0.18 * math.sin(2 * phase)
            + 0.06 * math.sin(3 * phase)) / 1.24


def sample(t):
    """Quiet synth pad, soft bass and delayed glass-like arpeggio.

    Each chord and note has an envelope; the final master fade avoids clicks
    at the loop boundary. Mix deliberately leaves headroom for dialogue.
    """
    t %= DURATION
    bar = int(t / BAR)
    local = t - bar * BAR
    chord = CHORDS[bar % len(CHORDS)]
    pad = sum(tone(local, n) for n in chord) / len(chord)
    value = 0.12 * envelope(local, BAR, 0.8, 0.85) * pad
    value += 0.085 * envelope(local, BAR, 0.15, 0.7) * tone(local, chord[0] - 12)
    for delay, gain in ((0.0, 0.075), (0.375, 0.025), (0.75, 0.012)):
        past = (t - delay) % DURATION
        pb = int(past / BAR)
        beat = (past % BAR) / 0.5
        step = int(beat)
        age = (beat - step) * 0.5
        note = CHORDS[pb % len(CHORDS)][PATTERN[step]] + 12
        if pb >= 4:
            value += gain * envelope(age, 0.5, 0.018, 0.23) * tone(age, note)
    fade = envelope(t, DURATION, 1.2, 1.2)
    return value * fade


def render_wav(path, rate=RATE, seconds=DURATION):
    if rate <= 0 or not 0 < seconds <= DURATION:
        raise ValueError("invalid render dimensions")
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        for start in range(0, round(rate * seconds), 4096):
            end = min(start + 4096, round(rate * seconds))
            values = [round(32767 * sample(i / rate)) for i in range(start, end)]
            out.writeframes(struct.pack("<" + "h" * len(values), *values))


def render_mp3(path):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required for MP3 encoding")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=path.parent) as tmp:
        wav = Path(tmp) / "lab.wav"
        mp3 = Path(tmp) / "lab.mp3"
        render_wav(wav)
        subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-i", str(wav),
                        "-c:a", "libmp3lame", "-b:a", "128k",
                        "-metadata", "title=Evidence in the Quiet",
                        "-metadata", "artist=99.9% SURE original procedural score",
                        str(mp3)], check=True)
        mp3.replace(path)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    if args.out.suffix.lower() != ".mp3":
        p.error("--out must end in .mp3")
    render_mp3(args.out)
    print(f"Original {DURATION:.0f}-second score: {args.out}")


if __name__ == "__main__":
    main()
