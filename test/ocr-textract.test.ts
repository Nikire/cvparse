import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CvparseError } from "../src/errors.js";
import { orderTextItems } from "../src/extract/layout.js";
import {
  createTextractAdapter,
  TEXTRACT_NOMINAL_HEIGHT,
  TEXTRACT_NOMINAL_WIDTH,
} from "../src/ocr/textract.js";
import type { OcrInput, OcrPage } from "../src/ocr/types.js";
import { ocrItemsToTextItems } from "../src/ocr/types.js";

// The real SDK provides the command classes; only the client the adapter builds itself is
// replaced, so no test can reach the network.
const sdk = vi.hoisted(() => ({
  loaded: false,
  constructed: [] as unknown[],
  send: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@aws-sdk/client-textract", async (importOriginal) => {
  sdk.loaded = true;
  const real = await importOriginal<typeof import("@aws-sdk/client-textract")>();
  class TextractClient {
    constructor(config: unknown) {
      sdk.constructed.push(config);
    }
    send(...args: unknown[]) {
      return sdk.send(...args);
    }
    destroy() {
      sdk.destroy();
    }
  }
  return { ...real, TextractClient };
});

// --- canned Textract responses ------------------------------------------------------------------

interface Block {
  BlockType: string;
  Id: string;
  Text?: string;
  Confidence?: number;
  Page?: number;
  Geometry?: { BoundingBox: { Left: number; Top: number; Width: number; Height: number } };
  Relationships?: { Type: string; Ids: string[] }[];
}

let nextId = 0;
function lineBlock(text: string, left: number, top: number, width: number, confidence = 99): Block {
  return {
    BlockType: "LINE",
    Id: `line-${nextId++}`,
    Text: text,
    Confidence: confidence,
    Geometry: { BoundingBox: { Left: left, Top: top, Width: width, Height: 0.012 } },
  };
}

/** PAGE + LINE + WORD blocks, like DetectDocumentText returns. */
function detectResponse(lines: Block[]) {
  const words: Block[] = lines.flatMap((line) =>
    (line.Text ?? "").split(" ").map((text) => ({
      BlockType: "WORD",
      Id: `word-${nextId++}`,
      Text: text,
      Confidence: 10, // must not leak into the line items or the page confidence
      Geometry: line.Geometry,
    })),
  );
  const page: Block = {
    BlockType: "PAGE",
    Id: "page",
    Geometry: { BoundingBox: { Left: 0, Top: 0, Width: 1, Height: 1 } },
    Relationships: [{ Type: "CHILD", Ids: lines.map((line) => line.Id) }],
  };
  return { Blocks: [page, ...lines, ...words], DocumentMetadata: { Pages: 1 } };
}

/** Two-column CV: header, left column (experience), right column (skills). */
function twoColumnLines(): Block[] {
  return [
    lineBlock("LUCÍA BEATRIZ MORALES", 0.065, 0.05, 0.45),
    lineBlock("Analista de Datos Sr. — Montevideo, Uruguay", 0.065, 0.08, 0.46),
    lineBlock("EXPERIENCIA", 0.065, 0.15, 0.15),
    lineBlock("Banco Oriental S.A.", 0.065, 0.2, 0.2),
    lineBlock("marzo 2021 – actualidad", 0.065, 0.225, 0.25),
    lineBlock("Reportes de ventas semanales.", 0.065, 0.25, 0.3),
    lineBlock("HABILIDADES", 0.61, 0.15, 0.16),
    lineBlock("Python", 0.61, 0.2, 0.07),
    lineBlock("Power BI", 0.61, 0.225, 0.09),
    lineBlock("Excel avanzado", 0.61, 0.25, 0.16),
  ];
}

function input(overrides: Partial<OcrInput> = {}): OcrInput {
  return { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png", ...overrides };
}

function fakeClient(response: unknown = detectResponse(twoColumnLines())) {
  return { send: vi.fn(async (..._args: unknown[]) => response), destroy: vi.fn() };
}

function awsError(name: string, message: string, status = 400): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, { $fault: "client", $metadata: { httpStatusCode: status } });
  return error;
}

