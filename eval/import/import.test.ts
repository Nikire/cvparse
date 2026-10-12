import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockModelWithObject } from "../../test/helpers.js";
import { formatSummary, runEval } from "../run/runner.js";
import type { DatasetEntry, EvalSystem, GroundTruth } from "../types.js";
import {
  createIdAllocator,
  type DraftTruth,
  detectManifestLanguage,
  formatImportSummary,
  idPrefix,
  manifestLayout,
  notCvReason,
  type PrivateDatasetEntry,
  parseImportArgs,
  parseInboxName,
  rejectReason,
  runImport,
  SUSPECT_NOT_CV_TAG,
  toDraftTruth,
} from "./index.js";

describe("parseInboxName", () => {
  it("reads the source prefix and the country of public records", () => {
    expect(parseInboxName("consent-CV Juan Perez 2025.pdf")).toEqual({
      source: "consent",
      cc: "xx",
    });
    expect(parseInboxName("linkedin-export.pdf")).toEqual({ source: "linkedin", cc: "xx" });
    expect(parseInboxName("public-mx-CV_PUBLICO.pdf")).toEqual({
      source: "public-record",
      cc: "mx",
    });
    expect(parseInboxName("PUBLIC-AR-hcdn.pdf")).toEqual({ source: "public-record", cc: "ar" });
    expect(parseInboxName("public-manual.pdf")).toEqual({ source: "public-record", cc: "xx" });
    expect(parseInboxName("fake-canva-template.docx")).toEqual({ source: "fake", cc: "xx" });
    expect(parseInboxName("fixture-open-resume.pdf")).toEqual({ source: "fixture", cc: "xx" });
    expect(parseInboxName("cv.pdf")).toEqual({ source: "unknown", cc: "xx" });
    expect(parseInboxName("random-prefix-cv.pdf")).toEqual({ source: "unknown", cc: "xx" });
  });

  it("rejects HTML pages and extension/content mismatches", () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html lang="es"><head></head></html>');
    expect(rejectReason("public-es-cv.pdf", "text", html)).toMatch(/HTML page/);
    expect(rejectReason("cv.pdf", "text", new TextEncoder().encode("Juan Pérez\n"))).toMatch(
      /extension \.pdf but the content is text/,
    );
    expect(
      rejectReason("cv.txt", "text", new TextEncoder().encode("Juan Pérez\n")),
    ).toBeUndefined();
    expect(rejectReason("cv.PDF", "pdf", new Uint8Array())).toBeUndefined();
    expect(rejectReason("no-extension", "docx", new Uint8Array())).toBeUndefined();
  });

  it("builds id prefixes", () => {
    expect(idPrefix("consent", "xx")).toBe("consent-xx");
    expect(idPrefix("public-record", "MX")).toBe("public-mx");
  });
});

describe("createIdAllocator", () => {
  it("continues after the highest existing number per prefix", () => {
    const allocate = createIdAllocator([
      "real-en-001",
      "public-mx-003",
      "public-mx-001",
      "es-ar-012",
    ]);
    expect(allocate("public-mx")).toBe("public-mx-004");
    expect(allocate("public-mx")).toBe("public-mx-005");
    expect(allocate("consent-xx")).toBe("consent-xx-001");
    expect(allocate("public-ar")).toBe("public-ar-001");
    expect(allocate("es-ar")).toBe("es-ar-013");
  });
});

describe("layout and language", () => {
  it("maps extraction results to manifest layouts", () => {
    expect(manifestLayout({ format: "pdf", layout: "single-column" })).toBe("single-column");
    expect(manifestLayout({ format: "pdf", layout: "multi-column" })).toBe("two-column");
    expect(manifestLayout({ format: "docx", layout: "unknown" })).toBe("single-column");
    expect(manifestLayout({ format: "image", layout: "unknown" })).toBe("scanned");
    expect(
      manifestLayout({
        format: "pdf",
        layout: "single-column",
        ocr: { adapter: "tesseract", pages: 2 },
      }),
    ).toBe("scanned");
    expect(manifestLayout({ format: "pdf", layout: "single-column", scannedPages: [2] })).toBe(
      "scanned",
    );
  });

  it("detects mixed CVs by section headings in both languages", () => {
    const spanish =
      "Juan Pérez\n\nExperiencia laboral\nDesarrollador en la empresa Acme\n\nEducación\nUniversidad de Buenos Aires, licenciatura\n\nIdiomas\nInglés avanzado, nivel intermedio de portugués\n";
    expect(detectManifestLanguage(spanish)).toBe("es");
    expect(detectManifestLanguage(`${spanish}\nSkills\nTypeScript, Node.js\n`)).toBe("mixed");
    expect(detectManifestLanguage("x")).toBe("unknown");
  });
});

