import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CvparseError, parseResume } from "../src/index.js";
import {
  buildMixedVisionPrompt,
  buildVisionPrompt,
  MAX_VISION_IMAGE_BYTES,
  toVisionImages,
} from "../src/vision.js";
import { mockModelWithObject } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (...parts: string[]) => readFileSync(join(here, "fixtures", ...parts));

type Part = { type: string; mediaType?: string; data?: unknown; text?: string };

function userParts(model: ReturnType<typeof mockModelWithObject>): Part[] {
  const prompt = model.doGenerateCalls[0]?.prompt ?? [];
  const user = prompt.find((m) => m.role === "user");
  return (user?.content ?? []) as Part[];
}

describe("vision mode", () => {
  it("sends a PNG straight to the model as a file part", async () => {
    const model = mockModelWithObject({ basics: { name: "María" } });
    const result = await parseResume(fixture("image", "cv-es-two-column.png"), {
      model,
      ocr: "vision",
    });
    const parts = userParts(model);
    expect(parts[0]?.type).toBe("text");
    const files = parts.filter((p) => p.type === "file");
    expect(files).toHaveLength(1);
    expect(files[0]?.mediaType).toBe("image/png");
    expect(result.source).toMatchObject({ format: "image", ocr: { adapter: "vision", pages: 1 } });
    expect(result.resume.basics?.name).toBe("María");
  });

  it("renders a scanned PDF to page images", async () => {
    const model = mockModelWithObject({});
    const result = await parseResume(fixture("pdf", "scanned-es.pdf"), { model, ocr: "vision" });
    const files = userParts(model).filter((p) => p.type === "file");
    expect(files).toHaveLength(1);
    expect(files[0]?.mediaType).toBe("image/png");
    expect(result.source).toEqual({
      format: "pdf",
      pages: 1,
      layout: "unknown",
      ocr: { adapter: "vision", pages: 1 },
    });
  });

  it("sends a stamped scan as an image, not the stamp text", async () => {
    const model = mockModelWithObject({});
    await parseResume(fixture("pdf", "scanned-stamp-es.pdf"), { model, ocr: "vision" });
    const parts = userParts(model);
    expect(parts.filter((p) => p.type === "file")).toHaveLength(1);
  });

  it("sends a mixed PDF as text pages plus images of the scanned pages", async () => {
    const model = mockModelWithObject({});
    const result = await parseResume(fixture("pdf", "mixed-es.pdf"), { model, ocr: "vision" });
    const parts = userParts(model);
    expect(parts[0]?.type).toBe("text");
    const text = parts[0]?.text ?? "";
    expect(text).toContain("text layer of page 1");
    expect(text).toContain("page 2 is a scanned page attached as an image");
    expect(text).toContain("MARÍA FERNANDA LÓPEZ GARCÍA");
    const files = parts.filter((p) => p.type === "file");
    expect(files).toHaveLength(1);
    expect(files[0]?.mediaType).toBe("image/png");
    expect(result.source).toEqual({
      format: "pdf",
      pages: 2,
      layout: "single-column",
      ocr: { adapter: "vision", pages: 1 },
    });
    expect(result.warnings.some((w) => w.includes("looks scanned"))).toBe(false);
  });

  it("still uses the text layer of a normal PDF instead of images", async () => {
    const model = mockModelWithObject({});
    await parseResume(fixture("pdf", "two-column-es.pdf"), { model, ocr: "vision" });
    const parts = userParts(model);
    expect(parts.some((p) => p.type === "file")).toBe(false);
    expect(parts.map((p) => p.text ?? "").join("")).toContain("EXPERIENCIA");
  });

  it("without vision or an adapter, images still fail with OCR_REQUIRED", async () => {
    const model = mockModelWithObject({});
    const error = await parseResume(fixture("image", "cv-es-two-column.png"), { model }).catch(
      (e: unknown) => e,
    );
    expect(CvparseError.is(error) && error.code).toBe("OCR_REQUIRED");
  });

  it("rejects image formats vision APIs do not take", async () => {
    const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0]);
    const error = await parseResume(tiff, { model: mockModelWithObject({}), ocr: "vision" }).catch(
      (e: unknown) => e,
    );
    expect(CvparseError.is(error) && error.code).toBe("UNSUPPORTED_INPUT");
  });

  it("maps an aborted signal to PROVIDER_ERROR before rendering", async () => {
    const controller = new AbortController();
    controller.abort();
    for (const data of [
      fixture("pdf", "scanned-es.pdf"),
      fixture("image", "cv-es-two-column.png"),
    ]) {
      const error = await toVisionImages(data, controller.signal).catch((e: unknown) => e);
      expect(CvparseError.is(error) && error.code).toBe("PROVIDER_ERROR");
      expect((error as Error).message).toBe("The extraction call was aborted.");
    }
  });

  it("rejects images over the size cap with UNSUPPORTED_INPUT", async () => {
    const big = new Uint8Array(MAX_VISION_IMAGE_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const error = await toVisionImages(big).catch((e: unknown) => e);
    expect(CvparseError.is(error) && error.code).toBe("UNSUPPORTED_INPUT");
    expect((error as Error).message).toMatch(/15 MB limit/);
    expect((error as Error).message).toMatch(/OCR adapter/);
  });

  it("renders PDF pages at scale 2 within the 2000 px cap", async () => {
    const { images, totalPages } = await toVisionImages(fixture("pdf", "mixed-es.pdf"), undefined, {
      pages: [2],
    });
    expect(totalPages).toBe(2);
    expect(images.map((i) => i.page)).toEqual([2]);
  });

  it("phrases the mixed prompt", () => {
    const prompt = buildMixedVisionPrompt("TEXTO", [1, 3], [2, 4]);
    expect(prompt).toContain("text layer of pages 1, 3");
    expect(prompt).toContain("pages 2, 4 are scanned pages");
    expect(prompt).toContain("<cv>\nTEXTO\n</cv>");
  });

  it("phrases the prompt for one or several pages", () => {
    expect(buildVisionPrompt(1)).toContain("the attached image");
    expect(buildVisionPrompt(3)).toContain("3 attached page images");
  });
});
