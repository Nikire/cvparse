import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  // Mirrors the tsup `define` so tests see the same CVPARSE_VERSION as the build.
  define: { __CVPARSE_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/cli.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
