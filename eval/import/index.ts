/**
 * Imports CVs dropped into `<dataset>/inbox/` into a dataset directory (meant for the private
 * set, eval/private): stable ids, files moved to `files/<id>.<ext>`, extracted text under
 * `text/<id>.txt`, a draft ground truth under `truth/<id>.json` (written by the model, marked
 * `_review.status: "draft"` so the runner skips it until a human reviews it) and a manifest
 * entry with provenance (source, PII flag, acquisition date, original file name).
 *
 *   tsx eval/import/index.ts --dataset eval/private [--provider ollama --model llama3.1] [--dry-run]
 *
 * This file is committed tooling: it must never contain CV contents. See README.md next to it.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { LanguageModel } from "ai";
import {
  CLI_PROVIDERS,
  type CliProvider,
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
} from "../../src/cli/args.js";
import { tesseractCacheDir } from "../../src/cli/ocr.js";
import { createCliModel } from "../../src/cli/provider.js";
import {
  type DetectedFormat,
  detectFormat,
  detectLanguage,
  type ExtractedDocument,
  extractText,
  imageMimeType,
  type OcrAdapter,
  type ParseLanguage,
  parseResume,
  type Resume,
} from "../../src/index.js";
import { EVAL_DIR } from "../run/runner.js";
import type { DatasetEntry, DatasetFormat, DatasetLayout, GroundTruth } from "../types.js";

export const USAGE = `Usage: npm run eval:import -- --dataset <dir> [options]

Imports every file in <dir>/inbox/ into the dataset: files/<id>.<ext>, text/<id>.txt,
truth/<id>.json (draft, written by the model) and a manifest.json entry.

Options:
  --dataset <dir>        dataset directory with an inbox/ folder (default: eval/private)
  --provider <p>         ollama | openai | openai-compatible (default: ollama)
  --model <id>           model id (default: llama3.1 for ollama, gpt-4o-mini for openai)
  --base-url <url>       API base URL (default per provider)
  --api-key <key>        API key (falls back to CVPARSE_API_KEY, or OPENAI_API_KEY for openai)
  --concurrency <n>      files processed in parallel (default: 1)
  --dry-run              detect, extract and report; write nothing, call no model
  -h, --help             show this help`;

// ---------------------------------------------------------------------------------------------
// Names and ids

/** Where a private CV came from. */
export type ImportSource =
  | "consent"
  | "linkedin"
  | "public-record"
  | "fake"
  | "fixture"
  | "unknown";

export interface ParsedInboxName {
  source: ImportSource;
  /** ISO 3166-1 alpha-2 in lowercase from a `public-<cc>-` prefix; "xx" when unknown. */
  cc: string;
}

const SOURCE_PREFIXES: Record<string, ImportSource> = {
  consent: "consent",
  linkedin: "linkedin",
  public: "public-record",
  fake: "fake",
  fixture: "fixture",
};

/** Source and country from the inbox file name prefix (`consent-`, `public-<cc>-`, ...). */
export function parseInboxName(fileName: string): ParsedInboxName {
  const match = /^([a-z]+)-/i.exec(fileName);
  const source = match ? SOURCE_PREFIXES[match[1]?.toLowerCase() ?? ""] : undefined;
  if (!source) return { source: "unknown", cc: "xx" };
  if (source === "public-record") {
    const cc = /^public-([a-z]{2})(?:-|$)/i.exec(fileName)?.[1];
    return { source, cc: cc ? cc.toLowerCase() : "xx" };
  }
  return { source, cc: "xx" };
}

/** Id prefix for a source: "public-record" ids read `public-<cc>-NNN`. */
export function idPrefix(source: ImportSource, cc: string): string {
  const head = source === "public-record" ? "public" : source;
  return `${head}-${cc.toLowerCase()}`;
}

/**
 * Allocates `<prefix>-NNN` ids that continue after the highest NNN already used for that prefix
 * (in the manifest or earlier in the same batch). Ids never need to be contiguous.
 */
