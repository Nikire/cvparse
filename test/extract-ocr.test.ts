import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CvparseError } from "../src/errors.js";
import { extractText, imageMimeType } from "../src/extract/index.js";
import { scannedPageWarning } from "../src/extract/messages.js";
import { recognizeWithAdapter } from "../src/extract/ocr.js";
import { pngSize, renderPdfPages } from "../src/extract/raster.js";
import { parseResume } from "../src/index.js";
import type { OcrAdapter } from "../src/ocr/types.js";
import {
  fakeOcrAdapter,
  fakeTextOcrAdapter,
  mockModelWithObject,
  SPANISH_EXTRACTION,
} from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => new Uint8Array(readFileSync(join(here, "fixtures", ...parts)));

const png = read("image", "cv-es-two-column.png");
const jpg = read("image", "cv-es-two-column.jpg");
const scannedPdf = read("pdf", "scanned-es.pdf");
const mixedPdf = read("pdf", "mixed-es.pdf");
const stampPdf = read("pdf", "scanned-stamp-es.pdf");

async function errorOf(promise: Promise<unknown>): Promise<CvparseError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(CvparseError.is(error)).toBe(true);
  return error as CvparseError;
}

describe("image fixtures", () => {
  it("are A4 at 150 DPI and small", () => {
    expect(pngSize(png)).toEqual({ width: 1240, height: 1754 });
    expect(png.length).toBeLessThan(150 * 1024);
  });
});

