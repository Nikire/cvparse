import {
  APICallError,
  generateText,
  JSONParseError,
  type JSONSchema7,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  RetryError,
  TypeValidationError,
  type Warning,
} from "ai";
import type { z } from "zod";
import { CvparseError } from "./errors.js";
import { extractText } from "./extract/index.js";
import { scannedPageWarning } from "./extract/messages.js";
import { detectLanguage } from "./normalize/language.js";
import { normalizeResume } from "./normalize/resume.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import {
  RESUME_EXTRACTION_JSON_SCHEMA,
  ResumeExtractionSchema,
  ResumeSchema,
} from "./schema/resume.js";
import type { ExtractionSource, ParseOptions, ParseResult, ResumeInput } from "./types.js";
import {
  buildMixedVisionPrompt,
  buildVisionPrompt,
  toVisionImages,
  type VisionImage,
} from "./vision.js";

type ExtractionOutput = z.infer<typeof ResumeExtractionSchema>;

const MAX_INPUT_CHARS = 200_000;

function formatSdkWarning(warning: Warning): string {
  const w = warning as { type: string; feature?: string; message?: string; details?: string };
  const head = w.feature ? `${w.type}: ${w.feature}` : w.type;
  const tail = w.details ?? w.message;
  let text = tail ? `provider ${head} — ${tail}` : `provider ${head}`;
  if (w.feature === "responseFormat") {
    text +=
      ". The model did not receive the resume schema, so results will be unreliable; " +
      "use a provider/model with structured-output support (for @ai-sdk/openai-compatible pass supportsStructuredOutputs: true).";
  }
  return text;
}

