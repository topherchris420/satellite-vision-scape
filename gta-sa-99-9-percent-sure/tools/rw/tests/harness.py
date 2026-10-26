"""Minimal test harness (pytest is not required)."""

import os
import struct
import tempfile

import numpy as np

TESTS = []


class Skip(Exception):
    """Raise to mark a test as skipped (e.g. optional validator missing)."""


class Config:
    out_dir = None          # where test outputs are written
    dragonff_dir = None     # directory containing gtaLib/ (DragonFF checkout)
    librw_dir = None        # librw checkout (headers: rw.h, src/)
    librw_lib = None        # liblibrw.a built with -DRW_NULL
    verbose = False


def test(fn):
    TESTS.append(fn)
    return fn


def out_path(name):
    if Config.out_dir is None:
        Config.out_dir = tempfile.mkdtemp(prefix="rw_tests_")
    return os.path.join(Config.out_dir, name)


def log(*a):
    if Config.verbose:
        print("      ", *a)


def fnv1a(data: bytes) -> int:
    h = 2166136261
    for b in data:
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def deep_equal(a, b, path="obj", ignore=()):
    """Exact structural comparison of library objects (numpy arrays compared
    bit-for-bit incl. dtype, floats exactly).  Attribute names in ``ignore``
    are skipped.  Raises AssertionError naming the first differing path."""
    if isinstance(a, np.ndarray) or isinstance(b, np.ndarray):
        assert isinstance(a, np.ndarray) and isinstance(b, np.ndarray), "%s: array vs non-array" % path
        assert a.dtype == b.dtype, "%s: dtype %s != %s" % (path, a.dtype, b.dtype)
        assert a.shape == b.shape, "%s: shape %r != %r" % (path, a.shape, b.shape)
        assert a.tobytes() == b.tobytes(), "%s: array contents differ" % path
        return
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        assert len(a) == len(b), "%s: length %d != %d" % (path, len(a), len(b))
        for i, (x, y) in enumerate(zip(a, b)):
            deep_equal(x, y, "%s[%d]" % (path, i), ignore)
        return
    if hasattr(a, "__dict__") or hasattr(a, "__slots__"):
        assert type(a) is type(b), "%s: type %s != %s" % (path, type(a).__name__, type(b).__name__)
        keys = set(getattr(a, "__dict__", {}).keys()) | set(getattr(b, "__dict__", {}).keys())
        for cls in type(a).__mro__:
            keys.update(getattr(cls, "__slots__", ()))
        for k in sorted(keys):
            if k.startswith("__") or k in ignore:
                continue
            deep_equal(getattr(a, k, None), getattr(b, k, None), "%s.%s" % (path, k), ignore)
        return
    if isinstance(a, float) and isinstance(b, float):
        assert struct.pack("<d", a) == struct.pack("<d", b), "%s: %r != %r" % (path, a, b)
        return
    assert a == b, "%s: %r != %r" % (path, a, b)
