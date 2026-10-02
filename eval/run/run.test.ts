import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatasetEntry, EvalSystem, GroundTruth } from "../types.js";
import {
  formatCommand,
  loadBaseline,
  ollamaDetails,
  ollamaRoot,
  parseEvalArgs,
  runtimeDetails,
} from "./index.js";
import { formatSummary, type RunResultFile, runEval, slugify } from "./runner.js";

const truthA: GroundTruth = {
  basics: { name: "Ana Pérez", email: "ana@example.com" },
  work: [{ name: "Acme", position: "Developer", startDate: "2020-01", endDate: null }],
  x_cvparse: { educationLevels: [] },
};
const truthB: GroundTruth = {
  basics: { name: "Luis Gómez", email: "luis@example.com" },
  skills: [{ name: "Tech", keywords: ["TypeScript"] }],
};

const manifest: DatasetEntry[] = [
  {
    id: "es-ar-001",
    country: "AR",
    language: "es",
    layout: "two-column",
    format: "pdf",
    file: "files/es-ar-001.pdf",
    truth: "truth/es-ar-001.json",
    dateStyles: [],
    tags: [],
  },
  {
    id: "es-mx-002",
    country: "MX",
    language: "es",
    layout: "scanned",
    format: "image",
    file: "files/es-mx-002.png",
    truth: "truth/es-mx-002.json",
    dateStyles: [],
    tags: [],
  },
];

function fakeSystem(behavior: "ok" | "throw-second" = "ok"): EvalSystem & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    info: { name: "Fake System (test)", kind: "baseline", details: { version: "1" } },
    supports: ["pdf", "image"],
    async predict(file, entry) {
      calls.push(entry.id);
      expect(existsSync(file)).toBe(true);
      if (entry.id === "es-mx-002" && behavior === "throw-second") throw new Error("OCR exploded");
      return entry.id === "es-ar-001"
        ? structuredClone(truthA)
        : { basics: { name: "Luis Gomez" } };
    },
  };
}

