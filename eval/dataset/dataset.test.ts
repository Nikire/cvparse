/**
 * Sanity checks for the committed evaluation dataset (eval/dataset/). Regenerate with
 * `npm run eval:dataset` when any of these fail after a generator change.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractText, normalizeDate, ResumeSchema, splitDateRange } from "../../src/index.js";
import { stableJson } from "../generate/index.js";
import { buildDocs, DATASET_VERSION, EXTENSIONS, PLAN } from "../generate/plan.js";
import type { DatasetEntry, GroundTruth } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8")) as DatasetEntry[];
const readTruth = (entry: DatasetEntry) =>
  JSON.parse(readFileSync(join(here, entry.truth), "utf8")) as GroundTruth;
const docs = buildDocs();
const byId = new Map(docs.map((doc) => [doc.spec.id, doc]));

/** Collapses whitespace so values wrapped across lines still match. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

describe("eval dataset manifest", () => {
  it("has 60 entries with unique, sorted ids", () => {
    expect(manifest).toHaveLength(60);
    const ids = manifest.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(/^es-(ar|mx|es|co|cl|pe|uy)-\d{3}$/);
  });

  it("records the dataset version", () => {
    expect(readFileSync(join(here, "VERSION"), "utf8").trim()).toBe(DATASET_VERSION);
  });

  it("matches the plan: counts by layout/format, every country, two mixed-language CVs", () => {
    for (const group of PLAN) {
      const count = manifest.filter((e) => e.layout === group.layout && e.format === group.format);
      expect(count, `${group.layout}/${group.format}`).toHaveLength(group.count);
    }
    const countries = new Set(manifest.map((e) => e.country));
    expect([...countries].sort()).toEqual(["AR", "CL", "CO", "ES", "MX", "PE", "UY"]);
    expect(manifest.filter((e) => e.language === "mixed")).toHaveLength(2);
    expect(manifest.filter((e) => e.layout === "scanned")).toHaveLength(6);
  });

  it("is in sync with the generator (ids, metadata and truth)", () => {
    expect(docs.map((d) => d.spec.id).sort()).toEqual(manifest.map((e) => e.id));
    for (const entry of manifest) {
      const doc = byId.get(entry.id);
      expect(doc, entry.id).toBeDefined();
      if (!doc) continue;
      expect(entry).toMatchObject({
        country: doc.spec.country,
        layout: doc.spec.layout,
        format: doc.spec.format,
        language: doc.spec.language,
        dateStyles: doc.dateStyles,
        file: `files/${entry.id}.${EXTENSIONS[doc.spec.format]}`,
        truth: `truth/${entry.id}.json`,
      });
      expect(readFileSync(join(here, entry.truth), "utf8")).toBe(stableJson(doc.truth));
    }
  });
});

describe("eval dataset files and truth", () => {
  it("every file and truth exists and files stay small", () => {
    for (const entry of manifest) {
      const file = join(here, entry.file);
      expect(existsSync(file), entry.file).toBe(true);
      expect(existsSync(join(here, entry.truth)), entry.truth).toBe(true);
      const size = statSync(file).size;
      const limit = entry.layout === "scanned" ? 200_000 : 30_000;
      expect(size, `${entry.file} is ${size} bytes`).toBeLessThan(limit);
    }
  });

  it("every truth validates against ResumeSchema", () => {
    for (const entry of manifest) {
      const result = ResumeSchema.safeParse(readTruth(entry));
      expect(result.success, `${entry.id}: ${result.error?.message}`).toBe(true);
    }
  });

  it("truth is internally consistent", () => {
    for (const entry of manifest) {
      const truth = readTruth(entry);
      expect(truth.basics?.email, entry.id).toMatch(/@example\.(com|org)$/);
      expect(truth.basics?.location?.countryCode).toBe(entry.country);
      expect(truth.x_cvparse?.educationLevels).toHaveLength(truth.education?.length ?? 0);
      expect(truth.work?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(entry.tags.includes("ongoing-role")).toBe(
        truth.work?.some((w) => w.endDate === null) ?? false,
      );
    }
  });

  it("rendered dates map back to the truth dates", () => {
    const check = (text: string, start: string | null | undefined, end: string | null) => {
      if (text.startsWith("verano ")) {
        // Season: stored with year precision (hemisphere-dependent month).
        expect(end).toBe(text.slice(7));
        return;
      }
      const range = splitDateRange(text);
      if (range) {
        expect([range.start, range.current ? null : range.end], text).toEqual([start, end]);
      } else {
        expect(start ?? null, text).toBeNull();
        expect(normalizeDate(text).value, text).toBe(end);
      }
    };
    for (const doc of docs) {
      doc.jobs.forEach((job, i) => {
        const truth = doc.truth.work?.[i];
        check(job.dates, truth?.startDate, truth?.endDate ?? null);
      });
      doc.studies.forEach((study, i) => {
        const truth = doc.truth.education?.[i];
        check(study.dates, truth?.startDate, truth?.endDate ?? null);
      });
    }
  });

  const textEntries = manifest.filter((e) => e.layout !== "scanned");

  it.each(textEntries.map((e) => [e.id, e] as const))(
    "%s: extracted text contains the truth values",
    async (_id, entry) => {
      const data = new Uint8Array(readFileSync(join(here, entry.file)));
      const { text } = await extractText({ data, filename: entry.file });
      const haystack = flat(text);
      const truth = readTruth(entry);
      const values = [
        truth.basics?.name,
        truth.basics?.email,
        truth.basics?.phone,
        ...(truth.work ?? []).flatMap((w) => [w.name, w.position]),
        ...(truth.education ?? []).map((e) => e.institution),
        ...(truth.skills ?? []).map((s) => s.name),
      ];
      for (const value of values) {
        expect(haystack, `${entry.id}: missing "${value}"`).toContain(flat(value ?? ""));
      }
    },
  );
});
