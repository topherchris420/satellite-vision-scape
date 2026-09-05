import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "../src/lib/terrain/grid";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: bun terrain:build <input.json> <output.json>");
const source = JSON.parse(await readFile(resolve(input), "utf8"));
if (!source.width || !source.height || source.samples?.length !== source.width * source.height)
  throw new TypeError("Invalid row-major terrain grid");
const payload = JSON.stringify({
  width: source.width,
  height: source.height,
  bounds: source.bounds,
  samples: source.samples,
});
const artifactHash = `sha256:${await sha256(payload)}`;
const artifact = {
  ...source,
  manifest: {
    ...source.manifest,
    schemaVersion: "1.0.0",
    artifactHash,
    processingVersion: "geotwn-terrain-1",
  },
};
await writeFile(resolve(output), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Wrote ${output} (${artifactHash})`);
