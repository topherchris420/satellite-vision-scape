"""GTA San Andreas IMG archive, version 2 ("VER2").

Layout (little endian; 1 sector = 2048 bytes):
    char[4]  "VER2"
    u32      number of entries
    entries  numEntries x 32 bytes:
               u32      offset          (in sectors, from start of file)
               u16      streamingSize   (in sectors)
               u16      sizeInArchive   (in sectors; SA writes 0 -- unused)
               char[24] name            (NUL terminated, <= 23 chars)
    data     each file starts on a sector boundary, padded to whole sectors.

Sizes are only known to sector granularity, so extracted data includes the
zero padding of the last sector.  ``extract(..., trim=True)`` cuts RW streams
(DFF/TXD) after their last top-level chunk.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Dict, Iterable, List, Mapping, Optional, Tuple, Union

__all__ = ["SECTOR", "ImgEntry", "ImgArchive", "write_img", "rw_stream_length"]

SECTOR = 2048
_ENTRY = struct.Struct("<IHH24s")


@dataclass
class ImgEntry:
    name: str
    offset: int            # sectors
    streaming_size: int    # sectors
    size_in_archive: int   # sectors (0 in SA archives)

    @property
    def size_sectors(self) -> int:
        return self.streaming_size or self.size_in_archive

    @property
    def byte_offset(self) -> int:
        return self.offset * SECTOR

    @property
    def byte_size(self) -> int:
        return self.size_sectors * SECTOR


def rw_stream_length(data: bytes) -> int:
    """Length of the run of valid top-level RW chunks at the start of data."""
    pos = 0
    while len(data) - pos >= 12:
        ctype, size, _ = struct.unpack_from("<III", data, pos)
        if ctype == 0 or size > len(data) - pos - 12:
            break
        pos += 12 + size
    return pos


class ImgArchive:
    """Read-only view of an IMG v2 archive (from a path or bytes)."""

    def __init__(self, source: Union[str, bytes, bytearray, "os.PathLike"]):
        if isinstance(source, (bytes, bytearray, memoryview)):
            self._data = bytes(source)
        else:
            with open(source, "rb") as fh:
                self._data = fh.read()
        d = self._data
        if len(d) < 8 or d[:4] != b"VER2":
            raise ValueError("not an IMG v2 archive (missing 'VER2' header)")
        (n,) = struct.unpack_from("<I", d, 4)
        if 8 + 32 * n > len(d):
            raise ValueError("IMG directory (%d entries) exceeds file size" % n)
        self.entries: List[ImgEntry] = []
        for i in range(n):
            off, ssz, asz, raw = _ENTRY.unpack_from(d, 8 + 32 * i)
            name = raw.split(b"\0", 1)[0].decode("latin-1")
            e = ImgEntry(name, off, ssz, asz)
            if e.byte_offset + e.byte_size > len(d):
                raise ValueError("IMG entry %r (sectors %d+%d) exceeds file size"
                                 % (name, off, e.size_sectors))
            self.entries.append(e)
        self._index = {}
        for e in self.entries:
            self._index.setdefault(e.name.lower(), e)

    def names(self) -> List[str]:
        return [e.name for e in self.entries]

    def __contains__(self, name: str) -> bool:
        return name.lower() in self._index

    def __len__(self):
        return len(self.entries)

    def find(self, name: str) -> ImgEntry:
        try:
            return self._index[name.lower()]
        except KeyError:
            raise KeyError("%r not in IMG archive" % name) from None

    def extract(self, name: str, trim: bool = False) -> bytes:
        """Return the entry's bytes (whole sectors).  Name lookup is
        case-insensitive.  trim=True cuts after the RW top-level chunks."""
        e = self.find(name)
        data = self._data[e.byte_offset:e.byte_offset + e.byte_size]
        if trim:
            n = rw_stream_length(data)
            if n:
                data = data[:n]
        return data


def write_img(files: Union[Mapping[str, bytes], Iterable[Tuple[str, bytes]]],
              path: Optional[str] = None) -> bytes:
    """Build a fresh IMG v2 archive from name -> bytes (insertion order kept)."""
    items = list(files.items()) if isinstance(files, Mapping) else list(files)
    seen = set()
    for name, data in items:
        enc = name.encode("ascii")
        if not enc or len(enc) > 23 or b"\0" in enc:
            raise ValueError("IMG entry name %r must be 1..23 ASCII characters" % name)
        if name.lower() in seen:
            raise ValueError("duplicate IMG entry name %r (names are case-insensitive)" % name)
        seen.add(name.lower())
        if len(data) == 0:
            raise ValueError("IMG entry %r is empty" % name)
        if (len(data) + SECTOR - 1) // SECTOR > 0xFFFF:
            raise ValueError("IMG entry %r too large for a u16 sector count" % name)
    header_sectors = (8 + 32 * len(items) + SECTOR - 1) // SECTOR
    dirbuf = [b"VER2", struct.pack("<I", len(items))]
    blobs = []
    cur = header_sectors
    for name, data in items:
        nsec = (len(data) + SECTOR - 1) // SECTOR
        dirbuf.append(_ENTRY.pack(cur, nsec, 0, name.encode("ascii").ljust(24, b"\0")))
        blobs.append(bytes(data) + b"\0" * (nsec * SECTOR - len(data)))
        cur += nsec
    head = b"".join(dirbuf)
    head += b"\0" * (header_sectors * SECTOR - len(head))
    out = head + b"".join(blobs)
    if path is not None:
        with open(path, "wb") as fh:
            fh.write(out)
    return out