describe("imageMimeType", () => {
  it("detects PNG, JPEG, WEBP and TIFF and rejects GIF/BMP/other", () => {
    expect(imageMimeType(png)).toBe("image/png");
    expect(imageMimeType(jpg)).toBe("image/jpeg");
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(imageMimeType(webp)).toBe("image/webp");
    expect(imageMimeType(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBe("image/tiff");
    expect(imageMimeType(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a]))).toBe("image/tiff");
    expect(imageMimeType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
    expect(imageMimeType(new Uint8Array([0x42, 0x4d, 0, 0]))).toBeNull();
    expect(imageMimeType(scannedPdf)).toBeNull();
  });
});

describe("extractText with an OCR adapter: images", () => {
  it("routes PNG and JPEG to the adapter with the right MIME type and hints", async () => {
    const adapter = fakeOcrAdapter();
    const controller = new AbortController();
    const fromPng = await extractText(png, {
      ocr: adapter,
      ocrLanguages: ["es"],
      abortSignal: controller.signal,
    });
    await extractText({ data: jpg, filename: "cv.jpg" }, { ocr: adapter });

    expect(adapter.calls.map((c) => c.mimeType)).toEqual(["image/png", "image/jpeg"]);
    expect(adapter.calls[0]?.data).toBe(png);
    expect(adapter.calls[0]?.languages).toEqual(["es"]);
    expect(adapter.calls[0]?.abortSignal).toBe(controller.signal);
    expect(adapter.calls[0]?.page).toBeUndefined();
    expect(fromPng.format).toBe("image");
    expect(fromPng.pages).toBe(1);
    expect(fromPng.ocr).toEqual({ adapter: "fake", confidence: 0.95, pages: 1 });
    expect(fromPng.warnings).toEqual([]);
  });

  it("orders two-column OCR boxes: header, whole left column, then right column", async () => {
    const doc = await extractText(png, { ocr: fakeOcrAdapter() });
    const t = doc.text;
    expect(doc.layout).toBe("multi-column");
    expect(t.indexOf("LUCÍA BEATRIZ MORALES")).toBe(0);
    expect(t).toContain("marzo 2021 – actualidad");
    // The whole left column precedes the right column: no interleaving.
    expect(t.indexOf("Automatización de cargas ETL.")).toBeLessThan(t.indexOf("HABILIDADES"));
    expect(t.indexOf("EXPERIENCIA")).toBeLessThan(t.indexOf("Banco Oriental S.A."));
    expect(t.indexOf("HABILIDADES")).toBeLessThan(t.indexOf("Inglés (B2)"));
    expect(t).not.toMatch(/Banco Oriental S\.A\. +SQL/);
  });

  it("uses plain text when the adapter returns no boxes", async () => {
    const doc = await extractText(png, { ocr: fakeTextOcrAdapter() });
    expect(doc.text.startsWith("LUCÍA BEATRIZ MORALES\n")).toBe(true);
    expect(doc.layout).toBe("unknown");
    expect(doc.ocr?.adapter).toBe("fake-text");
  });

  it("warns on low confidence and prefixes adapter warnings with the adapter name", async () => {
    const doc = await extractText(png, {
      ocr: fakeOcrAdapter({ confidence: 0.62, warnings: ["image is skewed"] }),
    });
    expect(doc.warnings).toEqual(["fake: image is skewed", "ocr: low confidence (0.62) on page 1"]);
    expect(doc.ocr?.confidence).toBe(0.62);
  });

  it("wraps adapter errors as OCR_FAILED and keeps cvparse errors as is", async () => {
    const boom = new Error("engine crashed");
    const error = await errorOf(extractText(png, { ocr: fakeOcrAdapter({ throws: boom }) }));
    expect(error.code).toBe("OCR_FAILED");
    expect(error.message).toBe("fake: engine crashed");
    expect(error.cause).toBe(boom);

    const missing = new CvparseError("MISSING_DEPENDENCY", "npm install tesseract.js");
    const kept = await errorOf(extractText(png, { ocr: fakeOcrAdapter({ throws: missing }) }));
    expect(kept).toBe(missing);
  });

  it("requires an adapter for images and rejects GIF/BMP even with one", async () => {
    const error = await errorOf(extractText({ data: png, filename: "cv.png" }));
    expect(error.code).toBe("OCR_REQUIRED");
    expect(error.message).toContain("options.ocr");
    expect(error.message).toContain("--ocr tesseract|textract");
    expect(error.message).toContain('ocr: "vision"');

    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
    const adapter = fakeOcrAdapter();
    expect((await errorOf(extractText(gif, { ocr: adapter }))).code).toBe("UNSUPPORTED_INPUT");
    expect(adapter.calls).toHaveLength(0);
  });
});

describe("recognizeWithAdapter", () => {
  it("joins multi-page results, averages confidence and flags empty pages", async () => {
    const adapter: OcrAdapter = {
      name: "multi",
      async recognize() {
        return [
          { text: "Página uno", confidence: 0.9 },
          { text: "   ", confidence: 0.5 },
          { text: "Página tres" },
        ];
      },
    };
    const doc = await recognizeWithAdapter(adapter, [{ data: png, mimeType: "image/png" }], "pdf");
    expect(doc.text).toBe("Página uno\n\nPágina tres");
    expect(doc.pages).toBe(3);
    expect(doc.ocr?.adapter).toBe("multi");
    expect(doc.ocr?.pages).toBe(3);
    expect(doc.ocr?.confidence).toBeCloseTo(0.7);
    expect(doc.warnings).toEqual([
      "ocr: low confidence (0.50) on page 2",
      "ocr: page 2 produced no text",
    ]);
  });

  it("omits confidence when no page reports it", async () => {
    const adapter: OcrAdapter = { name: "plain", recognize: async () => ({ text: "hola mundo" }) };
    const doc = await recognizeWithAdapter(
      adapter,
      [{ data: png, mimeType: "image/png" }],
      "image",
    );
    expect(doc.ocr).toEqual({ adapter: "plain", pages: 1 });
  });
});

describe("extractText with an OCR adapter: scanned PDFs", () => {
  it("still throws NO_TEXT_LAYER without an adapter", async () => {
    expect((await errorOf(extractText(scannedPdf))).code).toBe("NO_TEXT_LAYER");
  });

  it("hands the raw PDF once to an adapter that supports PDFs", async () => {
    const adapter = fakeOcrAdapter({ supportsPdf: true, name: "pdf-capable" });
    const doc = await extractText(scannedPdf, { ocr: adapter, ocrLanguages: ["es", "en"] });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.mimeType).toBe("application/pdf");
    expect(adapter.calls[0]?.data).toBe(scannedPdf);
    expect(adapter.calls[0]?.languages).toEqual(["es", "en"]);
    expect(doc.format).toBe("pdf");
    expect(doc.ocr?.adapter).toBe("pdf-capable");
    expect(doc.text).toContain("marzo 2021 – actualidad");
  });

  it("renders pages to PNG for an image-only adapter, with page numbers", async () => {
    const adapter = fakeTextOcrAdapter();
    const doc = await extractText(scannedPdf, { ocr: adapter });
    expect(adapter.calls).toHaveLength(1);
    const call = adapter.calls[0];
    expect(call?.mimeType).toBe("image/png");
    expect(call?.page).toBe(1);
    expect(imageMimeType(call?.data ?? new Uint8Array())).toBe("image/png");
    expect(doc.format).toBe("pdf");
    expect(doc.pages).toBe(1);
    expect(doc.ocr).toEqual({ adapter: "fake-text", confidence: 0.95, pages: 1 });
    // The caller's bytes are not detached by pdf.js.
    expect(scannedPdf.byteLength).toBeGreaterThan(0);
  });
});