async function rejection(promise: Promise<unknown>): Promise<CvparseError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CvparseError);
    return error as CvparseError;
  }
  throw new Error("expected the promise to reject");
}

beforeEach(() => {
  sdk.constructed = [];
  sdk.send.mockReset();
  sdk.destroy.mockReset();
});

// --- tests -------------------------------------------------------------------------------------

describe("createTextractAdapter", () => {
  it("does not import the SDK when the adapter is created", () => {
    const adapter = createTextractAdapter({ client: fakeClient() });
    expect(sdk.loaded).toBe(false);
    expect(adapter.name).toBe("textract");
    expect(adapter.supports?.pdf).toBe(false);
  });

  it("sends DetectDocumentText with the bytes in Document.Bytes", async () => {
    const client = fakeClient();
    const data = new Uint8Array([1, 2, 3, 4]);
    await createTextractAdapter({ client }).recognize(input({ data }));

    expect(sdk.loaded).toBe(true);
    const { DetectDocumentTextCommand } = await import("@aws-sdk/client-textract");
    const [command, options] = client.send.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(DetectDocumentTextCommand);
    expect((command as { input: unknown }).input).toEqual({ Document: { Bytes: data } });
    expect((command as { input: { Document: { Bytes: unknown } } }).input.Document.Bytes).toBe(
      data,
    );
    expect(options).toBeUndefined();
  });

  it("turns LINE blocks (not WORD/PAGE) into items on the nominal page", async () => {
    const lines = [
      lineBlock("Banco Oriental", 0.1, 0.2, 0.3, 98),
      lineBlock("Python", 0.6, 0.2, 0.1, 90),
    ];
    const out = (await createTextractAdapter({
      client: fakeClient(detectResponse(lines)),
    }).recognize(input())) as OcrPage;

    expect(out.width).toBe(TEXTRACT_NOMINAL_WIDTH);
    expect(out.height).toBe(TEXTRACT_NOMINAL_HEIGHT);
    expect(out.text).toBeUndefined();
    expect(out.items).toHaveLength(2);
    const [first, second] = out.items ?? [];
    expect(first?.text).toBe("Banco Oriental");
    expect(first?.x).toBeCloseTo(0.1 * TEXTRACT_NOMINAL_WIDTH);
    expect(first?.y).toBeCloseTo(0.2 * TEXTRACT_NOMINAL_HEIGHT);
    expect(first?.width).toBeCloseTo(0.3 * TEXTRACT_NOMINAL_WIDTH);
    expect(first?.height).toBeCloseTo(0.012 * TEXTRACT_NOMINAL_HEIGHT);
    expect(first?.confidence).toBeCloseTo(0.98);
    expect(second?.confidence).toBeCloseTo(0.9);
    // Mean of the LINE confidences; the WORD blocks (confidence 10) are ignored.
    expect(out.confidence).toBeCloseTo(0.94);
    expect(out.warnings).toBeUndefined();
  });

  it("clamps confidence and skips lines without text or geometry", async () => {
    const noBox: Block = { BlockType: "LINE", Id: "x", Text: "ghost", Confidence: 50 };
    const blank = lineBlock("   ", 0.1, 0.5, 0.1);
    const out = (await createTextractAdapter({
      client: fakeClient({ Blocks: [lineBlock("Hola", 0.1, 0.1, 0.1, 100.4), noBox, blank] }),
    }).recognize(input())) as OcrPage;
    expect(out.items?.map((item) => item.text)).toEqual(["Hola"]);
    expect(out.items?.[0]?.confidence).toBe(1);
  });

  it("reads a two-column page in column order through the layout code", async () => {
    const out = (await createTextractAdapter({ client: fakeClient() }).recognize(
      input(),
    )) as OcrPage;
    const ordered = orderTextItems(ocrItemsToTextItems(out.items ?? [], out.height ?? 0), {
      width: out.width ?? 0,
      height: out.height ?? 0,
    });
    expect(ordered.layout).toBe("multi-column");
    const text = ordered.text;
    expect(text.indexOf("LUCÍA BEATRIZ MORALES")).toBe(0);
    expect(text.indexOf("Reportes de ventas semanales.")).toBeLessThan(text.indexOf("HABILIDADES"));
    expect(text.indexOf("HABILIDADES")).toBeLessThan(text.indexOf("Excel avanzado"));
    expect(text).toContain("Banco Oriental S.A.\nmarzo 2021 – actualidad");
  });

  it("returns an empty page without warnings when Textract finds no text", async () => {
    const out = (await createTextractAdapter({ client: fakeClient({ Blocks: [] }) }).recognize(
      input(),
    )) as OcrPage;
    expect(out).toEqual({
      width: TEXTRACT_NOMINAL_WIDTH,
      height: TEXTRACT_NOMINAL_HEIGHT,
      items: [],
    });
  });

  it("returns one page per Page number when blocks span several pages", async () => {
    const a = { ...lineBlock("Página uno", 0.1, 0.1, 0.2), Page: 2 };
    const b = { ...lineBlock("Page one", 0.1, 0.1, 0.2), Page: 1 };
    const out = await createTextractAdapter({ client: fakeClient({ Blocks: [a, b] }) }).recognize(
      input(),
    );
    expect(Array.isArray(out)).toBe(true);
    expect((out as OcrPage[]).map((page) => page.items?.[0]?.text)).toEqual([
      "Page one",
      "Página uno",
    ]);
  });

  describe("abort", () => {
    it("forwards the abort signal to client.send", async () => {
      const client = fakeClient();
      const controller = new AbortController();
      await createTextractAdapter({ client }).recognize(input({ abortSignal: controller.signal }));
      expect(client.send.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });
    });

    it("rejects early when the signal is already aborted", async () => {
      const client = fakeClient();
      const controller = new AbortController();
      controller.abort(new Error("user cancelled"));
      const error = await rejection(
        createTextractAdapter({ client }).recognize(input({ abortSignal: controller.signal })),
      );
      expect(error.code).toBe("OCR_FAILED");
      expect(error.message).toMatch(/aborted/);
      expect((error.cause as Error).message).toBe("user cancelled");
      expect(client.send).not.toHaveBeenCalled();
    });

    it("maps an abort during the call to the same OCR_FAILED error", async () => {
      const controller = new AbortController();
      const client = fakeClient();
      const abortError = awsError("AbortError", "Request aborted", 0);
      client.send.mockImplementation(async () => {
        controller.abort();
        throw abortError;
      });
      const error = await rejection(
        createTextractAdapter({ client }).recognize(input({ abortSignal: controller.signal })),
      );
      expect(error.code).toBe("OCR_FAILED");
      expect(error.message).toBe("OCR recognition was aborted");
      expect(error.cause).toBe(abortError);
    });
  });

  describe("errors", () => {
    async function failWith(error: unknown): Promise<CvparseError> {
      const client = fakeClient();
      client.send.mockRejectedValue(error);
      return rejection(createTextractAdapter({ client }).recognize(input()));
    }

    it("UnsupportedDocumentException gets a format and size hint", async () => {
      const cause = awsError(
        "UnsupportedDocumentException",
        "Request has unsupported document format",
      );
      const error = await failWith(cause);
      expect(error.code).toBe("OCR_FAILED");
      expect(error.message).toContain("UnsupportedDocumentException");
      expect(error.message).toContain("unsupported document format");
      expect(error.message).toMatch(/JPEG and PNG/);
      expect(error.message).toMatch(/10 MB/);
      expect(error.statusCode).toBe(400);
      expect(error.cause).toBe(cause);
    });

    it.each([
      ["BadDocumentException", /rejected the document/],
      ["DocumentTooLargeException", /rejected the document.*10 MB/],
      ["ThrottlingException", /rate limit.*backoff/],
      ["ProvisionedThroughputExceededException", /rate limit/],
      ["InvalidParameterException", /not a valid image/],
      ["AccessDeniedException", /textract:DetectDocumentText/],
      ["CredentialsProviderError", /AWS_ACCESS_KEY_ID/],
      ["ExpiredTokenException", /credentials problem/],
      ["InternalServerError", /AWS Textract call failed \(InternalServerError\)/],
    ])("%s → readable OCR_FAILED", async (name, pattern) => {
      const error = await failWith(awsError(name, "details"));
      expect(error.code).toBe("OCR_FAILED");
      expect(error.message).toContain(name);
      expect(error.message).toMatch(pattern);
    });

    it("falls back to __type or a generic name", async () => {
      expect((await failWith({ __type: "SomethingException" })).message).toMatch(
        /\(SomethingException\)/,
      );
      expect((await failWith(new Error("socket hang up"))).message).toBe(
        "AWS Textract call failed (UnknownError): socket hang up",
      );
    });

    it("rejects WebP before calling AWS", async () => {
      const client = fakeClient();
      const error = await rejection(
        createTextractAdapter({ client }).recognize(input({ mimeType: "image/webp" })),
      );
      expect(error.code).toBe("OCR_FAILED");
      expect(error.message).toMatch(/WebP/);
      expect(client.send).not.toHaveBeenCalled();
    });

    it("rejects inputs over the size limit before calling AWS", async () => {
      const client = fakeClient();
      const error = await rejection(
        createTextractAdapter({ client, maxBytes: 1024 }).recognize(
          input({ data: new Uint8Array(2048) }),
        ),
      );
      expect(error.code).toBe("OCR_FAILED");
      expect(error.message).toMatch(/2 KB, over the 1 KB limit/);
      expect(client.send).not.toHaveBeenCalled();
    });
  });

  describe('features: "layout"', () => {
    /** LAYOUT blocks in Textract's reading order, deliberately not in geometric order. */
    function layoutResponse() {
      const name = lineBlock("LUCÍA MORALES", 0.1, 0.05, 0.3);
      const skills = lineBlock("HABILIDADES", 0.6, 0.15, 0.15);
      const python = lineBlock("Python", 0.6, 0.2, 0.08);
      const sql = lineBlock("SQL", 0.6, 0.23, 0.05);
      const exp = lineBlock("EXPERIENCIA", 0.1, 0.15, 0.15);
      const job = lineBlock("Banco Oriental S.A.", 0.1, 0.2, 0.2);
      const orphan = lineBlock("Página 1", 0.45, 0.95, 0.1);
      const pythonItem: Block = {
        BlockType: "LAYOUT_TEXT",
        Id: "li-1",
        Relationships: [{ Type: "CHILD", Ids: [python.Id] }],
      };
      const sqlItem: Block = {
        BlockType: "LAYOUT_TEXT",
        Id: "li-2",
        Relationships: [{ Type: "CHILD", Ids: [sql.Id] }],
      };
      const blocks: Block[] = [
        { BlockType: "PAGE", Id: "page" },
        { BlockType: "LAYOUT_TITLE", Id: "t", Relationships: [{ Type: "CHILD", Ids: [name.Id] }] },
        // A list item listed before its list: must come out once, inside the list.
        pythonItem,
        {
          BlockType: "LAYOUT_SECTION_HEADER",
          Id: "h1",
          Relationships: [{ Type: "CHILD", Ids: [skills.Id] }],
        },
        {
          BlockType: "LAYOUT_LIST",
          Id: "list",
          Relationships: [{ Type: "CHILD", Ids: ["li-1", "li-2"] }],
        },
        sqlItem,
        {
          BlockType: "LAYOUT_SECTION_HEADER",
          Id: "h2",
          Relationships: [{ Type: "CHILD", Ids: [exp.Id] }],
        },
        { BlockType: "LAYOUT_TEXT", Id: "p", Relationships: [{ Type: "CHILD", Ids: [job.Id] }] },
        name,
        skills,
        python,
        sql,
        exp,
        job,
        orphan,
      ];
      return { Blocks: blocks };
    }

    it("calls AnalyzeDocument with FeatureTypes LAYOUT", async () => {
      const client = fakeClient(layoutResponse());
      await createTextractAdapter({ client, features: "layout" }).recognize(input());
      const { AnalyzeDocumentCommand } = await import("@aws-sdk/client-textract");
      const command = client.send.mock.calls[0]?.[0] as { input: unknown };
      expect(command).toBeInstanceOf(AnalyzeDocumentCommand);
      expect(command.input).toMatchObject({ FeatureTypes: ["LAYOUT"] });
    });

    it("emits text in Textract's reading order, lists flattened once, orphans last", async () => {
      const client = fakeClient(layoutResponse());
      const out = (await createTextractAdapter({ client, features: "layout" }).recognize(
        input(),
      )) as OcrPage;
      expect(out.items).toBeUndefined();
      expect(out.text).toBe(
        [
          "LUCÍA MORALES",
          "HABILIDADES",
          "Python\nSQL",
          "EXPERIENCIA",
          "Banco Oriental S.A.",
          "Página 1",
        ].join("\n\n"),
      );
      expect(out.confidence).toBeCloseTo(0.99);
    });

    it("falls back to positioned lines when no LAYOUT blocks come back", async () => {
      const client = fakeClient(detectResponse(twoColumnLines()));
      const out = (await createTextractAdapter({ client, features: "layout" }).recognize(
        input(),
      )) as OcrPage;
      expect(out.items).toHaveLength(10);
      expect(out.warnings).toEqual([
        "Textract returned no LAYOUT blocks; falling back to geometric reading order.",
      ]);
    });
  });

  describe("client lifecycle", () => {
    it("creates one client with the region, reuses it, and destroys it on dispose", async () => {
      sdk.send.mockResolvedValue(detectResponse(twoColumnLines()));
      const adapter = createTextractAdapter({ region: "eu-west-1" });
      await adapter.recognize(input());
      await adapter.recognize(input());
      expect(sdk.constructed).toEqual([{ region: "eu-west-1" }]);
      expect(sdk.send).toHaveBeenCalledTimes(2);

      await adapter.dispose?.();
      expect(sdk.destroy).toHaveBeenCalledTimes(1);
      await adapter.dispose?.();
      expect(sdk.destroy).toHaveBeenCalledTimes(1);
    });

    it("lets the SDK resolve the region when none is given", async () => {
      sdk.send.mockResolvedValue({ Blocks: [] });
      await createTextractAdapter().recognize(input());
      expect(sdk.constructed).toEqual([{}]);
    });

    it("never creates or destroys an injected client", async () => {
      const client = fakeClient();
      const adapter = createTextractAdapter({ client, region: "us-east-1" });
      await adapter.recognize(input());
      await adapter.dispose?.();
      expect(sdk.constructed).toEqual([]);
      expect(client.destroy).not.toHaveBeenCalled();
    });
  });
});

describe("missing dependency", () => {
  afterEach(() => {
    vi.doUnmock("@aws-sdk/client-textract");
    vi.resetModules();
  });

  it("throws MISSING_DEPENDENCY with the install command when the SDK is absent", async () => {
    vi.resetModules();
    vi.doMock("@aws-sdk/client-textract", () => {
      throw new Error("Cannot find package '@aws-sdk/client-textract'");
    });
    const { createTextractAdapter: create } = await import("../src/ocr/textract.js");
    const client = fakeClient();
    const error = (await create({ client })
      .recognize(input())
      .catch((e: unknown) => e)) as CvparseError;
    expect(error.name).toBe("CvparseError");
    expect(error.code).toBe("MISSING_DEPENDENCY");
    expect(error.message).toMatch(/npm install @aws-sdk\/client-textract/);
    expect(client.send).not.toHaveBeenCalled();
  });
});
