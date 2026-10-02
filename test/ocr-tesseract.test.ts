import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CvparseError } from "../src/errors.js";
import { orderTextItems } from "../src/extract/layout.js";
import {
  createTesseractAdapter,
  PSM,
  readImageSize,
  toTesseractLanguages,
} from "../src/ocr/tesseract.js";
import type { OcrInput, OcrPage } from "../src/ocr/types.js";
import { ocrItemsToTextItems } from "../src/ocr/types.js";

// One mock for the whole file: unit tests drive a fake worker through `tess.createWorker`;
// the gated integration test flips `tess.real` to reach the real tesseract.js.
const tess = vi.hoisted(() => ({
  createWorker: vi.fn(),
  real: false,
}));
vi.mock("tesseract.js", async (importOriginal) => {
  const real = await importOriginal<{ createWorker: (...args: unknown[]) => Promise<unknown> }>();
  const createWorker = (...args: unknown[]) =>
    tess.real ? real.createWorker(...args) : tess.createWorker(...args);
  return { default: { createWorker }, createWorker };
});

const here = dirname(fileURLToPath(import.meta.url));

// --- fake tesseract.js result builders --------------------------------------------------------

interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface FakeWord {
  text: string;
  confidence: number;
  bbox: Bbox;
}
interface FakeLine {
  words: FakeWord[];
  bbox: Bbox;
}

function word(text: string, x0: number, y0: number, x1: number, y1: number, confidence = 90) {
  return { text, confidence, bbox: { x0, y0, x1, y1 } };
}

/** A line whose bbox is the union of its words. */
function line(...words: FakeWord[]): FakeLine {
  return {
    words,
    bbox: {
      x0: Math.min(...words.map((w) => w.bbox.x0)),
      y0: Math.min(...words.map((w) => w.bbox.y0)),
      x1: Math.max(...words.map((w) => w.bbox.x1)),
      y1: Math.max(...words.map((w) => w.bbox.y1)),
    },
  };
}

function page(...blocks: FakeLine[][]) {
  return {
    text: "",
    confidence: 88,
    blocks: blocks.map((lines) => ({
      paragraphs: [{ lines }],
      bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
    })),
  };
}

type FakePage = ReturnType<typeof page> | { text: string; confidence: number; blocks: null };

function fakeWorker(result: FakePage = page()) {
  return {
    recognize: vi.fn(async (..._args: unknown[]) => ({ data: result })),
    reinitialize: vi.fn(async (..._args: unknown[]) => ({})),
    terminate: vi.fn(async () => ({})),
  };
}

