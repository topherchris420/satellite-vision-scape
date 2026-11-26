import * as THREE from "three";
import meshUrl from "./chrisw-mesh.json?url";
import bodyUrl from "../../../../gta-sa-99-9-percent-sure/assets/character/textures/chrisw_body.png?url";
import headUrl from "../../../../gta-sa-99-9-percent-sure/assets/character/textures/chrisw_head.png?url";
import accUrl from "../../../../gta-sa-99-9-percent-sure/assets/character/textures/chrisw_acc.png?url";
import lensUrl from "../../../../gta-sa-99-9-percent-sure/assets/character/textures/chrisw_lens.png?url";
import { decodeChris, type ChrisFile } from "./chrisData";
import { ChrisVisual, type ChrisTextures } from "./ChrisVisual";

/**
 * Loads Christopher for the hidden case: the exported mesh and the four
 * textures painted for the mod (the same PNGs its TXD is made from). Fetched
 * only when the case starts, so the rest of the site never downloads them.
 */
const TEXTURES: Record<string, string> = {
  chrisw_body: bodyUrl,
  chrisw_head: headUrl,
  chrisw_acc: accUrl,
  chrisw_lens: lensUrl,
};

export async function loadChris(): Promise<ChrisVisual> {
  const loader = new THREE.TextureLoader();
  const [file, ...maps] = await Promise.all([
    fetch(meshUrl).then((r) => {
      if (!r.ok) throw new Error(`chrisw: mesh request failed (${r.status})`);
      return r.json() as Promise<ChrisFile>;
    }),
    ...Object.entries(TEXTURES).map(async ([name, url]) => {
      const t = await loader.loadAsync(url);
      t.name = name;
      // The export keeps the mod's UVs (v = 0 at the top of the image).
      t.flipY = false;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      t.needsUpdate = true;
      return [name, t] as const;
    }),
  ]);
  const textures: ChrisTextures = Object.fromEntries(maps);
  return new ChrisVisual(decodeChris(file), textures);
}
