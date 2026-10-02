import { describe, expect, it } from "vitest";
import { CliUsageError, parseCliArgs, USAGE, unsupportedExtension } from "../src/cli/args.js";

describe("parseCliArgs", () => {
  it("returns help/version commands", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["./cv.txt", "--help"])).toEqual({ kind: "help" });
  });

  it("defaults to Ollama with llama3.1 and auto language", () => {
    expect(parseCliArgs(["./cv.txt"])).toEqual({
      kind: "run",
      options: {
        file: "./cv.txt",
        provider: "ollama",
        model: "llama3.1",
        baseUrl: "http://localhost:11434/v1",
        apiKey: undefined,
        language: "auto",
        pretty: false,
      },
    });
  });

  it("configures OpenAI from flags and env", () => {
    const fromFlag = parseCliArgs(["cv.txt", "--provider", "openai", "--api-key", "sk-flag"]);
    expect(fromFlag).toMatchObject({
      kind: "run",
      options: {
        provider: "openai",
        model: "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-flag",
      },
    });

    const fromEnv = parseCliArgs(["cv.txt", "--provider", "openai", "--model", "gpt-4.1"], {
      OPENAI_API_KEY: "sk-env",
    });
    expect(fromEnv).toMatchObject({ options: { apiKey: "sk-env", model: "gpt-4.1" } });

    const flagWins = parseCliArgs(["cv.txt", "--provider=openai", "--api-key=sk-flag"], {
      OPENAI_API_KEY: "sk-env",
    });
    expect(flagWins).toMatchObject({ options: { apiKey: "sk-flag" } });
  });

  it("never sends OPENAI_API_KEY to non-OpenAI providers", () => {
    const env = { OPENAI_API_KEY: "sk-real" };
    expect(parseCliArgs(["cv.txt"], env)).toMatchObject({
      options: { provider: "ollama", apiKey: undefined },
    });
    expect(parseCliArgs(["cv.txt", "--base-url", "http://gpu-box:11434/v1"], env)).toMatchObject({
      options: { provider: "ollama", apiKey: undefined },
    });
    expect(
      parseCliArgs(
        [
          "cv.txt",
          "--provider",
          "openai-compatible",
          "--base-url",
          "https://x.test/v1",
          "--model",
          "m",
        ],
        env,
      ),
    ).toMatchObject({ options: { provider: "openai-compatible", apiKey: undefined } });
  });

  it("reads CVPARSE_API_KEY for any provider, with --api-key winning", () => {
    const env = { CVPARSE_API_KEY: "cv-env", OPENAI_API_KEY: "sk-env" };
    expect(
      parseCliArgs(
        [
          "cv.txt",
          "--provider",
          "openai-compatible",
          "--base-url",
          "https://x.test/v1",
          "--model",
          "m",
        ],
        env,
      ),
    ).toMatchObject({ options: { apiKey: "cv-env" } });
    expect(parseCliArgs(["cv.txt", "--provider", "openai"], env)).toMatchObject({
      options: { apiKey: "cv-env" },
    });
    expect(parseCliArgs(["cv.txt", "--api-key", "flag"], env)).toMatchObject({
      options: { apiKey: "flag" },
    });
  });

  it("requires an API key for OpenAI", () => {
    expect(() => parseCliArgs(["cv.txt", "--provider", "openai"], {})).toThrow(/OPENAI_API_KEY/);
  });

  it("configures an OpenAI-compatible endpoint", () => {
    expect(
      parseCliArgs([
        "cv.txt",
        "--provider",
        "openai-compatible",
        "--base-url",
        "http://localhost:1234/v1",
        "--model",
        "qwen2.5",
        "--lang",
        "es",
        "--pretty",
      ]),
    ).toEqual({
      kind: "run",
      options: {
        file: "cv.txt",
        provider: "openai-compatible",
        model: "qwen2.5",
        baseUrl: "http://localhost:1234/v1",
        apiKey: undefined,
        language: "es",
        pretty: true,
      },
    });
  });

  it("requires --base-url and --model for openai-compatible", () => {
    expect(() => parseCliArgs(["cv.txt", "--provider", "openai-compatible"])).toThrow(
      /--model is required/,
    );
    expect(() =>
      parseCliArgs(["cv.txt", "--provider", "openai-compatible", "--model", "x"]),
    ).toThrow(/--base-url is required/);
  });

  it("lets --base-url override the Ollama default", () => {
    expect(parseCliArgs(["cv.txt", "--base-url", "http://gpu-box:11434/v1"])).toMatchObject({
      options: { provider: "ollama", baseUrl: "http://gpu-box:11434/v1" },
    });
  });

  it("accepts '-' for stdin", () => {
    expect(parseCliArgs(["-"])).toMatchObject({ options: { file: "-" } });
  });

  it.each([
    [[], /Missing <file>/],
    [["a.txt", "b.txt"], /single <file>/],
    [["cv.txt", "--provider", "anthropic"], /Unknown provider "anthropic"/],
    [["cv.txt", "--lang", "fr"], /Unknown language "fr"/],
    [["cv.txt", "--base-url", "not a url"], /not a valid URL/],
    [["cv.txt", "--bogus"], /Unknown option/],
    [["cv.txt", "--model"], /argument missing/i],
  ])("rejects invalid usage %j", (argv, pattern) => {
    expect(() => parseCliArgs(argv)).toThrow(CliUsageError);
    expect(() => parseCliArgs(argv)).toThrow(pattern);
  });
});

