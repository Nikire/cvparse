import { CvparseError } from "../errors.js";
import type { ExtractedDocument, InputFormat } from "./types.js";

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
        "UNSUPPORTED_INPUT",
        `Image input${name} is not supported yet: scanned CVs need OCR, which is planned for 0.2. Run OCR first and pass the text.`,
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

/**
 * Turns a document (PDF, DOCX or plain text bytes) into reading-order text. Format is detected
 * from the bytes unless `format` is given. PDF and DOCX support is loaded on demand, so callers
 * that only pass text never load pdf.js or mammoth.
 *
 * @throws {CvparseError} `UNSUPPORTED_INPUT` for images, legacy .doc and unknown bytes;
 * `NO_TEXT_LAYER` for PDFs without text; `EXTRACTION_FAILED` for corrupt documents.
 */
export async function extractText(input: Uint8Array | DocumentInput): Promise<ExtractedDocument> {
  const { data, filename, format } =
    input instanceof Uint8Array ? { data: input, filename: undefined, format: undefined } : input;
  if (!(data instanceof Uint8Array)) {
    throw new CvparseError("INVALID_INPUT", "extractText expects a Uint8Array or { data }.");
  }

  const detected: DetectedFormat = format ?? detectFormat(data, filename);
  switch (detected) {
    case "text":
      return { text: decodeText(data), format: "text", layout: "unknown", warnings: [] };
    case "pdf": {
      const { extractPdfText } = await import("./pdf.js");
      return extractPdfText(data);
    }
    case "docx": {
      const { extractDocxText } = await import("./docx.js");
      return extractDocxText(data);
    }
    default:
      throw unsupported(detected, filename);
  }
}
