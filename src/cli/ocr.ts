import { homedir } from "node:os";
import { join } from "node:path";
import type { OcrAdapter } from "../ocr/types.js";
import type { CliOcr } from "./args.js";

/**
 * Where the CLI keeps Tesseract language data. tesseract.js downloads `<lang>.traineddata` on
 * first use and, without a cache path, writes it into the current directory on every run from a
 * new folder. `CVPARSE_CACHE_DIR` overrides the default.
 */
export function tesseractCacheDir(env: Record<string, string | undefined> = process.env): string {
  if (env.CVPARSE_CACHE_DIR) return join(env.CVPARSE_CACHE_DIR, "tessdata");
  const base =
    env.XDG_CACHE_HOME ??
    (process.platform === "win32" && env.LOCALAPPDATA
      ? env.LOCALAPPDATA
      : join(homedir(), ".cache"));
  return join(base, "cvparse", "tessdata");
}

/**
 * Builds the OCR option for `--ocr`. Adapters are imported lazily so the CLI never loads an
 * OCR engine (or requires its optional peer dependency) unless the user asked for it.
 */
export async function createCliOcr(
  engine: CliOcr | undefined,
  languages: readonly string[] | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<OcrAdapter | "vision" | undefined> {
  switch (engine) {
    case undefined:
      return undefined;
    case "vision":
      return "vision";
    case "tesseract": {
      const { createTesseractAdapter } = await import("../ocr/tesseract.js");
      return createTesseractAdapter({
        cachePath: tesseractCacheDir(env),
        ...(languages ? { languages } : {}),
      });
    }
    case "textract": {
      const { createTextractAdapter } = await import("../ocr/textract.js");
      return createTextractAdapter();
    }
  }
}
