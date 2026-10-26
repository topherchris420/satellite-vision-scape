// librw_validate.cpp -- independent check of DFF/TXD files with librw
// (https://github.com/aap/librw, built for the NULL platform, no GPU needed).
//
// usage: librw_validate [--txd file.txd] [--dff file.dff] [--out dir]
//
// Prints one "KEY values..." line per fact; run_tests.py parses them.  With
// --out it also writes librw's own re-serialisation of every geometry
// (geo<i>.bin) and librw's RGBA/RGB decode of level 0 of every texture
// (tex<i>.raw) so the Python side can compare bytes.
#include <rw.h>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <string>

using namespace rw;

// --- GTA frame name plugin (0x0253F2FE), not part of librw -----------------
struct NodeName { char name[32]; };
static int32 nodeNameOffset;
static void *nameCtor(void *o, int32 off, int32) { PLUGINOFFSET(NodeName, o, off)->name[0] = 0; return o; }
static void *nameCopy(void *d, void *s, int32 off, int32) {
	memcpy(PLUGINOFFSET(NodeName, d, off), PLUGINOFFSET(NodeName, s, off), sizeof(NodeName)); return d; }
static Stream *nameRead(Stream *s, int32 len, void *o, int32 off, int32) {
	char *n = PLUGINOFFSET(NodeName, o, off)->name;
	int32 r = len < 31 ? len : 31;
	s->read8(n, r);
	n[r] = 0;
	if(len > r) s->seek(len - r);
	return s;
}
static const char *frameName(Frame *f) { return PLUGINOFFSET(NodeName, f, nodeNameOffset)->name; }

static uint32 fnv1a(const uint8 *p, uint32 n) {
	uint32 h = 2166136261u;
	for(uint32 i = 0; i < n; i++) { h ^= p[i]; h *= 16777619u; }
	return h;
}

static void printMatrix(const char *tag, int i, Matrix *m) {
	printf("%s %d %.9g %.9g %.9g %.9g %.9g %.9g %.9g %.9g %.9g %.9g %.9g %.9g\n", tag, i,
	       m->right.x, m->right.y, m->right.z, m->up.x, m->up.y, m->up.z,
	       m->at.x, m->at.y, m->at.z, m->pos.x, m->pos.y, m->pos.z);
}

static int indexOfFrame(Frame **list, int n, Frame *f) {
	for(int i = 0; i < n; i++) if(list[i] == f) return i;
	return -1;
}

// librw keeps only parent/child links after loading.  We number frames by a
// depth-first walk (children in stream order thanks to
// rw::streamAppendFrames = 1); this equals the on-disk frame order whenever
// the file lists frames in depth-first pre-order, as SA files and rw.dff do.
static void dfs(Frame *f, Frame **out, int *n) {
	out[(*n)++] = f;
	for(Frame *c = f->child; c; c = c->next) dfs(c, out, n);
}

static int dumpTxd(const char *path, const char *outdir) {
	StreamFile in;
	if(in.open(path, "rb") == nil) { printf("ERROR cannot open %s\n", path); return 1; }
	if(!findChunk(&in, ID_TEXDICTIONARY, nil, nil)) { printf("ERROR no texdict\n"); return 1; }
	TexDictionary *txd = TexDictionary::streamRead(&in);
	in.close();
	if(txd == nil) { printf("ERROR texdict read failed\n"); return 1; }
	TexDictionary::setCurrent(txd);
	printf("TXD %d\n", txd->count());
	int i = 0;
	FORLIST(lnk, txd->textures) {
		Texture *t = Texture::fromDict(lnk);
		Raster *r = t->raster;
		d3d::D3dRaster *ext = GETD3DRASTEREXT(r);
		int nl = r->getNumLevels();
		printf("TEX %d name=%s mask=%s filterAddressing=0x%X rasterFormat=0x%X width=%d height=%d depth=%d "
		       "numLevels=%d hasAlpha=%d d3dFormat=%u customFormat=%d platform=%d\n",
		       i, t->name, t->mask, t->filterAddressing, r->format, r->width, r->height, r->depth,
		       nl, ext->hasAlpha, ext->format, ext->customFormat, r->platform);
		for(int l = 0; l < nl; l++) {
			uint8 *px = r->lock(l, Raster::LOCKREAD);
			int32 sz = d3d::getLevelSize(r, l);
			printf("LEVEL %d %d size=%d fnv=0x%08X\n", i, l, sz, fnv1a(px, sz));
			r->unlock(l);
		}
		Image *img = r->toImage();
		if(img && outdir) {
			std::string fn = std::string(outdir) + "/tex" + std::to_string(i) + ".raw";
			FILE *f = fopen(fn.c_str(), "wb");
			fwrite(img->pixels, 1, img->width * img->height * img->bpp, f);
			fclose(f);
			printf("IMAGE %d width=%d height=%d bpp=%d path=%s\n", i, img->width, img->height, img->bpp, fn.c_str());
		}
		if(img) img->destroy();
		i++;
	}
	return 0;
}

