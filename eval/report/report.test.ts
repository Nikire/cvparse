import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatasetEntry, EntryScore } from "../types.js";
import {
  END_MARKER,
  generateReport,
  loadResults,
  normalizeResult,
  type ReportResult,
  renderReport,
  replaceBetweenMarkers,
  START_MARKER,
} from "./report.js";

const counted = (tp: number, fp: number, fn: number) => {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, support: tp + fn, tp, fp, fn };
};

const entry = (id: string, layout: DatasetEntry["layout"], format: DatasetEntry["format"]) =>
  ({
    id,
    country: "AR",
    language: "es",
    layout,
    format,
    file: `files/${id}.${format}`,
    truth: `truth/${id}.json`,
    dateStyles: [],
    tags: [],
  }) satisfies DatasetEntry;

const manifest: DatasetEntry[] = [
  entry("a", "two-column", "pdf"),
  entry("b", "table", "docx"),
  entry("c", "scanned", "image"),
];

const perfect: EntryScore["fields"] = {
  "basics.name": counted(1, 0, 0),
  "work.entries": counted(2, 0, 0),
  "education.level": counted(0, 1, 1),
};
const half: EntryScore["fields"] = {
  "basics.name": counted(1, 0, 0),
  "work.entries": counted(1, 1, 1),
};

const cvparseResult: ReportResult = {
  system: {
    name: "cvparse + llama3.1 (ollama)",
    kind: "cvparse",
    details: {
      model: "llama3.1",
      hardware: "RTX 3060",
      cvparseCommit: "abc1234",
      command: "npm run eval -- --system cvparse --model llama3.1 --ocr tesseract",
    },
  },
  finishedAt: "2026-10-02T00:00:00.000Z",
  cvparseVersion: "0.3.0",
  datasetVersion: "1.0.0",
  entries: [
    { id: "a", ok: true, fields: perfect },
    { id: "b", ok: true, fields: half },
    { id: "c", ok: false, error: "boom", fields: { "basics.name": counted(0, 0, 1) } },
  ],
  fields: {},
  overallF1: 0,
  totalSeconds: 120,
};

const baselineResult: ReportResult = {
  ...cvparseResult,
  system: {
    name: "open-resume (rules)",
    kind: "baseline",
    details: {
      commit: "4f8255a",
      cvparseCommit: "abc1234",
      command: "npm run eval -- --system open-resume",
    },
  },
  entries: [
    { id: "a", ok: true, fields: half },
    // old result files: unsupported formats recorded as plain failures
    {
      id: "b",
      ok: false,
      error: "unsupported format: docx",
      fields: { "basics.name": counted(0, 0, 1) },
    },
    {
      id: "c",
      ok: false,
      error: "unsupported format: image",
      skipped: "unsupported-format",
      fields: {},
    },
  ],
};

const README = `# Title\n\n## Benchmark\n\n${START_MARKER}\n\nplaceholder\n\n${END_MARKER}\n\n## Next\n`;

describe("replaceBetweenMarkers", () => {
  it("replaces only the marked block and is idempotent", () => {
    const once = replaceBetweenMarkers(README, "NEW");
    expect(once).toContain(`${START_MARKER}\n\nNEW\n\n${END_MARKER}`);
    expect(once).toContain("## Next");
    expect(replaceBetweenMarkers(once, "NEW")).toBe(once);
  });

  it("throws without markers", () => {
    expect(() => replaceBetweenMarkers("# nothing", "x")).toThrow(/Markers/);
  });
});

describe("normalizeResult", () => {
  it("treats unsupported-format failures as skipped and recomputes common-field overall", () => {
    const r = normalizeResult(baselineResult, manifest);
    expect(r.entries[1]?.skipped).toBe("unsupported-format");
    expect(r.attempted).toBe(1);
    // only CV "a" is scored: name 1.0, work entries 0.5 → overall 0.75
    expect(r.overallF1).toBeCloseTo(0.75);
    expect(r.byLayout?.table).toEqual({ entries: 1, attempted: 0, overallF1: null });
    expect(r.byFormat?.pdf).toMatchObject({ entries: 1, attempted: 1 });

    const c = normalizeResult(cvparseResult, manifest);
    expect(c.attempted).toBe(3);
    // education.level is scored but not part of overall
    expect(c.fields["education.level"]?.f1).toBe(0);
    expect(c.byFormat?.pdf?.overallF1).toBe(1);
  });
});

