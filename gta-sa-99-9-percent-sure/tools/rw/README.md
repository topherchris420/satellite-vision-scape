# rw: GTA San Andreas (PC, RenderWare 3.6) DFF / TXD / IMG library

Pure Python 3 + numpy (Pillow optional, only to accept PIL images). It covers the
binary-format layer for a custom skinned ped: read/write DFF clumps (frames, HAnim,
geometry, materials, Bin Mesh, Skin), read/write D3D9 TXDs, read/write IMG v2
archives, and a `dump` CLI.

The authority for chunk layouts is **librw** (aap, MIT), commit
`18532c2e13efbc1aa43f0b00b4459831f9414de0`; `file:line` references below are to
that commit. DragonFF (GPL-3.0) was used only as reading material and as an
independent validator in the tests. None of its code is in this package.

```
tools/rw/
  __init__.py   public API (re-exports)
  chunk.py      section headers, libraryID packing, generic chunk tree
  dff.py        Clump / Frame / HAnim / Geometry / Material / Texture / BinMesh / Skin / Atomic
  txd.py        TexDictionary / TextureNative (D3D9 write; D3D9+D3D8 read), decoders, mipmaps
  img.py        IMG v2 ("VER2") reader / writer
  ped.py        high-level skinned-ped helpers
  dump.py       python -m rw.dump
  tests/        run_tests.py + test modules + librw_validate.cpp
```

## Quick start

```python
import sys; sys.path.insert(0, "gta-sa-99-9-percent-sure/tools")
import numpy as np, rw

ref = rw.load_clump("wmybar.dff")          # stock ped used as the skeleton reference
h = rw.get_hierarchy(ref)                   # or ref.hierarchy
h.bone_names, h.bone_ids                    # node order == skin bone index order
bind = rw.skin_bind_pose(ref)               # (32,4,4) joints the game skins against
frames_w = rw.world_bind_matrices(ref)      # (numFrames,4,4) from the frame hierarchy

mesh = dict(vertices=V, normals=N, uvs=UV,        # (N,3) (N,3) (N,2)
            triangles=T, material_ids=M,           # (M,3) (M,)
            bone_indices=BI, bone_weights=BW)      # (N,4) node indices, (N,4) sum to 1
rw.build_skinned_ped_dff(ref, mesh, [("mychar_body", (255,255,255,255)),
                                     ("mychar_head", (255,255,255,255))], "mychar.dff")

rw.write_txd([rw.make_texture("mychar_body", body_rgba),   # (h,w,4) uint8 or PIL image
              rw.make_texture("mychar_head", head_rgba)], "mychar.txd")
rw.write_img({"mychar.dff": open("mychar.dff","rb").read(),
              "mychar.txd": open("mychar.txd","rb").read()}, "mychar.img")
```

CLI (run from `tools/`, i.e. the directory that contains the `rw` package):

```
python -m rw.dump file.dff|file.txd [-v] [--max-depth N]   # section tree + decoded fields
python -m rw.dump archive.img [entry.dff]                   # list an IMG / dump one entry
```

## Conventions (read before generating data)

* **Matrices** returned by helpers are 4x4 float64 in *column-vector* convention
  (`p' = M @ [x,y,z,1]`): columns 0..3 = RW `right, up, at, pos`. RW stores the
  transpose. `Frame.rotation` is the raw (3,3) float32 with **rows** right/up/at,
  exactly as on disk. World matrices: `W[i] = W[parent] @ L[i]`.
* **Triangles** are `(v0, v1, v2)` = librw `Triangle.v[0..2]`, **counter-clockwise
  seen from the front** (outward normal = `cross(v1-v0, v2-v0)`). This was checked
  against the stored vertex normals of the four sample DFFs in librw's `tools/`
  directory. In teapot and checker, 100% of non-degenerate triangles agree; in the two
  RW 3.7 clumps, 99.5% and 97.9% agree, with the rest at smoothed-normal creases.
  On disk the u16 order is **v1, v0, matId, v2** (see below).