describe("toDraftTruth", () => {
  it("keeps only the scored subset and the review block", () => {
    const truth = toDraftTruth(
      {
        basics: {
          name: "Ana",
          email: "ana@example.com",
          phone: null,
          summary: "long text",
          location: { city: "Montevideo", countryCode: "UY", address: null, region: null },
        },
        work: [
          {
            name: "Acme",
            position: "Dev",
            startDate: "2020-01",
            endDate: null,
            highlights: ["secret"],
          },
        ],
        education: [{ institution: "UdelaR", studyType: "Licenciatura", area: "CS", score: "9" }],
        skills: [{ name: "TypeScript", keywords: ["ts"] }],
        languages: [{ language: "Inglés", fluency: "Avanzado" }],
        x_cvparse: {
          educationLevels: [{ level: "bachelor", confidence: 0.9 }],
          normalizedSkills: ["typescript"],
        },
      } as never,
      { status: "draft", source: "fake", warnings: ["w"] },
    );
    expect(truth).toEqual({
      _review: { status: "draft", source: "fake", warnings: ["w"] },
      basics: {
        name: "Ana",
        email: "ana@example.com",
        phone: null,
        location: { city: "Montevideo", countryCode: "UY" },
      },
      work: [{ name: "Acme", position: "Dev", startDate: "2020-01", endDate: null }],
      education: [{ institution: "UdelaR", studyType: "Licenciatura", area: "CS" }],
      skills: [{ name: "TypeScript" }],
      languages: [{ language: "Inglés", fluency: "Avanzado" }],
      x_cvparse: { educationLevels: [{ level: "bachelor", confidence: 0.9 }] },
    });
  });
});

describe("parseImportArgs", () => {
  it("defaults to ollama + llama3.1 and the private dataset", () => {
    const o = parseImportArgs([], {});
    expect(o?.provider).toBe("ollama");
    expect(o?.model).toBe("llama3.1");
    expect(o?.datasetDir.replace(/\\/g, "/")).toMatch(/\/eval\/private$/);
    expect(o?.dryRun).toBe(false);
    expect(parseImportArgs(["--help"])).toBeNull();
    expect(() => parseImportArgs(["--provider", "openai-compatible"], {})).toThrow(/--model/);
    expect(parseImportArgs(["--provider", "openai-compatible", "--dry-run"], {})?.model).toBe("");
  });
});

const CV_TEXT = `María López
maria.lopez@example.com · +54 9 11 5555-1234 · Buenos Aires, Argentina

Experiencia laboral
Desarrolladora backend — Acme
marzo 2021 - actualidad

Educación
Universidad de Buenos Aires — Licenciatura en Sistemas
2015 - 2020

Habilidades
TypeScript, Node.js

Idiomas
Inglés: avanzado
`;

const MODEL_OUTPUT = {
  basics: {
    name: "María López",
    email: "maria.lopez@example.com",
    phone: "+54 9 11 5555-1234",
    location: { city: "Buenos Aires", countryCode: "AR" },
  },
  work: [{ name: "Acme", position: "Desarrolladora backend", startDate: "2021-03", endDate: null }],
  education: [
    {
      institution: "Universidad de Buenos Aires",
      studyType: "Licenciatura",
      area: "Sistemas",
      startDate: "2015",
      endDate: "2020",
    },
  ],
  skills: [{ name: "TypeScript" }, { name: "Node.js" }],
  languages: [{ language: "Inglés", fluency: "avanzado" }],
};

