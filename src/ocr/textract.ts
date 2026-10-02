/**
 * AWS Textract OCR adapter. Hosted, pay-per-page, better than Tesseract on photographed and
 * low-quality scans and the only reference adapter with a layout model. The CV bytes leave the
 * machine and go to AWS; see docs/ocr.md before using it on real candidate data.
 *
 * `@aws-sdk/client-textract` is an optional peer dependency and is imported lazily on the first
 * `recognize` call, never at module load, so importing this module without the SDK installed is
 * free and the error is a `CvparseError("MISSING_DEPENDENCY")` with the install command.
 */

import { CvparseError } from "../errors.js";
import type { OcrAdapter, OcrInput, OcrItem, OcrPage } from "./types.js";

/**
 * The subset of `TextractClient` the adapter uses. Structural on purpose: the published types
 * must not depend on `@aws-sdk/client-textract` being installed, and tests can inject a fake.
 */
export interface TextractClientLike {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the SDK's generic `send` without importing its types
  send(command: any, options?: { abortSignal?: AbortSignal }): Promise<any>;
  destroy?(): void;
}

export interface TextractAdapterOptions {
  /**
   * An existing `TextractClient`. When given, the adapter never creates or destroys a client
   * (`dispose()` is a no-op for it) and `region` is ignored. The SDK module is still imported
   * lazily on the first `recognize` to build the command objects `client.send` expects.
   */
  client?: TextractClientLike;
  /**
   * AWS region for the client the adapter creates itself. When omitted the SDK resolves it from
   * `AWS_REGION` / `AWS_DEFAULT_REGION` or the shared config file, exactly like any other SDK client.
   */
  region?: string;
  /**
   * - `"detect"` (default): `DetectDocumentText`. Lines with boxes; cvparse computes the reading
   *   order with the same XY-cut it uses for PDFs. Cheapest Textract call.
   * - `"layout"`: `AnalyzeDocument` with `FeatureTypes: ["LAYOUT"]`. Textract's own layout model
   *   returns `LAYOUT_*` blocks in reading order; the adapter emits their text directly (see
   *   `layoutText`). Roughly 2.6x the price of `"detect"` at the time of writing.
   */
  features?: "detect" | "layout";
  /**
   * Reject inputs larger than this many bytes before calling AWS. Defaults to the synchronous
   * API limit of 10 MB; raise it only if AWS raises theirs.
   */
  maxBytes?: number;
}

/**
 * Nominal page size the normalized Textract boxes (0..1) are projected onto. The layout algorithm
 * only compares relative positions and sizes, so any size with a plausible portrait aspect ratio
 * works; A4 at ~120 dpi keeps the numbers readable when debugging.
 */
export const TEXTRACT_NOMINAL_WIDTH = 1000;
export const TEXTRACT_NOMINAL_HEIGHT = 1414;

/** Synchronous Textract operations reject documents over 10 MB. */
const SYNC_MAX_BYTES = 10 * 1024 * 1024;

const FORMAT_HINT =
  "The synchronous Textract API accepts JPEG and PNG images (and single-page PDF/TIFF) up to 10 MB. " +
  "cvparse renders PDF pages to PNG before calling the adapter, so check the image is not corrupt or oversized.";

/** Minimal view of the SDK's `Block`; only the fields the adapter reads. */
interface TextractBlock {
  BlockType?: string;
  Id?: string;
  Text?: string;
  Confidence?: number;
  Page?: number;
  Geometry?: { BoundingBox?: { Left?: number; Top?: number; Width?: number; Height?: number } };
  Relationships?: { Type?: string; Ids?: string[] }[];
}

interface TextractResponse {
  Blocks?: TextractBlock[];
}

type TextractSdk = typeof import("@aws-sdk/client-textract");