/** The 24 header bytes of a PNG with the given size: enough for readImageSize. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function pngInput(overrides: Partial<OcrInput> = {}): OcrInput {
  return { data: pngHeader(1000, 1400), mimeType: "image/png", ...overrides };
}

async function rejection(promise: Promise<unknown>): Promise<CvparseError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CvparseError);
    return error as CvparseError;
  }
  throw new Error("expected the promise to reject");
}

beforeEach(() => {
  tess.createWorker.mockReset();
  tess.real = false;
});

// --- language mapping ---------------------------------------------------------------------------

describe("toTesseractLanguages", () => {
  it("maps ISO 639-1 codes to traineddata names", () => {
    expect(toTesseractLanguages(["es"])).toBe("spa");
    expect(toTesseractLanguages(["en"])).toBe("eng");
    expect(toTesseractLanguages(["pt"])).toBe("por");
    expect(toTesseractLanguages(["es", "en"])).toBe("spa+eng");
  });

  it("drops region subtags and dedupes", () => {
    expect(toTesseractLanguages(["es-AR", "ES_mx", "spa", "spa-ES"])).toBe("spa");
    expect(toTesseractLanguages(["pt-BR", "en-US"])).toBe("por+eng");
  });

  it("passes Tesseract codes through, keeping underscores", () => {
    expect(toTesseractLanguages(["spa", "eng"])).toBe("spa+eng");
    expect(toTesseractLanguages(["chi_sim", "SPA_OLD"])).toBe("chi_sim+spa_old");
  });

  it("rejects unknown two-letter codes and empty lists", () => {
    expect(() => toTesseractLanguages(["xx"])).toThrow(/unknown OCR language code "xx"/);
    expect(() => toTesseractLanguages([])).toThrow(CvparseError);
    expect(() => toTesseractLanguages([" "])).toThrow(/at least one OCR language/);
  });
});

// --- adapter ------------------------------------------------------------------------------------

describe("createTesseractAdapter", () => {
  it("does not import tesseract.js until the first recognize", () => {
    const adapter = createTesseractAdapter();
    expect(adapter.name).toBe("tesseract");
    expect(adapter.supports?.pdf).toBe(false);
    expect(tess.createWorker).not.toHaveBeenCalled();
  });

  it("starts the worker with spa+eng by default, passing paths, logger and an error handler", async () => {
    const worker = fakeWorker();
    tess.createWorker.mockResolvedValue(worker);
    const logger = vi.fn();
    const adapter = createTesseractAdapter({
      langPath: "/data/tessdata",
      cachePath: join(tmpdir(), "cvparse-test-cache"),
      logger,
      oem: 1,
    });

    await adapter.recognize(pngInput());

    expect(tess.createWorker).toHaveBeenCalledTimes(1);
    const [langs, oem, options] = tess.createWorker.mock.calls[0] ?? [];
    expect(langs).toBe("spa+eng");
    expect(oem).toBe(1);
    expect(options).toMatchObject({
      langPath: "/data/tessdata",
      cachePath: join(tmpdir(), "cvparse-test-cache"),
      logger,
    });
    expect(typeof (options as { errorHandler?: unknown }).errorHandler).toBe("function");
    expect(options).not.toHaveProperty("workerPath");
  });

  it("maps configured and per-input languages", async () => {
    const worker = fakeWorker();
    tess.createWorker.mockResolvedValue(worker);
    const adapter = createTesseractAdapter({ languages: ["es"] });

    await adapter.recognize(pngInput());
    expect(tess.createWorker.mock.calls[0]?.[0]).toBe("spa");

    await adapter.recognize(pngInput({ languages: ["pt", "en"] }));
    expect(worker.reinitialize).toHaveBeenCalledWith("por+eng", undefined);
  });

  it("requests blocks with PSM AUTO by default", async () => {
    const worker = fakeWorker();
    tess.createWorker.mockResolvedValue(worker);
    await createTesseractAdapter().recognize(pngInput());

    const [image, options, output] = worker.recognize.mock.calls[0] ?? [];
    expect(Buffer.isBuffer(image)).toBe(true);
    expect(options).toEqual({ tessedit_pageseg_mode: "3" });
    expect(output).toEqual({ text: true, blocks: true });
  });

  it("forwards psm and rotateAuto", async () => {
    const worker = fakeWorker();
    tess.createWorker.mockResolvedValue(worker);
    await createTesseractAdapter({ psm: PSM.SPARSE_TEXT, rotateAuto: true }).recognize(pngInput());
    expect(worker.recognize.mock.calls[0]?.[1]).toEqual({
      tessedit_pageseg_mode: "11",
      rotateAuto: true,
    });
  });

  it("hands tesseract exactly the input bytes, even from a subarray", async () => {
    const worker = fakeWorker();
    tess.createWorker.mockResolvedValue(worker);
    const backing = new Uint8Array(100);
    backing.set(pngHeader(10, 10), 20);
    const data = backing.subarray(20, 53);
    await createTesseractAdapter().recognize({ data, mimeType: "image/png" });
    const image = worker.recognize.mock.calls[0]?.[0] as Buffer;
    expect(image.byteLength).toBe(33);
    expect([...image]).toEqual([...data]);
  });

  it("walks blocks → paragraphs → lines → words into positioned phrase items", async () => {
    const result = page(
      [
        // "con" has no ascenders: its ink box is shorter than the line's.
        line(word("Banco", 100, 200, 180, 230, 96), word("con", 190, 210, 230, 230, 80)),
        line(word("  ", 100, 250, 110, 280), word("Oriental", 100, 250, 220, 280, 101)),
      ],
      [line(word("Python", 600, 200, 700, 230, 50))],
    );
    tess.createWorker.mockResolvedValue(fakeWorker(result));

    const out = (await createTesseractAdapter().recognize(pngInput())) as OcrPage;

    expect(out.width).toBe(1000);
    expect(out.height).toBe(1400);
    expect(out.items).toEqual([
      // Words of a line joined with a space; vertical extent from the line, confidence 0..1.
      { text: "Banco con", x: 100, y: 200, width: 130, height: 30, confidence: 0.88 },
      { text: "Oriental", x: 100, y: 250, width: 120, height: 30, confidence: 1 },
      { text: "Python", x: 600, y: 200, width: 100, height: 30, confidence: 0.5 },
    ]);
    // Page confidence is the mean over words, not phrases.
    expect(out.confidence).toBeCloseTo((0.96 + 0.8 + 1 + 0.5) / 4);
    expect(out.warnings).toEqual([]);
  });

  it("splits a line into separate items at gutter-sized gaps", async () => {
    // Tesseract ran one line across both columns: "Retail Sur ... Español (nativo)".
    const result = page([
      line(
        word("Retail", 80, 640, 150, 670),
        word("Sur", 160, 640, 200, 670),
        word("Español", 760, 640, 860, 676),
        word("(nativo)", 870, 640, 960, 676),
      ),
    ]);
    tess.createWorker.mockResolvedValue(fakeWorker(result));
    const out = (await createTesseractAdapter().recognize(pngInput())) as OcrPage;
    expect(out.items?.map((item) => [item.text, item.x, item.width])).toEqual([
      ["Retail Sur", 80, 120],
      ["Español (nativo)", 760, 200],
    ]);
  });

  it("returns an empty page (no warning of its own) when nothing is recognized", async () => {
    tess.createWorker.mockResolvedValue(fakeWorker({ text: "", confidence: 0, blocks: null }));
    const out = (await createTesseractAdapter().recognize(pngInput())) as OcrPage;
    expect(out.items).toEqual([]);
    expect(out.confidence).toBe(0);
    expect(out.warnings).toEqual([]);
  });

  it("falls back to the text extent when the image size is unreadable", async () => {
    const result = page([line(word("Hola", 10, 20, 90, 50))]);
    tess.createWorker.mockResolvedValue(fakeWorker(result));
    const out = (await createTesseractAdapter().recognize({
      data: new Uint8Array([0x49, 0x49, 0x2a, 0]),
      mimeType: "image/tiff",
    })) as OcrPage;
    expect(out.width).toBe(90);
    expect(out.height).toBe(50);
    expect(out.warnings?.[0]).toMatch(/could not read the image size/);
  });

  it("reuses one worker and reinitializes only when the languages change", async () => {
    const worker = fakeWorker();
    tess.createWorker.mockResolvedValue(worker);
    const adapter = createTesseractAdapter();

    await adapter.recognize(pngInput());
    await adapter.recognize(pngInput({ languages: ["es", "en"] })); // same as the default
    expect(worker.reinitialize).not.toHaveBeenCalled();

    await adapter.recognize(pngInput({ languages: ["en"] }));
    await adapter.recognize(pngInput({ languages: ["en"] }));
    expect(worker.reinitialize).toHaveBeenCalledTimes(1);
    expect(worker.reinitialize).toHaveBeenCalledWith("eng", undefined);

    await adapter.recognize(pngInput());
    expect(worker.reinitialize).toHaveBeenLastCalledWith("spa+eng", undefined);
    expect(tess.createWorker).toHaveBeenCalledTimes(1);
    expect(worker.recognize).toHaveBeenCalledTimes(5);
  });

  it("serializes concurrent calls on the single worker", async () => {
    let running = 0;
    let maxRunning = 0;
    const worker = fakeWorker();
    worker.recognize.mockImplementation(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { data: page() };
    });
    tess.createWorker.mockResolvedValue(worker);
    const adapter = createTesseractAdapter();

    await Promise.all([
      adapter.recognize(pngInput()),
      adapter.recognize(pngInput({ languages: ["en"] })),
      adapter.recognize(pngInput()),
    ]);
    expect(maxRunning).toBe(1);
    expect(tess.createWorker).toHaveBeenCalledTimes(1);
  });

  it("starts over with a fresh worker after a failed language switch", async () => {
    const first = fakeWorker();
    first.reinitialize.mockRejectedValue("Error: Network error while fetching por.traineddata");
    const second = fakeWorker();
    tess.createWorker.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const adapter = createTesseractAdapter();

    await adapter.recognize(pngInput());
    const error = await rejection(adapter.recognize(pngInput({ languages: ["pt"] })));
    expect(error.code).toBe("OCR_FAILED");
    expect(error.message).toMatch(/could not switch tesseract languages to por.*Network error/);
    expect(first.terminate).toHaveBeenCalledTimes(1);

    await adapter.recognize(pngInput({ languages: ["pt"] }));
    expect(tess.createWorker).toHaveBeenCalledTimes(2);
    expect(tess.createWorker.mock.calls[1]?.[0]).toBe("por");
  });

  it("dispose terminates the worker; the next call starts a new one", async () => {
    const first = fakeWorker();
    const second = fakeWorker();
    tess.createWorker.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const adapter = createTesseractAdapter();

    await adapter.dispose?.(); // no worker yet: no-op
    await adapter.recognize(pngInput());
    await adapter.dispose?.();
    expect(first.terminate).toHaveBeenCalledTimes(1);
    await adapter.dispose?.();
    expect(first.terminate).toHaveBeenCalledTimes(1);

    await adapter.recognize(pngInput());
    expect(tess.createWorker).toHaveBeenCalledTimes(2);
    expect(second.recognize).toHaveBeenCalledTimes(1);
  });

  it("dispose waits for a running recognition", async () => {
    let release: () => void = () => {};
    const worker = fakeWorker();
    worker.recognize.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: page() });
        }),
    );
    tess.createWorker.mockResolvedValue(worker);
    const adapter = createTesseractAdapter();

    const job = adapter.recognize(pngInput());
    await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalled());
    const disposed = adapter.dispose?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(worker.terminate).not.toHaveBeenCalled();
    release();
    await job;
    await disposed;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects PDF input with OCR_FAILED without starting a worker", async () => {
    const error = await rejection(
      createTesseractAdapter().recognize({
        data: new TextEncoder().encode("%PDF-1.7"),
        mimeType: "application/pdf",
      }),
    );
    expect(error.code).toBe("OCR_FAILED");
    expect(error.message).toMatch(/page images/);
    expect(tess.createWorker).not.toHaveBeenCalled();
  });

  it("wraps engine errors (tesseract.js rejects with strings) as OCR_FAILED with cause", async () => {
    const worker = fakeWorker();
    worker.recognize.mockRejectedValue("Error: Unknown format: no pix returned");
    tess.createWorker.mockResolvedValue(worker);

    const error = await rejection(createTesseractAdapter().recognize(pngInput()));
    expect(error.code).toBe("OCR_FAILED");
    expect(error.message).toBe(
      "tesseract recognition failed: Error: Unknown format: no pix returned",
    );
    expect(error.cause).toBe("Error: Unknown format: no pix returned");
  });

  it("wraps worker start-up failures as OCR_FAILED", async () => {
    const cause = new Error("Network error while fetching spa.traineddata");
    tess.createWorker.mockRejectedValue(cause);
    const error = await rejection(createTesseractAdapter().recognize(pngInput()));
    expect(error.code).toBe("OCR_FAILED");
    expect(error.message).toMatch(/could not start the tesseract worker \(languages: spa\+eng\)/);
    expect(error.cause).toBe(cause);
  });

  it("rejects early when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    const error = await rejection(
      createTesseractAdapter().recognize(pngInput({ abortSignal: controller.signal })),
    );
    expect(error.code).toBe("OCR_FAILED");
    expect(error.message).toMatch(/aborted/);
    expect((error.cause as Error).message).toBe("user cancelled");
    expect(tess.createWorker).not.toHaveBeenCalled();
  });

  it("an abort mid-recognition rejects right away and kills the stuck worker", async () => {
    const stuck = fakeWorker();
    stuck.recognize.mockImplementation(() => new Promise(() => {}));
    const fresh = fakeWorker();
    tess.createWorker.mockResolvedValueOnce(stuck).mockResolvedValueOnce(fresh);
    const adapter = createTesseractAdapter();
    const controller = new AbortController();

    const job = adapter.recognize(pngInput({ abortSignal: controller.signal }));
    await vi.waitFor(() => expect(stuck.recognize).toHaveBeenCalled());
    controller.abort();
    const error = await rejection(job);
    expect(error.code).toBe("OCR_FAILED");
    expect(error.message).toMatch(/aborted/);
    expect(stuck.terminate).toHaveBeenCalledTimes(1);

    await adapter.recognize(pngInput());
    expect(fresh.recognize).toHaveBeenCalledTimes(1);
  });

  it("an unknown language hint is an INVALID_INPUT error", async () => {
    const error = await rejection(
      createTesseractAdapter().recognize(pngInput({ languages: ["zz"] })),
    );
    expect(error.code).toBe("INVALID_INPUT");
  });
});

describe("OCR items through the reading-order layout", () => {
  async function ordered(blocks: FakeLine[][]): Promise<ReturnType<typeof orderTextItems>> {
    tess.createWorker.mockResolvedValue(fakeWorker(page(...blocks)));
    const out = (await createTesseractAdapter().recognize({
      data: pngHeader(1240, 1754),
      mimeType: "image/png",
    })) as OcrPage;
    return orderTextItems(ocrItemsToTextItems(out.items ?? [], out.height ?? 0), {
      width: out.width ?? 0,
      height: out.height ?? 0,
    });
  }

  it("does not glue a word to a wide glyph before it", async () => {
    // On a real scan the gap after "—" measured 0.36 of its width; here it is exactly 1/3, the
    // glyph-width threshold below which the layout would join two separate items without a space.
    const result = await ordered([
      [
        line(
          word("Sr.", 300, 140, 340, 166),
          word("—", 350, 150, 383, 152),
          word("Montevideo,", 394, 140, 530, 166),
        ),
      ],
    ]);
    expect(result.text).toBe("Sr. — Montevideo,");
  });

  it("keeps word gaps as spaces and splits two columns", async () => {
    // Pixel boxes as tesseract reports them for ~11 pt Arial at 150 dpi: word gaps ~8 px,
    // average glyph ~11 px wide, column gutter ~150 px. Tesseract emits one block per column.
    const left = [
      line(word("Analista", 80, 350, 160, 372), word("de", 168, 350, 190, 372)),
      line(word("Banco", 80, 392, 140, 414), word("Oriental", 148, 392, 230, 414)),
      line(word("Reportes", 80, 434, 168, 456), word("de", 176, 434, 198, 456)),
    ];
    const right = [
      line(word("Python", 760, 350, 846, 378)),
      line(word("Power", 760, 392, 826, 414), word("BI", 834, 392, 860, 414)),
      line(word("Excel", 760, 434, 816, 456), word("avanzado", 824, 434, 940, 456)),
    ];
    const result = await ordered([left, right]);
    expect(result.layout).toBe("multi-column");
    expect(result.text).toBe(
      "Analista de\nBanco Oriental\nReportes de\n\nPython\nPower BI\nExcel avanzado",
    );
  });
});

describe("readImageSize", () => {
  it("reads PNG, JPEG and WebP headers", async () => {
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(123, 45);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 123, 45);
    expect(readImageSize(canvas.toBuffer("image/png"), "image/png")).toEqual({
      width: 123,
      height: 45,
    });
    expect(readImageSize(canvas.toBuffer("image/jpeg"), "image/jpeg")).toEqual({
      width: 123,
      height: 45,
    });
    expect(readImageSize(canvas.toBuffer("image/webp"), "image/webp")).toEqual({
      width: 123,
      height: 45,
    });
  });

  it("returns undefined for other formats and broken headers", () => {
    expect(readImageSize(new Uint8Array([1, 2, 3]), "image/png")).toBeUndefined();
    expect(readImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg")).toBeUndefined();
    expect(readImageSize(new Uint8Array(40), "image/webp")).toBeUndefined();
    expect(readImageSize(pngHeader(10, 10), "image/tiff")).toBeUndefined();
  });
});

describe("missing dependency", () => {
  afterEach(() => {
    vi.doUnmock("tesseract.js");
    vi.resetModules();
  });

  it("throws MISSING_DEPENDENCY with the install command when tesseract.js is absent", async () => {
    vi.resetModules();
    vi.doMock("tesseract.js", () => {
      throw new Error("Cannot find package 'tesseract.js'");
    });
    const { createTesseractAdapter: create } = await import("../src/ocr/tesseract.js");
    const { CvparseError: FreshError } = await import("../src/errors.js");
    const error = await create()
      .recognize(pngInput())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FreshError);
    expect((error as CvparseError).code).toBe("MISSING_DEPENDENCY");
    expect((error as CvparseError).message).toMatch(/npm install tesseract\.js/);
  });

  it("throws MISSING_DEPENDENCY when the module has no createWorker", async () => {
    vi.resetModules();
    vi.doMock("tesseract.js", () => ({ default: {} }));
    const { createTesseractAdapter: create } = await import("../src/ocr/tesseract.js");
    const error = (await create()
      .recognize(pngInput())
      .catch((e: unknown) => e)) as CvparseError;
    expect(error.code).toBe("MISSING_DEPENDENCY");
    expect(error.message).toMatch(/createWorker/);
  });
});

// --- real engine (opt-in: downloads ~15 MB of traineddata on first run) ------------------------

describe("tesseract.js integration", () => {
  const fixture = join(here, "fixtures", "image", "cv-es-two-column.png");

  async function loadImage(): Promise<Uint8Array> {
    if (existsSync(fixture)) {
      return readFileSync(fixture);
    }
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(1240, 600);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 1240, 600);
    context.fillStyle = "#000";
    context.font = "bold 40px sans-serif";
    context.fillText("LUCÍA BEATRIZ MORALES", 80, 100);
    context.font = "26px sans-serif";
    ["EXPERIENCIA", "Banco Oriental S.A.", "Reportes de ventas semanales."].forEach((text, i) => {
      context.fillText(text, 80, 260 + i * 42);
    });
    ["HABILIDADES", "Python", "Excel avanzado"].forEach((text, i) => {
      context.fillText(text, 760, 260 + i * 42);
    });
    return canvas.toBuffer("image/png");
  }

  it.skipIf(process.env.CVPARSE_OCR_TESTS !== "1")(
    "recognizes a two-column CV image in reading order",
    async () => {
      tess.real = true;
      const adapter = createTesseractAdapter({
        languages: ["es"],
        cachePath: join(tmpdir(), "cvparse-tessdata"),
      });
      try {
        const out = (await adapter.recognize({
          data: await loadImage(),
          mimeType: "image/png",
        })) as OcrPage;
        expect(out.width).toBeGreaterThan(0);
        expect(out.confidence).toBeGreaterThan(0.6);
        const recognized = (out.items ?? []).map((item) => item.text).join(" | ");
        for (const expected of ["MORALES", "EXPERIENCIA", "HABILIDADES", "Banco Oriental"]) {
          expect(recognized).toContain(expected);
        }

        const ordered = orderTextItems(ocrItemsToTextItems(out.items ?? [], out.height ?? 0), {
          width: out.width ?? 0,
          height: out.height ?? 0,
        });
        expect(ordered.layout).toBe("multi-column");
        // Words come back with spaces between them...
        expect(ordered.text).toContain("Banco Oriental");
        expect(ordered.text).toContain("Reportes de ventas semanales");
        // ...and the left column is read before the right one.
        const text = ordered.text;
        expect(text.indexOf("Reportes de ventas")).toBeLessThan(text.indexOf("HABILIDADES"));
        expect(text.indexOf("HABILIDADES")).toBeLessThan(text.indexOf("Excel avanzado"));
      } finally {
        await adapter.dispose?.();
      }
    },
    180_000,
  );
});