describe("runImport", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cvparse-import-"));
    await mkdir(join(dir, "inbox"), { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify([
        {
          id: "consent-xx-001",
          country: "AR",
          language: "es",
          layout: "single-column",
          format: "text",
          file: "files/consent-xx-001.txt",
          truth: "truth/consent-xx-001.json",
          dateStyles: [],
          tags: [],
        },
      ]),
    );
    await writeFile(join(dir, "inbox", "consent-Maria Lopez.txt"), CV_TEXT);
    await writeFile(join(dir, "inbox", "public-mx-cv.txt"), CV_TEXT);
    await writeFile(join(dir, "inbox", "weird.bin"), Buffer.from([0, 1, 2, 3, 0, 0, 0, 9]));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("dry run plans ids and touches nothing", async () => {
    const files = await runImport({
      datasetDir: dir,
      modelName: "fake",
      dryRun: true,
      log: () => {},
    });
    expect(files.map((f) => [f.id, f.status])).toEqual([
      ["consent-xx-002", "dry-run"],
      ["public-mx-001", "dry-run"],
      [undefined, "failed"],
    ]);
    expect(files[2]?.error).toMatch(/unsupported format/);
    expect(existsSync(join(dir, "inbox", "consent-Maria Lopez.txt"))).toBe(true);
    expect(existsSync(join(dir, "files"))).toBe(false);
    expect(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))).toHaveLength(1);
  });

  it("imports files, drafts truths, writes manifest entries and never overwrites a truth", async () => {
    await mkdir(join(dir, "truth"), { recursive: true });
    await writeFile(join(dir, "truth", "public-mx-001.json"), '{"basics":{"name":"kept"}}');
    const log: string[] = [];
    const files = await runImport({
      datasetDir: dir,
      model: mockModelWithObject(MODEL_OUTPUT),
      modelName: "fake-model",
      referenceDate: new Date("2026-10-12T00:00:00Z"),
      log: (l) => log.push(l),
    });
    expect(files.map((f) => [f.id, f.status])).toEqual([
      ["consent-xx-002", "imported"],
      ["public-mx-001", "truth-exists"],
      [undefined, "failed"],
    ]);

    // inbox: only the unsupported file stays
    expect(existsSync(join(dir, "inbox", "weird.bin"))).toBe(true);
    expect(existsSync(join(dir, "inbox", "consent-Maria Lopez.txt"))).toBe(false);
    expect(existsSync(join(dir, "files", "consent-xx-002.txt"))).toBe(true);
    expect(await readFile(join(dir, "text", "consent-xx-002.txt"), "utf8")).toContain(
      "María López",
    );

    const truth = JSON.parse(
      await readFile(join(dir, "truth", "consent-xx-002.json"), "utf8"),
    ) as DraftTruth;
    expect(truth._review.status).toBe("draft");
    expect(truth._review.source).toBe("fake-model");
    expect(truth.basics?.name).toBe("María López");
    expect(truth.work?.[0]).toMatchObject({ name: "Acme", startDate: "2021-03" });
    expect(truth.skills).toEqual([{ name: "TypeScript" }, { name: "Node.js" }]);
    expect(truth.x_cvparse?.educationLevels?.[0]).toMatchObject({ level: expect.any(String) });
    expect(await readFile(join(dir, "truth", "public-mx-001.json"), "utf8")).toBe(
      '{"basics":{"name":"kept"}}',
    );
    expect(log.some((l) => /truth exists, not overwritten/.test(l))).toBe(true);

    const manifest = JSON.parse(
      await readFile(join(dir, "manifest.json"), "utf8"),
    ) as PrivateDatasetEntry[];
    expect(manifest.map((e) => e.id)).toEqual([
      "consent-xx-001",
      "consent-xx-002",
      "public-mx-001",
    ]);
    expect(manifest[1]).toMatchObject({
      id: "consent-xx-002",
      country: "XX",
      language: "es",
      layout: "single-column",
      format: "text",
      file: "files/consent-xx-002.txt",
      truth: "truth/consent-xx-002.json",
      dateStyles: [],
      tags: ["real", "consent"],
      source: "consent",
      pii: true,
      originalName: "consent-Maria Lopez.txt",
    });
    expect(manifest[1]?.acquired).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest[2]).toMatchObject({ country: "MX", source: "public-record", pii: true });

    const summary = formatImportSummary(files);
    expect(summary).toContain("consent-xx-002");
    expect(summary).toContain("3 files: 1 imported (1 draft truths), 1 failed");
  });
});

