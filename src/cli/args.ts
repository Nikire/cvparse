import { parseArgs } from "node:util";
import type { ParseLanguage } from "../types.js";

/** Built-in provider presets available from the CLI. */
export type CliProvider = "ollama" | "openai" | "openai-compatible";

export const CLI_PROVIDERS: readonly CliProvider[] = ["ollama", "openai", "openai-compatible"];
export const CLI_LANGUAGES: readonly ParseLanguage[] = ["auto", "es", "en"];

/** Default model per provider when `--model` is omitted. */
export const DEFAULT_MODELS: Record<CliProvider, string | undefined> = {
  ollama: "llama3.1",
  openai: "gpt-4o-mini",
  "openai-compatible": undefined,
};

/** Default model per provider for `--ocr vision` when `--model` is omitted. */
export const DEFAULT_VISION_MODELS: Record<CliProvider, string | undefined> = {
  ollama: "gemma3:4b",
  openai: "gpt-4o-mini",
  "openai-compatible": undefined,
};

/** Default base URL per provider when `--base-url` is omitted. */
export const DEFAULT_BASE_URLS: Record<CliProvider, string | undefined> = {
  ollama: "http://localhost:11434/v1",
  openai: "https://api.openai.com/v1",
  "openai-compatible": undefined,
};

/** OCR engines selectable from the CLI. `vision` sends page images to the (multimodal) model. */
export type CliOcr = "tesseract" | "textract" | "vision";
export const CLI_OCR: readonly CliOcr[] = ["tesseract", "textract", "vision"];

/** Options for a `run` command, fully resolved (defaults applied). */
export interface RunOptions {
  /** Path to the CV (PDF, DOCX or text), or `-` for stdin. */
  file: string;
  provider: CliProvider;
  model: string;
  baseUrl: string;
  apiKey: string | undefined;
  language: ParseLanguage;
  pretty: boolean;
  /** OCR engine for images and scanned PDFs (`--ocr`). */
  ocr: CliOcr | undefined;
  /** OCR language hints (`--ocr-lang es,en`). */
  ocrLanguages: string[] | undefined;
}

/** Options for an `extract` command (`--extract-only`): no model involved. */
export interface ExtractOptions {
  /** Path to the CV (PDF, DOCX or text), or `-` for stdin. */
  file: string;
  /** OCR engine for images and scanned PDFs; `vision` is not allowed here (it needs a model). */
  ocr: Exclude<CliOcr, "vision"> | undefined;
  ocrLanguages: string[] | undefined;
}

export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "extract"; options: ExtractOptions }
  | { kind: "run"; options: RunOptions };

/** Thrown by {@link parseCliArgs} on invalid usage. The CLI prints the message and exits 2. */
export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

export const USAGE = `Usage: cvparse <file> [options]

Turn a CV/resume (PDF, DOCX, image or plain text) into JSON Resume-compatible JSON using an LLM.

Arguments:
  <file>                    Path to the CV: .pdf, .docx, .png/.jpg/.webp/.tiff or plain text. The
                            format is detected from the file contents. Use "-" to read from stdin.
                            Images and scanned PDFs need --ocr.

Options:
  --provider <name>         ollama | openai | openai-compatible   (default: ollama)
  --model <id>              Model id (default: llama3.1 for ollama, gpt-4o-mini for openai;
                            with --ocr vision: gemma3:4b for ollama)
  --base-url <url>          API base URL (default: http://localhost:11434/v1 for ollama,
                            https://api.openai.com/v1 for openai; required for openai-compatible)
  --api-key <key>           API key sent as a Bearer token. Falls back to env CVPARSE_API_KEY
                            (any provider) or OPENAI_API_KEY (openai only; required for openai).
                            The key is only sent to the configured --base-url (default
                            https://api.openai.com/v1 for openai); override it and the key goes there.
  --lang <auto|es|en>       Language of the CV (default: auto)
  --pretty                  Pretty-print the JSON output
  --ocr <engine>            OCR for images and scanned PDFs: tesseract (local; npm i tesseract.js),
                            textract (AWS; npm i @aws-sdk/client-textract, uses the default AWS
                            credential chain and AWS_REGION), or vision (send page images to the
                            model, which must accept images, e.g. gemma3:4b or gpt-4o-mini).
                            Scanned PDFs are rendered with @napi-rs/canvas (npm i @napi-rs/canvas).
  --ocr-lang <codes>        OCR language hints, comma-separated ISO codes (default: --lang, or es,en)
  --extract-only            Print the text extracted from the document and exit, without calling
                            any model. Use it to check reading order on two-column PDFs or to
                            attach the extracted text to a bug report. Needs no provider or key.
  -h, --help                Show this help
  -v, --version             Print the cvparse version

Output:
  JSON to stdout (plain text with --extract-only). Warnings, errors and help go to stderr.

Exit codes:
  0  success
  1  extraction failed (provider error, invalid model output, corrupt document)
  2  usage error (bad arguments, missing file, unsupported or empty input, PDF without text layer)

Examples:
  npx @cvparse/core ./cv.pdf --pretty
  npx @cvparse/core ./cv.docx --lang es
  npx @cvparse/core ./cv.txt --provider openai --model gpt-4o-mini --api-key sk-...
  npx @cvparse/core ./cv.txt --provider openai-compatible --base-url http://localhost:1234/v1 --model qwen2.5
  cat cv.txt | npx @cvparse/core - --lang es
  npx @cvparse/core ./cv.pdf --extract-only > cv.txt
  npx @cvparse/core ./scan.jpg --ocr tesseract --ocr-lang es
  npx @cvparse/core ./scan.pdf --ocr vision --model gemma3:4b
`;

