/**
 * PDF text extraction via unpdf (pdf.js bundled for Node). The library is imported lazily so
 * that `import "@cvparse/core"` does not load pdf.js unless a PDF is actually parsed.
 *
 * Scanned pages are detected per page: a page needs OCR when it has no text, or when it has only
 * a few characters (a scanner-app stamp such as "Escaneado con CamScanner") over a page-size image.
 */

import { CvparseError } from "../errors.js";
import { orderTextItems } from "./layout.js";
import { NEEDS_OCR_HINT, scannedPageWarning } from "./messages.js";
import type { DetectedLayout, ExtractedDocument, TextItem } from "./types.js";

/** Below this many non-whitespace characters (across text pages) the PDF is image-only. */
const MIN_TEXT_CHARS = 20;

/**
 * A page with fewer non-whitespace characters than this, and an image covering at least
 * {@link SCAN_IMAGE_COVERAGE} of it, is treated as scanned: the text is a stamp or footer added
 * by a scanner app, not the CV.
 */
const MIN_PAGE_CHARS = 80;

/** Share of the page area one image must cover for a short-text page to count as scanned. */
const SCAN_IMAGE_COVERAGE = 0.25;

/** Text-layer analysis of one PDF page. */
export interface PdfPageText {
  /** 1-based page number. */
  page: number;
  /** Reading-order text of the text layer (on a scanned page, at most a short stamp). */
  text: string;
  /** Non-whitespace characters in `text`. */
  chars: number;
  layout: DetectedLayout;
  /** True when the page looks scanned: no text, or tiny text over a large image. */
  needsOcr: boolean;
}

/** Text-layer analysis of a whole PDF. */
export interface PdfAnalysis {
  totalPages: number;
  pages: PdfPageText[];
}

/** Shape of a pdf.js `TextItem` (marked-content entries lack `str` and are skipped). */
interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

function isRawTextItem(value: unknown): value is RawTextItem {
  return (
    typeof value === "object" &&
    value !== null &&
    "str" in value &&
    typeof (value as { str: unknown }).str === "string" &&
    "transform" in value &&
    Array.isArray((value as { transform: unknown }).transform)
  );
}

/** pdf.js operator codes (`OPS`) needed to locate painted images. */
const OP_SAVE = 10;
const OP_RESTORE = 11;
const OP_TRANSFORM = 12;
const OP_FORM_BEGIN = 74;
const OP_FORM_END = 75;
/** paintImageMaskXObject(83) .. paintSolidColorImageMask(90). */
const IMAGE_OPS = new Set([83, 84, 85, 86, 87, 88, 89, 90]);

type Matrix = [number, number, number, number, number, number];

/** `n × m`: applies `n` (a PDF `cm` matrix) in the space of the current matrix `m`. */
function concat(m: Matrix, n: readonly unknown[]): Matrix {
  const [a, b, c, d, e, f] = m;
  const [a2, b2, c2, d2, e2, f2] = n.map((v) => (typeof v === "number" ? v : 0));
  return [
    (a2 ?? 1) * a + (b2 ?? 0) * c,
    (a2 ?? 1) * b + (b2 ?? 0) * d,
    (c2 ?? 0) * a + (d2 ?? 1) * c,
    (c2 ?? 0) * b + (d2 ?? 1) * d,
    (e2 ?? 0) * a + (f2 ?? 0) * c + e,
    (e2 ?? 0) * b + (f2 ?? 0) * d + f,
  ];
}

/**
 * Largest share (0..1) of the page covered by a single painted image. Images are drawn into the
 * unit square under the current transform, so their area is |det(CTM)|.
 */
export function largestImageCoverage(
  operators: { fnArray: readonly number[]; argsArray: readonly unknown[] },
  pageArea: number,
): number {
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let largest = 0;
  operators.fnArray.forEach((fn, i) => {
    const args = operators.argsArray[i];
    if (fn === OP_SAVE) {
      stack.push(ctm);
    } else if (fn === OP_RESTORE || fn === OP_FORM_END) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === OP_TRANSFORM && Array.isArray(args) && args.length === 6) {
      ctm = concat(ctm, args);
    } else if (fn === OP_FORM_BEGIN) {
      stack.push(ctm);
      const matrix = Array.isArray(args) ? args[0] : undefined;
      if (Array.isArray(matrix) && matrix.length === 6) ctm = concat(ctm, matrix);
    } else if (IMAGE_OPS.has(fn) && pageArea > 0) {
      const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
      largest = Math.max(largest, Math.min(1, area / pageArea));
    }
  });
  return largest;
}

/**
 * Reads the text layer of every page and flags the pages that look scanned.
 *
 * @throws CvparseError `EXTRACTION_FAILED` when pdf.js cannot open the file (corrupt,
 *   password-protected).
 */