* **UVs** are stored as given, in the RW/D3D convention: `v = 0` is the *top* row of
  the texture image. Flip `v → 1 - v` if your tool uses OpenGL/Blender UVs.
* **Bone indices** in a skin = indices into the HAnim node table of the hierarchy
  root frame (`Hierarchy.nodes`), not frame indices and not bone IDs.
  `Hierarchy.node_frames[i]` is the frame for node `i` (matched by HAnim ID, as librw
  `findUnattachedById`, hanim.cpp:89-107).
* **Mesh space**: `build_skinned_ped_dff` expects vertices in the reference's model
  (atomic-frame) space, i.e. the space of its inverse bind matrices. Model around
  `skin_bind_pose(ref)`. `skin_bind_error(ref)` reports how far the reference's frame
  hierarchy is from its skin bind pose (≈1e-7 for files written by this library).
* **Names**: frame names ≤ 23 chars (SA keeps them in a 24-byte buffer). Texture and
  mask names ≤ 31 chars. IMG entry names ≤ 23 chars. Texture names in the DFF must
  match the TXD names. Keep the same case to be safe.

## Public API

| Area | Names |
|---|---|
| chunk | `RWError`, `LIBRARY_ID_SA` (0x1803FFFF), `pack_library_id`, `unpack_library_id`, `version_string`, `chunk_bytes`, `Chunk`, `parse_chunks`, `read_top_level`, `iter_top_level`, `find_top_level`, `chunk_name` |
| DFF model | `Clump` (`frames`, `geometries`, `atomics`, `lights`, `cameras`, `extensions`, `leading_chunks`, `.hierarchy`, `.skin`, `hanim_root_index()`, `skinned_atomic_indices()`, `to_bytes()`), `Frame` (`rotation`, `position`, `parent`, `matrix_flags`, `.name`, `.hanim`, `extensions`, `local_matrix()`), `HAnimPLG` (`node_id`, `nodes`, `flags`, `key_frame_size`), `HAnimNode(id,index,flags)`, `FrameName`, `Geometry` (`format_flags`, `num_vertices`, `triangles`, `tri_materials`, `uv_sets`, `prelit`, `morph_targets`, `materials`, `.vertices`, `.normals`, `.uvs`, `.bin_mesh`, `.skin`, `extensions`), `MorphTarget`, `Material`, `Texture`, `BinMesh`, `SkinPLG`, `Atomic`, `RightToRender`, `AtomicMatFX`, `RawChunk`, `read_clump`, `write_clump`, `compute_bounding_sphere`, `pack_filter_addressing` |
| TXD | `TexDictionary` (`textures`, `device_id`, `find()`), `TextureNative` (`from_image()`, `to_rgba(level)`, `pixel_format`, `has_alpha`, `levels`, …), `make_texture`, `read_txd`, `write_txd`, `generate_mipmaps`, `decode_dxt1/3/5` |
| IMG | `ImgArchive(path_or_bytes)` (`entries`, `names()`, `find()`, `extract(name, trim=False)`), `write_img(dict_or_pairs, path=None)`, `rw_stream_length` |
| peds | `load_clump`, `world_bind_matrices`, `get_hierarchy` / `Hierarchy`, `skin_bind_pose`, `skin_bind_error`, `build_skinned_ped_dff`, `make_skinned_ped_clump`, `build_skinned_clump` (from scratch), `build_skinned_geometry`, `SkinnedMesh`, `normalize_skin_weights`, `make_material`, `inverse_bind_matrices`, `compute_hanim_node_flags`, `sa_ped_skeleton`, `SA_PED_BONES`, `BoneSpec`, `matrix_to_rw16`, `rw16_to_matrix` |

### `build_skinned_ped_dff(reference, mesh, materials, out_path=None, atomic_matfx=False, keep_clump_extensions=False)`

