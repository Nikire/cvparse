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
import {
  checkCoverage,
  detectSectionSpans,
  groundResume,
  normalizeForMatch,
} from "./normalize/grounding.js";
import { detectLanguage } from "./normalize/language.js";
import {
  dedupeResumeEntries,
  detectRepetitionLoop,
  pruneSalvagedEntries,
  repairTruncatedJson,
} from "./normalize/repetition.js";
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

/**
 * Default cap on the tokens the model may generate for one CV. A long CV in JSON Resume form is
 * typically 1-4k tokens; the cap stops a model that loops (repeating entries or highlights) from
 * generating until the HTTP client times out.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Frequency penalty for the single retry after the model got stuck repeating itself. Measured on
 * llama3.1 8B (Ollama): 0.3 breaks the loop deterministically at temperature 0, while applying a
 * penalty to every call costs 1-2 points on normal CVs (it penalizes the JSON keys every entry
 * repeats), so it is only used for the retry.
 */
export const LOOP_RETRY_FREQUENCY_PENALTY = 0.3;

/**
 * Default input budget (estimated tokens of CV text sent to the model). Fits API models with a
 * 32k+ window; the CLI derives a tighter one for Ollama from the loaded context length.
 */
export const DEFAULT_INPUT_BUDGET_TOKENS = 24_000;

/** Characters per token used for the budget estimate (Spanish/English prose with punctuation). */
export const CHARS_PER_TOKEN = 3.3;

/**
 * Tokens reserved for the system prompt (~1.6k) plus the message framing when the budget is
 * derived from a context length.
 */
export const INSTRUCTIONS_RESERVE_TOKENS = 2_000;

/** Fraction of the budget the input is cut to on the retry after an output-limit cut. */
export const RETRY_INPUT_FRACTION = 0.6;

/** Rough token count of a text: characters / {@link CHARS_PER_TOKEN}. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Headings of sections dropped first when the CV exceeds the input budget: what an academic CV
 * pads itself with and no resume field captures (publications, talks, committees, reviews...).
 */
const LOW_VALUE_HEADING_REGEX = new RegExp(
  "^(?:(?:otros|otras|mis|principales|other|selected|recent)\\s+)?(?:" +
    [
      "publicaciones",
      "publications",
      "congresos",
      "conferences",
      "ponencias",
      "comunicaciones",
      "proyectos de investigacion",
      "research projects",
      "comites",
      "committees",
      "revisiones",
      "reviews",
      "referencias",
      "references",
      "intereses",
      "interests",
      "hobbies",
      "otros meritos",
      "meritos",
      "merits",
      "actividades academicas",
      "academic activities",
      "tribunales",
      "estancias",
      "research stays",
    ]
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|") +
    ")(?:\\s+\\p{L}+){0,3}$",
  "u",
);