export async function analyzePdf(data: Uint8Array): Promise<PdfAnalysis> {
  const { getDocumentProxy } = await import("unpdf");

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(toPlainBytes(data), { verbosity: 0 });
  } catch (cause) {
    throw toExtractionError(cause);
  }

  try {
    const totalPages = pdf.numPages;
    const pages: PdfPageText[] = [];
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items: TextItem[] = [];
        for (const raw of content.items) {
          if (!isRawTextItem(raw)) {
            continue;
          }
          items.push({
            str: raw.str,
            x: raw.transform[4] ?? 0,
            y: raw.transform[5] ?? 0,
            width: raw.width,
            height: raw.height,
            hasEOL: raw.hasEOL,
          });
        }

        const ordered = orderTextItems(items, { width: viewport.width, height: viewport.height });
        const chars = ordered.text.replace(/\s+/g, "").length;
        let needsOcr = chars === 0;
        if (!needsOcr && chars < MIN_PAGE_CHARS) {
          // Only short pages pay for the operator list (it loads the page's images).
          const operators = await page.getOperatorList();
          needsOcr =
            largestImageCoverage(operators, viewport.width * viewport.height) >=
            SCAN_IMAGE_COVERAGE;
        }
        pages.push({
          page: pageNumber,
          text: ordered.text,
          chars,
          layout: ordered.layout,
          needsOcr,
        });
      } finally {
        page.cleanup();
      }
    }
    return { totalPages, pages };
  } catch (cause) {
    if (CvparseError.is(cause)) {
      throw cause;
    }
    throw toExtractionError(cause);
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

/** The `NO_TEXT_LAYER` error for a PDF that has no usable text layer at all. */
export function noTextLayerError(): CvparseError {
  return new CvparseError(
    "NO_TEXT_LAYER",
    `No extractable text found: this PDF has no text layer (scanned or image-only) and needs OCR: ${NEEDS_OCR_HINT}.`,
  );
}

/** True when no page has a usable text layer (every page scanned, or almost no text overall). */
export function isImageOnly(analysis: PdfAnalysis): boolean {
  const chars = analysis.pages.reduce((sum, p) => sum + (p.needsOcr ? 0 : p.chars), 0);
  return analysis.pages.every((p) => p.needsOcr) || chars < MIN_TEXT_CHARS;
}

/**
 * Joins the text-layer pages of an analysis. Pages that look scanned are left out with a warning
 * and listed in `scannedPages`.
 */
export function textLayerDocument(analysis: PdfAnalysis): ExtractedDocument {
  const warnings: string[] = [];
  const texts: string[] = [];
  const scannedPages: number[] = [];
  let layout: DetectedLayout = "unknown";
  for (const page of analysis.pages) {
    if (page.needsOcr) {
      scannedPages.push(page.page);
      warnings.push(scannedPageWarning(page.page));
    } else {
      texts.push(page.text);
      layout = mergeLayout(layout, page.layout);
    }
  }
  const doc: ExtractedDocument = {
    text: texts.join("\n\n"),
    format: "pdf",
    pages: analysis.totalPages,
    layout,
    warnings,
  };
  if (scannedPages.length > 0) doc.scannedPages = scannedPages;
  return doc;
}

/**
 * Extracts reading-order text from a PDF's text layer. Pages that look scanned are skipped with a
 * warning and listed in `scannedPages` (use `extractText` with an OCR adapter to read them).
 *
 * @throws CvparseError `NO_TEXT_LAYER` when every page looks scanned (even if a scanner stamp
 *   adds a few characters), `EXTRACTION_FAILED` when pdf.js cannot open the file.
 */
export async function extractPdfText(data: Uint8Array): Promise<ExtractedDocument> {
  const analysis = await analyzePdf(data);
  if (isImageOnly(analysis)) throw noTextLayerError();
  return textLayerDocument(analysis);
}

/** A document is multi-column if any page is; a page with text is at least single-column. */
export function mergeLayout(current: DetectedLayout, page: DetectedLayout): DetectedLayout {
  if (current === "multi-column" || page === "multi-column") {
    return "multi-column";
  }
  if (page === "single-column") {
    return "single-column";
  }
  return current;
}

/**
 * pdf.js transfers the underlying ArrayBuffer to its worker, which detaches it: the caller's
 * array would be left with byteLength 0. Always hand pdf.js a private copy.
 */
function toPlainBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(data);
}

function toExtractionError(cause: unknown): CvparseError {
  const name = cause instanceof Error ? cause.name : "";
  const detail = cause instanceof Error ? cause.message : String(cause);
  const reason =
    name === "PasswordException"
      ? "the PDF is password-protected"
      : name === "InvalidPDFException"
        ? "the file is not a valid PDF or is corrupt"
        : "pdf.js could not read the file";
  return new CvparseError("EXTRACTION_FAILED", `Could not extract text: ${reason} (${detail}).`, {
    cause,
  });
}
