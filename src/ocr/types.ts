/**
 * OCR adapter contract (0.2). An adapter turns an image (or, if it declares support, a PDF)
 * into text. It may return plain text or positioned words; positioned words go through the
 * same reading-order algorithm as PDF text (`orderTextItems`), which is what makes two-column
 * scans come out in order.
 *
 * Reference adapters live in `@cvparse/core/ocr/tesseract` and `@cvparse/core/ocr/textract`
 * and load their engines lazily from optional peer dependencies.
 */

import type { TextItem } from "../extract/types.js";

/** MIME types an OCR input can carry. */
export type OcrMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/tiff"
  | "application/pdf";

/** One image or document handed to an adapter. */
export interface OcrInput {
  data: Uint8Array;
  mimeType: OcrMimeType;
  /** 1-based page number when the image was rendered from a multi-page document. */
  page?: number;
  /** Language hints as ISO 639-1/639-2 codes (e.g. `["es", "en"]`). Adapters map them to engine codes. */
  languages?: readonly string[];
  /** Abort the recognition. */
  abortSignal?: AbortSignal;
}

/** A recognized word/line with its box, in pixels of the recognized image, origin top-left. */
export interface OcrItem {
  text: string;
  /** Left edge, in pixels. */
  x: number;
  /** Top edge, in pixels. */
  y: number;
  width: number;
  height: number;
  /** 0..1 when the engine reports it. */
  confidence?: number;
}

/** What an adapter returns for one input. */
export interface OcrPage {
  /** Image size in pixels; required when `items` are given so cvparse can compute layout. */
  width?: number;
  height?: number;
  /** Positioned words or lines. When present, cvparse derives reading-order text from them. */
  items?: OcrItem[];
  /** Plain text, used when `items` are absent. Lines separated by `\n`. */
  text?: string;
  /** Mean confidence 0..1 for the page when the engine reports it. */
  confidence?: number;
  /** Non-fatal observations (skew, low DPI, unsupported script, ...). */
  warnings?: string[];
}

/** The adapter interface. */
export interface OcrAdapter {
  /** Short engine name reported in `ParseResult.source.ocr.adapter` and in warnings. */
  readonly name: string;
  /**
   * Formats the adapter accepts directly. When `pdf` is false (the default), cvparse renders
   * PDF pages to PNG with pdf.js and `@napi-rs/canvas` before calling `recognize`.
   */
  readonly supports?: { readonly pdf?: boolean };
  /** Recognizes one input. Multi-page inputs (PDF) may return several pages. */
  recognize(input: OcrInput): Promise<OcrPage | OcrPage[]>;
  /** Releases engine resources (workers, sockets). Optional. */
  dispose?(): Promise<void>;
}

/** Converts OCR boxes (pixels, origin top-left) into the PDF-style items the layout code expects. */
export function ocrItemsToTextItems(items: readonly OcrItem[], pageHeight: number): TextItem[] {
  return items.map((item) => ({
    str: item.text,
    x: item.x,
    // Layout works in PDF user space (origin bottom-left, y = baseline).
    y: pageHeight - (item.y + item.height),
    width: item.width,
    height: item.height,
    hasEOL: false,
  }));
}
