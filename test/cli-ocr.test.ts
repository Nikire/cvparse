import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCliOcr, tesseractCacheDir } from "../src/cli/ocr.js";

describe("tesseractCacheDir", () => {
  it("honors CVPARSE_CACHE_DIR, then XDG_CACHE_HOME", () => {
    expect(tesseractCacheDir({ CVPARSE_CACHE_DIR: "/tmp/cv" })).toBe(join("/tmp/cv", "tessdata"));
    expect(tesseractCacheDir({ XDG_CACHE_HOME: "/x" })).toBe(join("/x", "cvparse", "tessdata"));
  });

  it("never points at the current directory", () => {
    expect(tesseractCacheDir({})).toContain(join("cvparse", "tessdata"));
  });
});

describe("createCliOcr", () => {
  it("maps engines to adapters lazily", async () => {
    expect(await createCliOcr(undefined, undefined)).toBeUndefined();
    expect(await createCliOcr("vision", undefined)).toBe("vision");
    const tesseract = await createCliOcr("tesseract", ["es"], { CVPARSE_CACHE_DIR: "/tmp/cv" });
    expect(typeof tesseract === "object" && tesseract.name).toMatch(/tesseract/);
    const textract = await createCliOcr("textract", undefined);
    expect(typeof textract === "object" && textract.name).toMatch(/textract/);
  });
});
