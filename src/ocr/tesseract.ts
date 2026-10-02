/**
 * Tesseract OCR adapter (`@cvparse/core/ocr/tesseract`), backed by `tesseract.js`, which is an
 * optional peer dependency loaded on first use. Runs fully locally (WASM in a worker thread),
 * so it pairs with Ollama for a no-cloud pipeline.
 *
 * The adapter returns positioned phrases (the words of one Tesseract line, split wherever the
 * gap is wide enough to be a gutter or a tab stop) so cvparse's reading-order algorithm
 * (`orderTextItems`) can split columns and sidebars the same way it does for PDFs, instead of
 * trusting the engine's own line order. See `toOcrPage` for why not single words.
 */

import { mkdir } from "node:fs/promises";
import { CvparseError } from "../errors.js";
import type { OcrAdapter, OcrInput, OcrItem, OcrMimeType, OcrPage } from "./types.js";

/** Tesseract page segmentation modes (`tessedit_pageseg_mode`). Mirrors `tesseract.js`'s `PSM`. */
export const PSM = {
  OSD_ONLY: "0",
  AUTO_OSD: "1",
  AUTO_ONLY: "2",
  /** Full automatic page segmentation, no orientation detection. Default. */
  AUTO: "3",
  SINGLE_COLUMN: "4",
  SINGLE_BLOCK_VERT_TEXT: "5",
  SINGLE_BLOCK: "6",
  SINGLE_LINE: "7",
  SINGLE_WORD: "8",
  CIRCLE_WORD: "9",
  SINGLE_CHAR: "10",
  /** Find as much text as possible in no particular order. */
  SPARSE_TEXT: "11",
  SPARSE_TEXT_OSD: "12",
  RAW_LINE: "13",
} as const;

/** Tesseract OCR engine modes. Mirrors `tesseract.js`'s `OEM`. */
export const OEM = {
  TESSERACT_ONLY: 0,
  /** Neural-net LSTM engine only. Default of `tesseract.js`. */
  LSTM_ONLY: 1,
  TESSERACT_LSTM_COMBINED: 2,
  DEFAULT: 3,
} as const;

export type TesseractPsm = (typeof PSM)[keyof typeof PSM];
export type TesseractOem = (typeof OEM)[keyof typeof OEM];

/** Progress message forwarded from `tesseract.js` (`loading language traineddata`, `recognizing text`, ...). */
export interface TesseractLogMessage {
  status: string;
  /** 0..1 */
  progress: number;
  workerId?: string;
  jobId?: string;
  userJobId?: string;
}

/** Options for {@link createTesseractAdapter}. */
export interface TesseractAdapterOptions {
  /**
   * Languages to recognize, as ISO 639-1 (`"es"`), ISO 639-2 (`"spa"`) or Tesseract codes
   * (`"chi_sim"`). Two-letter codes are mapped; three-letter and longer codes pass through.
   * Order matters: put the document's main language first. Default `["spa", "eng"]`.
   * `OcrInput.languages` (which `parseResume` fills from `ocrLanguages` / `language`) overrides it.
   */
  languages?: readonly string[];
  /**
   * Where `<lang>.traineddata(.gz)` files are read from: a local directory or a base URL.
   * By default `tesseract.js` downloads them from its jsDelivr CDN on first use, which needs
   * network access and sends the language list (not the image) to a third party. For an
   * offline or air-gapped setup download the files once and point this at the directory.
   */
  langPath?: string;
  /**
   * Directory where downloaded traineddata is cached (created if missing). `tesseract.js`
   * defaults to the current working directory (it writes `spa.traineddata` next to your
   * process); set this to keep the cache somewhere deliberate.
   */
  cachePath?: string;
  /** Path of the worker script. Passed through to `tesseract.js`; rarely needed. */
  workerPath?: string;
  /** Path or URL of `tesseract-core*.wasm.js`. Passed through to `tesseract.js`; rarely needed. */
  corePath?: string;
  /** Receives progress messages (traineddata download, recognition progress). */
  logger?: (message: TesseractLogMessage) => void;
  /**
   * Page segmentation mode. Default {@link PSM.AUTO}: full layout analysis, which keeps the
   * lines of each column separate and gives reliable word boxes. It is Tesseract's own default
   * and is pinned explicitly because `tesseract.js` < 5 defaulted to {@link PSM.SINGLE_BLOCK},
   * which treats the page as one block and runs lines straight across a two-column gutter. {@link PSM.SPARSE_TEXT} finds
   * stray text in icon-heavy sidebars that AUTO sometimes drops, at the cost of noisier output.
   */
  psm?: TesseractPsm;
  /** OCR engine mode. Default: `tesseract.js`'s (LSTM only). */
  oem?: TesseractOem;
  /**
   * Detect and correct small skew angles before recognition (uses Tesseract's own estimate).
   * Helps with phone photos and slightly rotated scans; costs an extra layout pass.
   */
  rotateAuto?: boolean;
}

