import type { LanguageModel } from "ai";
import type { DocumentInput } from "./extract/index.js";
import type { DetectedLayout, InputFormat } from "./extract/types.js";
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