* Copies the reference **Frame List verbatim**: matrices, parents, matrix flags,
  names, HAnim PLGs and unknown frame plugins. The test checks that the Frame List
  chunk is byte-identical.
* Copies the reference skin's **inverse bind matrices verbatim** (all 16 floats per
  bone, including the stored w column) and its `numBones`.
* New geometry: format `0x00010076` (POSITIONS|TEXTURED|NORMALS|LIGHT|MODULATE,
  1 UV set; `+PRELIT` if `prelit` given), one morph target with computed bounding
  sphere, material list (all `-1`), Bin Mesh (triangle lists per material), Skin.
* Skin weights are validated (≥0, sum to 1 ±1e-3) and canonicalised. Per vertex
  they are sorted by descending weight so non-zero weights come first, because RW's
  skin pipelines only read the first `maxWeightsPerVertex` entries. Unused slots get
  bone 0 / weight 0, and weights are renormalised. `usedBones` and
  `maxWeightsPerVertex` are computed.
* One atomic: the reference skinned atomic's frame and flags, Right To Render =
  `(0x116, 1)`, optional MatFX flag. Other reference atomics are not copied.
  The clump extension is empty unless `keep_clump_extensions`.
* `materials`: list of `(texture_name, (r,g,b,a))`, `Material`, or dict
  (`texture`, `color`, `mask`, `filter_addressing`, `surface_props`). Texture
  filter defaults to `0x1106` (wrap/wrap/LINEARMIPLINEAR); surface props default
  to `(1, 1, 1)`.

`build_skinned_clump(bones, mesh, materials, model_name=...)` builds the same
structure from scratch. Frame 0 is a root dummy named `model_name` with no HAnim.
Frames 1..N are the bones in depth-first pre-order. The first bone holds the HAnim
node table (flags 0, keyFrameSize 36, node flags PUSH/POP computed from the tree).
Every bone frame has an HAnim PLG with its ID. Inverse bind matrices are
`inv(W_bone) @ W_frame0`, and the atomic sits on frame 0. `sa_ped_skeleton()` gives
the 32 SA bones (IDs from gta-reversed `eBoneTag.h`) with a synthetic bind pose.

## On-disk layouts implemented (all little endian)

### Section header, libraryID (base.cpp:1084-1110, rwbase.h:698-722)
`u32 type, u32 size (payload only), u32 libraryID`. All writes use
`0x1803FFFF` = `pack(0x36003, 0xFFFF)`:
`((v-0x30000)&0x3FF00)<<14 | (v&0x3F)<<16 | build`. Versions ≤ 0x31000 pack as
`v>>8` (old style). Every chunk written gets an exact size. Reading checks that
every child chunk exactly tiles its parent and that every struct size matches its
counts (`RWError` with a path such as `Clump/Geometry[0]/Material List/Material[1]: …`).
Unknown extension chunks are kept as `RawChunk` (type, payload, *own* libraryID) and
written back unchanged. Lights and cameras are kept raw, and so are chunks before
the clump. Data after the first clump (IMG sector padding, garbage) is ignored.

### Clump (0x10), clump.cpp:148-344
| child | content |
|---|---|
| Struct (12) | `i32 numAtomics, i32 numLights, i32 numCameras` (4 bytes if RW ≤ 3.3) |
| Frame List (0x0E) | see below |
| Geometry List (0x1A) | Struct `i32 numGeometries`, then Geometry × n |
| Atomic (0x14) × numAtomics | see below |
| (Struct `i32 frame`, Light 0x12) × numLights | raw |
| (Struct `i32 frame`, Camera 0x05) × numCameras | raw |
| Extension (0x03) | empty for peds |

