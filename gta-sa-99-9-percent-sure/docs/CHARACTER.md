# CHRISW: Christopher Woodyard special ped

"99.9% SURE" spawns Christopher with `load_special_character 1 'CHRISW'`
(special slot 1 = model 290, SPECIAL01). The game then streams **`chrisw.dff`**
and **`chrisw.txd`**. This page covers how those two files are made, how to
build them on your own copy of the game, how to install them, and what has
and has not been checked.

Nothing here has been run in the game. Every check below was done on the files
themselves, with the `rw` package, DragonFF and librw, and with a software
renderer.

## Files

| Path | What |
|---|---|
| `tools/character/build_chris.py` | Build CLI: writes `chrisw.dff` + `chrisw.txd` |
| `tools/character/chris_model.py` | Procedural body, clothes and skin weights, built from a skeleton's joints |
| `tools/character/head_model.py` | Head, face (lips split for the Jaw bone, mouth pocket), facial weight fields, ears, hair and glasses (head-local, independent of the skeleton) |
| `tools/character/rig.py` | Skeleton access: joints, body frame, posing, linear blend skinning |
| `tools/character/meshkit.py`, `layout.py` | Mesh helpers, atlas layout and material order |
| `tools/character/chris_textures.py` | Texture painter (writes the PNGs below) |
| `tools/character/photo_face.py` | Photo cleanup (glasses removal, eyes and brows) and camera fit for the face |
| `tools/character/raster.py` | numpy software rasteriser (previews and texture baking) |
| `tools/character/preview_chris.py` | Preview renders, the facial animation sheet (jaw and brow test) and the comparison sheet |
| `tools/character/validate_chris.py`, `librw_texcheck.cpp` | Validation (rw, facial animation, DragonFF, librw) |
| `assets/character/textures/*.png` | Painted textures, the source of the TXD |
| `assets/character/previews/*.png` | Renders (see [Previews](#previews)) |
| `release/99sure/extras/model-preview/chrisw.dff`, `chrisw.txd` | Prebuilt on the synthetic skeleton, for model viewers only (see the warning below); `tools/build.py` writes it to `build/models/preview/` and packages it |

All tools need only Python 3 with numpy and Pillow.

## Build from your gta3.img (recommended)

```
cd gta-sa-99-9-percent-sure
python3 tools/character/build_chris.py --img "C:/Program Files/Rockstar Games/GTA San Andreas/models/gta3.img"
```

On Windows, `py -3` works in place of `python3`. The IMG is only read: the tool
reads its directory and the one `male01.dff` entry, and never loads or changes
the rest of the archive. The output goes to `build/models/chrisw.dff` and
`build/models/chrisw.txd` (`--out DIR` to change). [INSTALL.md](INSTALL.md)
uses `--out build/models/installable`; `python3 tools/build.py --img <gta3.img>`
builds there and packages the result into `release/99sure/modloader/99sure/`.

What it does:
1. Reads the reference ped DFF (`--reference`, default `male01`) with the `rw` package.
   It refuses files that are not skinned, have no HAnim hierarchy, or lack any of
   the 32 SA ped bone IDs.
2. Takes the joint positions from the reference skin's inverse bind matrices
   (`rw.skin_bind_pose`). That is the pose the game skins against.
3. Regenerates the whole mesh around those joints. Limbs are lofted along the
   actual bone segments, the torso follows the spine joints and the shoulder and
   hip widths, and the head sits on the Head bone.
4. Weights the lower face to the reference's own `Jaw` joint and the brows to its
   `L Brow`/`R Brow` joints (see [Facial animation](#facial-animation)).
5. Writes the DFF with `rw.build_skinned_ped_dff`. This copies the reference
   Frame List and inverse bind matrices verbatim, so the game's animations drive
   CHRISW exactly as they drive the reference ped.
6. Writes the TXD from `assets/character/textures/*.png`. The TXD does not depend
   on the skeleton.

Other options: `--reference-dff path/to/some_ped.dff` to use a DFF you extracted
yourself, `--textures DIR`, and `--json` to print a build report. The output is
deterministic: the same inputs give byte-identical files (checked by the
validator on this machine; see [Determinism](#determinism)).

### Why `male01` is the default reference, and how to pick another

From the gta-reversed sources (the reverse-engineered game code):
* `CStreaming::LoadInitialPeds()` (0x40D3D0) and `CStreaming::RemoveCurrentZonesModels()`
  request `MODEL_MALE01` (ID 7) as game-required, with the comment "Without this
  model the game basically crashes, it has to be loaded at all times". So every
  working install has it.
* `CAnimManager::CreateAnimAssocGroups()` (0x4D3CC0) builds the standard ped
  animation groups (`default`/`ped`, bikes, most weapon groups;
  `AnimAssocDefinitions.cpp`) on an instance of `MODEL_MALE01`. Its hierarchy is
  the one the game itself binds the standard animations to.
* `CPopulation` spawns it as an ordinary civilian (`AddPed(PED_TYPE_CIVMALE, MODEL_MALE01, ...)`).
  Its actual proportions could not be checked here, because no stock file was
  available.

To use another ped, pass `--reference <name>` (the IMG entry without `.dff`,
case-insensitive), for example a slimmer male civilian from your `gta3.img`. Pick
an ordinary skinned civilian or gang ped. Do not use the player model, which is
built from the clothes system. The tool stops with a message if the entry is
missing or unsuitable.

## Install

The game finds special characters by name in the IMG directories. In
`CStreaming::LoadCdDirectory`, any `.dff` that is not named in an IDE goes into
the "extra objects" directory (capacity 550). `CStreaming::RequestSpecialModel`
then looks `chrisw` up there, case-insensitively, and uses the TXD slot named
`chrisw`. If no such TXD exists, it falls back to `generic` and the ped renders
without its textures. If the DFF is missing, the request has no fallback.

1. Back up `models/gta3.img`.
2. Use one of these:
   * **IMG tool:** add `chrisw.dff` and `chrisw.txd` to `models/gta3.img` (or to
     another IMG archive the game loads) with an IMG editor, then rebuild or save
     the archive.
   * **Mod Loader:** copy both files to `modloader\99sure\chrisw.dff` and
     `modloader\99sure\chrisw.txd`.
3. Make sure no other `chrisw.dff`/`chrisw.txd` exists in any loaded IMG.

Use the files from your own `--img` build. The prebuilt in
`release/99sure/extras/model-preview/` is for model viewers only (see below).

## The synthetic-skeleton prebuilt (model viewers only)

`python3 tools/character/build_chris.py --synthetic` builds on
`rw.sa_ped_skeleton()`. That skeleton has the correct bone names, IDs and
hierarchy, but its bind-pose bone orientations are made up. SA animations set
absolute local bone rotations, and the local bone positions come from the skin.
A skeleton whose bind orientations differ from the stock ones is therefore not
expected to animate correctly: limbs would be twisted. Use the prebuilt to
inspect the files, not as the install.

The synthetic skeleton is also a mirror image. Its "L" bones are at +X while it
faces +Y, and RenderWare space is right-handed. The generator detects this
(`Rig.mirrored`) and keeps every part on the side its bone name says: the stripe
on his right chest, the emblem on his left. The prebuilt is therefore a mirror
image of what a stock skeleton gives. Its previews are flipped horizontally
(and labelled) to show the intended handedness. The stand-in skeleton used to
test the `--img` path is right-handed and needs no flip.

## Pipeline

**Skeleton → body frame** (`rig.py`). Right, forward and up come from the
joints alone: left-to-right shoulders and hips, ankles to toes plus head to
brows, feet to head. Everything is modelled in body-local metres (x right,
y forward, z up). Each part is then mapped to model space; for a mirrored
skeleton the triangle winding is reversed.

**Mesh** (`chris_model.py`, `head_model.py`). Triangles are counter-clockwise
seen from the front; UVs use the D3D convention.
* **Head:** a 12-row × 15-column grid with an elongated face (eye to chin
  0.118 m), nose, lips, chin and brow features, and caps at the crown and under
  the chin. Ears are double-sided flaps.
* **Mouth:** the lips are split so the Jaw bone can open them. The rows of the
  lower lip, the mouth and the nose base get two extra columns at the mouth
  corners as painted in the face texture. Between the corners, the mouth row
  lies on the painted lip line (`LIP_LINE`, measured on `chrisw_head.png`) and
  is split into an upper-lip edge and a lower-lip edge, which coincide in the
  bind pose. The corners are shared. Rows with and without the extra columns
  are joined by a zipper triangulation. Every new vertex lies on the closed
  surface the photo was baked onto, at its own texture coordinate, so the face
  texture stays registered and was not repainted. Behind the lips sits a
  22-triangle mouth pocket: an upper wall, a lower wall and a back wall, all
  facing into the pocket, textured from a dark `mouth` region of the clothes
  atlas with a dim hint of teeth. With the mouth closed the pocket is
  entirely behind the lips.
* **Hair:** a lumpy volume shell plus 19 curling, coily clumps. They are
  hand-placed after the photo and jittered by a seeded RNG. They fan outward
  and rise up to 11.4 cm above the scalp (the volume alone reaches 9.4 cm).
  The hair is about 30 cm across at the top and 20 cm at the temples, so it is
  wider at the top.
* **Glasses:** two round "panto" rims (16 segments: front, inner and outer
  faces), a keyhole bridge arch, temple arms that bend behind the ears, and
  lenses on their own alpha material.
* **Jacket:** an open shell (13 columns × 9 rows) with armholes that the
  sleeves attach to. It has a lining (inner faces), front-edge and hem
  thickness strips, a two-part collar (fold-down leaf and stand), and an emblem
  decal on the left chest.
* **Sleeves:** 8-sided, with a ring at the elbow, a cuff with lining, and a cap
  behind the wrist.
* **T-shirt:** a 12-column tube with a crew-neck rib and a lip tucked inside.
* **Trousers:** a 12-column pelvis that splits into two 8-sided legs through a
  crotch vertex, so there is no overlap. Each leg has a ring at the knee and a
  hem lining.
* **Sneakers:** lofted from heel to toe along Foot→Toe0.
* **Hands:** mittens with a thumb.
* **Pendant:** a dodecahedron (flat-shaded, silver open-frame texture) on a
  black cord.

**Skin weights.** Each part is rigid to its bone, with smooth two-bone blends
at the joints the brief lists:
* neck: Spine1/Neck, plus a ring at the Head joint with Neck/Head 50/50
* shoulders: Clavicle/UpperArm at the armholes, Spine1/Clavicle on the
  shoulder tops
* elbows, wrists and knuckles
* hips: Pelvis/Thigh
* knees and ankles, plus Toe0 for the toe box

The jacket and T-shirt hems also carry about 30% thigh, so walking does not
push the thighs through them. Hair, ears and glasses are rigid to Head. The
pendant is on Spine1. The face carries the facial bones (see
[Facial animation](#facial-animation)). No vertex has more than 3 weights.

**Textures** (`chris_textures.py`, `photo_face.py`). The face comes from the
supplied photo:
1. White balance, taken from the wall.
2. Partial flattening of the side lighting.
3. The glasses are removed: rims, lenses (which carry reflections), bridge and
   endpieces are filled from surrounding skin only, plus skin detail taken from
   the forehead. The 3D glasses are therefore not doubled in the texture.
4. Calm, slightly hooded eyes and the brows are painted back in.
5. A camera is fitted to 13 facial landmarks (rms 10.8 px). The cleaned photo is
   projected onto the head's texture chart through it, wherever the surface faces
   the camera and is not hidden (z-buffer).

The back and top of the head, the scalp, the neck, the ears and the hands are
painted procedurally in the photo's skin tone, RGB (82, 55, 46). The photo is
baked onto the closed face surface (`head_surface_mesh`). The model uses the
same surface with the lips split, so splitting the mouth left `chrisw_head.png`
unchanged: repainting reproduces it bit for bit. The clothes are procedural:
* charcoal jacket with seams, plackets, a teal stripe across the right chest
  pocket and slanted hip pockets
* the emblem decal: a hexagon outline with a three-spoke "cube", in #0B5D63
* pale mint tee with a rib collar
* dark trousers
* dark green-teal sneakers with white soles, toe caps and laces
* the mouth interior (`mouth` region of `chrisw_body`): dark red-brown, darker
  toward the throat, with a dim band of upper teeth at the top of the back wall
  and a fainter lower row

The original photo file is not in the repository. The face texture
`chrisw_head.png` is derived from it. The side-by-side sheet
`previews/chrisw_comparison.png` contains a downsampled crop of the photo, so
it is git-ignored and stays local. To repaint, run
`python3 tools/character/chris_textures.py --photo <photo>`. The landmarks were
measured by hand on the supplied 1154×1536 photo, and other images are refused.
Without `--photo`, a fully painted face is used, without the likeness.

**Files** (`build_chris.py`):
* Synthetic build: `rw.build_skinned_clump`. Frame 0 is `chrisw`, the 32 bones
  follow, and the atomic sits on frame 0.
* Reference build: `rw.build_skinned_ped_dff`.
* TXD: `rw.make_texture` and `rw.write_txd`, D3D9 format with full mip chains.

## Facial animation

SA's talking and expression animations move the face bones `Jaw` and
`L Brow` / `R Brow`. These are `BONE_JAW` = 8 and `BONE_L_BROW` /
`BONE_R_BROW` = 6 / 7 in gta-reversed `eBoneTag.h`. The animations are the
`START_CHAR_FACIAL_TALK` lip-sync and the `factalk`, `facsurp`, `facsurpm`,
`facurios`, `facanger` and `facgum` clips, which `AnimAssocDescriptions.h`
flags `ANIMATION_FACIAL`.

Which bones those clips key, and by how much, is stored in `ped.ifp`. That
file was not available here.

The face is weighted to these bones, around the skeleton's own joints
(`chris_model.w_face`, `head_model.jaw_mask`, `jaw_pivot_term`,
`brow_weight`):

* **Jaw:** the lower lip, the chin, the beard below the mouth and the jaw line.
  The weight is an anatomical mask times a pivot term:
  * The mask is 1 on the lower lip and chin. Along the lower-lip edge it falls
    to 0.4 at the mouth corners, which gives an oval opening. Toward the
    cheeks and the front of the ears it blends into Head (it reaches 0 at
    110° around the head). The upper lip stays on Head.
  * The pivot term uses the skeleton's `Jaw` joint. Opening the jaw lowers
    points in front of the joint but lifts points behind it. The term is
    therefore 1 from 15 mm in front of the joint and fades to 0 at 35 mm
    behind it. On a skeleton whose jaw joint sits in the chin (the synthetic
    and stand-in skeletons do) this keeps the underside of the chin from
    rising. On one with the joint near the ears, the whole jaw line follows.
  * The joint is used only inside a plausible box in head-local space: within
    3 cm of the mid-plane, from 4 cm behind the ear plane to the chin, and
    from 15 cm below eye level up to eye level. An implausible joint (for
    example one placed at the model origin) leaves the mouth on Head, and the
    build prints a note.
* **Brows:** a light Gaussian around each brow, peaking at 0.55, centred on
  that side's `Brow` joint and reaching further into the forehead than the
  eyelids. An implausible brow joint leaves that brow on Head.
* The mouth pocket takes the weights of the lip edge it hangs from, so no
  crack opens between them.

Synthetic build: Jaw 71 vertices, L Brow 12 and R Brow 12 (maximum weight
0.55). The stand-in build has the same counts.

## Budget

| | |
|---|---|
| Triangles | **2,949** (limit 1,500–3,000): `chrisw_body` 1,334 · `chrisw_head` 1,221 · `chrisw_acc` 362 · `chrisw_lens` 32 |
| Triangles by part | hair 629, jacket incl. lining/edges/collar 408, head+ears 396, glasses 320 incl. lenses, trousers 272, sleeves+cuffs 240, shoes 224, T-shirt 168, hands 148, pendant+cord 72, neck 48, mouth pocket 22, emblem 2 |
| Vertices | 2,146 |
| Skin | 32 bones, 26 used (including Jaw, L Brow and R Brow); at most 3 weights per vertex (format limit 4) |
| Materials | 4, in draw order: `chrisw_body`, `chrisw_head`, `chrisw_acc`, `chrisw_lens` (the translucent lenses are drawn last) |
| `chrisw_head` | 512×512 888, 10 mip levels: face, scalp, neck, ears, hands, hair |
| `chrisw_body` | 256×256 888, 9 levels: clothes and the mouth interior |
| `chrisw_acc` | 128×128 888, 8 levels: glasses frame, pendant, cord, emblem |
| `chrisw_lens` | 64×64 8888 with alpha, 7 levels |
| File sizes | `chrisw.txd` 1,857,520 bytes (uncompressed 32-bit, since the `rw` writer has no DXT encoder; stock ped TXDs are DXT and much smaller), `chrisw.dff` 177,639 bytes (synthetic build) |

## What was verified, and how

Run the checks with
`DRAGONFF_DIR=… LIBRW_DIR=… LIBRW_LIB=… python3 -I tools/character/validate_chris.py`.
The last run gave **49 passed, 0 failed, 0 skipped**:

* **Read back with `rw`:**
  * The DFF and TXD re-serialise byte-identically.
  * The 32 SA bone IDs, one skinned atomic, and Right To Render (0x116, 1).
  * Skin numBones is 32, at most 4 weights per vertex (the histogram is 1390 /
    709 / 47 vertices with 1 / 2 / 3 weights), weights are ≥ 0 and sum to 1
    (max error 3e-08), non-zero weights come first, and bone indices are valid.
  * There are two-bone-blended vertices at the neck, neck/head, shoulders,
    elbows, wrists, hips, knees and ankles.
  * Jaw, L Brow and R Brow carry vertices: 71, 12 and 12.
  * 2,949 triangles, unit normals, UVs within 0..1, no degenerate triangles, and
    99.9% of triangles wound consistently with their vertex normals.
  * The bind pose skins to itself (max move 2.7e-08 m), and the skin bind error
    is 4e-08.
  * Every material texture exists in the TXD with the same name, and the TXD
    sizes, formats, mip counts and alpha flags are as listed above.
* **Determinism:** two builds are byte-identical.
* **`--img` path, end to end, on a stand-in.** The validator makes a stand-in
  skeleton: 32 SA bones, right-handed, arms in an A-pose, different proportions
  and orientations. It is **not** a stock file. The validator packs it as
  `male01.dff` in an IMG and runs `build_chris.py --img` on it:
  * the streamed entry equals `rw.ImgArchive.extract`
  * the output Frame List is byte-identical to the reference's
  * the inverse bind matrices are bit-identical
  * hands, feet and forearms sit within 0.1–0.25 m of their joints
  * Jaw and both brows carry vertices (71, 12, 12)
  * the soles sit on the stand-in's ground
* **Facial animation, on both the synthetic DFF and the stand-in build.** The
  jaw is opened 13° about its own frame's axis: the local axis closest to
  left-right, signed so the chin goes down. The brow bones are raised 6 mm.
  Everything is skinned with the file's own weights.
  * **No inside-out triangles.** On the synthetic DFF 173 triangles deform,
    with a maximum normal turn of 31°. On the stand-in the maximum turn is 46°.
  * **The lips part with nothing seen through.** Tight 50 × 50 mm renders
    around the mouth were made from the front, both three-quarters, below and
    above, with back faces culled. They show no background through the face,
    and the pocket fills the gap. The test counts background enclosed by the
    face, plus any background within 15 mm of the mouth where the closed face
    was. Removing or flipping the pocket makes it fail with thousands of
    pixels.
  * **Closed, the pocket shows in none of those views.**
  * **The beard does not stretch.** The 17 chin and beard triangles below the
    lower lip, between the mouth corners, stay within 0.88–1.10 of their size
    on the synthetic DFF and 0.97–1.07 on the stand-in. Stretch is
    concentrated at the mouth corners and the blends into the cheeks: up to
    1.46 on the synthetic and 1.61 on the stand-in, where the shared corner
    vertex follows the jaw 40%.
  * **How far the lower lip moves.** On the synthetic DFF the lower lip moves
    11.2 mm. That skeleton's jaw axis is 36° off left-right because its
    orientations are invented, so its opening is skewed. On the stand-in,
    whose jaw axis is exactly left-right, it moves 13.1 mm.
  * **Other jaw positions (scratch test, not in the validator).** Stand-in
    variants were tried with the jaw joint near the ears and with it on the
    Head joint. Both passed the same checks, with lower-lip travel of 24.5 mm
    and 21.2 mm. A variant with the jaw 0.6 m away fell back to no jaw weights
    and printed a note.
* **DragonFF** (`tools/rw/tests` `check_dff_against_dragonff`) reads both the
  synthetic and the reference-path DFF with the same frames, HAnim, geometry,
  materials, Bin Mesh, skin and atomic fields as `rw`. All 34 TXD mip levels
  decode identically.
* **librw** (`check_dff_with_librw` plus `librw_texcheck.cpp`):
  * librw's reader gives the same LTMs, HAnim nodes, skin pipeline and counts,
    with a bind error of 2.4e-07.
  * librw's own writer reproduces the geometry chunk, except for the documented
    texture-filter bit.
  * TXD level hashes match.
  * With dummy textures disabled, all 4 material textures resolve from
    `chrisw.txd` (`RESOLVED 4/4`).
* `python3 -I tools/rw/tests/run_tests.py` still passes: 31/31 with the
  validators configured, 20 passed and 11 skipped without. `tools/rw` was not
  modified.
* The new mesh renders the closed face like the previous build. Over three
  close-ups, no pixel differs by more than 24 of 255, and the mean difference
  is under 1.
* The software previews (below) were inspected for likeness, outfit and
  deformation. They include a linear-blend-skinned pose test using the DFF's own
  weights.

## Not verified

* **Anything in the game.** That covers how he looks under SA's lighting and
  time of day, which mip level the game picks, and colour balance.
* **Alpha sorting.** The lenses use an alpha texture on the last material.
  Whether SA draws them without artefacts against the face and other
  transparent objects is unchecked.
* **Clipping in real animations:** walk, run, sit, aim, vehicles and
  cutscenes. The pose test only covers single joint rotations. Hands in the
  jacket, a seated hem and raised arms through the collar are all unchecked.
* **The stock skeleton.** No stock SA file was available. The `--img` path was
  exercised only on the stand-in. How well the mesh fits real `male01` joints
  (bind-pose arm angle, brow and Head joint offsets, which place the face), and
  the handedness of stock skeletons, are untested.
* **The synthetic skeleton's fidelity to stock** (its orientations are invented,
  see above).
* **Facial animation in the game.** The jaw and brows are weighted and tested
  only in the software previews. How far SA's clips rotate or move these
  bones, and where the stock `Jaw` and `Brow` joints sit, are unknown here. So
  the size of the mouth opening in game, and whether the brows rotate or
  translate, are unchecked. On the synthetic prebuilt, facial clips are no
  more expected to look right than its other animations (invented
  orientations; see above).
* **Mod Loader's handling** of the files, and memory and streaming cost of the
  1.8 MB TXD.

## Previews

`assets/character/previews/` (render with
`python3 tools/character/preview_chris.py --photo <photo> --concept <concept art>`):

| File | Shows |
|---|---|
| `chrisw_front.png`, `chrisw_three_quarter.png`, `chrisw_side.png`, `chrisw_back.png` | Bind pose |
| `chrisw_head_closeup.png`, `chrisw_head_front.png` | Head |
| `chrisw_relaxed_pose.png` | Arms lowered, the usual in-game stance |
| `chrisw_pose_test.png`, `chrisw_pose_joints.png` | Arm raise and lower, elbow, wrist, hip and knee bends, head turn, skinned with the DFF weights |
| `chrisw_facial.png` | Synthetic prebuilt: jaw closed, opened 13° about its own axis, and opened with the brows raised. Front, three-quarter, mouth close-up and profile views, plus the Jaw and Brow weights |
| `chrisw_facial_standin.png` | The same sheet for the `--img` build on the stand-in skeleton |
| `chrisw_comparison.png` | Head renders beside the photo and the concept art (git-ignored: contains a crop of the photo) |
| `chrisw_refit_standin.png` | The `--img` path on the stand-in skeleton |

`chrisw_facial_standin.png` and `chrisw_refit_standin.png` are rendered from the
validator's stand-in build: run `validate_chris.py --work DIR`, then
`preview_chris.py --dff DIR/ref_build/chrisw.dff --txd DIR/ref_build/chrisw.txd`
with `--facial <png>` or `--overview <png>`.

The renderer is a numpy z-buffer with Lambert lighting. It approximates the
look but is not RenderWare.

## Determinism

Seeds are fixed: `HAIR_SEED`, `SHELL_SEED`, the painter's `SEED`, and the photo
brow noise. The build reads the committed PNGs. The same inputs give
byte-identical DFF/TXD on the same platform; two builds were compared. On a
different OS or numpy build, last-bit floating-point differences could change
bytes, though not the visible result.
