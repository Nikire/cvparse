/**
 * Evaluation runner: runs an {@link EvalSystem} over the dataset, caches predictions, scores
 * them against the ground truth and writes a {@link RunResult}.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, SCORED_FIELDS, scoreEntry } from "../score/index.js";
import type {
  DatasetEntry,
  DatasetFormat,
  EntryScore,
  EvalSystem,
  GroundTruth,
  Prediction,
  RunResult,
  ScoredField,
} from "../types.js";

export const EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(EVAL_DIR, "..");

/**
 * `SystemInfo.details` keys that are informational and excluded from the prediction cache key
 * (they do not change predictions).
 */
export const CACHE_IGNORED_DETAILS = new Set(["hardware", "notes", "command", "node"]);

/** Aggregate over a slice of the dataset (a layout or a format). */
export interface SliceScore {
  /** CVs in the slice. */
  entries: number;
  /** CVs the system attempted (not skipped for format). */
  attempted: number;
  /** Overall F1 over the attempted CVs; null when none was attempted. */
  overallF1: number | null;
}

/** What the runner writes: the {@link RunResult} contract plus coverage and slices. */
export type RunResultFile = RunResult & {
  /** CVs attempted (not skipped for format) out of `entries.length`. */
  attempted?: number;
  byLayout?: Record<string, SliceScore>;
  byFormat?: Partial<Record<DatasetFormat, SliceScore>>;
  totalSeconds?: number;
};

/** Per-slice aggregate of entry scores; `key` picks the slice of each entry. */
export function sliceScores(
  scored: readonly { entry: DatasetEntry; score: EntryScore }[],
  key: (entry: DatasetEntry) => string,
): Record<string, SliceScore> {
  const out: Record<string, SliceScore> = {};
  for (const k of [...new Set(scored.map((s) => key(s.entry)))].sort()) {
    const subset = scored.filter((s) => key(s.entry) === k).map((s) => s.score);
    const attempted = subset.filter((s) => !s.skipped);
    out[k] = {
      entries: subset.length,
      attempted: attempted.length,
      overallF1: attempted.length === 0 ? null : aggregate(attempted).overallF1,
    };
  }
  return out;
}

const sha256 = () => createHash("sha256");

/** File text with CRLF normalized to LF, so hashes match across git autocrlf settings. */
async function readText(path: string): Promise<string> {
  return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
}

/** sha256 (first 16 hex) of the manifest and every truth file it references. */
export async function hashDataset(
  datasetDir: string,
  entries: readonly DatasetEntry[],
): Promise<string> {
  const hash = sha256();
  hash.update(await readText(join(datasetDir, "manifest.json")));
  for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`\0${entry.truth}\0`);
    hash.update(await readText(join(datasetDir, entry.truth)));
  }
  return hash.digest("hex").slice(0, 16);
}

/** sha256 (first 16 hex) of every `*.ts` under `dir` (paths + contents, sorted, CRLF→LF). */
export async function hashSources(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".ts")) files.push(relative(dir, full).replace(/\\/g, "/"));
    }
  };
  if (existsSync(dir)) await walk(dir);
  const hash = sha256();
  for (const file of files.sort()) {
    hash.update(`\0${file}\0`);
    hash.update(await readText(join(dir, file)));
  }
  return hash.digest("hex").slice(0, 16);
}

/** `git rev-parse HEAD` of the repo (read-only), or "unknown". */
export function gitCommit(cwd = REPO_DIR): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Provenance that makes a cached prediction valid: dataset and cvparse source identity. */
export interface Provenance {
  datasetVersion: string;
  datasetHash: string;
  cvparseCommit: string;
  cvparseSrcHash: string;
}

/**
 * Prediction cache key: system kind, details (minus display-only ones such as hardware and the
 * command line) and provenance. Any change to the dataset truth, the cvparse sources or commit,
 * the model (id or digest), temperature or referenceDate invalidates cached predictions.
 */