/** `true` when a heading (as written) names a low-value section. */
function isLowValueHeading(heading: string): boolean {
  const line = normalizeForMatch(heading)
    .replace(/^[^\p{L}\p{N}]+/u, "")
    // Numbered headings: "4. Publicaciones", "4.2 Congresos", "IV. Ponencias".
    .replace(/^(?:\d+(?:\.\d+)*|[ivx]+)[.)]?\s+/u, "")
    .replace(/[\s:.\-–—|]+$/u, "");
  if (line === "" || line.length > 60 || /[,;()"]/u.test(line)) return false;
  return LOW_VALUE_HEADING_REGEX.test(line);
}

/**
 * A single-word (or very short) low-value heading the generic detector does not know
 * ("CONGRESOS", "Ponencias y comunicaciones"): at most four words, not a bullet.
 */
function isStandaloneLowValueHeading(rawLine: string): boolean {
  const trimmed = rawLine.trim();
  if (trimmed === "" || /^[-•*·▪◦]/u.test(trimmed)) return false;
  if (trimmed.split(/\s+/).length > 4) return false;
  return isLowValueHeading(trimmed);
}

/** A section of the document as the budget cut sees it: heading line to the next heading. */
export interface InputSection {
  /** The heading as written (trimmed, without leading bullets / trailing punctuation). */
  heading: string;
  /** Line index of the heading. */
  start: number;
  /** Line index right after the section. */
  end: number;
  /** Dropped first when the document exceeds the budget. */
  lowValue: boolean;
}

/**
 * Splits the lines of a document into sections: the spans of {@link detectSectionSpans}
 * (generic headings included) plus standalone low-value headings it does not know. Lines before
 * the first heading belong to no section.
 */
export function splitInputSections(lines: readonly string[]): InputSection[] {
  const starts = new Map<number, string>();
  for (const span of detectSectionSpans(lines.join("\n"), { genericHeadings: true })) {
    starts.set(span.start, span.heading);
  }
  lines.forEach((line, i) => {
    if (!starts.has(i) && isStandaloneLowValueHeading(line)) {
      starts.set(
        i,
        line
          .trim()
          .replace(/^[^\p{L}\p{N}]+/u, "")
          .replace(/[\s:.\-–—|]+$/u, ""),
      );
    }
  });
  const sorted = [...starts.entries()].sort(([a], [b]) => a - b);
  return sorted.map(([start, heading], index) => ({
    heading,
    start,
    end: sorted[index + 1]?.[0] ?? lines.length,
    lowValue: isLowValueHeading(heading),
  }));
}

/** Result of {@link fitInputToBudget}. */
export interface InputFit {
  /** The text to send to the model. */
  text: string;
  /** Estimated tokens of the original text. */
  estimatedTokens: number;
  /** Budget the text was fitted to. */
  budgetTokens: number;
  /** Headings of the sections dropped, in document order. */
  droppedSections: string[];
  /** `true` when the tail had to be cut after dropping every low-value section. */
  tailCut: boolean;
}

/**
 * Fits the document text to a token budget by section: low-value sections are dropped first
 * (largest first, until the text fits), then the tail is cut at a line break. The lines before
 * the first heading (name and contact details) are always kept.
 */
export function fitInputToBudget(text: string, budgetTokens: number): InputFit {
  const estimatedTokens = estimateTokens(text);
  const base = { estimatedTokens, budgetTokens, droppedSections: [], tailCut: false };
  if (estimatedTokens <= budgetTokens) return { ...base, text };

  const budgetChars = Math.floor(budgetTokens * CHARS_PER_TOKEN);
  const lines = text.split("\n");
  const sections = splitInputSections(lines);
  const dropped = new Set<InputSection>();
  let length = text.length;
  const candidates = sections
    .filter((section) => section.lowValue)
    .map((section) => ({
      section,
      // +1 for the line break that goes with each line.
      chars: lines.slice(section.start, section.end).reduce((n, l) => n + l.length + 1, 0),
    }))
    .sort((a, b) => b.chars - a.chars);
  for (const candidate of candidates) {
    if (length <= budgetChars) break;
    dropped.add(candidate.section);
    length -= candidate.chars;
  }

  let kept: string[] = [];
  if (dropped.size === 0) {
    kept = lines;
  } else {
    const droppedLines = new Set<number>();
    for (const section of dropped) {
      for (let i = section.start; i < section.end; i++) droppedLines.add(i);
    }
    kept = lines.filter((_, i) => !droppedLines.has(i));
  }
  let fitted = kept.join("\n").trim();
  let tailCut = false;
  if (fitted.length > budgetChars) {
    const head = fitted.slice(0, budgetChars);
    const lastBreak = head.lastIndexOf("\n");
    fitted = (lastBreak > budgetChars / 2 ? head.slice(0, lastBreak) : head).trimEnd();
    tailCut = true;
  }
  return {
    ...base,
    text: fitted,
    droppedSections: sections.filter((s) => dropped.has(s)).map((s) => s.heading),
    tailCut,
  };
}

/** The "; dropped sections: ...; the tail was cut" part of an input-budget warning. */
function describeFit(fit: InputFit): string {
  const parts: string[] = [];
  if (fit.droppedSections.length > 0) {
    parts.push(`dropped sections: ${fit.droppedSections.join(", ")}`);
  }
  if (fit.tailCut) parts.push("the tail was cut");
  return parts.join("; ");
}

function inputBudgetWarning(fit: InputFit): string {
  return `input: the document exceeds the input budget (${fit.estimatedTokens} tokens est., budget ${fit.budgetTokens}); ${describeFit(fit)}`;
}

type Attempt = { kind: "ok"; output: unknown; warnings: string[] } | { kind: "cut"; text: string };

/**
 * Rebuilds a resume from looping outputs cut by the output limit: repairs the truncated JSON,
 * removes the repeated (identical or near-identical) entries and checks the extraction schema.
 * Tries each text in order; returns `undefined` when none can be recovered.
 */
export function salvageLoopingOutput(
  texts: readonly string[],
  options: { referenceDate?: Date | undefined; warnings?: string[] | undefined } = {},
): unknown {
  for (const text of texts) {
    const repaired = repairTruncatedJson(text);
    if (!repaired) continue;
    // No per-section warnings: the salvage warning already says repeated entries were removed.
    dedupeResumeEntries(repaired, { similar: true });
    // What the loop fabricated and the identity check cannot catch: implausible dates, entries
    // drifting their dates in a fixed step, endless arrays.
    const pruned = pruneSalvagedEntries(repaired, options.referenceDate);
    const parsed = ResumeExtractionSchema.safeParse(repaired);
    if (parsed.success) {
      options.warnings?.push(...pruned);
      return parsed.data;
    }
  }
  return undefined;
}

/** Message for an extraction cut by the output limit. */
function outputLimitMessage(maxOutputTokens: number): string {
  return `The model hit the output limit (maxOutputTokens=${maxOutputTokens}); the CV may be too long or the model looped. Raise ParseOptions.maxOutputTokens if the CV is genuinely long.`;
}

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

function wrapError(error: unknown, context: { maxOutputTokens: number }): CvparseError {
  if (error instanceof CvparseError) return error;

  // After maxRetries the SDK throws a RetryError; the useful one is the last underlying error.
  if (RetryError.isInstance(error) && error.lastError instanceof Error) {
    const wrapped = wrapError(error.lastError, context);
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
    if (error.finishReason === "length") {
      return new CvparseError("NO_OBJECT_GENERATED", outputLimitMessage(context.maxOutputTokens), {
        cause: error,
        rawText: error.text,
      });
    }
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
  const fullText = text.slice(0, MAX_INPUT_CHARS);

  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const budgetTokens = Math.max(
    1,
    options.inputBudgetTokens ??
      (options.contextLengthTokens === undefined
        ? DEFAULT_INPUT_BUDGET_TOKENS
        : options.contextLengthTokens - maxOutputTokens - INSTRUCTIONS_RESERVE_TOKENS),
  );
  const fit = fitInputToBudget(fullText, budgetTokens);
  if (fit.text !== fullText) warnings.push(inputBudgetWarning(fit));
  /** The text the model reads; replaced when the retry cuts the input further. */
  let cvText = fit.text;

  const language = options.language ?? "auto";
  const heuristicLanguage = language === "auto" && cvText ? detectLanguage(cvText) : null;

  const referenceDate = options.referenceDate ?? new Date();
  const instructions = buildSystemPrompt({
    language,
    detectedLanguage: heuristicLanguage,
    instructions: options.instructions,
    referenceDate,
  });

  const userContentFor = (text: string) =>
    images.length > 0
      ? {
          messages: [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: mixed
                    ? buildMixedVisionPrompt(text, mixed.textPages, mixed.imagePages)
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
      : { prompt: buildUserPrompt(text) };

  const usage: ParseResult["usage"] = {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  };
  const addUsage = (u: ParseResult["usage"]) => {
    for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
      if (u[key] !== undefined) usage[key] = (usage[key] ?? 0) + (u[key] ?? 0);
    }
  };

  const attempt = async (
    text: string,
    tuning: { frequencyPenalty?: number; maxOutputTokens: number } = { maxOutputTokens },
  ): Promise<Attempt> => {
    const { frequencyPenalty } = tuning;
    try {
      const result = await generateText({
        model: options.model,
        instructions,
        ...userContentFor(text),
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
        maxOutputTokens: tuning.maxOutputTokens,
        ...(frequencyPenalty === undefined ? {} : { frequencyPenalty }),
      });
      addUsage({
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      });
      if (result.finishReason === "length") {
        // A truncated object almost never parses; if it did, it is missing its tail.
        return { kind: "cut", text: result.text };
      }
      return {
        kind: "ok",
        output: result.output,
        warnings: (result.warnings ?? []).map(formatSdkWarning),
      };
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error) && error.finishReason === "length") {
        if (error.usage) {
          addUsage({
            inputTokens: error.usage.inputTokens,
            outputTokens: error.usage.outputTokens,
            totalTokens: error.usage.totalTokens,
          });
        }
        return { kind: "cut", text: error.text ?? "" };
      }
      throw wrapError(error, { maxOutputTokens });
    }
  };
  const lengthError = (text: string) =>
    new CvparseError("NO_OBJECT_GENERATED", outputLimitMessage(maxOutputTokens), {
      rawText: text,
    });

  let raw: unknown;
  const first = await attempt(cvText);
  if (first.kind === "ok") {
    raw = first.output;
    warnings.push(...first.warnings);
  } else {
    // Cut by the output limit. With the input sent at the budget (within 10% of it) the cause is
    // almost always the context window (Ollama shifts the instructions and the head of the CV
    // out, the model degenerates into repetition), so a frequency penalty would not help: retry
    // with less input. Only the text actually sent counts: a document cut well under the budget
    // by the section drop does not overflow. Otherwise a genuinely long CV needs a higher limit
    // (retrying would hit the same wall) and a model stuck repeating itself gets one retry with
    // a frequency penalty.
    const inputTokens = estimateTokens(cvText);
    const atBudget = inputTokens >= budgetTokens * 0.9;
    let second: Attempt | undefined;
    let retryWarning: string;
    if (atBudget) {
      const retryFit = fitInputToBudget(fullText, Math.floor(budgetTokens * RETRY_INPUT_FRACTION));
      cvText = retryFit.text;
      let retryMaxOutputTokens = maxOutputTokens;
      if (options.contextLengthTokens !== undefined) {
        const promptTokens = estimateTokens(instructions) + estimateTokens(buildUserPrompt(cvText));
        retryMaxOutputTokens = Math.max(
          512,
          Math.min(maxOutputTokens, options.contextLengthTokens - promptTokens - 256),
        );
      }
      const detail = describeFit(retryFit);
      retryWarning =
        `input: the first extraction hit the output limit with the input at the budget (${inputTokens} tokens est., budget ${budgetTokens}); ` +
        `retried with the input cut to ${Math.round(RETRY_INPUT_FRACTION * 100)}% of the budget (${estimateTokens(cvText)} tokens est.)` +
        (detail ? `; ${detail}` : "") +
        (retryMaxOutputTokens !== maxOutputTokens
          ? `; maxOutputTokens ${retryMaxOutputTokens}`
          : "");
      try {
        second = await attempt(cvText, { maxOutputTokens: retryMaxOutputTokens });
      } catch (error) {
        if (options.abortSignal?.aborted) throw error;
        // The retry failed in another way: fall back to salvaging the first output.
      }
    } else {
      if (!detectRepetitionLoop(first.text)) throw lengthError(first.text);
      retryWarning = `model: the first extraction got stuck repeating itself until the output limit; retried with frequencyPenalty ${LOOP_RETRY_FREQUENCY_PENALTY}.`;
      try {
        second = await attempt(cvText, {
          frequencyPenalty: LOOP_RETRY_FREQUENCY_PENALTY,
          maxOutputTokens,
        });
      } catch (error) {
        if (options.abortSignal?.aborted) throw error;
        // The retry failed in another way: fall back to salvaging the first output.
      }
    }
    if (second?.kind === "ok") {
      raw = second.output;
      warnings.push(...second.warnings, retryWarning);
    } else {
      if (atBudget) warnings.push(retryWarning);
      // Both attempts failed: keep what the model got right before it started looping. The
      // retry's output is tried first; grounding then runs against the text that output read.
      const salvageWarnings: string[] = [];
      if (second?.kind === "cut") {
        raw = salvageLoopingOutput([second.text], { referenceDate, warnings: salvageWarnings });
      }
      if (raw === undefined) {
        cvText = fit.text;
        raw = salvageLoopingOutput([first.text], { referenceDate, warnings: salvageWarnings });
      }
      if (raw === undefined) throw lengthError(first.text);
      warnings.push(
        "model: the output was cut by a repetition loop; repeated entries were removed and later sections may be missing",
        ...salvageWarnings,
      );
    }
  }

  // Only let the heuristic fill in detectedLanguage when the language is not forced; otherwise
  // it would warn about a detected language that is overridden right below.
  const normalized = normalizeResume(raw, language === "auto" ? cvText : undefined, {
    referenceDate,
    // Lets the normalizer undo months the model invented ("2020" written as "2020-01").
    sourceText: images.length === 0 ? cvText : undefined,
  });
  warnings.push(...normalized.warnings);

  if (language !== "auto") {
    normalized.resume.x_cvparse = { ...normalized.resume.x_cvparse, detectedLanguage: language };
  }

  // Grounding and coverage compare the output with the text the model read. In vision mode
  // (whole document or some pages sent as images) part of the CV is only pixels, so a value
  // missing from the text may still be real: skip both checks entirely.
  let resume = normalized.resume;
  if (images.length === 0 && cvText !== "") {
    // Coverage is checked on the grounded resume: grounding may move entries into a section the
    // model left empty (a university returned in work[] goes back to education[]).
    const grounded = options.grounding !== false ? groundResume(resume, cvText) : null;
    if (grounded) resume = grounded.resume;
    warnings.push(...checkCoverage(resume, cvText));
    if (grounded) warnings.push(...grounded.warnings);
  }

  const validated = ResumeSchema.safeParse(resume);
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