const ARG_OPTIONS = {
  provider: { type: "string" },
  model: { type: "string" },
  "base-url": { type: "string" },
  "api-key": { type: "string" },
  lang: { type: "string" },
  pretty: { type: "boolean", default: false },
  "extract-only": { type: "boolean", default: false },
  ocr: { type: "string" },
  "ocr-lang": { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;

function safeParseArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: ARG_OPTIONS,
    });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Parses CLI arguments (without the `node` and script entries) into a command.
 * Pure: reads `env` for defaults but never touches process state.
 */
export function parseCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): CliCommand {
  const { values, positionals } = safeParseArgs(argv);
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };

  if (positionals.length === 0) {
    throw new CliUsageError("Missing <file> argument.");
  }
  if (positionals.length > 1) {
    throw new CliUsageError(`Expected a single <file> argument, got: ${positionals.join(", ")}`);
  }
  const file = positionals[0] as string;

  const ocrRaw = values.ocr;
  if (ocrRaw !== undefined && !CLI_OCR.includes(ocrRaw as CliOcr)) {
    throw new CliUsageError(
      `Unknown OCR engine "${ocrRaw}". Expected one of: ${CLI_OCR.join(", ")}.`,
    );
  }
  const ocr = ocrRaw as CliOcr | undefined;
  const ocrLanguages = parseOcrLanguages(values["ocr-lang"]);

  // Extraction never talks to a model, so provider/model/key validation does not apply.
  if (values["extract-only"]) {
    if (ocr === "vision") {
      throw new CliUsageError(
        "--ocr vision needs a model, so it cannot be used with --extract-only.",
      );
    }
    return { kind: "extract", options: { file, ocr, ocrLanguages } };
  }

  const providerRaw = values.provider ?? "ollama";
  if (!CLI_PROVIDERS.includes(providerRaw as CliProvider)) {
    throw new CliUsageError(
      `Unknown provider "${providerRaw}". Expected one of: ${CLI_PROVIDERS.join(", ")}.`,
    );
  }
  const provider = providerRaw as CliProvider;

  const langRaw = values.lang ?? "auto";
  if (!CLI_LANGUAGES.includes(langRaw as ParseLanguage)) {
    throw new CliUsageError(
      `Unknown language "${langRaw}". Expected one of: ${CLI_LANGUAGES.join(", ")}.`,
    );
  }
  const language = langRaw as ParseLanguage;

  // Vision mode needs a multimodal model; llama3.1 (the Ollama default) is text-only.
  const model =
    values.model ?? (ocr === "vision" ? DEFAULT_VISION_MODELS[provider] : DEFAULT_MODELS[provider]);
  if (!model) {
    throw new CliUsageError(`--model is required for provider "${provider}".`);
  }

  const baseUrl = values["base-url"] ?? DEFAULT_BASE_URLS[provider];
  if (!baseUrl) {
    throw new CliUsageError(`--base-url is required for provider "${provider}".`);
  }
  try {
    new URL(baseUrl);
  } catch {
    throw new CliUsageError(`--base-url "${baseUrl}" is not a valid URL.`);
  }

  // OPENAI_API_KEY is only picked up for --provider openai, so a developer with it exported does
  // not leak it to Ollama or an openai-compatible endpoint by accident. It is still sent to whatever
  // --base-url resolves to (api.openai.com by default), so overriding --base-url sends it there.
  const apiKey =
    values["api-key"] ??
    env.CVPARSE_API_KEY ??
    (provider === "openai" ? env.OPENAI_API_KEY : undefined) ??
    undefined;
  if (provider === "openai" && !apiKey) {
    throw new CliUsageError(
      'An API key is required for provider "openai": pass --api-key or set OPENAI_API_KEY.',
    );
  }

  return {
    kind: "run",
    options: {
      file,
      provider,
      model,
      baseUrl,
      apiKey,
      language,
      pretty: values.pretty ?? false,
      ocr,
      ocrLanguages,
    },
  };
}

function parseOcrLanguages(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const codes = raw
    .split(",")
    .map((code) => code.trim().toLowerCase())
    .filter((code) => code !== "");
  if (codes.length === 0 || codes.some((code) => !/^[a-z]{2,3}(_[a-z]+)?$/.test(code))) {
    throw new CliUsageError(
      `--ocr-lang expects comma-separated language codes such as "es,en", got "${raw}".`,
    );
  }
  return codes;
}

/** Image formats no OCR path accepts; convert to PNG or JPEG first. */
export const IMAGE_EXTENSIONS = new Set([".gif", ".bmp", ".heic", ".heif", ".svg"]);

/** Legacy / other office formats: convert to .docx or PDF first. */
export const LEGACY_DOCUMENT_EXTENSIONS = new Set([".doc", ".odt", ".rtf", ".pages"]);

/** Returns the lowercase extension of `file` if cvparse cannot read that format, else `null`. */
export function unsupportedExtension(file: string): string | null {
  const match = /\.[a-z0-9]+$/i.exec(file);
  if (!match) return null;
  const ext = match[0].toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || LEGACY_DOCUMENT_EXTENSIONS.has(ext) ? ext : null;
}

/** Human-readable reason for an unsupported extension, for the CLI error message. */
export function unsupportedExtensionMessage(ext: string): string {
  if (IMAGE_EXTENSIONS.has(ext)) {
    return `${ext} images are not supported. Convert the image to PNG or JPEG and pass --ocr.`;
  }
  return `${ext} files are not supported. Save the CV as .docx or PDF and try again.`;
}
