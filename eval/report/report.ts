/**
 * Benchmark report: renders eval/results/*.json as markdown tables and splices them into the
 * READMEs between `<!-- eval:results:start -->` and `<!-- eval:results:end -->`.
 *
 * Only results covering the full dataset manifest are reported; subset runs live in
 * eval/results/partial/ and are ignored. Aggregates are recomputed from the per-CV scores so
 * every system is summarized with the same rules (common-field overall, skipped formats).
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type SliceScore, sliceScores } from "../run/runner.js";
import { aggregate, COMMON_FIELDS } from "../score/index.js";
import type { DatasetEntry, DatasetFormat, RunResult, ScoredField } from "../types.js";

export const START_MARKER = "<!-- eval:results:start -->";
export const END_MARKER = "<!-- eval:results:end -->";

export type ReportLanguage = "en" | "es";

/** RunResult as written by the runner (with coverage and per-layout/format slices). */
export type ReportResult = RunResult & {
  attempted?: number;
  byLayout?: Record<string, SliceScore>;
  byFormat?: Partial<Record<DatasetFormat, SliceScore>>;
  totalSeconds?: number;
};

/** Field columns of the main table: every field common to all systems. */
export const MAIN_FIELDS: readonly ScoredField[] = COMMON_FIELDS;

/** Shown for systems without a recorded command (older result files). */
export const DEFAULT_COMMAND =
  "npm run eval -- --system cvparse --provider ollama --model llama3.1 --ocr tesseract";

/** `SystemInfo.details` keys left out of the Setup list (shown elsewhere or cvparse-internal). */
const SETUP_HIDDEN = new Set(["command"]);
/** Keys describing the cvparse checkout; not printed next to baselines. */
const CVPARSE_KEYS = new Set(["cvparseCommit", "cvparseSrcHash"]);

const TEXT = {
  en: {
    columns: {
      "basics.name": "Name",
      "basics.email": "Email",
      "basics.phone": "Phone",
      "basics.location": "Location",
      "work.entries": "Work entries",
      "work.dates": "Work dates",
      "education.entries": "Education",
      "education.dates": "Education dates",
      "education.level": "Education level",
      skills: "Skills",
      languages: "Languages",
    } as Record<ScoredField, string>,
    system: "System",
    coverage: "Coverage",
    overall: "Overall",
    pdfOnly: (n: number) => `PDF only (${n})`,
    layout: "Layout",
    field: "Field",
    fieldF1: "Field-level F1 (%)",
    byLayout: "Overall F1 by layout (%)",
    levelTitle: "cvparse-only diagnostic: education level",
    detail: (name: string) => `Precision / recall: ${name} (%)`,
    caveats: (pdf: number, link: string) =>
      `**Read this first.** The dataset and the scorer were written by the cvparse authors, so this is an in-distribution benchmark, not an independent one: the date styles and the degree vocabulary are the ones cvparse's normalizers were built for. Both baselines detect sections by English headings and these CVs use Spanish ones; that is the gap the benchmark is meant to show, but it also means the baselines lose most sections by design. resume-parser is fed the text cvparse extracts (its own reader needs poppler), so it inherits cvparse's reading order. open-resume reads only PDFs: **Coverage** says how many CVs each system attempted, and **PDF only** compares every system on the same ${pdf} PDF inputs. More in the [dataset card](${link}dataset/README.md#who-made-this-and-known-biases).`,
    dataset: (versions: string, cvs: string) =>
      `Dataset ${versions}, ${cvs} synthetic Spanish CVs.`,
    overallNote: (link: string) =>
      `Overall is the mean F1 over the ${MAIN_FIELDS.length} fields above, computed on the CVs a system attempted (formats it cannot read are skipped, not scored as zero, and show up in Coverage). Scoring rules: [eval/score/README.md](${link}score/README.md).`,
    levelNote:
      "Not part of Overall. The dataset's degree vocabulary was written alongside cvparse's degree normalizer, so this is not an independent measure; baselines do not produce education levels.",
    na: "n/a",
    setup: "Setup",
    reproduce: "Reproduce (then `npm run eval:report`):",
    placeholder: `No benchmark results yet. Run \`${DEFAULT_COMMAND}\`, then \`npm run eval:report\`.`,
    failed: (n: number) => `${n} failed`,
    cvsIn: (n: number, s: number) => `${n} CVs in ${s} s`,
  },
  es: {
    columns: {
      "basics.name": "Nombre",
      "basics.email": "Email",
      "basics.phone": "Teléfono",
      "basics.location": "Ubicación",
      "work.entries": "Experiencia",
      "work.dates": "Fechas exp.",
      "education.entries": "Educación",
      "education.dates": "Fechas educ.",
      "education.level": "Nivel educ.",
      skills: "Habilidades",
      languages: "Idiomas",
    } as Record<ScoredField, string>,
    system: "Sistema",
    coverage: "Cobertura",
    overall: "Global",
    pdfOnly: (n: number) => `Solo PDF (${n})`,
    layout: "Diseño",
    field: "Campo",
    fieldF1: "F1 por campo (%)",
    byLayout: "F1 global por diseño (%)",
    levelTitle: "Diagnóstico solo de cvparse: nivel educativo",
    detail: (name: string) => `Precisión / exhaustividad: ${name} (%)`,
    caveats: (pdf: number, link: string) =>
      `**Antes de leer la tabla.** El dataset y el evaluador los escribieron los autores de cvparse, así que es un benchmark dentro de distribución, no independiente: los formatos de fecha y el vocabulario de títulos son los que los normalizadores de cvparse ya contemplan. Los dos baselines detectan secciones por encabezados en inglés y estos CVs los tienen en español; esa es la brecha que el benchmark quiere mostrar, pero también significa que los baselines pierden la mayoría de las secciones por diseño. resume-parser recibe el texto que extrae cvparse (su lector propio necesita poppler), así que hereda el orden de lectura de cvparse. open-resume solo lee PDF: **Cobertura** indica cuántos CVs intentó cada sistema y **Solo PDF** compara a todos sobre los mismos ${pdf} PDF. Más detalles en la [ficha del dataset](${link}dataset/README.md#who-made-this-and-known-biases).`,
    dataset: (versions: string, cvs: string) =>
      `Dataset ${versions}, ${cvs} CVs sintéticos en español.`,
    overallNote: (link: string) =>
      `Global es el promedio de F1 sobre los ${MAIN_FIELDS.length} campos de la tabla, calculado sobre los CVs que cada sistema intentó (los formatos que no puede leer se omiten en vez de contar como cero, y se ven en Cobertura). Reglas de puntuación: [eval/score/README.md](${link}score/README.md).`,
    levelNote:
      "No forma parte de Global. El vocabulario de títulos del dataset se escribió junto con el normalizador de títulos de cvparse, así que no es una medida independiente; los baselines no producen niveles educativos.",
    na: "n/a",
    setup: "Configuración",
    reproduce: "Reproducir (y luego `npm run eval:report`):",
    placeholder: `Todavía no hay resultados del benchmark. Para generarlos: \`${DEFAULT_COMMAND}\` y luego \`npm run eval:report\`.`,
    failed: (n: number) => `${n} con error`,
    cvsIn: (n: number, s: number) => `${n} CVs en ${s} s`,
  },
} as const;