### Frame List (0x0E), frame.cpp:366-440
Struct: `u32 numFrames`, then per frame 56 bytes: `f32 right[3], up[3], at[3], pos[3], i32 parent (-1 root, must be < own index), u32 matrixFlags`.
Then one Extension per frame:
* **Frame name** `0x0253F2FE`: raw characters, no terminator, size = strlen (≤ 23).
* **HAnim PLG** `0x11E` (hanim.cpp:252-315): `i32 version (0x100), i32 nodeID, i32 numNodes`;
  if numNodes > 0: `i32 flags, i32 keyFrameSize (36)`, then numNodes ×
  `(i32 nodeID, i32 nodeIndex, i32 nodeFlags)`, where nodeFlags POP = 1 if the node
  is a leaf and PUSH = 2 if it has a later sibling (rwplugins.h:64-67; stack walk in
  `HAnimHierarchy::updateMatrices`, hanim.cpp:152-194).
* Order written for new frames: HAnim, then name. Read order is preserved.

### Geometry (0x0F), geometry.cpp:125-294
Struct:
```
u32 format  = flags | numTexSets << 16   (TRISTRIP 1, POSITIONS 2, TEXTURED 4, PRELIT 8,
                                           NORMALS 0x10, LIGHT 0x20, MODULATE 0x40,
                                           TEXTURED2 0x80, NATIVE 0x01000000 = unsupported)
i32 numTriangles, i32 numVertices, i32 numMorphTargets (1)
[f32 ambient, specular, diffuse        only if RW < 3.4]
[u8 RGBA × numVertices                 if PRELIT]
f32 (u,v) × numVertices × numTexSets
triangle × numTriangles: u16 v1, u16 v0, u16 matId, u16 v2
per morph target: f32 sphere x,y,z,r; i32 hasVertices; i32 hasNormals;
                  [f32 xyz × numVertices]; [f32 xyz × numVertices]
```
Triangle order (geometry.cpp:161-168 read, 252-259 write): librw packs
`tribuf[0] = v[0]<<16 | v[1]` and `tribuf[1] = v[2]<<16 | matId` as two u32s, so the
u16 stream is `v[1], v[0], matId, v[2]`. In 1-based naming that is "v2, v1, matId, v3".
The `rw` API always uses `(v[0], v[1], v[2])`.

Bounding sphere: centre = AABB centre as in librw (geometry.cpp:687-706). The radius
is the maximum vertex distance from that centre, rounded *up* to float32. This is
tighter than librw's half-diagonal but still contains every vertex (tested).

Then **Material List** (0x08, geometry.cpp:766-851): Struct `i32 n, i32 index[n]`.
An index of -1 means a Material chunk follows. An index ≥ 0 reuses an earlier slot,
which the reader resolves to the same object; the writer emits a reference only
when the same object repeats.

**Material** (0x07, geometry.cpp:915-1010): Struct 28 bytes
`i32 flags(0), u8 r,g,b,a, i32 unused, i32 isTextured, f32 ambient, specular, diffuse`,
then Texture (if textured) and Extension (empty).

**Texture** (0x06, texture.cpp:366-463): Struct `u32 filterAddressing`
(`addrV<<12 | addrU<<8 | filter`, librw adds 0x10000 on write for rasters without
AUTOMIPMAP, line 434. We write `0x1106`), String name, String mask (each
NUL-terminated and zero-padded to a multiple of 4, `size = strlen+4 & ~3`, lines
439/445), and an empty Extension.

**Geometry Extension**:
* **Bin Mesh PLG** `0x50E` (geoplg.cpp:95-212): `u32 flags (0 trilist / 1 tristrip),
  u32 numMeshes, u32 totalIndices`; per mesh `u32 numIndices, i32 materialIndex,
  u32 index × numIndices`. The writer makes one triangle list per material in
  material order with the original triangle order and `(v0,v1,v2)` per triangle, like
  `Geometry::buildMeshes` (geometry.cpp:514-563). Materials without triangles get no
  mesh, whereas librw would emit an empty one. Meshes read from files (e.g. tristrips)
  are preserved as-is.
