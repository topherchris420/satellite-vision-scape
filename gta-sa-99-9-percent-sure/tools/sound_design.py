"""Original sound effects and ambience for the Vers3Dynamics expansion.

Everything here is synthesised from oscillators and seeded noise, so no
recording, sample library or game audio is involved. Each sound is rendered
to a 16-bit WAV and encoded with ffmpeg: one-shots to MP3, loops to Ogg
Vorbis (the CLEO audio plugin decodes both through BASS; Vorbis loops are
gapless).

    python3 tools/sound_design.py --out build/CLEO/99sure/audio

Loops are built so that their last sample flows into their first: every
partial completes a whole number of cycles over the loop length and noise is
made periodic in the frequency domain. The scripts set their volume from the
player's audio settings at the R.A.I.N. terminal.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import wave

import numpy as np

RATE = 44100
TAU = 2.0 * np.pi


# ---------------------------------------------------------------------------
# building blocks
# ---------------------------------------------------------------------------
def t_axis(seconds):
    return np.arange(int(round(seconds * RATE))) / RATE


def loop_freq(f, seconds):
    """Nearest frequency that completes a whole number of cycles in `seconds`."""
    return max(1, round(f * seconds)) / seconds


def periodic_noise(seconds, seed, lo=20.0, hi=18000.0, tilt=0.0):
    """Seamlessly looping noise: random phases on a band of FFT bins.

    tilt is the spectral slope in dB per octave (-3 = pink, -6 = brown).
    """
    n = int(round(seconds * RATE))
    rng = np.random.default_rng(seed)
    freqs = np.fft.rfftfreq(n, 1.0 / RATE)
    mag = np.zeros_like(freqs)
    band = (freqs >= lo) & (freqs <= hi)
    mag[band] = (freqs[band] / 1000.0) ** (tilt / 6.02)
    spec = mag * np.exp(1j * rng.uniform(0, TAU, freqs.size))
    out = np.fft.irfft(spec, n)
    return out / (np.max(np.abs(out)) + 1e-12)


def env_ar(t, attack, release, length=None):
    length = t[-1] if length is None else length
    a = np.clip(t / max(attack, 1e-4), 0.0, 1.0)
    r = np.clip((length - t) / max(release, 1e-4), 0.0, 1.0)
    return np.minimum(a, r)


def env_exp(t, decay):
    return np.exp(-t / decay)


def tone(t, f, harmonics=((1, 1.0),), phase=0.0):
    out = np.zeros_like(t)
    for k, a in harmonics:
        out += a * np.sin(TAU * f * k * t + phase * k)
    return out


def place(buf, clip, at):
    i = int(round(at * RATE))
    j = min(buf.size, i + clip.size)
    if i < buf.size:
        buf[i:j] += clip[:j - i]


def normalise(x, peak):
    m = np.max(np.abs(x))
    return x if m == 0 else x * (peak / m)


# ---------------------------------------------------------------------------
# the sounds
# ---------------------------------------------------------------------------
def amb_lab():
    """Equipment room tone: mains hum, fans, a faint CRT whine, relays and disks."""
    sec = 16.0
    t = t_axis(sec)
    hum = tone(t, loop_freq(60, sec), ((1, 1.0), (2, 0.55), (3, 0.3), (5, 0.12)))
    hum *= 0.55 + 0.08 * np.sin(TAU * loop_freq(0.25, sec) * t)
    fans = periodic_noise(sec, 11, lo=60, hi=4000, tilt=-3.0)
    fans += 0.35 * tone(t, loop_freq(97.5, sec), ((1, 1.0), (2, 0.4)))          # fan blade rate
    whine = 0.018 * np.sin(TAU * loop_freq(15734, sec) * t)                       # NTSC line rate
    out = 0.32 * hum + 0.24 * fans + whine
    rng = np.random.default_rng(12)
    click_t = t_axis(0.012)
    click = periodic_noise(0.012, 13, lo=800, hi=9000) * env_exp(click_t, 0.002)
    for at in (1.3, 1.36, 5.8, 9.1, 9.14, 13.7):                                  # relay pairs
        place(out, 0.35 * click, at)
    seek_t = t_axis(0.03)
    seek = periodic_noise(0.03, 14, lo=1500, hi=7000) * env_exp(seek_t, 0.006)
    for at in np.sort(rng.uniform(0.5, 15.4, 14)):                                # disk seeks
        place(out, 0.12 * seek, at)
    return normalise(out, 0.6), True


def ui_move():
    t = t_axis(0.06)
    out = tone(t, 2100.0, ((1, 1.0), (2, 0.2))) * env_exp(t, 0.012)
    return normalise(out, 0.45), False


def ui_ok():
    t = t_axis(0.22)
    f = np.where(t < 0.07, 660.0, 990.0)
    phase = TAU * np.cumsum(f) / RATE
    out = (np.sin(phase) + 0.25 * np.sin(2 * phase)) * env_ar(t, 0.004, 0.12)
    return normalise(out, 0.5), False


def ui_back():
    t = t_axis(0.2)
    f = np.where(t < 0.07, 740.0, 494.0)
    phase = TAU * np.cumsum(f) / RATE
    out = np.sin(phase) * env_ar(t, 0.004, 0.11)
    return normalise(out, 0.42), False


def rain_boot():
    """R.A.I.N. starting up: CRT degauss thump, then a rising five-note figure."""
    sec = 1.6
    t = t_axis(sec)
    out = np.zeros_like(t)
    th_t = t_axis(0.5)
    thump = np.sin(TAU * 52 * th_t) * env_exp(th_t, 0.12) * (1 + 0.6 * np.sin(TAU * 7 * th_t))
    place(out, 0.9 * thump, 0.0)
    for i, note in enumerate((62, 66, 69, 73, 74)):                 # D, F#, A, C#, D
        nt = t_axis(0.42)
        f = 440 * 2 ** ((note - 69) / 12)
        place(out, 0.33 * tone(nt, f, ((1, 1.0), (2, 0.3), (3, 0.08))) * env_ar(nt, 0.01, 0.35), 0.45 + i * 0.16)
    return normalise(out, 0.6), False


def chime(notes, seconds, decay, bright=0.25):
    t = t_axis(seconds)
    out = np.zeros_like(t)
    for i, note in enumerate(notes):
        f = 440 * 2 ** ((note - 69) / 12)
        nt = t_axis(seconds - i * 0.09)
        place(out, tone(nt, f, ((1, 1.0), (2, bright), (4.2, bright * 0.25))) * env_exp(nt, decay)
              * env_ar(nt, 0.006, 0.05), i * 0.09)
    return out


def rain_acc():
    return normalise(chime((69, 73, 76), 1.1, 0.35), 0.55), False             # A major, rising


def rain_rej():
    t = t_axis(0.55)
    buzz = tone(t, 110.0, ((1, 1.0), (2, 0.6), (3, 0.45), (4, 0.3))) * env_exp(t, 0.16)
    out = 0.7 * buzz + 0.5 * chime((57, 58), 0.55, 0.12, bright=0.1)          # A, B-flat
    return normalise(out, 0.55), False


def rain_abs():
    return normalise(chime((64, 71), 1.2, 0.5, bright=0.12), 0.45), False     # open fifth: undecided


def rain_warn():
    """Soft alarm for an overconfident conclusion (a tritone that does not resolve)."""
    sec = 1.2
    t = t_axis(sec)
    out = np.zeros_like(t)
    for i in range(3):
        nt = t_axis(0.3)
        pair = tone(nt, 466.2, ((1, 1.0), (3, 0.2))) + tone(nt, 659.3, ((1, 0.8),))
        place(out, pair * env_ar(nt, 0.01, 0.15), i * 0.38)
    return normalise(out, 0.45), False


def gen_tone():
    """Signal generator: 220 Hz sine. The scripts change its playback speed to tune it."""
    sec = 2.0
    t = t_axis(sec)
    out = np.sin(TAU * loop_freq(220.0, sec) * t)
    return normalise(out, 0.5), True


def plate_hum():
    """A metal plate driven at resonance, with sand dancing on it."""
    sec = 4.0
    t = t_axis(sec)
    f0 = loop_freq(220.0, sec)
    out = tone(t, f0, ((1, 1.0), (2, 0.5), (3, 0.42), (4.98, 0.18), (6.6, 0.1)))
    out *= 0.8 + 0.2 * np.sin(TAU * loop_freq(3.0, sec) * t)
    sand = periodic_noise(sec, 21, lo=3000, hi=12000)
    sand *= 0.5 + 0.5 * np.abs(np.sin(TAU * loop_freq(13.0, sec) * t))
    return normalise(0.8 * out + 0.22 * sand, 0.55), True


def plate_lock():
    """A resonant mode found: a clean bell with a long tail."""
    return normalise(chime((76, 83, 88), 2.2, 0.8, bright=0.35), 0.5), False


def rx_static():
    """Receiver hiss with crackle, for direction finding."""
    sec = 8.0
    t = t_axis(sec)
    hiss = periodic_noise(sec, 31, lo=300, hi=6500, tilt=-1.5)
    rng = np.random.default_rng(32)
    crack_t = t_axis(0.008)
    crack = periodic_noise(0.008, 33, lo=1000, hi=12000) * env_exp(crack_t, 0.0015)
    out = 0.6 * hiss
    for at in rng.uniform(0.05, sec - 0.05, 40):
        place(out, rng.uniform(0.3, 0.9) * crack, at)
    out *= 0.85 + 0.15 * np.sin(TAU * loop_freq(0.5, sec) * t)
    return normalise(out, 0.5), True


def rx_ghost():
    """The ghost signal: a 1 kHz carrier keyed in a slow seven-pulse pattern."""
    sec = 6.0
    t = t_axis(sec)
    carrier = tone(t, loop_freq(1000.0, sec), ((1, 1.0), (3, 0.12)))
    key = np.zeros_like(t)
    for i in range(7):
        a = 0.4 + i * 0.32
        key += env_ar(np.clip(t - a, 0, None), 0.01, 0.03, 0.14) * ((t >= a) & (t < a + 0.14))
    # a long final dash, then silence: the pattern listeners keep calling a "ghost"
    a = 2.9
    key += env_ar(np.clip(t - a, 0, None), 0.02, 0.1, 1.1) * ((t >= a) & (t < a + 1.1))
    warble = 1 + 0.004 * np.sin(TAU * loop_freq(5.0, sec) * t)
    out = carrier * key * warble
    return normalise(out, 0.5), True


def sentinel():
    """SENTINEL's corporate three-tone alert."""
    t_total = 1.0
    out = np.zeros(int(t_total * RATE))
    for i, note in enumerate((79, 76, 72)):
        nt = t_axis(0.3)
        f = 440 * 2 ** ((note - 69) / 12)
        place(out, tone(nt, f, ((1, 1.0), (2, 0.15))) * env_ar(nt, 0.005, 0.2), i * 0.22)
    return normalise(out, 0.5), False