static int dumpDff(const char *path, const char *outdir) {
	StreamFile in;
	if(in.open(path, "rb") == nil) { printf("ERROR cannot open %s\n", path); return 1; }
	if(!findChunk(&in, ID_CLUMP, nil, nil)) { printf("ERROR no clump\n"); return 1; }
	Clump *c = Clump::streamRead(&in);
	in.close();
	if(c == nil) { printf("ERROR clump read failed\n"); return 1; }

	Frame *root = c->getFrame();
	int nf = root->count();
	Frame **frames = new Frame*[nf];
	int n = 0;
	dfs(root, frames, &n);
	printf("FRAMES %d\n", nf);
	for(int i = 0; i < nf; i++) {
		Frame *f = frames[i];
		printf("FRAME %d name=%s parent=%d hanimID=%d\n", i, frameName(f),
		       indexOfFrame(frames, nf, f->getParent()), HAnimData::get(f)->id);
		printMatrix("LTM", i, f->getLTM());
	}

	HAnimHierarchy *hier = HAnimHierarchy::get(c);
	if(hier) {
		hier->attach();
		printf("HANIM root=%d numNodes=%d flags=%d\n", indexOfFrame(frames, nf, hier->parentFrame),
		       hier->numNodes, hier->flags);
		for(int i = 0; i < hier->numNodes; i++)
			printf("NODE %d id=%d index=%d flags=%d frame=%d name=%s\n", i, hier->nodeInfo[i].id,
			       hier->nodeInfo[i].index, hier->nodeInfo[i].flags,
			       indexOfFrame(frames, nf, hier->nodeInfo[i].frame),
			       hier->nodeInfo[i].frame ? frameName(hier->nodeInfo[i].frame) : "?");
	} else
		printf("HANIM none\n");

	int ai = 0;
	FORLIST(lnk, c->atomics) {
		Atomic *a = Atomic::fromClump(lnk);
		Geometry *g = a->geometry;
		printf("ATOMIC %d frame=%d flags=%d pipelinePluginID=0x%X pipelinePluginData=%d\n", ai,
		       indexOfFrame(frames, nf, a->getFrame()), a->object.object.flags,
		       a->pipeline ? a->pipeline->pluginID : 0, a->pipeline ? a->pipeline->pluginData : 0);
		printf("GEOMETRY %d flags=0x%X numVertices=%d numTriangles=%d numMorphTargets=%d numTexCoordSets=%d numMaterials=%d\n",
		       ai, g->flags, g->numVertices, g->numTriangles, g->numMorphTargets, g->numTexCoordSets,
		       g->matList.numMaterials);
		Sphere *s = &g->morphTargets[0].boundingSphere;
		printf("SPHERE %d %.9g %.9g %.9g %.9g\n", ai, s->center.x, s->center.y, s->center.z, s->radius);
		for(int m = 0; m < g->matList.numMaterials; m++) {
			Material *mat = g->matList.materials[m];
			printf("MATERIAL %d %d color=%d,%d,%d,%d texture=%s surface=%g,%g,%g\n", ai, m,
			       mat->color.red, mat->color.green, mat->color.blue, mat->color.alpha,
			       mat->texture ? mat->texture->name : "(none)", mat->surfaceProps.ambient,
			       mat->surfaceProps.specular, mat->surfaceProps.diffuse);
		}
		MeshHeader *mh = g->meshHeader;
		if(mh) {
			printf("MESHHEADER %d flags=%d numMeshes=%d totalIndices=%d\n", ai, mh->flags, mh->numMeshes, mh->totalIndices);
			Mesh *m = mh->getMeshes();
			for(uint32 k = 0; k < mh->numMeshes; k++)
				printf("MESH %d %d material=%d numIndices=%d\n", ai, k, g->matList.findIndex(m[k].material), m[k].numIndices);
		}
		uint32 th = 2166136261u;
		for(int t = 0; t < g->numTriangles; t++) {
			uint16 v[4] = { g->triangles[t].v[0], g->triangles[t].v[1], g->triangles[t].v[2], g->triangles[t].matId };
			for(int b = 0; b < 8; b++) { th ^= ((uint8*)v)[b]; th *= 16777619u; }
		}
		printf("TRIHASH %d 0x%08X\n", ai, th);
		Skin *skin = Skin::get(g);
		if(skin) {
			printf("SKIN %d numBones=%d numUsedBones=%d numWeights=%d boneLimit=%d numMeshes=%d rleSize=%d\n", ai,
			       skin->numBones, skin->numUsedBones, skin->numWeights, skin->boneLimit, skin->numMeshes, skin->rleSize);
			printf("USEDBONES %d", ai);
			for(int b = 0; b < skin->numUsedBones; b++) printf(" %d", skin->usedBones[b]);
			printf("\n");
			// bind pose check with librw's own matrix code:
			// invBone * boneLTM * inverse(atomicLTM) must be the identity
			if(hier && hier->numNodes == skin->numBones) {
				Matrix invAtm, tmp, tmp2;
				Matrix::invert(&invAtm, a->getFrame()->getLTM());
				float maxerr = 0.0f;
				for(int b = 0; b < skin->numBones; b++) {
					Matrix inv = ((Matrix*)skin->inverseMatrices)[b];
					inv.flags = 0;
					Frame *bf = hier->nodeInfo[b].frame;
					if(bf == nil) { maxerr = 1e30f; continue; }
					Matrix::mult(&tmp, bf->getLTM(), &invAtm);
					Matrix::mult(&tmp2, &inv, &tmp);
					float e[12] = { tmp2.right.x - 1, tmp2.right.y, tmp2.right.z,
					                tmp2.up.x, tmp2.up.y - 1, tmp2.up.z,
					                tmp2.at.x, tmp2.at.y, tmp2.at.z - 1,
					                tmp2.pos.x, tmp2.pos.y, tmp2.pos.z };
					for(int k = 0; k < 12; k++) if(fabsf(e[k]) > maxerr) maxerr = fabsf(e[k]);
				}
				printf("SKINBINDERR %d %.9g\n", ai, maxerr);
			}
			uint32 wh = 2166136261u;
			const uint8 *wp = (const uint8*)skin->weights;
			for(int k = 0; k < g->numVertices * 16; k++) { wh ^= wp[k]; wh *= 16777619u; }
			printf("WEIGHTHASH %d 0x%08X INDEXHASH 0x%08X\n", ai, wh, fnv1a(skin->indices, g->numVertices * 4));
		}
		if(outdir) {
			uint32 sz = 12 + g->streamGetSize();
			uint8 *buf = new uint8[sz];
			StreamMemory ms;
			ms.open(buf, 0, sz);
			g->streamWrite(&ms);
			std::string fn = std::string(outdir) + "/geo" + std::to_string(ai) + ".bin";
			FILE *f = fopen(fn.c_str(), "wb");
			fwrite(buf, 1, ms.getLength(), f);
			fclose(f);
			printf("GEOWRITE %d bytes=%u path=%s\n", ai, ms.getLength(), fn.c_str());
			delete[] buf;
		}
		ai++;
	}
	delete[] frames;
	c->destroy();
	return 0;
}

