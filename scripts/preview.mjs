// Builds for Node and serves the result, the way production runs. `vite preview`
// cannot serve this app: the default build targets a Worker, and it looks for a
// dist/server/server.js that build never writes.
//
//   bun run preview          (PORT and HOST are respected; default 3000)
import { spawnSync } from "node:child_process";

const env = { ...process.env, NITRO_PRESET: "node-server" };
// Through a shell: bun's commands are .cmd shims on some Windows installs.
const run = (command) => {
  const { status } = spawnSync(command, { stdio: "inherit", env, shell: true });
  if (status !== 0) process.exit(status ?? 1);
};

run("bunx vite build");
run("node .output/server/index.mjs");