const pct = (value: number | null | undefined, na = "–") =>
  value === undefined || value === null ? na : (value * 100).toFixed(1);

function row(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function table(header: string[], rows: string[][], align?: string[]): string {
  return [row(header), row(align ?? header.map(() => "---")), ...rows.map(row)].join("\n");
}

/** Systems sorted by overall F1, best first; ties by name. */
export function sortResults(results: readonly ReportResult[]): ReportResult[] {
  return [...results].sort(
    (a, b) => b.overallF1 - a.overallF1 || a.system.name.localeCompare(b.system.name),
  );
}

function failures(result: ReportResult): number {
  return result.entries.filter((e) => !e.ok && !e.skipped).length;
}

function attempted(result: ReportResult): number {
  return result.attempted ?? result.entries.filter((e) => !e.skipped).length;
}

function systemCell(result: ReportResult, lang: ReportLanguage): string {
  const failed = failures(result);
  return failed > 0 ? `${result.system.name} (${TEXT[lang].failed(failed)})` : result.system.name;
}

function pdfCount(results: readonly ReportResult[]): number {
  return Math.max(0, ...results.map((r) => r.byFormat?.pdf?.entries ?? 0));
}

function mainTable(results: readonly ReportResult[], lang: ReportLanguage): string {
  const t = TEXT[lang];
  const pdf = pdfCount(results);
  const header = [
    t.system,
    t.coverage,
    t.overall,
    ...(pdf > 0 ? [t.pdfOnly(pdf)] : []),
    ...MAIN_FIELDS.map((f) => t.columns[f]),
  ];
  const align = [
    "---",
    "---:",
    "---:",
    ...(pdf > 0 ? ["---:"] : []),
    ...MAIN_FIELDS.map(() => "---:"),
  ];
  return table(
    header,
    results.map((r) => [
      systemCell(r, lang),
      `${attempted(r)}/${r.entries.length}`,
      `**${pct(r.overallF1)}**`,
      ...(pdf > 0 ? [pct(r.byFormat?.pdf?.overallF1, t.na)] : []),
      ...MAIN_FIELDS.map((f) => pct(r.fields[f]?.f1)),
    ]),
    align,
  );
}

function levelTable(results: readonly ReportResult[], lang: ReportLanguage): string | null {
  const withLevel = results.filter(
    (r) => r.system.kind === "cvparse" && r.fields["education.level"],
  );
  if (withLevel.length === 0) return null;
  const t = TEXT[lang];
  return table(
    [t.system, `${t.columns["education.level"]} F1`, "P", "R", "support"],
    withLevel.map((r) => {
      const s = r.fields["education.level"];
      return [
        r.system.name,
        pct(s?.f1),
        pct(s?.precision),
        pct(s?.recall),
        String(s?.support ?? 0),
      ];
    }),
    ["---", "---:", "---:", "---:", "---:"],
  );
}

function layoutTable(results: readonly ReportResult[], lang: ReportLanguage): string | null {
  const layouts = [...new Set(results.flatMap((r) => Object.keys(r.byLayout ?? {})))].sort();
  if (layouts.length === 0) return null;
  const t = TEXT[lang];
  const counts = new Map<string, number>();
  for (const r of results)
    for (const [layout, s] of Object.entries(r.byLayout ?? {}))
      counts.set(layout, Math.max(counts.get(layout) ?? 0, s.entries));
  return table(
    [t.layout, ...results.map((r) => r.system.name)],
    layouts.map((layout) => [
      `${layout} (${counts.get(layout) ?? 0})`,
      ...results.map((r) => {
        const s = r.byLayout?.[layout];
        if (!s) return "–";
        return s.attempted === 0 || s.overallF1 === null ? t.na : pct(s.overallF1);
      }),
    ]),
    ["---", ...results.map(() => "---:")],
  );
}

function detailTable(result: ReportResult, lang: ReportLanguage): string {
  const t = TEXT[lang];
  const fields = [...MAIN_FIELDS, "education.level" as const].filter((f) => result.fields[f]);
  return table(
    [t.field, "P", "R", "F1", "support"],
    fields.map((f) => {
      const s = result.fields[f];
      return [t.columns[f], pct(s?.precision), pct(s?.recall), pct(s?.f1), String(s?.support ?? 0)];
    }),
    ["---", "---:", "---:", "---:", "---:"],
  );
}

function setupList(results: readonly ReportResult[], lang: ReportLanguage): string {
  const t = TEXT[lang];
  return results
    .map((r) => {
      const isCvparse = r.system.kind === "cvparse";
      const details = Object.entries(r.system.details)
        .filter(([k]) => !SETUP_HIDDEN.has(k) && (isCvparse || !CVPARSE_KEYS.has(k)))
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      const time =
        r.totalSeconds !== undefined
          ? `; ${t.cvsIn(attempted(r), Math.round(r.totalSeconds))}`
          : "";
      // Baselines carry their own version/commit in details; the cvparse version is cvparse's.
      const head = isCvparse ? `cvparse ${r.cvparseVersion}` : "";
      const body = [head, details].filter(Boolean).join("; ");
      return `- **${r.system.name}**: ${body}${time}`;
    })
    .join("\n");
}

function reproduceList(results: readonly ReportResult[]): string {
  return results
    .map((r) => `- ${r.system.name}: \`${r.system.details.command ?? DEFAULT_COMMAND}\``)
    .join("\n");
}

export interface RenderOptions {
  /** Add a precision/recall table per system (used for eval/results/README.md). */
  allFields?: boolean;
  /** Relative path from the rendered file to eval/ (default `eval/`, from the repo root). */
  evalLink?: string;
  /** Heading level prefix for subsections, e.g. "###". */
  heading?: string;
}

/** Renders the benchmark markdown block (without markers). */
export function renderReport(
  input: readonly ReportResult[],
  lang: ReportLanguage,
  options: RenderOptions = {},
): string {
  const t = TEXT[lang];
  if (input.length === 0) return t.placeholder;
  const h = options.heading ?? "###";
  const link = options.evalLink ?? "eval/";
  const results = sortResults(input);
  const versions = [...new Set(results.map((r) => r.datasetVersion))].join(", ");
  const sizes = [...new Set(results.map((r) => String(r.entries.length)))].join("/");

  const parts: string[] = [t.caveats(pdfCount(results), link), "", t.dataset(versions, sizes)];
  parts.push("", `${h} ${t.fieldF1}`, "", mainTable(results, lang), "", t.overallNote(link));
  const level = levelTable(results, lang);
  if (level) parts.push("", `${h} ${t.levelTitle}`, "", level, "", t.levelNote);
  const layouts = layoutTable(results, lang);
  if (layouts) parts.push("", `${h} ${t.byLayout}`, "", layouts);
  if (options.allFields) {
    for (const r of results)
      parts.push("", `${h} ${t.detail(r.system.name)}`, "", detailTable(r, lang));
  }
  parts.push("", `${h} ${t.setup}`, "", setupList(results, lang));
  parts.push("", t.reproduce, "", reproduceList(results));
  return parts.join("\n");
}

/**
 * Replaces the content between the markers with `block`. Idempotent. Throws when the markers
 * are missing or out of order.
 */
export function replaceBetweenMarkers(content: string, block: string): string {
  const start = content.indexOf(START_MARKER);
  const end = content.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Markers ${START_MARKER} / ${END_MARKER} not found (or out of order).`);
  }
  return `${content.slice(0, start + START_MARKER.length)}\n\n${block.trim()}\n\n${content.slice(end)}`;
}

/**
 * Normalizes a stored result with the current rules: marks "unsupported format" failures from
 * older files as skipped, recomputes field aggregates and the common-field overall, and, when
 * the manifest is given, coverage and per-layout / per-format slices.
 */
export function normalizeResult(
  result: ReportResult,
  manifest?: readonly DatasetEntry[],
): ReportResult {
  const entries = result.entries.map((e) =>
    !e.skipped && !e.ok && e.error?.startsWith("unsupported format")
      ? { ...e, skipped: "unsupported-format" as const, fields: {} }
      : e,
  );
  const { fields, overallF1 } = aggregate(entries);
  const out: ReportResult = {
    ...result,
    entries,
    fields,
    overallF1,
    attempted: entries.filter((e) => !e.skipped).length,
  };
  if (manifest) {
    const byId = new Map(manifest.map((m) => [m.id, m]));
    const scored = entries.flatMap((score) => {
      const entry = byId.get(score.id);
      return entry ? [{ entry, score }] : [];
    });
    out.byLayout = sliceScores(scored, (e) => e.layout);
    out.byFormat = sliceScores(scored, (e) => e.format);
  }
  return out;
}

/** Ids of `manifest` missing from `result`, i.e. why a result is partial. */
function missingIds(result: ReportResult, manifest: readonly DatasetEntry[]): string[] {
  const have = new Set(result.entries.map((e) => e.id));
  return manifest.filter((m) => !have.has(m.id)).map((m) => m.id);
}

/**
 * Reads every RunResult in `resultsDir` (`*.json`, not subdirectories such as `partial/`).
 * With a manifest, results that do not cover every manifest entry are ignored (reported via
 * `warn`). Aggregates are recomputed with {@link normalizeResult}.
 */
export async function loadResults(
  resultsDir: string,
  manifest?: readonly DatasetEntry[],
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<ReportResult[]> {
  if (!existsSync(resultsDir)) return [];
  const files = (await readdir(resultsDir, { withFileTypes: true }))
    .filter((f) => f.isFile() && f.name.endsWith(".json"))
    .map((f) => f.name)
    .sort();
  const results: ReportResult[] = [];
  for (const file of files) {
    const result = JSON.parse(await readFile(join(resultsDir, file), "utf8")) as ReportResult;
    if (!result?.system || !Array.isArray(result.entries)) continue;
    if (manifest) {
      const missing = missingIds(result, manifest);
      if (missing.length > 0) {
        warn(
          `ignoring ${file}: covers ${manifest.length - missing.length}/${manifest.length} dataset CVs (subset runs belong in partial/)`,
        );
        continue;
      }
    }
    results.push(normalizeResult(result, manifest));
  }
  return results;
}

export interface GenerateOptions {
  resultsDir: string;
  /** Dataset directory with manifest.json; results not covering it are ignored. */
  datasetDir?: string;
  /** READMEs to update, with their language. Missing files are skipped. */
  readmes: { path: string; lang: ReportLanguage }[];
  warn?: (line: string) => void;
}

/** Regenerates eval/results/README.md and the README marker blocks. Returns written paths. */
export async function generateReport(options: GenerateOptions): Promise<string[]> {
  const manifestPath = options.datasetDir ? join(options.datasetDir, "manifest.json") : undefined;
  const manifest =
    manifestPath && existsSync(manifestPath)
      ? (JSON.parse(await readFile(manifestPath, "utf8")) as DatasetEntry[])
      : undefined;
  const results = await loadResults(options.resultsDir, manifest, options.warn);
  const written: string[] = [];
  for (const { path, lang } of options.readmes) {
    if (!existsSync(path)) continue;
    const before = await readFile(path, "utf8");
    const after = replaceBetweenMarkers(before, renderReport(results, lang));
    if (after !== before) await writeFile(path, after);
    written.push(path);
  }
  const resultsReadme = join(options.resultsDir, "README.md");
  if (existsSync(options.resultsDir)) {
    const body = renderReport(results, "en", { allFields: true, heading: "##", evalLink: "../" });
    await writeFile(
      resultsReadme,
      `# Benchmark results\n\nGenerated by \`npm run eval:report\` from the JSON files in this directory (full-dataset runs only; subset runs in \`partial/\` are ignored). Do not edit by hand.\n\n${body}\n`,
    );
    written.push(resultsReadme);
  }
  return written;
}
