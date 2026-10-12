/**
 * EvalSystem for cvparse itself (from source), with the CLI's provider presets.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { type CliProvider, DEFAULT_BASE_URLS } from "../../src/cli/args.js";
import { loadedOllamaContextLength } from "../../src/cli/ollama-context.js";
import { createCliModel } from "../../src/cli/provider.js";
import { parseResume } from "../../src/index.js";
import { createTesseractAdapter } from "../../src/ocr/tesseract.js";
import type { OcrAdapter } from "../../src/ocr/types.js";
import type { DatasetFormat, DetailedPrediction, EvalSystem } from "../types.js";

export type EvalOcr = "tesseract" | "vision";

export interface CvparseSystemOptions {
  provider: CliProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  ocr?: EvalOcr;
  /** Display name; defaults to "cvparse + <model> (<provider>[, <ocr>])". */
  name?: string;
  /** Free-form hardware note shown in the report. */
  hardware?: string;
}

/** Fixed parse settings so runs are comparable. */
export const EVAL_PARSE_SETTINGS = {
  language: "es",
  temperature: 0,
  referenceDate: "2026-10-01",
  maxRetries: 1,
} as const;

export function createCvparseSystem(options: CvparseSystemOptions): EvalSystem {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URLS[options.provider];
  if (!baseUrl) throw new Error(`--base-url is required for provider "${options.provider}".`);
  const model = createCliModel({
    provider: options.provider,
    model: options.model,
    baseUrl,
    apiKey: options.apiKey,
  });
  let ocr: OcrAdapter | "vision" | undefined;
  if (options.ocr === "tesseract") ocr = createTesseractAdapter({ languages: ["spa", "eng"] });
  else if (options.ocr === "vision") ocr = "vision";

  const supports: DatasetFormat[] = ["pdf", "docx", "text"];
  if (ocr) supports.push("image");

  const details: Record<string, string> = {
    provider: options.provider,
    model: options.model,
    ocr: options.ocr ?? "none",
    temperature: String(EVAL_PARSE_SETTINGS.temperature),
    language: EVAL_PARSE_SETTINGS.language,
    referenceDate: EVAL_PARSE_SETTINGS.referenceDate,
  };
  if (options.provider !== "ollama") details.baseUrl = baseUrl;
  if (options.hardware) details.hardware = options.hardware;

  const name =
    options.name ??
    `cvparse + ${options.model} (${options.provider}${options.ocr ? `, ${options.ocr}` : ""})`;

  // Ollama serves the model with a fixed context window: look it up once (loading the model) so
  // parseResume sizes the CV text to it, like the CLI does. Recorded in the details for the report.
  let contextLength: Promise<number | null> | undefined;
  const contextLengthTokens = async (): Promise<number | undefined> => {
    if (options.provider !== "ollama") return undefined;
    contextLength ??= loadedOllamaContextLength(baseUrl, options.model).then((length) => {
      if (length !== null) details.contextLength = String(length);
      return length;
    });
    return (await contextLength) ?? undefined;
  };

  const predictDetailed = async (file: string): Promise<DetailedPrediction> => {
    const data = await readFile(file);
    const contextTokens = await contextLengthTokens();
    const result = await parseResume(
      { data, filename: basename(file) },
      {
        model,
        language: EVAL_PARSE_SETTINGS.language,
        temperature: EVAL_PARSE_SETTINGS.temperature,
        referenceDate: new Date(EVAL_PARSE_SETTINGS.referenceDate),
        maxRetries: EVAL_PARSE_SETTINGS.maxRetries,
        ...(ocr ? { ocr } : {}),
        ...(contextTokens === undefined ? {} : { contextLengthTokens: contextTokens }),
      },
    );
    // GroundTruth's x_cvparse is optional but not nullable.
    const { x_cvparse, ...resume } = result.resume;
    return {
      prediction: x_cvparse ? { ...resume, x_cvparse } : resume,
      warnings: result.warnings,
      usage: result.usage,
    };
  };

  return {
    info: { name, kind: "cvparse", details },
    supports,
    async predict(file) {
      return (await predictDetailed(file)).prediction;
    },
    predictDetailed,
    async dispose() {
      if (ocr && ocr !== "vision") await ocr.dispose?.();
    },
  };
}
