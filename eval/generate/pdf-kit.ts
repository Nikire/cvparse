/**
 * Minimal pdf-lib layout helpers for the dataset renderers: Helvetica (standard font, WinAnsi,
 * nothing embedded), greedy word wrap, flowing "runs" into a column, right-aligned date stamps.
 * Metadata dates are pinned so output is byte-identical across runs.
 */

import {
  type PDFDocument as Doc,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib";

export const A4 = { width: 595.28, height: 841.89 };
const EPOCH = new Date(0);

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

export interface PdfContext {
  doc: Doc;
  fonts: Fonts;
}

export async function createPdf(title: string): Promise<PdfContext> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(title);
  doc.setProducer("cvparse eval dataset");
  doc.setCreator("cvparse eval dataset");
  doc.setCreationDate(EPOCH);
  doc.setModificationDate(EPOCH);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, fonts: { regular, bold } };
}

export async function savePdf(doc: Doc): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

export function addPage(doc: Doc): PDFPage {
  return doc.addPage([A4.width, A4.height]);
}

/** Greedy word wrap at `maxWidth` points. */
export function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export interface Run {
  text: string;
  bold?: boolean;
  size?: number;
  /** Extra space after the run, in points. */
  after?: number;
  /** Extra space before the run, in points. */
  before?: number;
  /** Grey level 0..1 (0 = black). */
  grey?: number;
  /** Bullet item: "•" plus hanging indent. */
  bullet?: boolean;
  /** Text drawn right-aligned on the first line of this run (dates). */
  right?: string;
  /** Horizontal alignment of the run's lines. */
  align?: "left" | "center";
  /** Draw a thin rule under the run (section headings). */
  rule?: boolean;
}

export interface Column {
  x: number;
  width: number;
  top: number;
  bottom: number;
}

export interface FlowResult {
  y: number;
  page: PDFPage;
}

/**
 * Flows runs into a column. When the bottom is reached, `newPage()` provides the next page (the
 * column keeps its x/width and restarts at `top`); without it, overflow throws.
 */
export function flow(
  fonts: Fonts,
  page: PDFPage,
  column: Column,
  runs: readonly Run[],
  options: { newPage?: () => PDFPage; lineHeight?: number; startY?: number } = {},
): FlowResult {
  const lineHeight = options.lineHeight ?? 1.3;
  let y = options.startY ?? column.top;
  let current = page;
  for (const run of runs) {
    const size = run.size ?? 10;
    const font = run.bold ? fonts.bold : fonts.regular;
    const step = size * lineHeight;
    const grey = run.grey ?? 0.1;
    const color = rgb(grey, grey, grey);
    const indent = run.bullet ? 10 : 0;
    const rightWidth = run.right ? fonts.regular.widthOfTextAtSize(run.right, size) + 12 : 0;
    y -= run.before ?? 0;
    const lines =
      run.text === "" ? [""] : wrap(run.text, font, size, column.width - indent - rightWidth);
    lines.forEach((line, index) => {
      if (y - size < column.bottom) {
        if (!options.newPage) throw new Error(`column overflow at: ${line}`);
        current = options.newPage();
        y = column.top;
      }
      y -= size;
      if (line) {
        let x = column.x + indent;
        if (run.align === "center") {
          x = column.x + (column.width - font.widthOfTextAtSize(line, size)) / 2;
        }
        if (run.bullet && index === 0) {
          current.drawText("•", { x: column.x + 1, y, size, font: fonts.regular, color });
        }
        current.drawText(line, { x, y, size, font, color });
        if (run.right && index === 0) {
          const w = fonts.regular.widthOfTextAtSize(run.right, size);
          current.drawText(run.right, {
            x: column.x + column.width - w,
            y,
            size,
            font: fonts.regular,
            color: rgb(0.3, 0.3, 0.3),
          });
        }
      }
      y -= step - size;
    });
    if (run.rule) {
      current.drawLine({
        start: { x: column.x, y: y + 1 },
        end: { x: column.x + column.width, y: y + 1 },
        thickness: 0.6,
        color: rgb(0.55, 0.55, 0.55),
      });
      y -= 3;
    }
    y -= run.after ?? 0;
  }
  return { y, page: current };
}
