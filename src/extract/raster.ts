/**
 * Renders PDF pages to PNG for OCR adapters that only accept images. Uses unpdf (pdf.js) with
 * `@napi-rs/canvas`, an optional peer dependency loaded on demand.
 */

import { CvparseError } from "../errors.js";

/** One rendered page. */
export interface RenderedPage {
  /** 1-based page number. */
  page: number;
  /** PNG bytes. */
  png: Uint8Array;
  /** Image size in pixels. */
  width: number;
  height: number;
}

/** Options for {@link renderPdfPages}. */
export interface RenderPdfOptions {
  /** Pixels per PDF point. Default 2 (~144 DPI), a good trade-off for OCR. */
  scale?: number;
  /**
   * Cap on the longest side of each image, in pixels: pages whose size at `scale` would exceed it
   * are rendered at a smaller scale. Default: no cap.
   */
  maxSide?: number;
  /** 1-based page numbers to render, in this order. Default: every page. Out-of-range ones are ignored. */
  pages?: readonly number[];
  /** Render at most this many pages (of `pages`, when given). Default 20. */
  maxPages?: number;
  /** Abort between pages. */
  signal?: AbortSignal;
  /** Loader for `@napi-rs/canvas`. Overridable for tests. */
  canvasImport?: () => Promise<unknown>;
}

/** Result of {@link renderPdfPages}. */
export interface RenderPdfResult {
  pages: RenderedPage[];
  /** Pages in the document. */
  totalPages: number;
  /** True when `maxPages` cut the requested pages short. */
  truncated: boolean;
}

const DEFAULT_SCALE = 2;
const DEFAULT_MAX_PAGES = 20;

const MISSING_CANVAS =
  "Rendering PDF pages for OCR needs @napi-rs/canvas: npm install @napi-rs/canvas";

type CanvasImport = NonNullable<
  Parameters<typeof import("unpdf").renderPageAsImage>[2]
>["canvasImport"];

/**
 * Renders the pages of a PDF to PNG images.
 *
 * @throws CvparseError `MISSING_DEPENDENCY` when `@napi-rs/canvas` cannot be loaded,
 *   `EXTRACTION_FAILED` when pdf.js cannot open or render the document.
 */
export async function renderPdfPages(
  data: Uint8Array,
  options: RenderPdfOptions = {},
): Promise<RenderPdfResult> {
  const scale = options.scale ?? DEFAULT_SCALE;
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const canvasImport = (options.canvasImport ?? (() => import("@napi-rs/canvas"))) as CanvasImport;

  // unpdf caches the canvas module after the first successful load, so probe it ourselves to
  // report a missing dependency deterministically.
  try {
    await canvasImport?.();
  } catch (cause) {
    throw new CvparseError("MISSING_DEPENDENCY", MISSING_CANVAS, { cause });
  }

  options.signal?.throwIfAborted();
  const { createIsomorphicCanvasFactory, getDocumentProxy, renderPageAsImage } = await import(
    "unpdf"
  );

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    const CanvasFactory = await createIsomorphicCanvasFactory(canvasImport);
    // pdf.js detaches the buffer it is given; hand it a private copy.
    pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0, CanvasFactory });
  } catch (cause) {
    throw renderError(cause);
  }

  try {
    const totalPages = pdf.numPages;
    const requested = options.pages
      ? [...new Set(options.pages)].filter((p) => Number.isInteger(p) && p >= 1 && p <= totalPages)
      : Array.from({ length: totalPages }, (_, i) => i + 1);
    const selected = requested.slice(0, maxPages);
    const pages: RenderedPage[] = [];
    for (const page of selected) {
      options.signal?.throwIfAborted();
      let pageScale = scale;
      if (options.maxSide && options.maxSide > 0) {
        const proxy = await pdf.getPage(page);
        const { width, height } = proxy.getViewport({ scale: 1 });
        const longest = Math.max(width, height);
        if (longest * scale > options.maxSide) pageScale = options.maxSide / longest;
      }
      const buffer = await renderPageAsImage(pdf, page, { canvasImport, scale: pageScale });
      const png = new Uint8Array(buffer);
      const size = pngSize(png);
      pages.push({ page, png, width: size.width, height: size.height });
    }
    return { pages, totalPages, truncated: selected.length < requested.length };
  } catch (cause) {
    if (CvparseError.is(cause) || options.signal?.aborted) {
      throw cause;
    }
    throw renderError(cause);
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

/** Reads width/height from a PNG IHDR chunk; `0 x 0` when the bytes are not a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) {
    return { width: 0, height: 0 };
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function renderError(cause: unknown): CvparseError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CvparseError(
    "EXTRACTION_FAILED",
    `Could not render the PDF pages for OCR (${detail}).`,
    { cause },
  );
}