def crowd():
    """Plaza crowd murmur: noise shaped by moving vowel-like resonances."""
    sec = 10.0
    t = t_axis(sec)
    base = periodic_noise(sec, 41, lo=120, hi=3500, tilt=-3.0)
    out = np.zeros_like(t)
    for k, (f, rate) in enumerate(((420, 0.7), (780, 1.1), (1300, 0.9), (2300, 1.3))):
        band = periodic_noise(sec, 50 + k, lo=f * 0.7, hi=f * 1.3)
        out += band * (0.55 + 0.45 * np.sin(TAU * loop_freq(rate, sec) * t + k))
    out = 0.5 * base + 0.5 * out
    return normalise(out, 0.45), True


SOUNDS = {
    "amb_lab": amb_lab, "ui_move": ui_move, "ui_ok": ui_ok, "ui_back": ui_back,
    "rain_boot": rain_boot, "rain_acc": rain_acc, "rain_rej": rain_rej, "rain_abs": rain_abs,
    "rain_warn": rain_warn, "gen_tone": gen_tone, "plate_hum": plate_hum, "plate_lock": plate_lock,
    "rx_static": rx_static, "rx_ghost": rx_ghost, "sentinel": sentinel, "crowd": crowd,
}


# ---------------------------------------------------------------------------
def write_wav(path, samples):
    data = np.clip(np.round(samples * 32767.0), -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        w.writeframes(data.tobytes())


def encode(wav, out, title, looped):
    """One-shots become MP3. Loops become Ogg Vorbis, which BASS (the CLEO audio
    plugin's decoder) plays gaplessly; MP3 pads the start and end with silence."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to encode the sounds")
    codec = ["-c:a", "libvorbis", "-q:a", "5"] if looped else ["-c:a", "libmp3lame", "-b:a", "128k"]
    subprocess.run([ffmpeg, "-nostdin", "-y", "-v", "error", "-i", str(wav), *codec,
                    "-metadata", f"title={title}",
                    "-metadata", "artist=99.9% SURE original sound design", str(out)], check=True)


_EXT = {}


def render(name):
    samples, looped = SOUNDS[name]()
    _EXT[name] = ".ogg" if looped else ".mp3"
    if looped:
        # a loop must not click where it wraps round
        if abs(samples[0] - samples[-1]) > 0.08:
            raise ValueError(f"{name}: loop boundary jumps by {abs(samples[0] - samples[-1]):.3f}")
    else:
        fade = min(samples.size, int(0.004 * RATE))
        samples[-fade:] *= np.linspace(1.0, 0.0, fade)
    return samples, looped


def build(out_dir, names=None):
    os.makedirs(out_dir, exist_ok=True)
    made = []
    with tempfile.TemporaryDirectory() as tmp:
        for name in names or SOUNDS:
            samples, looped = render(name)
            wav = os.path.join(tmp, name + ".wav")
            write_wav(wav, samples)
            out = os.path.join(out_dir, name + _EXT[name])
            encode(wav, out, name, looped)
            made.append(os.path.basename(out))
    return made


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("names", nargs="*")
    args = ap.parse_args()
    made = build(args.out, args.names)
    print(f"{len(made)} original sounds -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
