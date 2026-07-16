// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { ConfigEnv, PluginOption } from "vite";

const base = defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});

// The dev-only TanStack devtools "inject-source" transform annotates every JSX
// element with a `data-tsd-source` attribute. react-three-fiber host elements
// (<mesh>, <group>, materials, …) interpret that dashed name as a nested
// property path and throw ("Cannot set data-tsd-source"), which crashes the
// Canvas on re-render. We surgically drop just that one dev sub-plugin so the
// 3D scene stays stable; all other devtools/build plugins are left untouched
// and production builds are unaffected (devtools is not added for builds).
function stripInjectSource(plugins: PluginOption[]): PluginOption[] {
  return plugins.map((p) => {
    if (Array.isArray(p)) return stripInjectSource(p);
    if (
      p &&
      typeof p === "object" &&
      "name" in p &&
      (p as { name?: unknown }).name === "@tanstack/devtools:inject-source"
    ) {
      return false;
    }
    return p;
  });
}

export default async (env: ConfigEnv) => {
  const config = await base(env);
  if (Array.isArray(config.plugins)) {
    config.plugins = stripInjectSource(config.plugins);
  }
  return config;
};