describe("runEval", () => {
  let dir: string;
  let datasetDir: string;
  const options = () => ({
    datasetDir,
    resultsDir: join(dir, "results"),
    cacheDir: join(dir, "cache"),
    cache: true,
    concurrency: 2,
    cvparseVersion: "9.9.9",
    srcDir: join(dir, "src"),
    commit: "abc1234",
    log: () => {},
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cvparse-run-"));
    datasetDir = join(dir, "dataset");
    await mkdir(join(datasetDir, "files"), { recursive: true });
    await mkdir(join(datasetDir, "truth"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "prompt.ts"), "export const PROMPT = 1;\n");
    await writeFile(join(datasetDir, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(datasetDir, "VERSION"), "1.2.3\n");
    await writeFile(join(datasetDir, "files/es-ar-001.pdf"), "pdf");
    await writeFile(join(datasetDir, "files/es-mx-002.png"), "png");
    await writeFile(join(datasetDir, "truth/es-ar-001.json"), JSON.stringify(truthA));
    await writeFile(join(datasetDir, "truth/es-mx-002.json"), JSON.stringify(truthB));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("scores every entry, writes the result file and caches predictions", async () => {
    const system = fakeSystem();
    const { result, path } = await runEval(system, options());
    expect(path).toBe(join(dir, "results", "fake-system-test.json"));
    const written = JSON.parse(await readFile(path, "utf8")) as RunResultFile;
    expect(written.datasetVersion).toBe("1.2.3");
    expect(written.cvparseVersion).toBe("9.9.9");
    expect(written.entries.map((e) => e.id)).toEqual(["es-ar-001", "es-mx-002"]);
    expect(written.entries.every((e) => e.ok)).toBe(true);
    expect(result.fields["basics.name"]).toMatchObject({ tp: 2, fp: 0, fn: 0 });
    expect(result.fields["basics.email"]).toMatchObject({ tp: 1, fn: 1 });
    expect(result.fields["education.level"]).toBeUndefined();
    expect(result.byLayout?.["two-column"]).toEqual({ entries: 1, attempted: 1, overallF1: 1 });
    expect(result.byFormat?.pdf).toEqual({ entries: 1, attempted: 1, overallF1: 1 });
    expect(result.attempted).toBe(2);
    expect(written.system.details).toMatchObject({
      datasetVersion: "1.2.3",
      cvparseCommit: "abc1234",
    });
    expect(written.system.details.datasetHash).toMatch(/^[0-9a-f]{16}$/);
    expect(written.system.details.cvparseSrcHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.byLayout?.scanned?.entries).toBe(1);
    expect(existsSync(join(dir, "cache", "fake-system-test", "es-ar-001.json"))).toBe(true);

    const summary = formatSummary(result);
    expect(summary).toContain("Fake System (test) on dataset 1.2.3");
    expect(summary).toContain("two-column");
    expect(summary).toContain("total time");

    // second run is served from the cache
    const again = fakeSystem();
    const second = await runEval(again, options());
    expect(again.calls).toEqual([]);
    expect(second.result.overallF1).toBe(result.overallF1);

    // ...unless the cvparse version changes or the cache is disabled
    const bumped = fakeSystem();
    await runEval(bumped, { ...options(), cvparseVersion: "10.0.0" });
    expect(bumped.calls.sort()).toEqual(["es-ar-001", "es-mx-002"]);
    // ...or a cvparse source file changes (prompt edits invalidate the cache)
    await writeFile(join(dir, "src", "prompt.ts"), "export const PROMPT = 2;\n");
    const edited = fakeSystem();
    await runEval(edited, { ...options(), cvparseVersion: "10.0.0" });
    expect(edited.calls.length).toBe(2);
    // ...or the ground truth, or the commit
    await writeFile(
      join(datasetDir, "truth/es-ar-001.json"),
      JSON.stringify({ ...truthA, skills: [] }),
    );
    const truthEdited = fakeSystem();
    await runEval(truthEdited, { ...options(), cvparseVersion: "10.0.0" });
    expect(truthEdited.calls.length).toBe(2);
    const recommitted = fakeSystem();
    await runEval(recommitted, { ...options(), cvparseVersion: "10.0.0", commit: "def5678" });
    expect(recommitted.calls.length).toBe(2);
    const stable = fakeSystem();
    await runEval(stable, { ...options(), cvparseVersion: "10.0.0", commit: "def5678" });
    expect(stable.calls).toEqual([]);
    const noCache = fakeSystem();
    await runEval(noCache, { ...options(), cache: false });
    expect(noCache.calls.length).toBe(2);
  });

  it("records a failing CV without aborting the run", async () => {
    const { result } = await runEval(fakeSystem("throw-second"), { ...options(), cache: false });
    const failed = result.entries.find((e) => e.id === "es-mx-002");
    expect(failed).toMatchObject({ ok: false, error: "OCR exploded" });
    expect(failed?.fields["basics.name"]).toMatchObject({ fn: 1, tp: 0 });
    expect(result.entries.find((e) => e.id === "es-ar-001")?.ok).toBe(true);
    expect(formatSummary(result)).toContain("es-mx-002: OCR exploded");
  });

  it("skips unsupported formats (coverage, not F1) and reports per-slice n/a", async () => {
    const pdfOnly = { ...fakeSystem(), supports: ["pdf"] as const };
    const { result } = await runEval(pdfOnly, { ...options(), cache: false });
    expect(pdfOnly.calls).toEqual(["es-ar-001"]);
    expect(result.entries.find((e) => e.id === "es-mx-002")).toEqual({
      id: "es-mx-002",
      ok: false,
      error: "unsupported format: image",
      skipped: "unsupported-format",
      fields: {},
    });
    expect(result.attempted).toBe(1);
    // the skipped image CV does not drag the score down
    expect(result.overallF1).toBe(1);
    expect(result.byLayout?.scanned).toEqual({ entries: 1, attempted: 0, overallF1: null });
    expect(result.byFormat?.image).toEqual({ entries: 1, attempted: 0, overallF1: null });
    const summary = formatSummary(result);
    expect(summary).toContain("2 CVs, 1 attempted, 0 failed");
    expect(summary).toMatch(/scanned\s+n\/a 0\/1/);
  });

  it("writes --only/--limit subset runs to results/partial/", async () => {
    const full = await runEval(fakeSystem(), { ...options(), cache: false });
    expect(full.path).toBe(join(dir, "results", "fake-system-test.json"));
    const only = await runEval(fakeSystem(), { ...options(), only: ["es-mx-002"], cache: false });
    expect(only.result.entries.map((e) => e.id)).toEqual(["es-mx-002"]);
    expect(only.path).toBe(join(dir, "results", "partial", "fake-system-test.json"));
    const limited = await runEval(fakeSystem(), { ...options(), limit: 1, cache: false });
    expect(limited.result.entries.map((e) => e.id)).toEqual(["es-ar-001"]);
    expect(limited.path).toBe(join(dir, "results", "partial", "fake-system-test.json"));
    // the published full result is untouched
    const published = JSON.parse(await readFile(full.path, "utf8")) as RunResultFile;
    expect(published.entries).toHaveLength(2);
  });

  it("scores education.level as FN for failed cvparse runs", async () => {
    await writeFile(
      join(datasetDir, "truth/es-ar-001.json"),
      JSON.stringify({
        education: [{ institution: "UBA", studyType: "Licenciatura" }],
        x_cvparse: { educationLevels: [{ level: "bachelor", original: null, canonical: null }] },
      }),
    );
    const system: EvalSystem = {
      info: { name: "cvparse fake", kind: "cvparse", details: {} },
      supports: ["pdf"],
      predict: async () => {
        throw new Error("model down");
      },
    };
    const { result } = await runEval(system, { ...options(), only: ["es-ar-001"], cache: false });
    expect(result.fields["education.level"]).toMatchObject({ tp: 0, fn: 1 });
  });

  it("fails clearly when the dataset is missing", async () => {
    await expect(
      runEval(fakeSystem(), { ...options(), datasetDir: join(dir, "nope") }),
    ).rejects.toThrow(/manifest not found/);
  });
});

describe("CLI helpers", () => {
  it("slugifies system names", () => {
    expect(slugify("cvparse + llama3.1 (ollama, tesseract)")).toBe(
      "cvparse-llama3.1-ollama-tesseract",
    );
    expect(slugify("open-resume (rules)")).toBe("open-resume-rules");
  });

  it("parses arguments with defaults", () => {
    const opts = parseEvalArgs(
      [
        "--system",
        "cvparse",
        "--model",
        "qwen2.5:7b",
        "--ocr",
        "tesseract",
        "--only",
        "a, b",
        "--no-cache",
        "--dataset",
        "x",
      ],
      {},
    );
    expect(opts).toMatchObject({
      system: "cvparse",
      provider: "ollama",
      model: "qwen2.5:7b",
      ocr: "tesseract",
      only: ["a", "b"],
      cache: false,
      concurrency: 1,
    });
    expect(opts?.datasetDir.endsWith("x")).toBe(true);
    expect(parseEvalArgs([], {})).toMatchObject({ model: "llama3.1", cache: true });
    expect(parseEvalArgs(["--help"], {})).toBeNull();
    expect(() => parseEvalArgs(["--ocr", "textract"], {})).toThrow(/--ocr/);
    expect(() => parseEvalArgs(["--limit", "0"], {})).toThrow(/--limit/);
    expect(() => parseEvalArgs(["--provider", "openai-compatible"], {})).toThrow(/--model/);
    expect(parseEvalArgs(["--provider", "openai"], { OPENAI_API_KEY: "k" })?.apiKey).toBe("k");
  });

  it("appends --gpu to the hardware note", () => {
    expect(
      parseEvalArgs(["--hardware", "Ryzen 7, 32 GB", "--gpu", "RTX 3060 12 GB"], {})?.hardware,
    ).toBe("Ryzen 7, 32 GB; GPU: RTX 3060 12 GB");
    expect(parseEvalArgs(["--gpu", "none"], {})?.hardware).toMatch(/; GPU: none$/);
  });

  it("records the exact command line with the API key redacted", () => {
    expect(
      formatCommand([
        "--system",
        "cvparse",
        "--name",
        "cvparse + llama3.1 8B (Ollama, local)",
        "--api-key",
        "sk-secret",
      ]),
    ).toBe(
      'npm run eval -- --system cvparse --name "cvparse + llama3.1 8B (Ollama, local)" --api-key <redacted>',
    );
    expect(formatCommand(["--api-key=sk-secret"])).toBe("npm run eval -- --api-key=<redacted>");
  });

  it("reads the Ollama version and model digest", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      const body = url.endsWith("/api/version")
        ? { version: "0.35.0" }
        : { models: [{ name: "llama3.1:latest", digest: "46e0c10c039e019119339687c3c1757c" }] };
      return { ok: true, json: async () => body };
    };
    expect(ollamaRoot("http://localhost:11434/v1/")).toBe("http://localhost:11434");
    expect(await ollamaDetails("http://localhost:11434/v1", "llama3.1", fetchImpl)).toEqual({
      ollamaVersion: "0.35.0",
      modelDigest: "sha256:46e0c10c039e",
    });
    expect(calls).toEqual([
      "http://localhost:11434/api/version",
      "http://localhost:11434/api/tags",
    ]);
    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await ollamaDetails("http://localhost:11434/v1", "x", down)).toEqual({
      ollamaVersion: "unknown",
      modelDigest: "unknown",
    });

    const opts = parseEvalArgs(["--ocr", "tesseract", "--hardware", "box"], {});
    if (!opts) throw new Error("unreachable");
    const details = await runtimeDetails(opts, ["--ocr", "tesseract"], fetchImpl);
    expect(details).toMatchObject({
      command: "npm run eval -- --ocr tesseract",
      node: process.version,
      hardware: "box",
      ollamaVersion: "0.35.0",
      modelDigest: "sha256:46e0c10c039e",
    });
    expect(details["tesseract.js"]).toMatch(/^\d+\.\d+\.\d+/);
    const baseline = await runtimeDetails(
      { ...opts, system: "open-resume" },
      ["--system", "open-resume"],
      fetchImpl,
    );
    expect(baseline.ollamaVersion).toBeUndefined();
    expect(baseline["tesseract.js"]).toBeUndefined();
  });

  it("reports a missing baseline module clearly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cvparse-baselines-"));
    try {
      await expect(loadBaseline("does-not-exist", dir)).rejects.toThrow(
        /baseline module at .*does-not-exist\.ts/,
      );
      await expect(loadBaseline("../evil", dir)).rejects.toThrow(/Invalid system name/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