describe("unsupportedExtension", () => {
  it("flags image formats no OCR path reads, and legacy office formats", () => {
    expect(unsupportedExtension("scan.gif")).toBe(".gif");
    expect(unsupportedExtension("photo.HEIC")).toBe(".heic");
    expect(unsupportedExtension("scan.png")).toBeNull();
    expect(unsupportedExtension("scan.jpeg")).toBeNull();
    expect(unsupportedExtension("./old.DOC")).toBe(".doc");
    expect(unsupportedExtension("cv.odt")).toBe(".odt");
  });

  it("allows PDF, DOCX, text-like files and files without extension", () => {
    expect(unsupportedExtension("cv.pdf")).toBeNull();
    expect(unsupportedExtension("./Curriculum.DOCX")).toBeNull();
    expect(unsupportedExtension("cv.txt")).toBeNull();
    expect(unsupportedExtension("cv.md")).toBeNull();
    expect(unsupportedExtension("cv")).toBeNull();
    expect(unsupportedExtension("-")).toBeNull();
  });
});

describe("--extract-only", () => {
  it("parses into an extract command and skips provider validation", () => {
    expect(parseCliArgs(["cv.pdf", "--extract-only"])).toEqual({
      kind: "extract",
      options: { file: "cv.pdf" },
    });
    // No API key needed even with --provider openai, and no --model for openai-compatible.
    expect(parseCliArgs(["cv.pdf", "--extract-only", "--provider", "openai"]).kind).toBe("extract");
    expect(parseCliArgs(["-", "--extract-only", "--provider", "openai-compatible"]).kind).toBe(
      "extract",
    );
  });

  it("still requires a single <file>", () => {
    expect(() => parseCliArgs(["--extract-only"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["a.pdf", "b.pdf", "--extract-only"])).toThrow(CliUsageError);
  });
});

describe("--ocr / --ocr-lang", () => {
  it("parses the engine and comma-separated languages", () => {
    const cmd = parseCliArgs(["scan.png", "--ocr", "tesseract", "--ocr-lang", "es, EN"]);
    expect(cmd.kind).toBe("run");
    if (cmd.kind === "run") {
      expect(cmd.options.ocr).toBe("tesseract");
      expect(cmd.options.ocrLanguages).toEqual(["es", "en"]);
    }
    const plain = parseCliArgs(["cv.pdf"]);
    if (plain.kind === "run") expect(plain.options.ocr).toBeUndefined();
  });

  it("rejects unknown engines, bad language lists and vision with --extract-only", () => {
    expect(() => parseCliArgs(["a.png", "--ocr", "abbyy"])).toThrow(/Unknown OCR engine/);
    expect(() => parseCliArgs(["a.png", "--ocr", "tesseract", "--ocr-lang", ","])).toThrow(
      /--ocr-lang/,
    );
    expect(() => parseCliArgs(["a.png", "--ocr", "vision", "--extract-only"])).toThrow(/vision/);
  });

  it("passes tesseract/textract through --extract-only", () => {
    expect(parseCliArgs(["a.png", "--ocr", "textract", "--extract-only"])).toEqual({
      kind: "extract",
      options: { file: "a.png", ocr: "textract", ocrLanguages: undefined },
    });
  });
});

describe("USAGE", () => {
  it("documents every flag", () => {
    for (const flag of [
      "--provider",
      "--model",
      "--base-url",
      "--api-key",
      "--lang",
      "--pretty",
      "--help",
      "--version",
    ]) {
      expect(USAGE).toContain(flag);
    }
    expect(USAGE).toMatch(/^Usage: cvparse <file>/);
  });
});

describe("--ocr vision defaults", () => {
  it("defaults to a multimodal model when --model is omitted", () => {
    const ollama = parseCliArgs(["scan.png", "--ocr", "vision"]);
    if (ollama.kind === "run") expect(ollama.options.model).toBe("gemma3:4b");
    const explicit = parseCliArgs(["scan.png", "--ocr", "vision", "--model", "qwen2.5vl"]);
    if (explicit.kind === "run") expect(explicit.options.model).toBe("qwen2.5vl");
    const textOnly = parseCliArgs(["cv.pdf"]);
    if (textOnly.kind === "run") expect(textOnly.options.model).toBe("llama3.1");
  });
});
