import { CvparseError } from "../errors.js";
import type { OcrAdapter, OcrInput, OcrMimeType, OcrPage } from "../ocr/types.js";
import { NEEDS_OCR_HINT, scannedPageWarning } from "./messages.js";
import type { PdfAnalysis } from "./pdf.js";
import type { DetectedLayout, ExtractedDocument, InputFormat } from "./types.js";

export type { DetectedLayout, ExtractedDocument, InputFormat, TextItem } from "./types.js";

/** A document given as bytes, with optional hints. */
export interface DocumentInput {
  /** File contents. A Node `Buffer` is a `Uint8Array`, so it can be passed directly. */
  data: Uint8Array;
  /** Original file name; used as a tie-breaker when the bytes alone are ambiguous. */
  filename?: string;
  /** Skip detection and treat the bytes as this format. */
  format?: InputFormat;
}

/** Options for {@link extractText}. */
export interface ExtractTextOptions {
  /** OCR adapter for images and scanned PDFs. Without it those inputs are rejected. */
  ocr?: OcrAdapter;
  /**
   * Language hints forwarded to the OCR adapter (ISO 639-1 codes). When omitted, the adapter
   * uses its own configured languages.
   */
  ocrLanguages?: readonly string[];
  /** Aborts OCR / page rendering. */
  abortSignal?: AbortSignal;
}

/** What `detectFormat` can tell from the bytes. */
export type DetectedFormat = InputFormat | "image" | "legacy-doc" | "zip" | "unknown";

const PDF_MAGIC = "%PDF-";
const PDF_SCAN_WINDOW = 1024;

function startsWith(data: Uint8Array, bytes: number[], offset = 0): boolean {
  if (data.length < offset + bytes.length) return false;
  return bytes.every((b, i) => data[offset + i] === b);
}

