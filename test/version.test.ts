import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CVPARSE_VERSION } from "../src/index.js";

describe("CVPARSE_VERSION", () => {
  it("matches package.json", () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(CVPARSE_VERSION).toBe(pkg.version);
  });
});
