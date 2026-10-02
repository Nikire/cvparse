import type { LanguageModel } from "ai";
import type { DocumentInput } from "./extract/index.js";
import type { DetectedLayout, InputFormat } from "./extract/types.js";
import type { OcrAdapter } from "./ocr/types.js";
import type { Resume } from "./schema/resume.js";

/**
 * What `parseResume` accepts: the CV as plain text, or the raw bytes of a PDF, DOCX or text file
 * (a Node `Buffer` works), optionally wrapped with a file name / format hint.
 */
export type ResumeInput = string | Uint8Array | DocumentInput;

/** Where the text came from. */
export interface ExtractionSource {
  /** Format the input was read as. `"text"` for string input. */
  format: InputFormat;
  /** Page count for PDFs. */
  pages?: number;
  /** Page layout detected for PDFs; `"unknown"` otherwise. */
  layout: DetectedLayout;
  /** Present when OCR or vision mode produced the text. */
  ocr?: OcrSource;
}

/** Language hint for the CV text. `auto` lets the model (and a small heuristic) detect it. */
export type ParseLanguage = "auto" | "es" | "en";

/** Options for `parseResume`. */
export interface ParseOptions {
  /**
   * Any AI SDK language model instance, e.g. `openai("gpt-4o-mini")`, `anthropic("claude-sonnet-5-5")`
   * or, for Ollama, `createOpenAICompatible({ name: "ollama", baseURL: "http://localhost:11434/v1",
   * supportsStructuredOutputs: true })("llama3.1")`. For `@ai-sdk/openai-compatible`,
   * `supportsStructuredOutputs: true` is required or the model never receives the resume schema
   * (`warnings` will then contain a `responseFormat` warning).
   *
   * Pass a model instance, not a string. The AI SDK also accepts a bare model id string
   * (`"openai/gpt-4o-mini"`), but that is resolved through the Vercel AI Gateway (requires
   * `AI_GATEWAY_API_KEY`) rather than your own provider.
   */
  model: LanguageModel;
  /** Language of the CV. Defaults to `"auto"`. */
  language?: ParseLanguage;
  /** Extra instructions appended to the system prompt (e.g. domain-specific normalization rules). */
  instructions?: string;
  /** Optional abort signal forwarded to the model call. */
  abortSignal?: AbortSignal;
  /**
   * Maximum number of retries for the model call on retryable errors (network failures, HTTP 429/5xx).
   * Forwarded to the AI SDK; defaults to the SDK default (2). Set `0` to fail fast.
   */
  maxRetries?: number;
  /**
   * Sampling temperature forwarded to the model. Omit to use the provider default. Extraction is
   * a copying task, so low values (`0` to `0.2`) are usually the right choice.
   */
  temperature?: number;
  /**
   * "Today" for resolving relative dates in the CV ("hace 3 años", "2 years ago"). It is told to
   * the model and used by the deterministic date normalizer. Defaults to `new Date()`; pin it
   * for reproducible output.
   */
  referenceDate?: Date;
  /**
   * How to read images and scanned PDFs (no text layer). An {@link OcrAdapter} instance such as
   * `createTesseractAdapter()` from `@cvparse/core/ocr/tesseract` or `createTextractAdapter()`
   * from `@cvparse/core/ocr/textract`; or `"vision"` to send the page images straight to
   * `model`, which must then be a vision-capable model. Without it, images and scanned PDFs are
   * rejected with `OCR_REQUIRED`.
   */
  ocr?: OcrAdapter | "vision";
  /** Language hints for OCR engines (ISO 639-1 codes, e.g. `["es", "en"]`). Not derived from `language`: when omitted, the adapter uses its own configured languages. */
  ocrLanguages?: readonly string[];
}

/** OCR details when an adapter or vision mode was used. */
export interface OcrSource {
  /** Adapter name, or `"vision"`. */
  adapter: string;
  /** Mean confidence 0..1 across pages when the engine reports it. */
  confidence?: number;
  /** Pages (images) that were recognized. */
  pages: number;
}

/** Token usage of the extraction call. Values are `undefined` when the provider does not report them. */
export interface ParseUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}

/** Result of `parseResume`. */
export interface ParseResult {
  /** The extracted resume, validated against `ResumeSchema`. */
  resume: Resume;
  /** Token usage reported by the provider. */
  usage: ParseUsage;
  /**
   * Human-readable warnings: provider/AI SDK warnings (unsupported settings), dates that could
   * not be normalized, heuristic fallbacks, and the model's own `confidenceNotes`.
   */
  warnings: string[];
  /** How the input was read (format, pages, detected layout). */
  source: ExtractionSource;
}
