"""Tests for the new audio and playtest packaging, not the GTA engine."""
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
                self.assertFalse(any("model-preview" in n or n.endswith("gta3.img") for n in z.namelist()))
                mp3 = Path(tmp) / "lab.mp3"
                mp3.write_bytes(z.read("cleo/99sure/music/lab.mp3"))
            probe = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=codec_name,sample_rate,channels:format=duration",
                "-of", "json", str(mp3)], text=True)
            info = json.loads(probe)
            self.assertEqual(info["streams"][0]["codec_name"], "mp3")
            self.assertEqual(info["streams"][0]["sample_rate"], "44100")
            self.assertEqual(info["streams"][0]["channels"], 1)
            self.assertAlmostEqual(float(info["format"]["duration"]), 48, delta=0.2)


if __name__ == "__main__":
    unittest.main()
