"""rw -- GTA San Andreas PC (RenderWare 3.6.0.3) binary formats: DFF, TXD, IMG v2.

Pure Python + numpy.  Layouts follow librw (aap, MIT); see README.md.

Quick reference::

    from rw import load_clump, get_hierarchy, world_bind_matrices, build_skinned_ped_dff
    from rw import make_texture, write_txd, read_txd, ImgArchive, write_img

    ref = load_clump("wmybar.dff")              # stock ped as skeleton reference
    hier = get_hierarchy(ref)                    # HAnim node order == skin bone index
    print(hier.bone_names, hier.bone_ids)
    build_skinned_ped_dff(ref, mesh, [("mytex", (255, 255, 255, 255))], "out.dff")
    write_txd([make_texture("mytex", rgba_array)], "out.txd")
"""

from .chunk import (
    RWError, LIBRARY_ID_SA, RW_VERSION_SA, RW_BUILD_SA, pack_library_id, unpack_library_id,
    version_string, chunk_bytes, Chunk, parse_chunks, read_top_level, chunk_name,
)
from .dff import (
    RawChunk, FrameName, HAnimNode, HAnimPLG, Frame, Texture, Material, BinMesh, SkinPLG,
    MorphTarget, Geometry, RightToRender, AtomicMatFX, Atomic, Clump, read_clump, write_clump,
    compute_bounding_sphere, pack_filter_addressing, unpack_filter_addressing,
    DEFAULT_FILTER_ADDRESSING,
)
from .txd import (
    TextureNative, TexDictionary, read_txd, write_txd, make_texture, generate_mipmaps,
    decode_dxt1, decode_dxt3, decode_dxt5,
)
from .img import ImgArchive, ImgEntry, write_img, rw_stream_length
from .ped import (
    load_clump, world_bind_matrices, Hierarchy, get_hierarchy, compute_hanim_node_flags,
    BoneSpec, sa_ped_skeleton, SA_PED_BONES, SkinnedMesh, normalize_skin_weights, make_material,
    build_skinned_geometry, build_skinned_clump, make_skinned_ped_clump, build_skinned_ped_dff,
    inverse_bind_matrices, matrix_to_rw16, rw16_to_matrix, skin_bind_error, skin_bind_pose,
)

__version__ = "1.0.0"