export function createIdAllocator(existingIds: Iterable<string>): (prefix: string) => string {
  const counters = new Map<string, number>();
  for (const id of existingIds) {
    const m = /^(.+)-(\d{3,})$/.exec(id);
    if (!m) continue;
    const prefix = m[1] as string;
    const n = Number(m[2]);
    counters.set(prefix, Math.max(counters.get(prefix) ?? 0, n));
  }
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}-${String(next).padStart(3, "0")}`;
  };
}

// ---------------------------------------------------------------------------------------------
// Format, layout and language

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/tiff": "tiff",
};

/** Dataset format + file extension for detected bytes; `null` when the format is unsupported. */
export function datasetFormat(
  detected: DetectedFormat,
  data: Uint8Array,
): { format: DatasetFormat; ext: string } | null {
  switch (detected) {
    case "pdf":
      return { format: "pdf", ext: "pdf" };
    case "docx":
      return { format: "docx", ext: "docx" };
    case "text":
      return { format: "text", ext: "txt" };
    case "image": {
      const ext = IMAGE_EXTENSIONS[imageMimeType(data) ?? ""];
      return ext ? { format: "image", ext } : null;
    }
    default:
      return null;
  }
}

const EXTENSION_FORMATS: Record<string, DatasetFormat> = {
  pdf: "pdf",
  docx: "docx",
  txt: "text",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  tif: "image",
  tiff: "image",
};

/**
 * Why a file must not be imported even though its bytes are readable: it is an HTML page saved
 * under a document name (a failed download), or its extension promises another format than the
 * bytes contain. Returns `undefined` when the file is fine.
 */
export function rejectReason(
  fileName: string,
  detected: DetectedFormat,
  data: Uint8Array,
): string | undefined {
  if (detected === "text") {
    const head = new TextDecoder("utf8", { fatal: false })
      .decode(data.subarray(0, 512))
      .trimStart()
      .toLowerCase();
    if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
      return "HTML page, not a document (failed download?)";
    }
  }
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  const expected = ext ? EXTENSION_FORMATS[ext] : undefined;
  if (expected && expected !== detected) {
    return `extension .${ext} but the content is ${detected}`;
  }
  return undefined;
}

/** Manifest layout from the extraction result: OCR'd or image-only input counts as scanned. */
export function manifestLayout(
  doc: Pick<ExtractedDocument, "layout" | "ocr" | "scannedPages" | "format">,
): DatasetLayout {
  if (doc.format === "image" || doc.ocr || (doc.scannedPages?.length ?? 0) > 0) return "scanned";
  if (doc.layout === "multi-column") return "two-column";
  return "single-column";
}

export type ManifestLanguage = "es" | "en" | "pt" | "mixed" | "unknown";

const ES_HEADINGS =
  /^\s*(experiencia( laboral| profesional)?|educaci[oó]n|formaci[oó]n( acad[eé]mica)?|habilidades|competencias|idiomas|perfil( profesional)?|resumen)\s*:?\s*$/im;
const EN_HEADINGS =
  /^\s*((work|professional) experience|experience|education|(technical )?skills|languages|summary|profile)\s*:?\s*$/im;

/**
 * Main language of the CV text; "mixed" when it has section headings in both Spanish and
 * English (a Spanish CV with a "Skills" section, an English one with "Idiomas").
 */
export function detectManifestLanguage(text: string): ManifestLanguage {
  if (ES_HEADINGS.test(text) && EN_HEADINGS.test(text)) return "mixed";
  return detectLanguage(text) ?? "unknown";
}

/** `parseResume` language hint for a manifest language. */
export function parseLanguageFor(language: ManifestLanguage): ParseLanguage {
  return language === "es" || language === "en" ? language : "auto";
}

// ---------------------------------------------------------------------------------------------
// Non-CV detection

/** Manifest tag for a document that does not read as a CV. */
export const SUSPECT_NOT_CV_TAG = "suspect-not-cv";

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u;
const PHONE_RUN = /\+?\(?\d[\d\s().\-/]{5,}\d/u;
/** A year, a month/year or a day/month/year, each a separate token ("2019", "03/2020", "15-03-2020"). */
const DATE_TOKEN = /(?<!\d)(?:\d{1,2}[/.-])?(?:\d{1,2}[/.-])?(?:19[5-9]\d|20\d\d)(?!\d)/gu;
const SECTION_HEADING =
  /^\s*[^\p{L}\p{N}]*(?:experiencia(?:\s+(?:laboral|profesional))?|empleos?|trayectoria(?:\s+(?:laboral|profesional))?|antecedentes\s+(?:laborales|profesionales)|cargos(?:\s+ejercidos)?|historial\s+laboral|(?:work|professional)?\s*experience|employment(?:\s+history)?|work\s+history|career|educaci[oó]n|formaci[oó]n(?:\s+acad[eé]mica)?|estudios|antecedentes\s+acad[eé]micos|t[ií]tulos|education|academic\s+background)\s*:?\s*$/imu;

/**
 * Why the extracted text does not read as a CV, or `undefined` when it does. A CV has at least
 * one of: an email, a phone-like digit run, two or more date-like tokens, an experience /
 * education heading. A document with none of them (a cover letter, a certificate, a form) is
 * imported anyway, but flagged for review.
 */
export function notCvReason(text: string): string | undefined {
  if (EMAIL.test(text) || PHONE_RUN.test(text)) return undefined;
  const dates = text.match(DATE_TOKEN)?.length ?? 0;
  if (dates >= 2 || SECTION_HEADING.test(text)) return undefined;
  return `no email, no phone number, ${dates === 0 ? "no" : "only one"} date and no experience/education heading in the text`;
}

// ---------------------------------------------------------------------------------------------
// Truth and manifest shapes

export interface TruthReview {
  status: "draft" | "reviewed";
  /** Who wrote the file: the model id for drafts. */
  source: string;
  warnings: string[];
}

/** What the import writes to truth/<id>.json: the scored subset plus review metadata. */
export type DraftTruth = GroundTruth & { _review: TruthReview };

function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/** Reduces a parsed resume to the fields the scorer reads, so reviewers see only what counts. */
export function toDraftTruth(resume: Resume, review: TruthReview): DraftTruth {
  const out: DraftTruth = { _review: review };
  if (resume.basics) {
    const basics = pick(resume.basics, ["name", "email", "phone"]) as NonNullable<Resume["basics"]>;
    const location = resume.basics.location;
    if (location) {
      const loc = Object.fromEntries(
        Object.entries(pick(location, ["city", "region", "countryCode"])).filter(
          ([, v]) => v != null,
        ),
      );
      if (Object.keys(loc).length > 0) basics.location = loc;
    }
    out.basics = basics;
  }
  if (resume.work) {
    out.work = resume.work.map((w) => pick(w, ["name", "position", "startDate", "endDate"]));
  }
  if (resume.education) {
    out.education = resume.education.map((e) =>
      pick(e, ["institution", "studyType", "area", "startDate", "endDate"]),
    );
  }
  if (resume.skills) out.skills = resume.skills.map((s) => pick(s, ["name"]));
  if (resume.languages) {
    out.languages = resume.languages.map((l) => pick(l, ["language", "fluency"]));
  }
  const levels = resume.x_cvparse?.educationLevels;
  if (levels) out.x_cvparse = { educationLevels: levels };
  return out;
}

/** Manifest entry of a private dataset: the shared contract plus provenance fields. */
export type PrivateDatasetEntry = Omit<DatasetEntry, "country" | "language"> & {
  /** ISO 3166-1 alpha-2 uppercased from the file name prefix; "XX" until review fixes it. */
  country: string;
  language: ManifestLanguage;
  source: ImportSource;
  /** Whether the document identifies a real person. */
  pii: boolean;
  /** YYYY-MM-DD the file was acquired (its modification time when dropped into the inbox). */
  acquired: string;
  originalName: string;
};

const REAL_SOURCES: ReadonlySet<ImportSource> = new Set([
  "consent",
  "linkedin",
  "public-record",
  "unknown",
]);

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Import

export interface ImportOptions {
  datasetDir: string;
  /** Model that drafts the truth. Not called (and not required) in a dry run. */
  model?: LanguageModel;
  /** Recorded as `_review.source` of the drafts. */
  modelName: string;
  dryRun?: boolean;
  concurrency?: number;
  /** OCR adapter for images and scanned PDF pages (omit to fail on them). */
  ocr?: OcrAdapter;
  /** "Today" for relative dates; defaults to now. */
  referenceDate?: Date;
  /** Progress output; defaults to stderr. */
  log?: (line: string) => void;
}

export type ImportStatus = "imported" | "dry-run" | "failed" | "truth-exists";

export interface ImportedFile {
  originalName: string;
  id?: string;
  status: ImportStatus;
  format?: DatasetFormat;
  layout?: DatasetLayout;
  language?: ManifestLanguage;
  source: ImportSource;
  error?: string;
  /** Seconds spent in the model call. */
  seconds?: number;
  /** Number of parse warnings recorded in the draft. */
  warnings?: number;
  /** Set when the text does not read as a CV (see {@link notCvReason}); the entry is tagged. */
  suspect?: string;
}

async function readManifest(path: string): Promise<PrivateDatasetEntry[]> {
  if (!existsSync(path)) return [];
  return JSON.parse(await readFile(path, "utf8")) as PrivateDatasetEntry[];
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  return results;
}

interface Planned {
  originalName: string;
  path: string;
  data: Uint8Array;
  parsed: ParsedInboxName;
  id: string;
  format: DatasetFormat;
  ext: string;
  acquired: string;
}

/**
 * Imports the inbox. Files whose format is not supported, or whose extraction / model call fails,
 * are left in the inbox untouched and reported as failed; everything else is moved and recorded.
 */
export async function runImport(options: ImportOptions): Promise<ImportedFile[]> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const datasetDir = resolve(options.datasetDir);
  const inboxDir = join(datasetDir, "inbox");
  if (!existsSync(inboxDir)) throw new Error(`Inbox not found: ${inboxDir}`);
  if (!options.dryRun && !options.model) throw new Error("A model is required unless --dry-run.");

  const manifestPath = join(datasetDir, "manifest.json");
  const manifest = await readManifest(manifestPath);
  const allocate = createIdAllocator(manifest.map((e) => e.id));

  const names = (await readdir(inboxDir, { withFileTypes: true }))
    .filter((d) => d.isFile() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  // Plan first (serially) so ids follow file-name order regardless of concurrency.
  const results: ImportedFile[] = [];
  const planned: Planned[] = [];
  for (const originalName of names) {
    const path = join(inboxDir, originalName);
    const parsed = parseInboxName(originalName);
    const data = new Uint8Array(await readFile(path));
    const detected = detectFormat(data, originalName);
    const fmt = datasetFormat(detected, data);
    const reason = fmt
      ? rejectReason(originalName, detected, data)
      : `unsupported format: ${detected}`;
    if (!fmt || reason) {
      results.push({ originalName, source: parsed.source, status: "failed", error: reason });
      continue;
    }
    const acquired = isoDate((await stat(path)).mtime);
    planned.push({
      originalName,
      path,
      data,
      parsed,
      id: allocate(idPrefix(parsed.source, parsed.cc)),
      format: fmt.format,
      ext: fmt.ext,
      acquired,
    });
  }

  if (!options.dryRun) {
    for (const dir of ["files", "text", "truth"])
      await mkdir(join(datasetDir, dir), { recursive: true });
  }

  // Manifest writes are serialized so concurrent imports never clobber each other.
  let manifestLock: Promise<void> = Promise.resolve();
  const appendEntry = (entry: PrivateDatasetEntry): Promise<void> => {
    manifestLock = manifestLock.then(async () => {
      manifest.push(entry);
      manifest.sort((a, b) => a.id.localeCompare(b.id));
      await writeJson(manifestPath, manifest);
    });
    return manifestLock;
  };

  const referenceDate = options.referenceDate ?? new Date();
  const imported = await mapPool(planned, options.concurrency ?? 1, async (item, index) => {
    const prefix = `[${index + 1}/${planned.length}] ${item.id}`;
    const base: ImportedFile = {
      originalName: item.originalName,
      id: item.id,
      source: item.parsed.source,
      format: item.format,
      status: "failed",
    };
    try {
      log(`${prefix} ${item.originalName}: extracting (${item.format})`);
      const doc = await extractText(
        { data: item.data, filename: item.originalName },
        options.ocr ? { ocr: options.ocr } : {},
      );
      const layout = manifestLayout(doc);
      const language = detectManifestLanguage(doc.text);
      Object.assign(base, { layout, language });
      const suspect = notCvReason(doc.text);
      if (suspect) {
        base.suspect = suspect;
        log(
          `${prefix} WARNING: does not look like a CV (${suspect}); tagged "${SUSPECT_NOT_CV_TAG}"`,
        );
      }
      if (options.dryRun) return { ...base, status: "dry-run" as const };

      await writeFile(join(datasetDir, "text", `${item.id}.txt`), doc.text);

      const truthRel = `truth/${item.id}.json`;
      const truthPath = join(datasetDir, truthRel);
      let status: ImportStatus = "imported";
      if (existsSync(truthPath)) {
        log(`${prefix} truth exists, not overwritten: ${truthRel}`);
        status = "truth-exists";
      } else {
        log(`${prefix} drafting truth with ${options.modelName}`);
        const t0 = performance.now();
        const result = await parseResume(doc.text, {
          model: options.model as LanguageModel,
          language: parseLanguageFor(language),
          temperature: 0,
          referenceDate,
          maxRetries: 1,
        });
        base.seconds = Math.round((performance.now() - t0) / 100) / 10;
        const warnings = [
          ...(suspect
            ? [`import: does not look like a CV (${suspect}); review before scoring`]
            : []),
          ...doc.warnings.map((w) => `extract: ${w}`),
          ...result.warnings,
        ];
        base.warnings = warnings.length;
        await writeJson(
          truthPath,
          toDraftTruth(result.resume, { status: "draft", source: options.modelName, warnings }),
        );
      }

      const fileRel = `files/${item.id}.${item.ext}`;
      await rename(item.path, join(datasetDir, fileRel));
      const real = REAL_SOURCES.has(item.parsed.source);
      const tags = [...(real ? ["real"] : []), item.parsed.source];
      if (layout === "scanned") tags.push("ocr");
      if (layout === "two-column") tags.push("two-columns");
      if (suspect) tags.push(SUSPECT_NOT_CV_TAG);
      await appendEntry({
        id: item.id,
        country: item.parsed.cc.toUpperCase(),
        language,
        layout,
        format: item.format,
        file: fileRel,
        truth: truthRel,
        dateStyles: [],
        tags,
        source: item.parsed.source,
        pii: real,
        acquired: item.acquired,
        originalName: item.originalName,
      });
      log(`${prefix} ${status}${base.seconds !== undefined ? ` (${base.seconds}s)` : ""}`);
      return { ...base, status };
    } catch (error) {
      const message = errorMessage(error);
      log(`${prefix} FAILED: ${message}`);
      return { ...base, status: "failed" as const, error: message };
    }
  });

  return [...results, ...imported].sort((a, b) => a.originalName.localeCompare(b.originalName));
}

// ---------------------------------------------------------------------------------------------
// CLI

export interface ImportCliOptions {
  datasetDir: string;
  provider: CliProvider;
  model: string;
  baseUrl: string | undefined;
  apiKey: string | undefined;
  concurrency: number;
  dryRun: boolean;
}

/** Parses CLI arguments. Returns `null` for `--help`. */
export function parseImportArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): ImportCliOptions | null {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    options: {
      dataset: { type: "string" },
      provider: { type: "string", default: "ollama" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "api-key": { type: "string" },
      concurrency: { type: "string", default: "1" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return null;
  const provider = values.provider as CliProvider;
  if (!CLI_PROVIDERS.includes(provider)) {
    throw new Error(`--provider must be one of: ${CLI_PROVIDERS.join(", ")}.`);
  }
  const model = values.model ?? DEFAULT_MODELS[provider];
  if (!model && !values["dry-run"])
    throw new Error(`--model is required for provider "${provider}".`);
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer.");
  }
  return {
    datasetDir: resolve(values.dataset ?? join(EVAL_DIR, "private")),
    provider,
    model: model ?? "",
    baseUrl: values["base-url"],
    apiKey:
      values["api-key"] ??
      env.CVPARSE_API_KEY ??
      (provider === "openai" ? env.OPENAI_API_KEY : undefined),
    concurrency,
    dryRun: values["dry-run"],
  };
}

/** Plain-text table of what happened to each inbox file. */
export function formatImportSummary(files: readonly ImportedFile[]): string {
  const rows = files.map((f) => [
    f.id ?? "-",
    f.originalName,
    f.format ?? "-",
    f.layout ?? "-",
    f.language ?? "-",
    f.status + (f.error ? ` (${f.error})` : "") + (f.suspect ? ` [${SUSPECT_NOT_CV_TAG}]` : ""),
  ]);
  const header = ["id", "original name", "format", "layout", "language", "status"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ");
  const counts = {
    imported: files.filter((f) => f.status === "imported").length,
    drafts: files.filter((f) => f.status === "imported" && f.warnings !== undefined).length,
    failed: files.filter((f) => f.status === "failed").length,
  };
  return [
    line(header),
    ...rows.map(line),
    "",
    `${files.length} files: ${counts.imported} imported (${counts.drafts} draft truths), ${counts.failed} failed`,
  ].join("\n");
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: ImportCliOptions | null;
  try {
    options = parseImportArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (!options) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let model: LanguageModel | undefined;
  if (!options.dryRun) {
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URLS[options.provider];
    if (!baseUrl) throw new Error(`--base-url is required for provider "${options.provider}".`);
    model = createCliModel({
      provider: options.provider,
      model: options.model,
      baseUrl,
      apiKey: options.apiKey,
    });
  }
  const { createTesseractAdapter } = await import("../../src/ocr/tesseract.js");
  const ocr = createTesseractAdapter({
    languages: ["spa", "eng"],
    cachePath: tesseractCacheDir(),
  });

  const started = performance.now();
  try {
    const files = await runImport({
      datasetDir: options.datasetDir,
      model,
      modelName: options.model || "none",
      dryRun: options.dryRun,
      concurrency: options.concurrency,
      ocr,
    });
    const total = ((performance.now() - started) / 1000).toFixed(1);
    process.stdout.write(`${formatImportSummary(files)}\ntotal time: ${total}s\n`);
    return files.some((f) => f.status === "failed") ? 1 : 0;
  } finally {
    await ocr.dispose?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