describe("renderPdfPages", () => {
  it("renders scanned-es.pdf at scale 2 (A4 ≈ 1191x1684 px)", async () => {
    const result = await renderPdfPages(scannedPdf);
    expect(result.totalPages).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.pages).toHaveLength(1);
    const page = result.pages[0];
    expect(page?.page).toBe(1);
    expect(page?.width).toBeGreaterThanOrEqual(1190);
    expect(page?.width).toBeLessThanOrEqual(1191);
    expect(page?.height).toBeGreaterThanOrEqual(1683);
    expect(page?.height).toBeLessThanOrEqual(1684);
    expect(pngSize(page?.png ?? new Uint8Array())).toEqual({
      width: page?.width,
      height: page?.height,
    });
  });

  it("throws MISSING_DEPENDENCY when @napi-rs/canvas cannot be loaded", async () => {
    const error = await errorOf(
      renderPdfPages(scannedPdf, {
        canvasImport: () => Promise.reject(new Error("Cannot find package '@napi-rs/canvas'")),
      }),
    );
    expect(error.code).toBe("MISSING_DEPENDENCY");
    expect(error.message).toContain("npm install @napi-rs/canvas");
  });
});

describe("parseResume with an OCR adapter", () => {
  it("fills source.ocr and does not turn the forced language into an OCR hint", async () => {
    const adapter = fakeOcrAdapter({ confidence: 0.88 });
    const model = mockModelWithObject(SPANISH_EXTRACTION);
    const result = await parseResume(
      { data: png, filename: "cv.png" },
      { model, ocr: adapter, language: "es" },
    );
    expect(result.source).toEqual({
      format: "image",
      pages: 1,
      layout: "multi-column",
      ocr: { adapter: "fake", confidence: 0.88, pages: 1 },
    });
    // The adapter keeps its own configured languages unless ocrLanguages is explicit.
    expect(adapter.calls[0]?.languages).toBeUndefined();
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("marzo 2021");
  });

  it("passes explicit ocrLanguages and omits hints otherwise", async () => {
    const model = mockModelWithObject(SPANISH_EXTRACTION);
    const explicit = fakeOcrAdapter();
    await parseResume(png, { model, ocr: explicit, language: "es", ocrLanguages: ["es", "en"] });
    expect(explicit.calls[0]?.languages).toEqual(["es", "en"]);

    const auto = fakeOcrAdapter();
    await parseResume(png, { model, ocr: auto });
    expect(auto.calls[0]?.languages).toBeUndefined();
  });

  it("rejects images without an adapter with OCR_REQUIRED", async () => {
    const model = mockModelWithObject(SPANISH_EXTRACTION);
    expect((await errorOf(parseResume(png, { model }))).code).toBe("OCR_REQUIRED");
  });
});

describe("extractText: PDFs mixing text and scanned pages", () => {
  it("OCRs only the scanned page and merges it after the text page", async () => {
    const adapter = fakeTextOcrAdapter();
    const doc = await extractText(mixedPdf, { ocr: adapter });

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.mimeType).toBe("image/png");
    expect(adapter.calls[0]?.page).toBe(2);
    const t = doc.text;
    expect(t.indexOf("MARÍA FERNANDA LÓPEZ GARCÍA")).toBe(0);
    expect(t.indexOf("Portugués: intermedio")).toBeLessThan(t.indexOf("LUCÍA BEATRIZ MORALES"));
    expect(doc.pages).toBe(2);
    expect(doc.layout).toBe("single-column");
    expect(doc.ocr).toEqual({ adapter: "fake-text", confidence: 0.95, pages: 1 });
    expect(doc.scannedPages).toBeUndefined();
    expect(doc.warnings).toEqual([]);
  });

  it("skips the scanned page with a warning when there is no adapter", async () => {
    const doc = await extractText(mixedPdf);
    expect(doc.text).toContain("MARÍA FERNANDA LÓPEZ GARCÍA");
    expect(doc.text).not.toContain("LUCÍA");
    expect(doc.scannedPages).toEqual([2]);
    expect(doc.warnings).toEqual([scannedPageWarning(2)]);
    expect(doc.ocr).toBeUndefined();
  });

  it("maps a PDF-capable adapter's pages back by page number", async () => {
    const calls: string[] = [];
    const adapter: OcrAdapter = {
      name: "pdf-pages",
      supports: { pdf: true },
      async recognize(input) {
        calls.push(input.mimeType);
        return [{ text: "OCR PÁGINA UNO" }, { text: "OCR PÁGINA DOS" }];
      },
    };
    const doc = await extractText(mixedPdf, { ocr: adapter });
    expect(calls).toEqual(["application/pdf"]);
    expect(doc.text).toContain("MARÍA FERNANDA LÓPEZ GARCÍA");
    expect(doc.text).not.toContain("OCR PÁGINA UNO");
    expect(doc.text.endsWith("OCR PÁGINA DOS")).toBe(true);
    expect(doc.ocr?.pages).toBe(1);
    expect(doc.pages).toBe(2);
  });

  it("renders the scanned pages when a PDF-capable adapter's pages cannot be mapped", async () => {
    const adapter = fakeTextOcrAdapter({ supportsPdf: true });
    const doc = await extractText(mixedPdf, { ocr: adapter });
    expect(adapter.calls.map((c) => [c.mimeType, c.page])).toEqual([
      ["application/pdf", undefined],
      ["image/png", 2],
    ]);
    expect(doc.text).toContain("LUCÍA BEATRIZ MORALES");
    expect(doc.ocr?.pages).toBe(1);
  });
});

