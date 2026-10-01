/**
 * PDF text extraction via unpdf (pdf.js bundled for Node). The library is imported lazily so
 * that `import "@cvparse/core"` does not load pdf.js unless a PDF is actually parsed.
 */

import { CvparseError } from "../errors.js";
import { orderTextItems } from "./layout.js";
import type { DetectedLayout, ExtractedDocument, TextItem } from "./types.js";

/** Below this many non-whitespace characters the document is treated as image-only. */
const MIN_TEXT_CHARS = 20;

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

/**
 * Extracts reading-order text from a PDF.
 *
 * @throws CvparseError `NO_TEXT_LAYER` when the PDF has no usable text (scanned / image-only),
 *   `EXTRACTION_FAILED` when pdf.js cannot open it (corrupt, password-protected).
 */
export async function extractPdfText(data: Uint8Array): Promise<ExtractedDocument> {
  const { getDocumentProxy } = await import("unpdf");

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(toPlainBytes(data), { verbosity: 0 });
  } catch (cause) {
    throw toExtractionError(cause);
  }

  const warnings: string[] = [];
  const pageTexts: string[] = [];
  let layout: DetectedLayout = "unknown";
  let nonWhitespace = 0;

  try {
    const pages = pdf.numPages;
    for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
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
        nonWhitespace += chars;
        if (chars === 0) {
          warnings.push(`Page ${pageNumber} has no text layer; it was skipped.`);
        } else {
          pageTexts.push(ordered.text);
          layout = mergeLayout(layout, ordered.layout);
        }
      } finally {
        page.cleanup();
      }
    }

    if (nonWhitespace < MIN_TEXT_CHARS) {
      throw new CvparseError(
        "NO_TEXT_LAYER",
        "No extractable text found: this PDF has no text layer (scanned or image-only). " +
          "OCR support is planned for 0.2; run OCR first and pass the text.",
      );
    }

    return {
      text: pageTexts.join("\n\n"),
      format: "pdf",
      pages,
      layout,
      warnings,
    };
  } catch (cause) {
    if (CvparseError.is(cause)) {
      throw cause;
    }
    throw toExtractionError(cause);
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

/** A document is multi-column if any page is; a page with text is at least single-column. */
function mergeLayout(current: DetectedLayout, page: DetectedLayout): DetectedLayout {
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
