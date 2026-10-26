// librw_texcheck.cpp -- does every material texture of a DFF resolve from a TXD?
//
// usage: librw_texcheck --txd chrisw.txd --dff chrisw.dff
//
// Loads the TXD with librw (https://github.com/aap/librw, NULL platform, D3D9
// raster code), makes it the current texture dictionary, disables texture
// loading from files and dummy textures, then loads the DFF.  librw's
// Texture::read looks the material texture names up in the current
// dictionary, so a material ends up with a texture only if the TXD has it.
// Prints one line per material and "RESOLVED <found>/<total>".
// Built by validate_chris.py with:  g++ -std=c++11 -DRW_NULL -I$LIBRW_DIR this.cpp $LIBRW_LIB
#include <rw.h>
#include <cstdio>
#include <cstring>

using namespace rw;

// GTA frame name plugin (0x0253F2FE): read and discard
static Stream *nameRead(Stream *s, int32 len, void *, int32, int32) { s->seek(len); return s; }
static void *nameCtor(void *o, int32, int32) { return o; }
static void *nameCopy(void *d, void *, int32, int32) { return d; }

int main(int argc, char *argv[]) {
	const char *txdPath = nil, *dffPath = nil;
	for(int i = 1; i < argc; i++) {
		if(strcmp(argv[i], "--txd") == 0 && i + 1 < argc) txdPath = argv[++i];
		else if(strcmp(argv[i], "--dff") == 0 && i + 1 < argc) dffPath = argv[++i];
	}
	if(!txdPath || !dffPath) { printf("usage: librw_texcheck --txd f.txd --dff f.dff\n"); return 2; }
	rw::streamAppendFrames = 1;
	Engine::init();
	registerMeshPlugin();
	registerNativeDataPlugin();
	registerAtomicRightsPlugin();
	registerMaterialRightsPlugin();
	xbox::registerVertexFormatPlugin();
	registerSkinPlugin();
	registerHAnimPlugin();
	registerMatFXPlugin();
	registerUVAnimPlugin();
	Frame::registerPlugin(4, 0x0253F2FE, nameCtor, nil, nameCopy);
	Frame::registerPluginStream(0x0253F2FE, nameRead, nil, nil);
	Engine::open(nil);
	Engine::start();
	rw::platform = PLATFORM_D3D9;

	StreamFile in;
	if(in.open(txdPath, "rb") == nil || !findChunk(&in, ID_TEXDICTIONARY, nil, nil)) { printf("ERROR txd\n"); return 1; }
	TexDictionary *txd = TexDictionary::streamRead(&in);
	in.close();
	if(txd == nil) { printf("ERROR txd read\n"); return 1; }
	TexDictionary::setCurrent(txd);
	printf("TXD textures=%d\n", txd->count());

	Texture::setLoadTextures(0);
	Texture::setCreateDummies(0);
	if(in.open(dffPath, "rb") == nil || !findChunk(&in, ID_CLUMP, nil, nil)) { printf("ERROR dff\n"); return 1; }
	Clump *c = Clump::streamRead(&in);
	in.close();
	if(c == nil) { printf("ERROR dff read\n"); return 1; }
	int total = 0, found = 0;
	FORLIST(lnk, c->atomics) {
		Atomic *a = Atomic::fromClump(lnk);
		Geometry *g = a->geometry;
		for(int m = 0; m < g->matList.numMaterials; m++) {
			Material *mat = g->matList.materials[m];
			Texture *t = mat->texture;
			int ok = t != nil && t->dict == txd && t->raster != nil && t->raster->width > 0;
			total++;
			found += ok;
			printf("MATERIAL %d texture=%s resolved=%d raster=%dx%d format=0x%X filter=0x%X\n", m,
			       t ? t->name : "(none)", ok, t && t->raster ? t->raster->width : 0,
			       t && t->raster ? t->raster->height : 0, t && t->raster ? t->raster->format : 0,
			       t ? t->filterAddressing : 0);
		}
	}
	printf("RESOLVED %d/%d\n", found, total);
	c->destroy();
	return found == total ? 0 : 1;
}