/** ISO 639-1 to Tesseract traineddata codes. Three-letter codes pass through unchanged. */
const ISO_639_1_TO_TESSERACT: Readonly<Record<string, string>> = {
  es: "spa",
  en: "eng",
  pt: "por",
  fr: "fra",
  de: "deu",
  it: "ita",
  ca: "cat",
  eu: "eus",
  gl: "glg",
  nl: "nld",
  pl: "pol",
  ro: "ron",
  ru: "rus",
  uk: "ukr",
  tr: "tur",
  sv: "swe",
  da: "dan",
  nb: "nor",
  no: "nor",
  fi: "fin",
  cs: "ces",
  sk: "slk",
  hu: "hun",
  el: "ell",
  he: "heb",
  ar: "ara",
  ja: "jpn",
  ko: "kor",
  zh: "chi_sim",
};

const DEFAULT_LANGUAGES: readonly string[] = ["spa", "eng"];

/**
 * Maps language hints to a Tesseract language string (`"spa+eng"`). Two-letter ISO 639-1 codes
 * are translated (region subtags such as `es-AR` are dropped); anything longer is passed
 * through lowercased so Tesseract-specific codes (`chi_sim`, `spa_old`) work.
 *
 * @throws CvparseError `INVALID_INPUT` for an empty list or an unknown two-letter code.
 */
export function toTesseractLanguages(codes: readonly string[]): string {
  const mapped: string[] = [];
  for (const raw of codes) {
    const code = raw.trim().toLowerCase().split(/[-_]/)[0] ?? "";
    if (code.length === 0) {
      continue;
    }
    let tess: string;
    if (code.length === 2) {
      const found = ISO_639_1_TO_TESSERACT[code];
      if (!found) {
        throw new CvparseError(
          "INVALID_INPUT",
          `unknown OCR language code "${raw}"; pass a Tesseract code such as "spa" instead`,
        );
      }
      tess = found;
    } else {
      // Keep Tesseract codes with underscores intact ("chi_sim" was split above on "_"), but
      // drop a BCP 47 region subtag ("spa-ES" → "spa"): Tesseract has no such traineddata.
      tess = raw.trim().toLowerCase().split("-")[0] ?? code;
    }
    if (!mapped.includes(tess)) {
      mapped.push(tess);
    }
  }
  if (mapped.length === 0) {
    throw new CvparseError("INVALID_INPUT", "at least one OCR language is required");
  }
  return mapped.join("+");
}

// Minimal view of the tesseract.js API the adapter uses. Declared here (not imported from the
// package types) so the published .d.ts does not require the optional peer to be installed.
interface TessBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TessWord {
  text: string;
  confidence: number;
  bbox: TessBbox;
}
interface TessLine {
  words: TessWord[];
  bbox: TessBbox;
}
interface TessParagraph {
  lines: TessLine[];
}
interface TessBlock {
  paragraphs: TessParagraph[];
  bbox: TessBbox;
}
interface TessPage {
  text: string | null;
  confidence: number | null;
  blocks: TessBlock[] | null;
}
interface TessWorker {
  recognize(
    image: Buffer,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ): Promise<{ data: TessPage }>;
  reinitialize(langs: string, oem?: number): Promise<unknown>;
  terminate(): Promise<unknown>;
}
interface TessModule {
  createWorker(langs: string, oem?: number, options?: Record<string, unknown>): Promise<TessWorker>;
}

