/** User-facing messages shared by the extraction modules (kept free of heavy imports). */

/** How to enable OCR, phrased for both library and CLI users. */
export const NEEDS_OCR_HINT =
  'pass an OCR adapter (library: options.ocr; CLI: --ocr tesseract|textract) or use vision mode (ocr: "vision" / --ocr vision)';

/** Warning for a scanned PDF page left out because no OCR was configured. */
export function scannedPageWarning(page: number): string {
  return `page ${page} looks scanned; pass an OCR adapter (or ocr: "vision") to read it.`;
}
