import { CvparseError } from "./errors.js";
import { detectFormat, imageMimeType } from "./extract/index.js";
import { renderPdfPages } from "./extract/raster.js";

/** One page image sent to a multimodal model in vision mode. */
export interface VisionImage {
  data: Uint8Array;
  mediaType: string;
  /** 1-based PDF page number for rendered pages. */
  page?: number;
}

/** What {@link toVisionImages} returns. */
export interface VisionImages {
  images: VisionImage[];
  format: "image" | "pdf";
  warnings: string[];
  /** Pages in the document (1 for an image). */
  totalPages: number;
}

/** Options for {@link toVisionImages}. */
export interface VisionImageOptions {
  /** PDF only: 1-based pages to render (e.g. the scanned pages of a mixed PDF). Default: all. */
  pages?: readonly number[];
}

/** Image formats multimodal chat APIs accept broadly. TIFF is rendered or rejected. */
const VISION_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Maximum pages sent as images; each page costs a full image worth of input tokens. */
export const MAX_VISION_PAGES = 5;

/** Largest image (bytes) sent to a model; provider limits are in the 5-20 MB range. */
export const MAX_VISION_IMAGE_BYTES = 15 * 1024 * 1024;

/** Longest side, in pixels, of a PDF page rendered for vision (scale 2, capped). */
export const VISION_MAX_SIDE = 2000;

function abortedError(cause: unknown): CvparseError {
  return new CvparseError("PROVIDER_ERROR", "The extraction call was aborted.", { cause });
}

function checkSize(image: VisionImage): void {
  if (image.data.byteLength <= MAX_VISION_IMAGE_BYTES) return;
  const mb = (image.data.byteLength / (1024 * 1024)).toFixed(1);
  const what = image.page === undefined ? "The image" : `Page ${image.page} rendered`;
  throw new CvparseError(
    "UNSUPPORTED_INPUT",
    `${what} is ${mb} MB, over the ${MAX_VISION_IMAGE_BYTES / (1024 * 1024)} MB limit for vision mode. ` +
      "Use a smaller or compressed image (e.g. JPEG, ~150 DPI), or an OCR adapter instead of vision.",
  );
}

/**
 * Turns an image or a scanned PDF into page images for a vision model. PDFs are rendered with
 * pdf.js and `@napi-rs/canvas` (optional peer dependency) at scale 2, longest side capped at
 * {@link VISION_MAX_SIDE} px.
 *
 * @throws CvparseError `PROVIDER_ERROR` when `signal` is aborted (as the model call would),
 *   `UNSUPPORTED_INPUT` for formats vision APIs do not take or images over
 *   {@link MAX_VISION_IMAGE_BYTES}.
 */
export async function toVisionImages(
  data: Uint8Array,
  signal?: AbortSignal,
  options: VisionImageOptions = {},
): Promise<VisionImages> {
  try {
    signal?.throwIfAborted();
  } catch (cause) {
    throw abortedError(cause);
  }
  const warnings: string[] = [];
  if (detectFormat(data) === "pdf") {
    let rendered: Awaited<ReturnType<typeof renderPdfPages>>;
    try {
      rendered = await renderPdfPages(data, {
        maxPages: MAX_VISION_PAGES,
        maxSide: VISION_MAX_SIDE,
        signal,
        ...(options.pages ? { pages: options.pages } : {}),
      });
    } catch (cause) {
      if (signal?.aborted && !CvparseError.is(cause)) throw abortedError(cause);
      throw cause;
    }
    if (rendered.truncated) {
      const requested = options.pages?.length ?? rendered.totalPages;
      warnings.push(
        `vision: only ${rendered.pages.length} of ${requested} pages were sent to the model.`,
      );
    }
    const images = rendered.pages.map((page) => ({
      data: page.png,
      mediaType: "image/png",
      page: page.page,
    }));
    images.forEach(checkSize);
    return { images, format: "pdf", warnings, totalPages: rendered.totalPages };
  }
  const mediaType = imageMimeType(data);
  if (!mediaType || !VISION_MEDIA_TYPES.has(mediaType)) {
    throw new CvparseError(
      "UNSUPPORTED_INPUT",
      `Vision mode accepts PNG, JPEG or WEBP images${mediaType ? ` (got ${mediaType})` : ""}. Convert the image first.`,
    );
  }
  const image = { data, mediaType };
  checkSize(image);
  return { images: [image], format: "image", warnings, totalPages: 1 };
}

/** User prompt for vision mode. */
export function buildVisionPrompt(pages: number): string {
  const what = pages === 1 ? "the attached image" : `the ${pages} attached page images, in order`;
  return `Extract the resume from ${what}. It is a scanned or photographed CV: read it as a person would, column by column, and copy text exactly as written.`;
}

function pageList(pages: readonly number[]): string {
  return pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(", ")}`;
}

/**
 * User prompt for a PDF with both text pages and scanned pages: the text layer of the text pages
 * goes inline, the scanned pages follow as images.
 */
export function buildMixedVisionPrompt(
  text: string,
  textPages: readonly number[],
  imagePages: readonly number[],
): string {
  return (
    `Extract the resume from a PDF that mixes text pages and scanned pages. The text below is the text layer of ${pageList(textPages)}; ` +
    `${pageList(imagePages)} ${imagePages.length === 1 ? "is a scanned page attached as an image" : "are scanned pages attached as images, in order"}. ` +
    "Combine both in page order into one resume. The text may have broken lines; read the images as a person would, column by column, and copy text exactly as written." +
    `\n\n<cv>\n${text}\n</cv>`
  );
}