export function cacheKey(
  system: EvalSystem,
  cvparseVersion: string,
  provenance: Provenance,
): string {
  const details = Object.fromEntries(
    Object.entries(system.info.details)
      .filter(([k]) => !CACHE_IGNORED_DETAILS.has(k) && !(k in provenance))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify({ kind: system.info.kind, details, cvparseVersion, ...provenance });
}

export interface RunOptions {
  /** Dataset directory containing manifest.json, VERSION, files/ and truth/. */
  datasetDir: string;
  /** Where `<slug>.json` is written. */
  resultsDir: string;
  /** Prediction cache root; predictions go to `<cacheDir>/<slug>/<id>.json`. */
  cacheDir: string;
  /** Read and write the prediction cache. */
  cache: boolean;
  /** cvparse `src/` directory hashed into the cache key (default: <repo>/src). */
  srcDir?: string;
  /** Git commit recorded and keyed (default: `git rev-parse HEAD`). */
  commit?: string;
  /** Only the first N entries (after `only`). Subset runs are written to `<resultsDir>/partial/`. */
  limit?: number;
  /** Restrict to these entry ids. */
  only?: readonly string[];
  concurrency: number;
  /** Version of cvparse recorded in the result and in the cache key. */
  cvparseVersion: string;
  /** Overrides the file slug (default: slug of `system.info.name`). */
  slug?: string;
  /** Progress output; defaults to stderr. Pass a no-op in tests. */
  log?: (line: string) => void;
}

/** Lowercase file-name-safe slug: "cvparse + llama3.1 (ollama)" → "cvparse-llama3.1-ollama". */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "system"
  );
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function loadDataset(
  datasetDir: string,
): Promise<{ entries: DatasetEntry[]; version: string }> {
  const manifestPath = join(datasetDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Dataset manifest not found: ${manifestPath}`);
  }
  const entries = await readJson<DatasetEntry[]>(manifestPath);
  const versionPath = join(datasetDir, "VERSION");
  const version = existsSync(versionPath)
    ? (await readFile(versionPath, "utf8")).trim() || "unknown"
    : "unknown";
  return { entries, version };
}

/** Keeps only the fields the scorer reads (incl. certificates), so cached predictions stay small. */
export function toGroundTruth(resume: Prediction): Prediction {
  const out: Prediction = {};
  if (resume.basics) out.basics = resume.basics;
  if (resume.work) out.work = resume.work;
  if (resume.education) out.education = resume.education;
  if (resume.skills) out.skills = resume.skills;
  if (resume.languages) out.languages = resume.languages;
  if (resume.certificates) out.certificates = resume.certificates;
  const ext = resume.x_cvparse;
  if (ext) {
    out.x_cvparse = {};
    if (ext.educationLevels) out.x_cvparse.educationLevels = ext.educationLevels;
    if (ext.location) out.x_cvparse.location = ext.location;
  }
  return out;
}

interface CacheRecord {
  key: string;
  seconds: number;
  prediction: Prediction;
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

/**
 * Runs `system` over the dataset and writes `<resultsDir>/<slug>.json`, or
 * `<resultsDir>/partial/<slug>.json` for a subset run (`only` / `limit`), so a subset never
 * overwrites a published full-dataset result. Adds provenance to `system.info.details`.
 */
export async function runEval(
  system: EvalSystem,
  options: RunOptions,
): Promise<{ result: RunResultFile; path: string }> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { entries: all, version: datasetVersion } = await loadDataset(options.datasetDir);
  let entries = all;
  if (options.only && options.only.length > 0) {
    const wanted = new Set(options.only);
    entries = entries.filter((e) => wanted.has(e.id));
    const missing = [...wanted].filter((id) => !all.some((e) => e.id === id));
    if (missing.length > 0) log(`warning: unknown dataset ids: ${missing.join(", ")}`);
  }
  if (options.limit !== undefined) entries = entries.slice(0, options.limit);
  const ids = new Set(entries.map((e) => e.id));
  const partial = all.some((e) => !ids.has(e.id));

  const provenance: Provenance = {
    datasetVersion,
    datasetHash: await hashDataset(options.datasetDir, all),
    cvparseCommit: options.commit ?? gitCommit(),
    cvparseSrcHash: await hashSources(options.srcDir ?? join(REPO_DIR, "src")),
  };
  Object.assign(system.info.details, provenance);
  const key = cacheKey(system, options.cvparseVersion, provenance);

  const slug = options.slug ?? slugify(system.info.name);
  const cacheDir = join(options.cacheDir, slug);
  const scoreLevel = system.info.kind === "cvparse";
  const started = performance.now();

  const scored = await mapPool(entries, options.concurrency, async (entry, index) => {
    const prefix = `[${index + 1}/${entries.length}] ${entry.id}`;
    const truth = await readJson<GroundTruth>(join(options.datasetDir, entry.truth));
    const cachePath = join(cacheDir, `${entry.id}.json`);
    let prediction: Prediction | null = null;
    let seconds: number | undefined;
    let error: string | undefined;
    let cached = false;

    if (!system.supports.includes(entry.format)) {
      const score: EntryScore = {
        id: entry.id,
        ok: false,
        error: `unsupported format: ${entry.format}`,
        skipped: "unsupported-format",
        fields: {},
      };
      log(`${prefix} SKIPPED (unsupported format: ${entry.format})`);
      return { entry, score };
    }

    if (options.cache && existsSync(cachePath)) {
      try {
        const record = await readJson<CacheRecord>(cachePath);
        if (record.key === key) {
          prediction = record.prediction;
          seconds = record.seconds;
          cached = true;
        }
      } catch {
        // corrupt cache entry: recompute
      }
    }

    if (!cached) {
      const t0 = performance.now();
      try {
        const raw = await system.predict(join(options.datasetDir, entry.file), entry);
        prediction = toGroundTruth(raw);
        seconds = (performance.now() - t0) / 1000;
        if (options.cache) {
          await mkdir(cacheDir, { recursive: true });
          const record: CacheRecord = { key, seconds, prediction };
          await writeFile(cachePath, `${JSON.stringify(record, null, 2)}\n`);
        }
      } catch (e) {
        seconds = (performance.now() - t0) / 1000;
        error = errorMessage(e);
      }
    }

    const fields = scoreEntry(truth, prediction, { educationLevel: scoreLevel });
    const score: EntryScore = { id: entry.id, ok: error === undefined, fields };
    if (error !== undefined) score.error = error;
    if (seconds !== undefined) score.seconds = Math.round(seconds * 1000) / 1000;
    const f1 = aggregate([score]).overallF1;
    log(
      `${prefix} ${error ? `FAILED (${error})` : `F1 ${f1.toFixed(3)}`}${cached ? " (cached)" : seconds !== undefined ? ` ${seconds.toFixed(1)}s` : ""}`,
    );
    return { entry, score };
  });

  const totalSeconds = (performance.now() - started) / 1000;
  const entryScores = scored.map((s) => s.score);
  const { fields, overallF1 } = aggregate(entryScores);

  const byLayout = sliceScores(scored, (e) => e.layout);
  const byFormat = sliceScores(scored, (e) => e.format);

  const result: RunResultFile = {
    system: system.info,
    finishedAt: new Date().toISOString(),
    cvparseVersion: options.cvparseVersion,
    datasetVersion,
    entries: entryScores,
    fields,
    overallF1,
    attempted: entryScores.filter((e) => !e.skipped).length,
    byLayout,
    byFormat,
    totalSeconds: Math.round(totalSeconds * 10) / 10,
  };
  const outDir = partial ? join(options.resultsDir, "partial") : options.resultsDir;
  if (partial) log(`subset run (${entries.length}/${all.length} CVs): writing to ${outDir}`);
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, `${slug}.json`);
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
  return { result, path };
}

const pct = (value: number | undefined) =>
  value === undefined ? "  -  " : (value * 100).toFixed(1).padStart(5);

/** Plain-text summary: per-field P/R/F1, per-layout overall F1, failures and total time. */
export function formatSummary(result: RunResultFile): string {
  const lines: string[] = [];
  const failed = result.entries.filter((e) => !e.ok && !e.skipped);
  const skipped = result.entries.filter((e) => e.skipped).length;
  lines.push(`${result.system.name} on dataset ${result.datasetVersion}`);
  lines.push(
    `${result.entries.length} CVs, ${result.entries.length - skipped} attempted, ${failed.length} failed`,
  );
  lines.push("");
  lines.push(
    `${"field".padEnd(20)} ${"P".padStart(5)} ${"R".padStart(5)} ${"F1".padStart(5)} support`,
  );
  for (const field of SCORED_FIELDS as ScoredField[]) {
    const score = result.fields[field];
    if (!score) continue;
    lines.push(
      `${field.padEnd(20)} ${pct(score.precision)} ${pct(score.recall)} ${pct(score.f1)} ${score.support}`,
    );
  }
  lines.push(
    `${"overall (common)".padEnd(20)} ${"".padStart(5)} ${"".padStart(5)} ${pct(result.overallF1)}`,
  );
  for (const [title, slices] of [
    ["layout", result.byLayout],
    ["format", result.byFormat],
  ] as const) {
    if (!slices || Object.keys(slices).length === 0) continue;
    lines.push("");
    lines.push(`${title.padEnd(20)} ${"F1".padStart(5)} attempted/CVs`);
    for (const [name, score] of Object.entries(slices)) {
      if (!score) continue;
      const f1 = score.overallF1 === null ? "  n/a" : pct(score.overallF1);
      lines.push(`${name.padEnd(20)} ${f1} ${score.attempted}/${score.entries}`);
    }
  }
  if (failed.length > 0) {
    lines.push("");
    lines.push("failures:");
    for (const entry of failed) lines.push(`  ${entry.id}: ${entry.error}`);
  }
  if (result.totalSeconds !== undefined) {
    lines.push("");
    lines.push(`total time: ${result.totalSeconds.toFixed(1)}s`);
  }
  return lines.join("\n");
}