* **Skin PLG** `0x116` (skin.cpp:75-253), RW ≥ 3.4 layout (the reader detects it like
  librw: `numUsedBones != 0`, line 142):
  ```
  u8 numBones, u8 numUsedBones, u8 maxWeightsPerVertex, u8 pad(0)
  u8 usedBones[numUsedBones]                 (sorted, bones with a non-zero weight)
  u8 boneIndices[numVertices][4]
  f32 weights[numVertices][4]
  f32 inverseBindMatrix[numBones][16]        RW layout: right.xyz, right.w, up.xyz, up.w,
                                             at.xyz, at.w, pos.xyz, pos.w -- NO marker
  i32 boneLimit, i32 numMeshes, i32 numRLE   (0,0,0 written)
  [u8 remap[numBones], u8[2] rleCount[numMeshes], u8[2] rle[numRLE]   if numMeshes]
  ```
  The `u32 0xDEADDEAD` marker before each matrix exists only in the old layout
  (`numUsedBones == 0`, no usedBones, no trailer; lines 158-162 and 211-214). The
  reader supports it, and also a new-layout chunk that lacks the trailer. Computed
  inverse matrices are written with w = (0,0,0,1). `right.w` holds RW matrix flags,
  and 0 is the safe value: RW's `Matrix::mult` treats the IDENTITY flag 0x20000 as
  an identity shortcut (base.cpp:325-336), and librw zeroes it before skinning
  (d3d9skin.cpp:249).

### Atomic (0x14), clump.cpp:513-595, 630-667
Struct 16 bytes `i32 frameIndex, i32 geometryIndex, u32 flags (5 = COLLISIONTEST|RENDER), i32 unused(0)`.
Extension:
* **Right To Render** `0x1F`: `u32 pluginID, u32 extraData`. Skinned atomics get
  `(0x116, 1)`. This is exactly what librw writes: its skin pipelines have
  `pluginID = ID_SKIN, pluginData = 1` (d3d9skin.cpp:406-413) and
  `writeAtomicRights` streams them (clump.cpp:640-657). On read, rights = Skin calls
  `Skin::setPipeline` (skin.cpp:306-320). I believe SA's stock peds carry the same
  chunk, but could not check that without a stock file.
* optional **Material Effects** `0x120`: `i32 enabled` (matfx.cpp:52-72).

### Texture Dictionary (0x16), texture.cpp:180-242
Struct `u16 textureCount, u16 deviceId`. librw always writes deviceId 0, and so do we
(`write_txd(..., device_id=)` to override). Then Texture Native × count, then Extension.

### Texture Native (0x15), D3D9, d3d/d3d9.cpp:704-850
Struct, 88-byte header:
```
u32 platformId (9)  u32 filterAddressing (0x1106)  char name[32]  char mask[32]
u32 rasterFormat    (0x0500 C8888 | 0x0600 C888, | 0x8000 MIPMAP when >1 level)
u32 d3dFormat       (21 D3DFMT_A8R8G8B8 | 22 D3DFMT_X8R8G8B8; DXTn = FourCC 'DXT1'...)
u16 width, u16 height, u8 depth (32), u8 numLevels, u8 rasterType (4 = texture)
u8  flags           (1 alpha, 2 cube, 4 auto-mipmap, 8 compressed)
[palette 4×32 (PAL4) or 4×256 (PAL8) bytes]
numLevels × (u32 size, pixel data)    8888/888: B,G,R,A bytes, size = w*h*4
```
Writing makes a full mip chain down to 1×1 (`floor(log2(max(w,h)))+1` levels =
librw `Raster::calculateNumLevels`, raster.cpp:134-141). Each level is a 2×2 box
filter with rounding. librw allocates the full chain for MIPMAP rasters
(d3d.cpp:413-426), so a partial chain would leave levels uninitialised. `fmt="auto"`
picks 8888 if any alpha < 255, else 888. The alpha flag bit is set only when alpha
is actually used. That is a deliberate deviation: librw sets it for every 8888
raster (d3d.cpp:280-291 table, applied at line 406), and it would enable alpha
blending needlessly in RW's D3D9 pipeline. Power-of-two sizes are enforced unless `allow_npot=True`. Reading also
accepts D3D8 (platform 8: `u32 hasAlpha` instead of d3dFormat, `u8 compression`
instead of flags; d3d8.cpp:531-676). Level sizes are not trusted for decoding:
`to_rgba` decodes DXT1 (565 rasters → opaque), DXT2/3, DXT4/5, 8888, 888, R8G8B8,
565, 555, 1555, 4444, L8, A8, A8L8, PAL8 and PAL4. For DXT2-5 it follows the D3D
rules (always 4-colour blocks). librw and DragonFF both use 3-colour mode when
c0 ≤ c1, and the tests avoid those blocks when comparing.