describe("runEval with draft truths", () => {
  let dir: string;
  const entry = (id: string): DatasetEntry => ({
    id,
    country: "AR",
    language: "es",
    layout: "single-column",
    format: "text",
    file: `files/${id}.txt`,
    truth: `truth/${id}.json`,
    dateStyles: [],
    tags: [],
  });
  const truth: GroundTruth = { basics: { name: "Ana Pérez" } };
  const system = (): EvalSystem & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      info: { name: "fake", kind: "baseline", details: {} },
      supports: ["text"],
      async predict(_file, e) {
        calls.push(e.id);
        return structuredClone(truth);
      },
    };
  };
  const options = (includeDrafts?: boolean) => ({
    datasetDir: dir,
    resultsDir: join(dir, "results"),
    cacheDir: join(dir, "cache"),
    cache: false,
    concurrency: 1,
    cvparseVersion: "0.0.0",
    srcDir: join(dir, "src"),
    commit: "abc",
    includeDrafts,
    log: () => {},
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cvparse-drafts-"));
    await mkdir(join(dir, "files"), { recursive: true });
    await mkdir(join(dir, "truth"), { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify([entry("a-xx-001"), entry("a-xx-002")]),
    );
    await writeFile(join(dir, "files", "a-xx-001.txt"), "cv");
    await writeFile(join(dir, "files", "a-xx-002.txt"), "cv");
    await writeFile(join(dir, "truth", "a-xx-001.json"), JSON.stringify(truth));
    await writeFile(
      join(dir, "truth", "a-xx-002.json"),
      JSON.stringify({ ...truth, _review: { status: "draft", source: "fake", warnings: [] } }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("skips draft truths by default and reports them", async () => {
    const sys = system();
    const { result } = await runEval(sys, options());
    expect(sys.calls).toEqual(["a-xx-001"]);
    expect(result.entries[1]).toMatchObject({ id: "a-xx-002", ok: false, skipped: "draft-truth" });
    expect(result.attempted).toBe(1);
    expect(result.overallF1).toBe(1);
    expect(result.byLayout?.["single-column"]).toEqual({ entries: 2, attempted: 1, overallF1: 1 });
    expect(formatSummary(result)).toContain("2 CVs, 1 attempted, 0 failed, 1 skipped: draft truth");
  });

  it("scores draft truths with includeDrafts", async () => {
    const sys = system();
    const { result } = await runEval(sys, options(true));
    expect(sys.calls).toEqual(["a-xx-001", "a-xx-002"]);
    expect(result.entries.every((e) => e.ok && !e.skipped)).toBe(true);
    expect(result.attempted).toBe(2);
  });
});

describe("notCvReason", () => {
  it("flags text without contact data, dates or a CV heading", () => {
    expect(
      notCvReason("Receta de locro\nIngredientes: maíz, zapallo, carne.\nCocinar 3 horas."),
    ).toMatch(/no email, no phone number, no date and no experience\/education heading/);
    expect(
      notCvReason("Certificado\nSe deja constancia de que la persona aprobó el curso en 2019."),
    ).toMatch(/only one date/);
  });

  it("accepts text with any one CV signal", () => {
    expect(notCvReason("Contacto: ana@example.com")).toBeUndefined();
    expect(notCvReason("Tel: +54 11 4127-7100")).toBeUndefined();
    expect(notCvReason("Analista, 2018 - 2020")).toBeUndefined();
    expect(notCvReason("EXPERIENCIA LABORAL\nAcme")).toBeUndefined();
    expect(notCvReason("Cargos ejercidos\nMinisterio")).toBeUndefined();
    expect(notCvReason("Work Experience:\nAcme")).toBeUndefined();
  });
});

describe("runImport — documents that are not CVs", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cvparse-import-notcv-"));
    await mkdir(join(dir, "inbox"), { recursive: true });
    await writeFile(join(dir, "inbox", "consent-cv.txt"), CV_TEXT);
    await writeFile(
      join(dir, "inbox", "fake-recipe.txt"),
      "Receta de locro\n\nIngredientes: maíz blanco, zapallo, carne y chorizo colorado.\nCocinar a fuego lento durante tres horas y servir con salsa picante.\n",
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("tags the manifest entry, notes it in the draft truth and warns", async () => {
    const log: string[] = [];
    const files = await runImport({
      datasetDir: dir,
      model: mockModelWithObject(MODEL_OUTPUT),
      modelName: "fake-model",
      log: (l) => log.push(l),
    });
    const recipe = files.find((f) => f.originalName === "fake-recipe.txt");
    const cv = files.find((f) => f.originalName === "consent-cv.txt");
    expect(recipe?.status).toBe("imported");
    expect(recipe?.suspect).toMatch(/no email/);
    expect(cv?.suspect).toBeUndefined();
    expect(log.some((l) => /WARNING: does not look like a CV/.test(l))).toBe(true);

    const manifest = JSON.parse(
      await readFile(join(dir, "manifest.json"), "utf8"),
    ) as PrivateDatasetEntry[];
    const entry = manifest.find((e) => e.originalName === "fake-recipe.txt");
    expect(entry?.tags).toContain(SUSPECT_NOT_CV_TAG);
    expect(manifest.find((e) => e.originalName === "consent-cv.txt")?.tags).not.toContain(
      SUSPECT_NOT_CV_TAG,
    );
    const truth = JSON.parse(
      await readFile(join(dir, entry?.truth as string), "utf8"),
    ) as DraftTruth;
    expect(truth._review.status).toBe("draft");
    expect(truth._review.warnings[0]).toMatch(/^import: does not look like a CV/);
    expect(formatImportSummary(files)).toContain(`[${SUSPECT_NOT_CV_TAG}]`);
  });
});