function asciiIndexOf(data: Uint8Array, needle: string, limit = data.length): number {
  const n = needle.length;
  const end = Math.min(limit, data.length) - n;
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < n; j++) {
      if (data[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

function looksLikeText(data: Uint8Array): boolean {
  const window = data.subarray(0, 8192);
  for (const byte of window) {
    if (byte === 0) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(window);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sniffs the format of a document from its bytes (magic numbers), using the file name only to
 * break ties. Never throws.
 */
export function detectFormat(data: Uint8Array, filename?: string): DetectedFormat {
  if (data.length === 0) return "unknown";
  const ext = /\.([a-z0-9]+)$/i.exec(filename ?? "")?.[1]?.toLowerCase();

  if (asciiIndexOf(data, PDF_MAGIC, PDF_SCAN_WINDOW) !== -1) {
    // A plain-text CV that merely mentions "%PDF-" early on is still text; real PDFs contain
    // binary bytes and are rarely named .txt/.md.
    const textExtension = ext === "txt" || ext === "md" || ext === "markdown";
    if (!(textExtension && looksLikeText(data))) return "pdf";
  }

  // UTF-16 text (Windows Notepad "Unicode"): decoded by extractText via its BOM.
  if (hasUtf16Bom(data)) return "text";

  // ZIP local file header: PK\x03\x04. DOCX is a ZIP with word/document.xml inside.
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04])) {
    if (asciiIndexOf(data, "word/") !== -1) return "docx";
    return ext === "docx" ? "docx" : "zip";
  }

  // OLE2 compound file (legacy .doc, .xls, .ppt).
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "legacy-doc";

  if (
    startsWith(data, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    startsWith(data, [0xff, 0xd8, 0xff]) || // JPEG
    startsWith(data, [0x47, 0x49, 0x46, 0x38]) || // GIF
    (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) || // WEBP
    startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || // TIFF LE
    startsWith(data, [0x4d, 0x4d, 0x00, 0x2a]) || // TIFF BE
    startsWith(data, [0x42, 0x4d]) // BMP
  ) {
    return "image";
  }

  if (looksLikeText(data)) return "text";
  return "unknown";
}

function hasUtf16Bom(data: Uint8Array): boolean {
  return startsWith(data, [0xff, 0xfe]) || startsWith(data, [0xfe, 0xff]);
}

function decodeText(data: Uint8Array): string {
  const encoding = startsWith(data, [0xff, 0xfe])
    ? "utf-16le"
    : startsWith(data, [0xfe, 0xff])
      ? "utf-16be"
      : "utf-8";
  const text = new TextDecoder(encoding).decode(data);
  // Strip a BOM if the decoder left it in.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function unsupported(detected: DetectedFormat, filename?: string): CvparseError {
  const name = filename ? ` (${filename})` : "";
  switch (detected) {
    case "image":
      return new CvparseError(
        "OCR_REQUIRED",
        `${OCR_REQUIRED_MESSAGE}${name ? ` Input${name}.` : ""}`,
      );
    case "legacy-doc":
      return new CvparseError(
        "UNSUPPORTED_INPUT",
        `Legacy Word .doc input${name} is not supported. Save it as .docx or PDF and try again.`,
      );
    case "zip":
      return new CvparseError(
        "UNSUPPORTED_INPUT",
        `The input${name} is a ZIP archive but not a DOCX document.`,
      );
    default:
      return new CvparseError(
        "UNSUPPORTED_INPUT",
        `Could not recognize the input${name} as PDF, DOCX or UTF-8 text.`,
      );
  }
}

const OCR_REQUIRED_MESSAGE = `The input is an image and needs OCR: ${NEEDS_OCR_HINT}.`;

/**
 * MIME type of an image from its magic bytes, for the formats OCR adapters accept (PNG, JPEG,
 * WEBP, TIFF). `null` for anything else, including GIF and BMP.
 */
export function imageMimeType(data: Uint8Array): OcrMimeType | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  if (startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || startsWith(data, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "image/tiff";
  }
  return null;
}

/**
 * Turns a document (PDF, DOCX, plain text or, with an OCR adapter, an image) into reading-order
 * text. Format is detected from the bytes unless `format` is given. PDF and DOCX support is
 * loaded on demand, so callers that only pass text never load pdf.js or mammoth.
 *
 * PDFs are handled page by page: a page that looks scanned (no text layer, or only a short stamp
 * such as "Escaneado con CamScanner" over a page-size image) is OCR'd when `options.ocr` is given
 * (the PDF goes to the adapter as is when it declares `supports.pdf`; otherwise the scanned pages
 * are rendered to PNG, which needs the optional peer `@napi-rs/canvas`) and its stamp text is
 * dropped in favour of the OCR text. Without an adapter, the scanned pages of a PDF that also has
 * text pages are skipped with a warning and listed in `scannedPages`.
 *
 * @throws {CvparseError} `OCR_REQUIRED` for images without an adapter; `UNSUPPORTED_INPUT` for
 * GIF/BMP images, legacy .doc and unknown bytes; `NO_TEXT_LAYER` for PDFs without text and no
 * adapter (every page scanned); `EXTRACTION_FAILED` for corrupt documents; `OCR_FAILED` (also when
 * aborted during OCR) / `MISSING_DEPENDENCY` from OCR.
 */
export async function extractText(
  input: Uint8Array | DocumentInput,
  options: ExtractTextOptions = {},
): Promise<ExtractedDocument> {
  const { data, filename, format } =
    input instanceof Uint8Array ? { data: input, filename: undefined, format: undefined } : input;
  if (!(data instanceof Uint8Array)) {
    throw new CvparseError("INVALID_INPUT", "extractText expects a Uint8Array or { data }.");
  }

  const detected: DetectedFormat = format ?? detectFormat(data, filename);
  switch (detected) {
    case "text":
      return { text: decodeText(data), format: "text", layout: "unknown", warnings: [] };
    case "pdf":
      return extractPdf(data, options);
    case "docx": {
      const { extractDocxText } = await import("./docx.js");
      return extractDocxText(data);
    }
    case "image":
      return extractImage(data, filename, options);
    default:
      throw unsupported(detected, filename);
  }
}

async function extractImage(
  data: Uint8Array,
  filename: string | undefined,
  options: ExtractTextOptions,
): Promise<ExtractedDocument> {
  const adapter = options.ocr;
  if (!adapter) throw unsupported("image", filename);
  const mimeType = imageMimeType(data);
  if (!mimeType) {
    const name = filename ? ` (${filename})` : "";
    throw new CvparseError(
      "UNSUPPORTED_INPUT",
      `The image${name} is not PNG, JPEG, WEBP or TIFF. Convert it to PNG or JPEG and try again.`,
    );
  }
  const { recognizeWithAdapter } = await import("./ocr.js");
  return withOcrAbort(options.abortSignal, () =>
    recognizeWithAdapter(adapter, [ocrInput(data, mimeType, options)], "image"),
  );
}

/**
 * PDFs are read page by page. Pages with a text layer keep it; pages that look scanned (no text,
 * or only a short stamp over a page-size image) are OCR'd when an adapter is given, and their
 * text-layer stamp is dropped (the rendered page still shows it, so OCR reads it in place).
 */
async function extractPdf(
  data: Uint8Array,
  options: ExtractTextOptions,
): Promise<ExtractedDocument> {
  const pdf = await import("./pdf.js");
  const analysis = await pdf.analyzePdf(data);
  const imageOnly = pdf.isImageOnly(analysis);
  const adapter = options.ocr;
  if (!adapter) {
    if (imageOnly) throw pdf.noTextLayerError();
    return pdf.textLayerDocument(analysis);
  }
  // An image-only PDF is OCR'd whole (including near-empty pages); otherwise only scanned pages.
  const ocrPages = analysis.pages.filter((p) => imageOnly || p.needsOcr).map((p) => p.page);
  if (ocrPages.length === 0) return pdf.textLayerDocument(analysis);
  return withOcrAbort(options.abortSignal, () =>
    ocrPdf(data, analysis, ocrPages, adapter, options),
  );
}

async function ocrPdf(
  data: Uint8Array,
  analysis: PdfAnalysis,
  ocrPages: readonly number[],
  adapter: OcrAdapter,
  options: ExtractTextOptions,
): Promise<ExtractedDocument> {
  const { foldLayout, meanConfidence, ocrPageText, runAdapter } = await import("./ocr.js");
  const recognized = new Map<number, OcrPage[]>();
  const warnings: string[] = [];

  let render = !adapter.supports?.pdf;
  if (adapter.supports?.pdf) {
    const [result = []] = await runAdapter(adapter, [ocrInput(data, "application/pdf", options)]);
    if (result.length === analysis.totalPages) {
      for (const page of ocrPages) recognized.set(page, [result[page - 1] as OcrPage]);
    } else if (ocrPages.length === analysis.totalPages) {
      // Page mapping unknown, but every page needed OCR: keep the adapter's pages in order.
      result.forEach((page, index) => {
        recognized.set(index + 1, [page]);
      });
    } else {
      // Mixed PDF whose OCR pages cannot be mapped back: OCR the scanned pages as images instead.
      render = true;
    }
  }
  if (render) {
    const { renderPdfPages } = await import("./raster.js");
    const images = await renderPdfPages(data, { pages: ocrPages, signal: options.abortSignal });
    const results = await runAdapter(
      adapter,
      images.pages.map((p) => ({ ...ocrInput(p.png, "image/png", options), page: p.page })),
    );
    images.pages.forEach((p, index) => {
      recognized.set(p.page, results[index] ?? []);
    });
    if (images.truncated) {
      warnings.push(
        `ocr: only ${images.pages.length} of ${ocrPages.length} scanned pages were recognized`,
      );
    }
  }

  const texts: string[] = [];
  const confidences: number[] = [];
  const skipped: number[] = [];
  let layout: DetectedLayout = "unknown";
  let ocrCount = 0;
  const numbers = new Set<number>([...analysis.pages.map((p) => p.page), ...recognized.keys()]);
  for (const pageNumber of [...numbers].sort((a, b) => a - b)) {
    const ocrResult = recognized.get(pageNumber);
    if (ocrResult) {
      for (const ocrPage of ocrResult) {
        ocrCount++;
        const page = ocrPageText(adapter, ocrPage, pageNumber);
        warnings.push(...page.warnings);
        if (page.confidence !== undefined) confidences.push(page.confidence);
        layout = foldLayout(layout, page.layout);
        if (page.text) texts.push(page.text);
      }
      continue;
    }
    const page = analysis.pages[pageNumber - 1];
    if (!page) continue;
    if (ocrPages.includes(pageNumber)) {
      // Requested but not recognized (render cap): report it like an unread scanned page.
      skipped.push(pageNumber);
      warnings.push(scannedPageWarning(pageNumber));
    } else {
      texts.push(page.text);
      layout = foldLayout(layout, page.layout);
    }
  }

  const confidence = meanConfidence(confidences);
  const doc: ExtractedDocument = {
    text: texts.join("\n\n"),
    format: "pdf",
    pages: analysis.totalPages,
    layout,
    warnings,
    ocr: {
      adapter: adapter.name,
      ...(confidence === undefined ? {} : { confidence }),
      pages: ocrCount,
    },
  };
  if (skipped.length > 0) doc.scannedPages = skipped;
  return doc;
}

/**
 * Maps an abort during OCR or page rendering (the signal's raw reason, usually a DOMException)
 * to `OCR_FAILED`. Other errors pass through.
 */
async function withOcrAbort<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const aborted =
      !CvparseError.is(error) &&
      (signal?.aborted === true || (error instanceof Error && error.name === "AbortError"));
    if (aborted) throw new CvparseError("OCR_FAILED", "OCR was aborted.", { cause: error });
    throw error;
  }
}

function ocrInput(data: Uint8Array, mimeType: OcrMimeType, options: ExtractTextOptions): OcrInput {
  const input: OcrInput = { data, mimeType };
  if (options.ocrLanguages) input.languages = options.ocrLanguages;
  if (options.abortSignal) input.abortSignal = options.abortSignal;
  return input;
}
