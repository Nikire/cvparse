/**
 * Runs an {@link OcrAdapter} over one or more inputs and turns its output into an
 * {@link ExtractedDocument}. Positioned words go through the same reading-order algorithm as
 * PDF text, so two-column scans come out column by column.
 */

import { CvparseError } from "../errors.js";
import type { OcrAdapter, OcrInput, OcrPage } from "../ocr/types.js";
import { ocrItemsToTextItems } from "../ocr/types.js";
import { orderTextItems } from "./layout.js";
import type { DetectedLayout, ExtractedDocument } from "./types.js";

/** Pages below this mean confidence get a warning. */
const LOW_CONFIDENCE = 0.7;

/**
 * Calls `adapter.recognize` for each input, sequentially, and returns the pages each one produced.
 *
 * @throws CvparseError `OCR_FAILED` when the adapter throws a non-cvparse error; cvparse errors
 *   (e.g. `MISSING_DEPENDENCY` from a reference adapter) are rethrown as is. An abort is
 *   rethrown untouched (the caller maps it).
 */
export async function runAdapter(
  adapter: OcrAdapter,
  inputs: readonly OcrInput[],
): Promise<OcrPage[][]> {
  const results: OcrPage[][] = [];
  for (const input of inputs) {
    input.abortSignal?.throwIfAborted();
    let result: OcrPage | OcrPage[];
    try {
      result = await adapter.recognize(input);
    } catch (cause) {
      if (CvparseError.is(cause)) throw cause;
      if (input.abortSignal?.aborted) throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new CvparseError("OCR_FAILED", `${adapter.name}: ${message}`, { cause });
    }
    results.push(Array.isArray(result) ? result : result ? [result] : []);
  }
  return results;
}

/** Text of one recognized page, its layout and warnings (numbered with `pageNumber`). */
export function ocrPageText(
  adapter: OcrAdapter,
  page: OcrPage,
  pageNumber: number,
): { text: string; layout: DetectedLayout; warnings: string[]; confidence?: number } {
  const warnings: string[] = [];
  for (const w of page.warnings ?? []) warnings.push(`${adapter.name}: ${w}`);

  let text: string;
  let layout: DetectedLayout = "unknown";
  if (page.items && page.items.length > 0 && page.width && page.height) {
    const ordered = orderTextItems(ocrItemsToTextItems(page.items, page.height), {
      width: page.width,
      height: page.height,
    });
    text = ordered.text;
    layout = ordered.layout;
  } else {
    text = (page.text ?? "").replace(/\r\n?/g, "\n").trim();
  }

  let confidence: number | undefined;
  if (typeof page.confidence === "number" && Number.isFinite(page.confidence)) {
    confidence = page.confidence;
    if (page.confidence < LOW_CONFIDENCE) {
      warnings.push(`ocr: low confidence (${page.confidence.toFixed(2)}) on page ${pageNumber}`);
    }
  }
  if (text.replace(/\s+/g, "") === "") {
    warnings.push(`ocr: page ${pageNumber} produced no text`);
    text = "";
  }
  return confidence === undefined
    ? { text, layout, warnings }
    : { text, layout, warnings, confidence };
}

/** Mean of the reported confidences, or `undefined` when none was reported. */
export function meanConfidence(confidences: readonly number[]): number | undefined {
  return confidences.length > 0
    ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
    : undefined;
}

/** Folds a page layout into the document layout (multi-column if any page is). */
export function foldLayout(current: DetectedLayout, page: DetectedLayout): DetectedLayout {
  if (current === "multi-column" || page === "multi-column") return "multi-column";
  if (page === "single-column") return "single-column";
  return current;
}

/**
 * Recognizes `inputs` sequentially with `adapter` and joins the pages in order.
 *
 * @throws CvparseError `OCR_FAILED` when the adapter throws a non-cvparse error; cvparse errors
 *   (e.g. `MISSING_DEPENDENCY` from a reference adapter) are rethrown as is.
 */
export async function recognizeWithAdapter(
  adapter: OcrAdapter,
  inputs: readonly OcrInput[],
  format: "image" | "pdf",
): Promise<ExtractedDocument> {
  const pages = (await runAdapter(adapter, inputs)).flat();

  const warnings: string[] = [];
  const texts: string[] = [];
  const confidences: number[] = [];
  let layout: DetectedLayout = "unknown";

  pages.forEach((page, index) => {
    const result = ocrPageText(adapter, page, index + 1);
    warnings.push(...result.warnings);
    layout = foldLayout(layout, result.layout);
    if (result.confidence !== undefined) confidences.push(result.confidence);
    if (result.text) texts.push(result.text);
  });

  const confidence = meanConfidence(confidences);
  return {
    text: texts.join("\n\n"),
    format,
    pages: pages.length,
    layout,
    warnings,
    ocr: {
      adapter: adapter.name,
      ...(confidence === undefined ? {} : { confidence }),
      pages: pages.length,
    },
  };
}