/** Loads the SDK on demand; the only place the optional peer is touched. */
async function loadSdk(): Promise<TextractSdk> {
  try {
    return await import("@aws-sdk/client-textract");
  } catch (error) {
    throw new CvparseError(
      "MISSING_DEPENDENCY",
      "The AWS Textract adapter needs @aws-sdk/client-textract. Install it with: npm install @aws-sdk/client-textract",
      { cause: error },
    );
  }
}

/**
 * Creates an OCR adapter backed by AWS Textract. The CV bytes are sent to AWS.
 *
 * ```ts
 * import { createTextractAdapter } from "@cvparse/core/ocr/textract";
 * const result = await parseResume(readFileSync("scan.jpg"), {
 *   model,
 *   ocr: createTextractAdapter({ region: "us-east-1" }),
 * });
 * ```
 */
export function createTextractAdapter(options: TextractAdapterOptions = {}): OcrAdapter {
  const features = options.features ?? "detect";
  const maxBytes = options.maxBytes ?? SYNC_MAX_BYTES;
  const injected = options.client;
  let ownClient: TextractClientLike | undefined;
  let sdkPromise: Promise<TextractSdk> | undefined;

  const getSdk = () => {
    sdkPromise ??= loadSdk();
    return sdkPromise;
  };

  const getClient = async (sdk: TextractSdk): Promise<TextractClientLike> => {
    if (injected) return injected;
    ownClient ??= new sdk.TextractClient(options.region ? { region: options.region } : {});
    return ownClient;
  };

  return {
    name: "textract",
    // Textract's sync API does take single-page PDF/TIFF bytes, but cvparse cannot know the page
    // count without parsing the file, and multi-page PDFs would fail with UnsupportedDocument.
    // Letting cvparse render pages to PNG works for any page count and keeps one code path.
    supports: { pdf: false },

    async recognize(input: OcrInput): Promise<OcrPage | OcrPage[]> {
      throwIfAborted(input.abortSignal);
      if (input.mimeType === "image/webp") {
        throw new CvparseError(
          "OCR_FAILED",
          `AWS Textract does not accept WebP images; convert the file to PNG or JPEG first. ${FORMAT_HINT}`,
        );
      }
      if (input.data.byteLength > maxBytes) {
        throw new CvparseError(
          "OCR_FAILED",
          `AWS Textract: input is ${formatBytes(input.data.byteLength)}, over the ${formatBytes(maxBytes)} limit of the synchronous API. ${FORMAT_HINT}`,
        );
      }
      // Both the client and the command classes come from the SDK module, so even an injected
      // client needs the import; it happens here, on first use, not when the adapter is created.
      const sdk = await getSdk();
      const client = await getClient(sdk);
      const document = { Bytes: input.data };
      const command =
        features === "layout"
          ? new sdk.AnalyzeDocumentCommand({ Document: document, FeatureTypes: ["LAYOUT"] })
          : new sdk.DetectDocumentTextCommand({ Document: document });

      let response: TextractResponse;
      try {
        response = (await client.send(
          command,
          input.abortSignal ? { abortSignal: input.abortSignal } : undefined,
        )) as TextractResponse;
      } catch (error) {
        if (input.abortSignal?.aborted) throw abortError(input.abortSignal, error);
        throw mapError(error);
      }

      const pages = blocksToPages(response.Blocks ?? [], features);
      return pages.length === 1 ? (pages[0] as OcrPage) : pages;
    },

    async dispose(): Promise<void> {
      // Only a client the adapter created is its responsibility to close.
      ownClient?.destroy?.();
      ownClient = undefined;
    },
  };
}

/** Groups blocks by `Page` and builds one OcrPage per page (sync calls return a single page). */
function blocksToPages(blocks: TextractBlock[], features: "detect" | "layout"): OcrPage[] {
  const byPage = new Map<number, TextractBlock[]>();
  for (const block of blocks) {
    const page = block.Page ?? 1;
    const list = byPage.get(page);
    if (list) list.push(block);
    else byPage.set(page, [block]);
  }
  if (byPage.size === 0) {
    // cvparse itself warns about pages that produced no text (src/extract/ocr.ts).
    return [{ width: TEXTRACT_NOMINAL_WIDTH, height: TEXTRACT_NOMINAL_HEIGHT, items: [] }];
  }
  return [...byPage.keys()]
    .sort((a, b) => a - b)
    .map((page) => {
      const pageBlocks = byPage.get(page) ?? [];
      return features === "layout" ? layoutPage(pageBlocks) : detectPage(pageBlocks);
    });
}