int main(int argc, char *argv[]) {
	const char *txd = nil, *dff = nil, *out = nil;
	for(int i = 1; i < argc; i++) {
		if(strcmp(argv[i], "--txd") == 0 && i + 1 < argc) txd = argv[++i];
		else if(strcmp(argv[i], "--dff") == 0 && i + 1 < argc) dff = argv[++i];
		else if(strcmp(argv[i], "--out") == 0 && i + 1 < argc) out = argv[++i];
	}
	rw::streamAppendFrames = 1;   // keep children in stream order
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
	nodeNameOffset = Frame::registerPlugin(sizeof(NodeName), 0x0253F2FE, nameCtor, nil, nameCopy);
	Frame::registerPluginStream(0x0253F2FE, nameRead, nil, nil);
	Engine::open(nil);
	Engine::start();
	// Dummy textures for names missing from the TXD need a raster; the NULL
	// driver cannot create one, the D3D9 driver code can (CPU-side levels).
	rw::platform = PLATFORM_D3D9;
	Texture::setLoadTextures(0);
	Texture::setCreateDummies(1);
	int ret = 0;
	if(txd) ret |= dumpTxd(txd, out);
	if(dff) ret |= dumpDff(dff, out);
	printf("DONE %d\n", ret);
	return ret;
}
