"""Tests for the original audio and the release package, not the GTA engine."""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import lab_score
import package_playtest
import sound_design


class PlaytestTests(unittest.TestCase):
    def test_audio_headroom_and_boundary(self):
        values = [lab_score.sample(i / 4000) for i in range(4000 * 48)]
        self.assertLess(max(map(abs, values)), 0.35)
        self.assertGreater(max(map(abs, values)), 0.08)
        self.assertEqual(lab_score.sample(0), 0)
        self.assertAlmostEqual(lab_score.sample(48), 0)
        self.assertLess(abs(lab_score.sample(47.999)), 0.001)

    def test_wav_dimensions_and_repeatability(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / "a.wav", Path(tmp) / "b.wav"
            lab_score.render_wav(a, rate=8000, seconds=1)
            lab_score.render_wav(b, rate=8000, seconds=1)
            self.assertEqual(a.read_bytes(), b.read_bytes())
            with wave.open(str(a), "rb") as w:
                self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()),
                                 (1, 2, 8000, 8000))
                self.assertTrue(any(struct.unpack("<8000h", w.readframes(8000))))

    def test_missing_file_fails_before_encoding(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(package_playtest, "render_mp3") as render:
                with self.assertRaises(FileNotFoundError):
                    package_playtest.package(Path(tmp) / "out.zip", Path(tmp))
                render.assert_not_called()

    def test_release_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "out.zip"
            manifest = package_playtest.package(archive)
            with zipfile.ZipFile(archive) as z:
                self.assertIsNone(z.testzip())
                self.assertEqual(json.loads(z.read("MANIFEST.json")), manifest)
                for name, meta in manifest.items():
                    data = z.read(name)
                    self.assertEqual(len(data), meta["bytes"])
                    self.assertEqual(hashlib.sha256(data).hexdigest(), meta["sha256"])
                names = z.namelist()
                self.assertFalse(any("model-preview" in n or n.endswith("gta3.img") for n in names))
                for script in ("99sure_launcher.cs", "99sure.cm", "v3dhq.cm", "v3dghost.cm", "v3dfalse.cm",
                               "v3dlink.cm", "v3dopen.cm"):
                    self.assertIn(f"cleo/{script}", names)
                self.assertIn("STORY.md", names)
                mp3 = Path(tmp) / "lab.mp3"
                mp3.write_bytes(z.read("cleo/99sure/music/lab.mp3"))
                ogg = Path(tmp) / "amb.ogg"
                ogg.write_bytes(z.read("cleo/99sure/sfx/amb_lab.ogg"))
            loop = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=codec_name", "-of", "json", str(ogg)], text=True))
            self.assertEqual(loop["streams"][0]["codec_name"], "vorbis")
            probe = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=codec_name,sample_rate,channels:format=duration",
                "-of", "json", str(mp3)], text=True)
            info = json.loads(probe)
            self.assertEqual(info["streams"][0]["codec_name"], "mp3")
            self.assertEqual(info["streams"][0]["sample_rate"], "44100")
            self.assertEqual(info["streams"][0]["channels"], 1)
            self.assertAlmostEqual(float(info["format"]["duration"]), 48, delta=0.2)


class SoundDesignTests(unittest.TestCase):
    def test_every_sound_renders_quietly_and_loops_cleanly(self):
        for name in sound_design.SOUNDS:
            samples, looped = sound_design.render(name)
            peak = float(abs(samples).max())
            self.assertGreater(peak, 0.05, name)
            self.assertLessEqual(peak, 0.65, name)             # headroom for dialogue
            if looped:
                self.assertLess(abs(float(samples[0]) - float(samples[-1])), 0.08, name)
            else:
                self.assertLess(abs(float(samples[-1])), 0.01, name)   # faded out, no click

    def test_deterministic(self):
        a, _ = sound_design.render("rx_ghost")
        b, _ = sound_design.render("rx_ghost")
        self.assertTrue((a == b).all())


if __name__ == "__main__":
    unittest.main()