function lineBlocks(blocks: TextractBlock[]): TextractBlock[] {
  return blocks.filter((block) => block.BlockType === "LINE" && (block.Text ?? "").trim() !== "");
}

function meanConfidence(lines: TextractBlock[]): number | undefined {
  const values = lines
    .map((line) => line.Confidence)
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return clamp01(mean / 100);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** `"detect"`: LINE blocks become positioned items; cvparse derives the reading order. */
function detectPage(blocks: TextractBlock[]): OcrPage {
  const lines = lineBlocks(blocks);
  const items: OcrItem[] = [];
  for (const line of lines) {
    const box = line.Geometry?.BoundingBox;
    if (!box) continue;
    const item: OcrItem = {
      text: (line.Text ?? "").trim(),
      x: (box.Left ?? 0) * TEXTRACT_NOMINAL_WIDTH,
      y: (box.Top ?? 0) * TEXTRACT_NOMINAL_HEIGHT,
      width: (box.Width ?? 0) * TEXTRACT_NOMINAL_WIDTH,
      height: (box.Height ?? 0) * TEXTRACT_NOMINAL_HEIGHT,
    };
    if (typeof line.Confidence === "number") item.confidence = clamp01(line.Confidence / 100);
    items.push(item);
  }
  const page: OcrPage = { width: TEXTRACT_NOMINAL_WIDTH, height: TEXTRACT_NOMINAL_HEIGHT, items };
  const confidence = meanConfidence(lines);
  if (confidence !== undefined) page.confidence = confidence;
  return page;
}

/**
 * `"layout"`: emit `text` from the LAYOUT_* blocks in the order Textract returns them.
 *
 * Trade-off: returning `items` would let cvparse run its own XY-cut, which is what every other
 * adapter does and keeps behaviour uniform; but it would throw away the reading order Textract's
 * layout model already computed, which is the whole reason to pay for `"layout"`. Textract's order
 * is produced by a model trained on real documents and handles sidebars, wrapped columns and
 * floating boxes that the geometric cut can get wrong, so we trust it and return plain text:
 * one `\n` between lines of a block, one blank line between blocks. The cost is that cvparse
 * cannot report `layout: "multi-column"` for these pages (it never sees boxes). If Textract
 * returns no LAYOUT blocks at all we fall back to the `"detect"` shape so nothing is lost.
 */
function layoutPage(blocks: TextractBlock[]): OcrPage {
  const layoutBlocks = blocks.filter((block) => block.BlockType?.startsWith("LAYOUT_"));
  if (layoutBlocks.length === 0) {
    const page = detectPage(blocks);
    page.warnings = [
      ...(page.warnings ?? []),
      "Textract returned no LAYOUT blocks; falling back to geometric reading order.",
    ];
    return page;
  }

  const byId = new Map<string, TextractBlock>();
  for (const block of blocks) if (block.Id) byId.set(block.Id, block);
  // LAYOUT_LIST nests LAYOUT_TEXT blocks that also appear at the top level of `Blocks`, not
  // necessarily after their list; they are emitted only through their parent.
  const nested = new Set<string>();
  for (const block of layoutBlocks) {
    for (const id of childIds(block)) {
      if (byId.get(id)?.BlockType?.startsWith("LAYOUT_")) nested.add(id);
    }
  }
  const consumed = new Set<string>();

  const linesOf = (block: TextractBlock): string[] => {
    if (block.Id) consumed.add(block.Id);
    const lines: string[] = [];
    for (const id of childIds(block)) {
      const child = byId.get(id);
      if (!child || consumed.has(id)) continue;
      if (child.BlockType === "LINE") {
        consumed.add(id);
        const text = (child.Text ?? "").trim();
        if (text) lines.push(text);
      } else if (child.BlockType?.startsWith("LAYOUT_")) {
        // LAYOUT_LIST nests LAYOUT_TEXT items; flatten them in place.
        lines.push(...linesOf(child));
      }
    }
    return lines;
  };

  const paragraphs: string[] = [];
  for (const block of layoutBlocks) {
    if (block.Id && (consumed.has(block.Id) || nested.has(block.Id))) continue;
    const lines = linesOf(block);
    if (lines.length > 0) paragraphs.push(lines.join("\n"));
  }
  // Lines Textract did not assign to any layout block (rare) go at the end rather than vanish.
  const orphans = lineBlocks(blocks).filter((line) => !line.Id || !consumed.has(line.Id));
  if (orphans.length > 0)
    paragraphs.push(orphans.map((line) => (line.Text ?? "").trim()).join("\n"));

  const page: OcrPage = {
    width: TEXTRACT_NOMINAL_WIDTH,
    height: TEXTRACT_NOMINAL_HEIGHT,
    text: paragraphs.join("\n\n"),
  };
  const confidence = meanConfidence(lineBlocks(blocks));
  if (confidence !== undefined) page.confidence = confidence;
  return page;
}

function childIds(block: TextractBlock): string[] {
  return (block.Relationships ?? [])
    .filter((relationship) => relationship.Type === "CHILD")
    .flatMap((relationship) => relationship.Ids ?? []);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Same shape as the Tesseract adapter's abort error, so callers handle both alike. */
function abortError(signal: AbortSignal, error?: unknown): CvparseError {
  return new CvparseError("OCR_FAILED", "OCR recognition was aborted", {
    cause: error ?? signal.reason,
  });
}

/** Turns SDK exceptions into `CvparseError("OCR_FAILED")` with a readable, name-bearing message. */
function mapError(error: unknown): CvparseError {
  if (CvparseError.is(error)) return error;
  const name = errorName(error);
  const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
  const statusCode = httpStatus(error);

  let message: string;
  switch (name) {
    case "ThrottlingException":
    case "ProvisionedThroughputExceededException":
      message = `AWS Textract rate limit hit (${name})${detail}. Retry with backoff or request a quota increase.`;
      break;
    case "UnsupportedDocumentException":
    case "BadDocumentException":
    case "DocumentTooLargeException":
      message = `AWS Textract rejected the document (${name})${detail}. ${FORMAT_HINT}`;
      break;
    case "InvalidParameterException":
      message = `AWS Textract rejected the request (${name})${detail}. The image bytes are probably empty or not a valid image.`;
      break;
    case "AccessDeniedException":
      message = `AWS Textract access denied (${name})${detail}. The credentials need textract:DetectDocumentText (and textract:AnalyzeDocument for features: "layout").`;
      break;
    case "CredentialsProviderError":
    case "ExpiredTokenException":
    case "UnrecognizedClientException":
    case "InvalidSignatureException":
      message = `AWS credentials problem (${name})${detail}. Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN if temporary), configure a profile, or pass a client.`;
      break;
    default:
      message = /region is missing/i.test(detail)
        ? `AWS region is not configured${detail}. Set AWS_REGION (e.g. us-east-1) or pass createTextractAdapter({ region }).`
        : `AWS Textract call failed (${name})${detail}`;
  }
  return new CvparseError("OCR_FAILED", message, {
    cause: error,
    ...(statusCode === undefined ? {} : { statusCode }),
  });
}

function errorName(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; __type?: unknown; code?: unknown };
    for (const value of [candidate.name, candidate.__type, candidate.code]) {
      if (typeof value === "string" && value && value !== "Error") return value;
    }
  }
  return "UnknownError";
}

function httpStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const meta = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
    if (meta && typeof meta.httpStatusCode === "number") return meta.httpStatusCode;
  }
  return undefined;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
