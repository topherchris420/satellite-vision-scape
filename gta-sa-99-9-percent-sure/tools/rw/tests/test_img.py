"""IMG v2 archive tests."""

import struct

import rw
from rw.img import SECTOR
from harness import test, out_path, log
from test_dff import synthetic_bytes
from test_txd import synthetic_txd_bytes


@test
def img_write_read_extract():
    dff, txd = synthetic_bytes(), synthetic_txd_bytes()
    data = rw.write_img({"synthped.dff": dff, "synthped.txd": txd}, out_path("synth.img"))
    assert data[:4] == b"VER2" and struct.unpack_from("<I", data, 4)[0] == 2
    assert len(data) % SECTOR == 0
    img = rw.ImgArchive(out_path("synth.img"))
    assert img.names() == ["synthped.dff", "synthped.txd"]
    e0, e1 = img.entries
    assert e0.offset == 1 and e0.streaming_size == -(-len(dff) // SECTOR) and e0.size_in_archive == 0
    assert e1.offset == e0.offset + e0.streaming_size
    assert e1.streaming_size == -(-len(txd) // SECTOR)
    raw = img.extract("SYNTHPED.DFF")                       # case-insensitive
    assert len(raw) % SECTOR == 0 and raw[:len(dff)] == dff and not any(raw[len(dff):])
    assert img.extract("synthped.dff", trim=True) == dff
    assert img.extract("SynthPed.Txd", trim=True) == txd
    assert "SYNTHPED.TXD" in img and "nope.dff" not in img
    # sector-padded entries load directly (trailing zeros are ignored), and so
    # does data with non-zero garbage after the clump
    cl = rw.load_clump(raw)
    assert cl.to_bytes() == dff
    assert rw.load_clump(dff + b"\x01\x02\x03\x04garbage-after-clump").to_bytes() == dff
    assert rw.read_txd(img.extract("synthped.txd")).names() == ["synth_skin", "synth_cloth"]
    # the archive bytes are independent of the input container type
    assert rw.write_img([("synthped.dff", dff), ("synthped.txd", txd)]) == data
    log("IMG %d bytes, entries %r" % (len(data), [(e.name, e.offset, e.streaming_size) for e in img.entries]))


@test
def img_rejects_bad_input():
    for files in ({"a.dff": b"x", "A.DFF": b"y"}, {"x" * 24: b"x"}, {"empty.dff": b""}):
        try:
            rw.write_img(files)
        except ValueError:
            pass
        else:
            raise AssertionError("accepted %r" % list(files))
    try:
        rw.ImgArchive(b"VER1" + bytes(4))
    except ValueError:
        pass
    else:
        raise AssertionError("accepted non-VER2 archive")
    try:
        rw.ImgArchive(rw.write_img({"a.dff": b"x"})).find("b.dff")
    except KeyError:
        pass
    else:
        raise AssertionError("found a missing entry")