/** Imports `tesseract.js` lazily; the peer is optional so a failed import is a user-facing error. */
async function loadTesseract(): Promise<TessModule> {
  let loaded: unknown;
  try {
    loaded = await import("tesseract.js");
  } catch (error) {
    throw new CvparseError(
      "MISSING_DEPENDENCY",
      "tesseract.js is not installed; run `npm install tesseract.js` to use the Tesseract OCR adapter",
      { cause: error },
    );
  }
  // tesseract.js is CommonJS: depending on the loader the API is the module itself or `default`.
  const candidate = (loaded as { default?: unknown }).default ?? loaded;
  if (typeof (candidate as Partial<TessModule>).createWorker !== "function") {
    throw new CvparseError(
      "MISSING_DEPENDENCY",
      "tesseract.js was found but does not export createWorker; install tesseract.js >= 5",
    );
  }
  return candidate as TessModule;
}

/**
 * Creates an {@link OcrAdapter} backed by `tesseract.js`.
 *
 * The worker (a worker thread running Tesseract compiled to WASM) starts on the first
 * `recognize` call and is reused; languages are reloaded when a call asks for different ones.
 * Calls are serialized on the single worker. Call `dispose()` when done, or the worker thread
 * keeps the process alive.
 *
 * Accepts images only (`supports.pdf` is false): cvparse renders PDF pages to PNG before
 * calling the adapter when `@napi-rs/canvas` is installed.
 */
export function createTesseractAdapter(options: TesseractAdapterOptions = {}): OcrAdapter {
  const defaultLanguages = toTesseractLanguages(options.languages ?? DEFAULT_LANGUAGES);
  const psm = options.psm ?? PSM.AUTO;

  let worker: TessWorker | undefined;
  let workerLanguages = "";
  // Serializes worker access: one worker, one job at a time, and a language switch must not
  // interleave with a recognition.
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function ensureWorker(languages: string): Promise<TessWorker> {
    if (!worker) {
      const tesseract = await loadTesseract();
      const workerOptions: Record<string, unknown> = {
        // Without a handler tesseract.js rethrows job errors inside its message listener,
        // which surfaces as an uncaught exception on the main thread.
        errorHandler: () => {},
      };
      if (options.langPath !== undefined) workerOptions.langPath = options.langPath;
      if (options.cachePath !== undefined) workerOptions.cachePath = options.cachePath;
      if (options.workerPath !== undefined) workerOptions.workerPath = options.workerPath;
      if (options.corePath !== undefined) workerOptions.corePath = options.corePath;
      if (options.logger !== undefined) workerOptions.logger = options.logger;
      if (options.cachePath !== undefined) {
        // tesseract.js writes `<cachePath>/<lang>.traineddata` with a bare fs.writeFile and
        // swallows the error, so a missing directory silently disables the cache.
        await mkdir(options.cachePath, { recursive: true }).catch(() => undefined);
      }
      try {
        worker = await tesseract.createWorker(languages, options.oem, workerOptions);
      } catch (error) {
        throw ocrFailed(`could not start the tesseract worker (languages: ${languages})`, error);
      }
      workerLanguages = languages;
    } else if (languages !== workerLanguages) {
      try {
        await worker.reinitialize(languages, options.oem);
      } catch (error) {
        // A failed reinitialize leaves the engine half-loaded; start fresh on the next call.
        await discardWorker(worker);
        throw ocrFailed(`could not switch tesseract languages to ${languages}`, error);
      }
      workerLanguages = languages;
    }
    return worker;
  }

  /** Terminates `target` and forgets it if it is still the current worker. Never throws. */
  async function discardWorker(target: TessWorker): Promise<void> {
    if (worker === target) {
      worker = undefined;
      workerLanguages = "";
    }
    try {
      await target.terminate();
    } catch {
      // Already dead; nothing to release.
    }
  }

  return {
    name: "tesseract",
    supports: { pdf: false },

    async recognize(input: OcrInput): Promise<OcrPage> {
      throwIfAborted(input.abortSignal);
      if (input.mimeType === "application/pdf") {
        throw new CvparseError(
          "OCR_FAILED",
          "tesseract adapter needs page images; cvparse renders PDFs when @napi-rs/canvas is installed",
        );
      }
      const languages = input.languages?.length
        ? toTesseractLanguages(input.languages)
        : defaultLanguages;

      return enqueue(async () => {
        // The signal may have fired while an earlier job held the worker.
        throwIfAborted(input.abortSignal);
        const active = await ensureWorker(languages);
        throwIfAborted(input.abortSignal);

        const image = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
        const recognizeOptions: Record<string, unknown> = { tessedit_pageseg_mode: psm };
        if (options.rotateAuto) {
          recognizeOptions.rotateAuto = true;
        }
        // tesseract.js >= 6 only fills `data.blocks` (and with it the word boxes) on request;
        // `data.words` / `data.lines` no longer exist.
        const job = active.recognize(image, recognizeOptions, { text: true, blocks: true });

        // tesseract.js cannot cancel a job, so an abort terminates the worker: the caller is
        // released right away, the CPU is freed, and the next call starts a fresh worker.
        let result: { data: TessPage };
        try {
          result = await raceAbort(job, input.abortSignal);
        } catch (error) {
          if (input.abortSignal?.aborted) {
            await discardWorker(active);
          }
          throw error;
        }
        return toOcrPage(result.data, input);
      });
    },

    async dispose(): Promise<void> {
      await enqueue(async () => {
        const active = worker;
        worker = undefined;
        workerLanguages = "";
        if (active) {
          await active.terminate();
        }
      });
    },
  };
}