### IMG v2
`"VER2", u32 n`, n × `(u32 offset_sectors, u16 streamingSize_sectors, u16 sizeInArchive (0), char name[24])`,
2048-byte sectors. The writer puts the directory first, padded to a sector, then
each file sector-aligned and zero-padded, in insertion order. Names are 1-23 ASCII
chars, unique case-insensitively. Lookup is case-insensitive, and
`extract(trim=True)` cuts an RW stream after its top-level chunks.

## Validation performed

`python -I tests/run_tests.py -v` from `tools/rw`:

* **Round trips**
  * A synthetic 32-bone SA ped: frame 0 is dummy `synthped`, frame 1 is `Root` with
    32 nodes, all SA bone names and IDs, non-trivial bone rotations, 11 skinned boxes
    (264 vertices, 132 triangles, up to 4 weights) and 2 materials.
  * write → read → write is byte-identical (23116 bytes).
  * Every field of the read objects equals the built ones (exact, bit-for-bit
    arrays); read → write → read is identical too.
  * The four sample DFFs in librw's `tools/` (RW 3.5.0.0 and 3.7.0.2, non-skinned) parse
    and re-serialise byte-identically.
* **Layout assertions**
  * PUSH/POP flags. A Python run of librw's `updateMatrices` stack walk reproduces
    every bone's world matrix and ends with an empty stack.
  * The on-disk triangle order `v1,v0,matId,v2`.
  * Skin byte layout, plus non-zero split data, trailer-less and old
    (0xDEADDEAD) variants.
  * Inverse bind matrices: `inv(W) @ W = I` to 4e-8, with w column (0,0,0,1).
  * Bounding sphere containment.
  * Material references, and unknown plugin chunks in every extension kept
    verbatim, including a foreign libraryID.
  * Corrupted sizes raise `RWError`, and bad mesh input raises `ValueError`.
* **`build_skinned_ped_dff`** with a modified reference: the atomic is on frame 1,
  there is an extra unknown frame plugin, and one frame has matrix flags
  0x00020003. The output Frame List chunk is byte-identical to the reference's, the
  inverse matrices are raw-identical, the atomic frame is kept, and the weights are
  equivalent after canonicalisation.
* **DragonFF** (`gtaLib`, commit 54baca8e, imported read-only with bytecode writing
  disabled) loading our DFFs gives exactly our values for:
  * frame count, names, parents, matrices and flags
  * HAnim headers and node tables
  * vertices, normals, UVs, triangles, bounding sphere, material colours, textures
    and filter bytes
  * Bin Mesh triangles
  * skin numBones, usedBones, maxWeights, indices, weights and inverse matrices
    (DragonFF overwrites the w column, so it is not compared)
  * atomic fields and Right To Render

  For the TXD, both textures and **all mip levels decode pixel-identical**. On
  random DXT blocks its decoders differ from ours by ≤ 2 (RGB) and 0 (alpha),
  which is rounding.
