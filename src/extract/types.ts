/**
 * Shared contract for the document extraction layer (0.1). Each format module turns raw
 * bytes into reading-order plain text plus metadata; `parseResume` and the CLI consume it.
 */

/** Input formats cvparse can turn into text. */
export type InputFormat = "text" | "pdf" | "docx";

/** Page layout detected during extraction. Only meaningful for paginated formats. */
export type DetectedLayout = "single-column" | "multi-column" | "unknown";

/** Result of extracting text from a document. */
export interface ExtractedDocument {
  /** Reading-order plain text, UTF-8, `\n` line breaks, blank line between blocks/sections. */
  text: string;
  /** Format the bytes were interpreted as. */
  format: InputFormat;
  /** Page count for paginated formats; `undefined` for text/docx. */
  pages?: number;
  /** Layout detected across the document (a document is multi-column if any page is). */
  layout: DetectedLayout;
  /** Non-fatal observations: skipped pages, empty pages, text boxes ignored, etc. */
  warnings: string[];
}

/** A positioned text fragment, in PDF user-space points, origin bottom-left. */
export interface TextItem {
  str: string;
  /** Left edge. */
  x: number;
  /** Baseline (bottom of the glyph box). */
  y: number;
  width: number;
  height: number;
  /** True when the producer marked an end-of-line after this item. */
  hasEOL: boolean;
}