function ocrFailed(message: string, cause: unknown): CvparseError {
  const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return new CvparseError("OCR_FAILED", detail ? `${message}: ${detail}` : message, { cause });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal: AbortSignal): CvparseError {
  return new CvparseError("OCR_FAILED", "OCR recognition was aborted", { cause: signal.reason });
}

async function raceAbort<T>(job: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const wrapped = job.catch((error: unknown) => {
    throw ocrFailed("tesseract recognition failed", error);
  });
  if (!signal) {
    return wrapped;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([wrapped, aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    // Keep the engine's eventual rejection from surfacing as unhandled after an abort.
    wrapped.catch(() => undefined);
  }
}

/**
 * A gap between two words of a Tesseract line wider than this × the line height splits them into
 * separate items (a column gutter or a tab stop); narrower gaps are ordinary word spaces.
 */
const PHRASE_GAP_RATIO = 0.8;

/**
 * Builds the `OcrPage` from a tesseract.js result, walking blocks → paragraphs → lines → words.
 *
 * Items are phrases, not words. The layout code re-derives spaces from geometry (a gap wider
 * than a third of the previous item's average glyph width), which is right for PDF text runs
 * but marginal for OCR word boxes: they are tight to the ink, so after a wide glyph ("—", "M",
 * "W") the measured gap is barely over the threshold (0.36 glyph widths on a real 150 dpi scan)
 * and the words would be glued. Tesseract already knows where the word breaks are, so the words
 * of a line are joined with spaces here and only split where the gap is gutter-sized, which keeps
 * column detection working even when Tesseract runs a line across two columns.
 */
function toOcrPage(data: TessPage, input: OcrInput): OcrPage {
  const items: OcrItem[] = [];
  const warnings: string[] = [];
  let confidenceSum = 0;
  let confidenceCount = 0;
  let extentX = 0;
  let extentY = 0;

  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        // Word boxes are tight to the ink, so words without ascenders/descenders ("con") sit on
        // a different bottom edge than their neighbours ("gap") and would be grouped onto
        // separate baselines. The vertical extent comes from the line instead.
        const lineTop = line.bbox.y0;
        const lineHeight = line.bbox.y1 - line.bbox.y0;
        const maxGap = Math.max(lineHeight * PHRASE_GAP_RATIO, 1);
        let phrase: { words: string[]; x0: number; x1: number; confidences: number[] } | undefined;
        const flush = () => {
          if (!phrase) return;
          const item: OcrItem = {
            text: phrase.words.join(" "),
            x: phrase.x0,
            y: lineTop,
            width: phrase.x1 - phrase.x0,
            height: lineHeight,
          };
          if (phrase.confidences.length > 0) {
            item.confidence =
              phrase.confidences.reduce((sum, c) => sum + c, 0) / phrase.confidences.length;
          }
          items.push(item);
          phrase = undefined;
        };

        for (const word of line.words ?? []) {
          const text = word.text.trim();
          if (text.length === 0) {
            continue;
          }
          if (phrase && word.bbox.x0 - phrase.x1 > maxGap) {
            flush();
          }
          phrase ??= { words: [], x0: word.bbox.x0, x1: word.bbox.x1, confidences: [] };
          phrase.words.push(text);
          phrase.x0 = Math.min(phrase.x0, word.bbox.x0);
          phrase.x1 = Math.max(phrase.x1, word.bbox.x1);
          if (Number.isFinite(word.confidence)) {
            const confidence = clamp01(word.confidence / 100);
            phrase.confidences.push(confidence);
            confidenceSum += confidence;
            confidenceCount++;
          }
          extentX = Math.max(extentX, word.bbox.x1);
          extentY = Math.max(extentY, line.bbox.y1);
        }
        flush();
      }
    }
  }

  let size = readImageSize(input.data, input.mimeType);
  if (!size) {
    size = { width: Math.ceil(extentX), height: Math.ceil(extentY) };
    warnings.push(
      `could not read the image size from the ${input.mimeType} header; using the text extent (${size.width}x${size.height})`,
    );
  }

  let confidence: number | undefined;
  if (confidenceCount > 0) {
    confidence = confidenceSum / confidenceCount;
  } else if (typeof data.confidence === "number" && Number.isFinite(data.confidence)) {
    confidence = clamp01(data.confidence / 100);
  }

  // Empty pages and low confidence are reported by cvparse itself (src/extract/ocr.ts), once
  // per page, so they are not repeated here.
  const page: OcrPage = { width: size.width, height: size.height, items, warnings };
  if (confidence !== undefined) {
    page.confidence = confidence;
  }
  return page;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