* **librw**: `tests/librw_validate.cpp` is compiled against librw built for the NULL
  platform (no GPU). It loads our DFF and TXD with librw's own readers.
  * DFF:
    * 33 frames with names (via a small frame-name plugin in the validator) and
      parents.
    * Frame LTMs equal `world_bind_matrices` to 1e-5.
    * HAnim root frame 1 has 32 nodes with the same IDs, flags and attached frames.
    * The atomic gets the skin pipeline (pluginID 0x116, data 1) from Right To
      Render.
    * Geometry counts, flags, sphere and materials/texture names match.
    * Mesh header: trilist, 2 meshes, 396 indices.
    * Triangle, weight and index hashes match.
    * Skin: 32 bones, 17 used, 4 weights, trailer (0,0,0).
    * **Bind error with librw's matrix code 2.4e-7.**
    * librw's own writer, fed what it read, **re-serialises our geometry
      byte-identically** except the two texture filter words, where it adds 0x10000
      as documented above.
  * TXD: names, raster format, size, depth, levels and alpha match, every level's
    FNV hash matches, and librw's BGRA→RGBA(8888)/RGB(888) conversion equals our
    pixels. On the random DXT TXD librw's decoders differ from ours by ≤ 2 (RGB)
    and ≤ 1 (alpha), because librw truncates where we round.
* **D3D8 read path** (platform 8: 8888 and DXT1 test textures): it round-trips,
  decodes identically to the equivalent D3D9 textures, and agrees with DragonFF
  and librw (8888 exact, DXT1 ≤ 2).
* **IMG**: 2-entry archive written and read back, with sector layout, case-insensitive
  extraction, trimmed extraction equal to the input, and loading of padded entries.

Last run: `31 passed, 0 failed, 0 skipped` (20 core tests + 11 that need DRAGONFF_DIR / LIBRW_*). The full output is in the delivery report.

### Running the tests
```
cd gta-sa-99-9-percent-sure/tools/rw
python -I tests/run_tests.py -v                      # core tests (validators SKIP)
DRAGONFF_DIR=/path/to/dragonff LIBRW_DIR=/path/to/librw LIBRW_LIB=/path/to/liblibrw.a \
  python -I tests/run_tests.py -v --out /tmp/rw_out
```
To build `liblibrw.a` for the NULL platform, compile every `.cpp` under
`src/ src/d3d src/gl src/ps2 src/lodepng` (the list in librw's `src/CMakeLists.txt`)
with `g++ -std=c++11 -DRW_NULL -DLODEPNG_NO_COMPILE_CPP -I<librw>` into objects
*outside* the checkout, then `ar rcs liblibrw.a *.o`. This takes about 1 min on 4 cores.
The validator sets `rw::platform = PLATFORM_D3D9` so librw's CPU-side D3D9 raster
code handles textures.

## Assumptions, limitations, open questions

* **No stock SA file was available in this environment**, so reading a real SA ped
  or TXD has not been exercised. Coverage comes from the synthetic SA-structured ped,
  librw's sample DFFs, librw and DragonFF. The game itself was not run. The first
  in-game test of a generated ped is still outstanding.
* SA-specific choices taken from librw rather than from stock files:
  * Right To Render `(0x116,1)` on the atomic.
  * TXD deviceId 0.
  * Texture filter `0x1106` without 0x10000.
  * HAnim hierarchy flags 0 and keyFrameSize 36.
  * Scratch frames use matrix flags 0, as librw writes (frame.cpp:435). The RW 3.7
    sample uses 3. The reference path keeps the stock flags.
* Triangle lists are written, not strips. RW and SA accept both. Vertex count ≤ 65536.
* Native (pre-instanced PS2/Xbox) geometry, RW < 3.4 atomics with embedded geometry,
  and non-D3D TXDs are rejected with a clear `RWError`. Writing always produces the
  RW 3.4.0.3+ layout.
* `build_skinned_ped_dff` keeps only one atomic (the new skinned one). If the
  reference had extra atomics, they are dropped.
* If a reference's frames and skin disagree (`skin_bind_error(ref)` noticeably > 0),
  the mesh must follow `skin_bind_pose(ref)`. That is what the game uses for skinning.