describe("renderReport", () => {
  const results = [
    normalizeResult(cvparseResult, manifest),
    normalizeResult(baselineResult, manifest),
  ];

  it("writes a placeholder when there are no results", () => {
    expect(renderReport([], "en")).toMatch(/No benchmark results yet/);
    expect(renderReport([], "es")).toMatch(/Todavía no hay resultados/);
  });

  it("renders coverage, PDF-only, every common field and n/a layouts", () => {
    const md = renderReport(results, "en");
    expect(md).toContain("**Read this first.**");
    expect(md).toContain(
      "| System | Coverage | Overall | PDF only (1) | Name | Email | Phone | Location | Work entries | Work dates | Education | Education dates | Skills | Languages |",
    );
    expect(md).toMatch(/\| open-resume \(rules\) \| 1\/3 \| \*\*75\.0\*\* \| 75\.0 \|/);
    expect(md).toMatch(/\| cvparse \+ llama3\.1 \(ollama\) \(1 failed\) \| 3\/3 \|/);
    // per-layout: open-resume never attempted the table/scanned CVs
    expect(md).toMatch(/\| table \(1\) \| [\d.]+ \| n\/a \|/);
    // education level is a separate cvparse-only diagnostic
    expect(md).toContain("cvparse-only diagnostic: education level");
    expect(md).toContain("not an independent measure");
    // cvparse first (higher overall)
    expect(md.indexOf("| cvparse +")).toBeLessThan(md.indexOf("| open-resume"));
  });

  it("prints each system's own setup and command", () => {
    const md = renderReport(results, "en");
    expect(md).toContain("- **cvparse + llama3.1 (ollama)**: cvparse 0.3.0; model: llama3.1");
    expect(md).toContain("cvparseCommit: abc1234");
    const baselineSetup = md.split("\n").find((l) => l.startsWith("- **open-resume"));
    expect(baselineSetup).toContain("commit: 4f8255a");
    expect(baselineSetup).not.toContain("cvparse 0.3.0");
    expect(baselineSetup).not.toContain("cvparseCommit");
    expect(md).toContain("- open-resume (rules): `npm run eval -- --system open-resume`");
    expect(md).toContain(
      "- cvparse + llama3.1 (ollama): `npm run eval -- --system cvparse --model llama3.1 --ocr tesseract`",
    );
  });

  it("renders Spanish headings", () => {
    const md = renderReport(results, "es");
    expect(md).toContain("| Sistema | Cobertura | Global | Solo PDF (1) | Nombre |");
    expect(md).toContain("F1 por campo (%)");
    expect(md).toContain("Configuración");
    expect(md).toContain("**Antes de leer la tabla.**");
  });

  it("adds precision/recall detail tables when allFields is set", () => {
    expect(renderReport(results, "en", { allFields: true })).toContain(
      "Precision / recall: open-resume (rules) (%)",
    );
    expect(renderReport(results, "en")).not.toContain("Precision / recall");
  });
});

describe("generateReport", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cvparse-report-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores results that do not cover the manifest and partial/ runs", async () => {
    const resultsDir = join(dir, "results");
    await mkdir(join(resultsDir, "partial"), { recursive: true });
    await writeFile(join(resultsDir, "full.json"), JSON.stringify(cvparseResult));
    const subset = { ...baselineResult, entries: baselineResult.entries.slice(0, 1) };
    await writeFile(join(resultsDir, "subset.json"), JSON.stringify(subset));
    await writeFile(join(resultsDir, "partial", "p.json"), JSON.stringify(subset));
    const warnings: string[] = [];
    const results = await loadResults(resultsDir, manifest, (l) => warnings.push(l));
    expect(results.map((r) => r.system.name)).toEqual(["cvparse + llama3.1 (ollama)"]);
    expect(warnings).toEqual([expect.stringMatching(/ignoring subset\.json: covers 1\/3/)]);
  });

  it("updates both READMEs and writes results/README.md, idempotently", async () => {
    const resultsDir = join(dir, "results");
    const datasetDir = join(dir, "dataset");
    const en = join(dir, "README.md");
    const es = join(dir, "README.es.md");
    await writeFile(en, README);
    await writeFile(es, README);
    await mkdir(resultsDir);
    await mkdir(datasetDir);
    await writeFile(join(datasetDir, "manifest.json"), JSON.stringify(manifest));
    const options = {
      resultsDir,
      datasetDir,
      readmes: [
        { path: en, lang: "en" as const },
        { path: es, lang: "es" as const },
      ],
      warn: () => {},
    };

    await generateReport(options);
    expect(await readFile(en, "utf8")).toMatch(/No benchmark results yet/);
    expect(await readFile(es, "utf8")).toMatch(/Todavía no hay resultados/);
    expect(await readFile(join(resultsDir, "README.md"), "utf8")).toMatch(
      /No benchmark results yet/,
    );

    await writeFile(join(resultsDir, "cvparse.json"), JSON.stringify(cvparseResult));
    await writeFile(join(resultsDir, "open-resume.json"), JSON.stringify(baselineResult));
    await generateReport(options);
    const first = await readFile(en, "utf8");
    expect(first).toContain("| open-resume (rules) | 1/3 | **75.0** |");
    expect(await readFile(es, "utf8")).toContain("F1 por campo (%)");
    const resultsReadme = await readFile(join(resultsDir, "README.md"), "utf8");
    expect(resultsReadme).toContain("Precision / recall");
    expect(resultsReadme).toContain("(../dataset/README.md#who-made-this-and-known-biases)");

    await generateReport(options);
    expect(await readFile(en, "utf8")).toBe(first);
  });
});
