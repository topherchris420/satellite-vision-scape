Christopher (chrisw.dff / chrisw.txd) built on a SYNTHETIC skeleton.

Do not install these in the game. GTA San Andreas animations set absolute bone
rotations, and this skeleton's bone orientations are not the game's, so the
model would animate twisted. They are here to inspect the mesh and textures in
a model viewer (for example Blender with DragonFF).

To get the installable model, build it on the stock skeleton from your own
models\gta3.img (read only):

    python tools/character/build_chris.py --img "<GTA San Andreas>\models\gta3.img"

then copy the two files it writes to <GTA San Andreas>\modloader\99sure\.
See INSTALL.md, section 4.
