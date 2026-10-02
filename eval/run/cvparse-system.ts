/**
 * EvalSystem for cvparse itself (from source), with the CLI's provider presets.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { type CliProvider, DEFAULT_BASE_URLS } from "../../src/cli/args.js";
import { createCliModel } from "../../src/cli/provider.js";
import { parseResume } from "../../src/index.js";
import { createTesseractAdapter } from "../../src/ocr/tesseract.js";
import type { OcrAdapter } from "../../src/ocr/types.js";
import type { DatasetFormat, EvalSystem } from "../types.js";

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

  return {
    info: { name, kind: "cvparse", details },
    supports,
    async predict(file) {
      const data = await readFile(file);
      const result = await parseResume(
        { data, filename: basename(file) },
        {
          model,
          language: EVAL_PARSE_SETTINGS.language,
          temperature: EVAL_PARSE_SETTINGS.temperature,
          referenceDate: new Date(EVAL_PARSE_SETTINGS.referenceDate),
          maxRetries: EVAL_PARSE_SETTINGS.maxRetries,
          ...(ocr ? { ocr } : {}),
        },
      );
      // GroundTruth's x_cvparse is optional but not nullable.
      const { x_cvparse, ...resume } = result.resume;
      return x_cvparse ? { ...resume, x_cvparse } : resume;
    },
    async dispose() {
      if (ocr && ocr !== "vision") await ocr.dispose?.();
    },
  };
}