describe("extractText: scanned PDF with a scanner-app stamp", () => {
  it("calls the adapter instead of returning the 24-character stamp", async () => {
    const adapter = fakeTextOcrAdapter();
    const doc = await extractText(stampPdf, { ocr: adapter });
    expect(adapter.calls).toHaveLength(1);
    expect(doc.text).toContain("LUCÍA BEATRIZ MORALES");
    // The stamp text layer is dropped for an OCR'd page (OCR reads the rendered page instead).
    expect(doc.text).not.toContain("CamScanner");
    expect(doc.ocr?.pages).toBe(1);
  });

  it("throws NO_TEXT_LAYER without an adapter even though the stamp has > 20 chars", async () => {
    expect((await errorOf(extractText(stampPdf))).code).toBe("NO_TEXT_LAYER");
  });
});

describe("extractText: abort during OCR", () => {
  it("maps an abort to OCR_FAILED for images and rendered PDFs", async () => {
    const controller = new AbortController();
    controller.abort();
    for (const data of [png, scannedPdf]) {
      const adapter = fakeOcrAdapter();
      const error = await errorOf(
        extractText(data, { ocr: adapter, abortSignal: controller.signal }),
      );
      expect(error.code).toBe("OCR_FAILED");
      expect(error.message).toBe("OCR was aborted.");
      expect((error.cause as Error).name).toBe("AbortError");
      expect(adapter.calls).toHaveLength(0);
    }
  });

  it("maps an abort raised by the adapter itself", async () => {
    const controller = new AbortController();
    const adapter: OcrAdapter = {
      name: "slow",
      async recognize() {
        controller.abort();
        throw new Error("worker terminated");
      },
    };
    const error = await errorOf(extractText(png, { ocr: adapter, abortSignal: controller.signal }));
    expect(error.code).toBe("OCR_FAILED");
    expect(error.message).toBe("OCR was aborted.");
  });

  it("does not affect text-layer PDFs", async () => {
    const controller = new AbortController();
    controller.abort();
    const doc = await extractText(mixedPdf, { abortSignal: controller.signal });
    expect(doc.text).toContain("MARÍA FERNANDA");
  });
});

describe("renderPdfPages options", () => {
  it("renders only the requested pages", async () => {
    const result = await renderPdfPages(mixedPdf, { pages: [2] });
    expect(result.totalPages).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.pages.map((p) => p.page)).toEqual([2]);
  });

  it("reports truncation against the requested pages", async () => {
    const result = await renderPdfPages(mixedPdf, { pages: [1, 2], maxPages: 1 });
    expect(result.pages.map((p) => p.page)).toEqual([1]);
    expect(result.truncated).toBe(true);
  });

  it("caps the longest side with maxSide", async () => {
    const result = await renderPdfPages(scannedPdf, { maxSide: 1000 });
    const page = result.pages[0];
    expect(Math.max(page?.width ?? 0, page?.height ?? 0)).toBeLessThanOrEqual(1000);
    expect(page?.height).toBeGreaterThanOrEqual(998);
  });
});

describe("parseResume on a mixed PDF with an adapter", () => {
  it("reports the document page count and the OCR'd page count separately", async () => {
    const model = mockModelWithObject(SPANISH_EXTRACTION);
    const result = await parseResume(mixedPdf, { model, ocr: fakeTextOcrAdapter() });
    expect(result.source).toEqual({
      format: "pdf",
      pages: 2,
      layout: "single-column",
      ocr: { adapter: "fake-text", confidence: 0.95, pages: 1 },
    });
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain("MARÍA FERNANDA");
    expect(prompt).toContain("LUCÍA BEATRIZ MORALES");
  });
});