function wrapError(error: unknown): CvparseError {
  if (error instanceof CvparseError) return error;

  // After maxRetries the SDK throws a RetryError; the useful one is the last underlying error.
  if (RetryError.isInstance(error) && error.lastError instanceof Error) {
    const wrapped = wrapError(error.lastError);
    return new CvparseError(
      wrapped.code,
      `${wrapped.message} (after ${error.errors.length} attempts)`,
      {
        cause: error,
        statusCode: wrapped.statusCode,
        rawText: wrapped.rawText,
      },
    );
  }

  if (NoObjectGeneratedError.isInstance(error)) {
    return new CvparseError(
      "NO_OBJECT_GENERATED",
      `The model did not return a valid resume object: ${error.message}`,
      { cause: error, rawText: error.text },
    );
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode === undefined ? "" : ` (HTTP ${error.statusCode})`;
    return new CvparseError("PROVIDER_ERROR", `Provider call failed${status}: ${error.message}`, {
      cause: error,
      statusCode: error.statusCode,
    });
  }
  if (JSONParseError.isInstance(error) || TypeValidationError.isInstance(error)) {
    return new CvparseError(
      "NO_OBJECT_GENERATED",
      `The model output could not be parsed as a resume: ${error.message}`,
      { cause: error },
    );
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new CvparseError("PROVIDER_ERROR", "The extraction call was aborted.", { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CvparseError("PROVIDER_ERROR", `Extraction failed: ${message}`, { cause: error });
}

/**
 * Extracts a JSON Resume-compatible object from a CV using any AI SDK language model.
 *
 * `input` can be the CV text, or the bytes of a PDF, DOCX or text file (format detected from
 * the bytes). Two-column PDFs are read in reading order. Images and scanned PDF pages need
 * `options.ocr` (an OCR adapter, or `"vision"` to send them to the model as images); in a PDF that
 * mixes text and scanned pages, only the scanned pages are OCR'd / sent as images.
 *
 * @example
 * ```ts
 * import { parseResume } from "@cvparse/core";
 * import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
 *
 * const ollama = createOpenAICompatible({
 *   name: "ollama",
 *   baseURL: "http://localhost:11434/v1",
 *   // Required so the provider sends the resume schema via response_format (json_schema).
 *   // Ollama >= 0.5, OpenAI, LM Studio and vLLM support it.
 *   supportsStructuredOutputs: true,
 * });
 * const { resume, warnings } = await parseResume(cvText, { model: ollama("llama3.1") });
 * ```
 *
 * @throws {CvparseError} with `code` `INVALID_INPUT`, `UNSUPPORTED_INPUT`, `NO_TEXT_LAYER`,
 * `EXTRACTION_FAILED`, `OCR_REQUIRED`, `OCR_FAILED`, `MISSING_DEPENDENCY`, `NO_OBJECT_GENERATED`,
 * `PROVIDER_ERROR` or `VALIDATION_ERROR`.
 */
export async function parseResume(input: ResumeInput, options: ParseOptions): Promise<ParseResult> {
  if (!options?.model) {
    throw new CvparseError(
      "INVALID_INPUT",
      "options.model is required (any AI SDK language model).",
    );
  }

  const warnings: string[] = [];
  let source: ExtractionSource = { format: "text", layout: "unknown" };
  let rawText: string;
  /** Page images sent to the model in vision mode; empty otherwise. */
  let images: VisionImage[] = [];
  /** Set when a PDF mixes text pages (sent as text) with scanned pages (sent as images). */
  let mixed: { textPages: number[]; imagePages: number[] } | undefined;
  if (typeof input === "string") {
    rawText = input;
    source = { format: "text", layout: "unknown" };
  } else if (input instanceof Uint8Array || (input && input.data instanceof Uint8Array)) {
    const bytes = input instanceof Uint8Array ? input : input.data;
    if (bytes.length === 0) {
      throw new CvparseError("INVALID_INPUT", "The input document is empty (0 bytes).");
    }
    let doc: Awaited<ReturnType<typeof extractText>> | undefined;
    try {
      doc = await extractText(input, {
        ocr: typeof options.ocr === "object" ? options.ocr : undefined,
        // Only explicit hints: deriving them from `language` would override the languages an
        // adapter was configured with.
        ocrLanguages: options.ocrLanguages,
        abortSignal: options.abortSignal,
      });
    } catch (error) {
      // Vision mode: images and fully scanned PDFs go to the model as pictures, not OCR text.
      const needsPixels =
        CvparseError.is(error) && (error.code === "OCR_REQUIRED" || error.code === "NO_TEXT_LAYER");
      if (options.ocr !== "vision" || !needsPixels) throw error;
      const vision = await toVisionImages(bytes, options.abortSignal);
      images = vision.images;
      warnings.push(...vision.warnings);
      source = {
        format: vision.format,
        pages: vision.totalPages,
        layout: "unknown",
        ocr: { adapter: "vision", pages: vision.images.length },
      };
    }
    if (doc) {
      rawText = doc.text;
      source = { format: doc.format, pages: doc.pages, layout: doc.layout };
      if (doc.ocr) source.ocr = { ...doc.ocr };
      let docWarnings = doc.warnings;
      const scanned = doc.scannedPages ?? [];
      if (options.ocr === "vision" && scanned.length > 0) {
        // Mixed PDF: text pages go as text, scanned pages as images.
        const vision = await toVisionImages(bytes, options.abortSignal, { pages: scanned });
        images = vision.images;
        warnings.push(...vision.warnings);
        const sent = new Set(images.map((image) => image.page));
        const covered = new Set(scanned.filter((p) => sent.has(p)).map(scannedPageWarning));
        docWarnings = docWarnings.filter((w) => !covered.has(w));
        mixed = {
          textPages: Array.from({ length: doc.pages ?? 0 }, (_, i) => i + 1).filter(
            (p) => !scanned.includes(p),
          ),
          imagePages: images.flatMap((image) => (image.page === undefined ? [] : [image.page])),
        };
        source.ocr = { adapter: "vision", pages: images.length };
      }
      for (const w of docWarnings) warnings.push(`extract: ${w}`);
    } else {
      rawText = "";
    }
  } else {
    throw new CvparseError(
      "INVALID_INPUT",
      "parseResume expects the CV as text, as a Uint8Array/Buffer, or as { data, filename? }.",
    );
  }

  const text = rawText.replace(/\r\n?/g, "\n").trim();
  if (text === "" && images.length === 0) {
    throw new CvparseError(
      "INVALID_INPUT",
      source.format === "text"
        ? "The CV text is empty."
        : `No text could be extracted from the ${source.format.toUpperCase()}.`,
    );
  }
  if (text.length > MAX_INPUT_CHARS) {
    warnings.push(
      `Input is ${text.length} characters; only the first ${MAX_INPUT_CHARS} were sent to the model.`,
    );
  }
  const cvText = text.slice(0, MAX_INPUT_CHARS);

  const language = options.language ?? "auto";
  const heuristicLanguage = language === "auto" && cvText ? detectLanguage(cvText) : null;

  const referenceDate = options.referenceDate ?? new Date();
  const instructions = buildSystemPrompt({
    language,
    detectedLanguage: heuristicLanguage,
    instructions: options.instructions,
    referenceDate,
  });

  let raw: unknown;
  let usage: ParseResult["usage"];
  try {
    const result = await generateText({
      model: options.model,
      instructions,
      ...(images.length > 0
        ? {
            messages: [
              {
                role: "user" as const,
                content: [
                  {
                    type: "text" as const,
                    text: mixed
                      ? buildMixedVisionPrompt(cvText, mixed.textPages, mixed.imagePages)
                      : buildVisionPrompt(images.length),
                  },
                  ...images.map((image) => ({
                    type: "file" as const,
                    mediaType: image.mediaType,
                    data: image.data,
                  })),
                ],
              },
            ],
          }
        : { prompt: buildUserPrompt(cvText) }),
      output: Output.object({
        // Wire format: strict-friendly JSON schema (all keys required, null allowed).
        // Validation: lenient Zod schema, so models that omit keys still pass.
        schema: jsonSchema<ExtractionOutput>(RESUME_EXTRACTION_JSON_SCHEMA as JSONSchema7, {
          validate: (value) => {
            const parsed = ResumeExtractionSchema.safeParse(value);
            return parsed.success
              ? { success: true, value: parsed.data }
              : { success: false, error: parsed.error };
          },
        }),
        name: "resume",
        description: "A resume in JSON Resume format with cvparse extensions.",
      }),
      abortSignal: options.abortSignal,
      maxRetries: options.maxRetries,
      temperature: options.temperature,
    });
    raw = result.output;
    usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    };
    for (const warning of result.warnings ?? []) warnings.push(formatSdkWarning(warning));
  } catch (error) {
    throw wrapError(error);
  }

  // Only let the heuristic fill in detectedLanguage when the language is not forced; otherwise
  // it would warn about a detected language that is overridden right below.
  const normalized = normalizeResume(raw, language === "auto" ? cvText : undefined, {
    referenceDate,
  });
  warnings.push(...normalized.warnings);

  if (language !== "auto") {
    normalized.resume.x_cvparse = { ...normalized.resume.x_cvparse, detectedLanguage: language };
  }

  const validated = ResumeSchema.safeParse(normalized.resume);
  if (!validated.success) {
    throw new CvparseError(
      "VALIDATION_ERROR",
      `The normalized resume did not match ResumeSchema: ${validated.error.message}`,
      { cause: validated.error },
    );
  }

  for (const note of validated.data.x_cvparse?.confidenceNotes ?? []) {
    warnings.push(`model: ${note}`);
  }

  return { resume: validated.data, usage, warnings, source };
}
