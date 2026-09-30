import { defineConfig } from "tsup";

// One config for both entries so tsup code-splits the shared library code into a chunk
// instead of bundling a second copy of it into dist/cli.js. The `#!/usr/bin/env node`
// shebang lives in src/cli.ts; esbuild preserves it and tsup marks the file executable.
export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  splitting: true,
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  target: "node22",
  platform: "node",
  outDir: "dist",
});
