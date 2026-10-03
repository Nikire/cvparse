import { describe, expect, it } from "vitest";
import {
  dedupeResumeEntries,
  detectRepetitionLoop,
  repairTruncatedJson,
} from "../src/normalize/repetition.js";
import { salvageLoopingOutput } from "../src/parse.js";
import { LOOP_FIRST, LOOP_HEAD, REAL_LOOP, SPANISH_EXTRACTION } from "./helpers.js";

/** The same extraction a normal run writes (Python-style separators, like Ollama). */
const NORMAL_OUTPUT = JSON.stringify(SPANISH_EXTRACTION, null, 1).replace(/\n\s*/g, " ");

describe("detectRepetitionLoop", () => {
  it("flags the real looping output", () => {
    expect(detectRepetitionLoop(REAL_LOOP)).toBe(true);
  });

  it("does not flag a normal extraction, complete or cut", () => {
    expect(detectRepetitionLoop(NORMAL_OUTPUT)).toBe(false);
    expect(detectRepetitionLoop(NORMAL_OUTPUT.slice(0, Math.floor(NORMAL_OUTPUT.length / 2)))).toBe(
      false,
    );
    expect(detectRepetitionLoop(LOOP_HEAD + LOOP_FIRST)).toBe(false);
  });

  it("needs the trailing chunk to occur `repeats` times", () => {
    const unit = `${"x".repeat(150)}${"y".repeat(150)}`;
    expect(detectRepetitionLoop(`head ${unit}${unit}`)).toBe(false);
    expect(detectRepetitionLoop(`head ${unit}${unit}${unit}`)).toBe(true);
    expect(detectRepetitionLoop(`head ${unit}${unit}`, { repeats: 2 })).toBe(true);
    expect(detectRepetitionLoop("short")).toBe(false);
  });
});

describe("repairTruncatedJson", () => {
  it("recovers every complete entry of the real looping output", () => {
    const repaired = repairTruncatedJson(REAL_LOOP);
    expect(repaired).toBeDefined();
    const basics = repaired?.basics as { name: string; email: string };
    expect(basics.name).toBe("Gabriela Quispe Ccori");
    expect(basics.email).toBe("gabriela.quispe@example.org");
    const work = repaired?.work as Array<{ name: string }>;
    // 3 jobs + the first university entry + 6 complete repeats; the partial 7th is dropped.
    expect(work).toHaveLength(10);
    expect(work[0]?.name).toBe("Estudio Creativo del Rímac E.I.R.L.");
  });

  it("closes nested objects and arrays and ignores brackets inside strings", () => {
    expect(repairTruncatedJson('{"a": {"b": [1, {"c": "x]}"}, {"d": "unfinished')).toEqual({
      a: { b: [1, { c: "x]}" }] },
    });
    expect(repairTruncatedJson('{"a": [{"q": "say \\"}\\""}, {"r": 1')).toEqual({
      a: [{ q: 'say "}"' }],
    });
  });

  it("returns complete JSON unchanged and gives up on text with nothing to recover", () => {
    expect(repairTruncatedJson('noise {"a": [1]} trailing')).toEqual({ a: [1] });
    expect(repairTruncatedJson('{"basics": {"name": "Ana')).toBeUndefined();
    expect(repairTruncatedJson("not json")).toBeUndefined();
    expect(repairTruncatedJson('{"a": [}')).toBeUndefined();
  });
});

describe("dedupeResumeEntries", () => {
  it("removes identical entries and repeated highlights, keeping the first", () => {
    const job = { name: "Acme", position: "Dev", highlights: ["APIs", "apis ", "Tests"] };
    const resume: Record<string, unknown> = {
      work: [job, { ...job, highlights: [...job.highlights] }, { name: "Other", position: "Dev" }],
      skills: [{ name: "SQL" }, { name: "SQL" }],
      basics: {
        profiles: [
          { network: "GitHub", url: "u" },
          { url: "u", network: "GitHub" },
        ],
      },
    };
    const warnings = dedupeResumeEntries(resume);
    expect(resume.work).toEqual([
      { name: "Acme", position: "Dev", highlights: ["APIs", "Tests"] },
      { name: "Other", position: "Dev" },
    ]);
    expect(resume.skills).toEqual([{ name: "SQL" }]);
    expect((resume.basics as { profiles: unknown[] }).profiles).toHaveLength(1);
    expect(warnings).toContain(
      "model: removed 1 repeated entry from work (the model repeated itself).",
    );
    expect(warnings).toContain(
      "model: removed 1 repeated entry from basics.profiles (the model repeated itself).",
    );
    expect(warnings.some((w) => w.includes("1 repeated item inside work"))).toBe(true);
  });

  it("keeps entries that differ, unless similar mode matches their identity fields", () => {
    const a = { name: "Acme", position: "Dev", startDate: "2020", highlights: ["A"] };
    const b = { name: "ACME ", position: "Dev", startDate: "2020", highlights: ["B"] };
    const exact: Record<string, unknown> = { work: [a, b] };
    expect(dedupeResumeEntries(exact)).toEqual([]);
    expect(exact.work).toHaveLength(2);
    const similar: Record<string, unknown> = { work: [a, b] };
    dedupeResumeEntries(similar, { similar: true });
    expect(similar.work).toEqual([a]);
    // Entries with no identity fields are only merged when identical.
    const blank: Record<string, unknown> = { work: [{ summary: "x" }, { summary: "y" }] };
    dedupeResumeEntries(blank, { similar: true });
    expect(blank.work).toHaveLength(2);
  });
});

describe("salvageLoopingOutput", () => {
  it("rebuilds the real looping output with the repeats collapsed", () => {
    const salvaged = salvageLoopingOutput([REAL_LOOP]) as {
      basics: { name: string };
      work: Array<{ name: string }>;
    };
    expect(salvaged.basics.name).toBe("Gabriela Quispe Ccori");
    expect(salvaged.work.map((w) => w.name)).toEqual([
      "Estudio Creativo del Rímac E.I.R.L.",
      "Banco Digital del Rímac S.A.",
      "Agencia Digital del Pacífico S.A.C.",
      "Universidad Peruana de Ciencias del Pacífico",
    ]);
  });

  it("falls back to the next text and returns undefined when nothing parses", () => {
    expect(salvageLoopingOutput(["garbage", REAL_LOOP])).toBeDefined();
    expect(salvageLoopingOutput(["garbage", '{"basics": {"name": "A'])).toBeUndefined();
  });
});