interface ImageSize {
  width: number;
  height: number;
}

/**
 * Reads the pixel size from a PNG, JPEG or WebP header (tesseract.js does not report it).
 * Returns `undefined` for other formats or malformed headers.
 */
export function readImageSize(data: Uint8Array, mimeType: OcrMimeType): ImageSize | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (mimeType) {
    case "image/png":
      return readPngSize(data, view);
    case "image/jpeg":
      return readJpegSize(data, view);
    case "image/webp":
      return readWebpSize(data, view);
    default:
      return undefined;
  }
}

function readPngSize(data: Uint8Array, view: DataView): ImageSize | undefined {
  // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4).
  if (data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e) {
    return undefined;
  }
  if (String.fromCharCode(data[12] ?? 0, data[13] ?? 0, data[14] ?? 0, data[15] ?? 0) !== "IHDR") {
    return undefined;
  }
  return validSize(view.getUint32(16), view.getUint32(20));
}

function readJpegSize(data: Uint8Array, view: DataView): ImageSize | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = data[offset + 1] ?? 0;
    // Padding and standalone markers carry no length.
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return validSize(view.getUint16(offset + 7), view.getUint16(offset + 5));
    }
    if (marker === 0xda || marker === 0xd9) {
      return undefined; // Start of scan / end of image without a frame header.
    }
    offset += 2 + length;
  }
  return undefined;
}

function readWebpSize(data: Uint8Array, view: DataView): ImageSize | undefined {
  if (data.length < 30 || ascii(data, 0, 4) !== "RIFF" || ascii(data, 8, 4) !== "WEBP") {
    return undefined;
  }
  const chunk = ascii(data, 12, 4);
  if (chunk === "VP8 ") {
    return validSize(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  }
  if (chunk === "VP8L") {
    const b0 = data[21] ?? 0;
    const b1 = data[22] ?? 0;
    const b2 = data[23] ?? 0;
    const b3 = data[24] ?? 0;
    return validSize(
      1 + (b0 | ((b1 & 0x3f) << 8)),
      1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
    );
  }
  if (chunk === "VP8X") {
    const width = 1 + ((data[24] ?? 0) | ((data[25] ?? 0) << 8) | ((data[26] ?? 0) << 16));
    const height = 1 + ((data[27] ?? 0) | ((data[28] ?? 0) << 8) | ((data[29] ?? 0) << 16));
    return validSize(width, height);
  }
  return undefined;
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function validSize(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}
