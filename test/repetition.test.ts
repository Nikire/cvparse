import { describe, expect, it } from "vitest";
import {
  dedupeResumeEntries,
  detectRepetitionLoop,
  pruneSalvagedEntries,
  repairTruncatedJson,
  SALVAGE_MAX_ENTRIES,
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
    expect(warnings).toContain("model: removed 1 duplicate entry from work.");
    expect(warnings).toContain("model: removed 1 duplicate entry from basics.profiles.");
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

describe("pruneSalvagedEntries", () => {
  const today = new Date("2026-10-12T00:00:00Z");

  it("drops entries with implausible dates and runs whose dates count in a fixed step", () => {
    const acme = (start: string, end: string) => ({
      name: "Acme",
      position: "Dev",
      startDate: start,
      endDate: end,
    });
    const resume: Record<string, unknown> = {
      work: [
        acme("2020", "2021"),
        acme("2021", "2022"),
        acme("2022-03", "2023"),
        acme("2023", "2024"),
        { name: "Globex", position: "Lead", startDate: "1890", endDate: "1895" },
        { name: "Initech", position: "QA", startDate: "2031" },
        { name: "Other", position: "Dev", startDate: "2019" },
        { name: "Nodate", position: "Dev" },
      ],
      education: [
        { institution: "UBA", studyType: "Lic.", startDate: "2010", endDate: "2015" },
        { institution: "UBA", studyType: "Lic.", startDate: "2012", endDate: "2017" },
        { institution: "UBA", studyType: "Lic.", startDate: "2014", endDate: "2019" },
      ],
    };
    const warnings = pruneSalvagedEntries(resume, today);
    expect((resume.work as Array<{ name: string; startDate?: string }>).map((w) => w.name)).toEqual(
      ["Acme", "Other", "Nodate"],
    );
    expect(resume.education).toHaveLength(1);
    expect(warnings).toEqual([
      "model: removed 2 work entries with dates before 1950 or after 2027 (fabricated by the repetition loop).",
      "model: removed 3 work entries that repeat another entry with dates counting in a fixed step (fabricated by the repetition loop).",
      "model: removed 2 education entries that repeat another entry with dates counting in a fixed step (fabricated by the repetition loop).",
    ]);
  });

  it("keeps a person rehired by the same employer and runs whose dates do not step evenly", () => {
    const resume: Record<string, unknown> = {
      work: [
        { name: "Acme", position: "Dev", startDate: "2015", endDate: "2016" },
        { name: "Acme", position: "Dev", startDate: "2019", endDate: "2020" },
        { name: "Globex", position: "QA", startDate: "2010" },
        { name: "Globex", position: "QA", startDate: "2012" },
        { name: "Globex", position: "QA", startDate: "2013" },
        { name: "Future", position: "Dev", startDate: "2026", endDate: "2027" },
      ],
    };
    expect(pruneSalvagedEntries(resume, today)).toEqual([]);
    expect(resume.work).toHaveLength(6);
  });

  it("caps a salvaged section at 40 entries", () => {
    const resume: Record<string, unknown> = {
      work: Array.from({ length: 45 }, (_, i) => ({ name: `Company ${i}`, position: `Role ${i}` })),
    };
    const warnings = pruneSalvagedEntries(resume, today);
    expect(resume.work).toHaveLength(SALVAGE_MAX_ENTRIES);
    expect(warnings).toEqual([
      "model: kept the first 40 work entries and dropped 5 more (a salvaged output is not trusted past that).",
    ]);
  });

  it("is applied by salvageLoopingOutput, which reports what it pruned", () => {
    const entry = (year: number) =>
      `{"name": "Acme", "position": "Dev", "startDate": "${year}", "endDate": "${year + 1}", "highlights": ["Loop ${year}"]}`;
    const text = `{"basics": {"name": "Ana"}, "work": [${Array.from({ length: 8 }, (_, i) => entry(2015 + i)).join(", ")}, {"name": "Acme", "posi`;
    const warnings: string[] = [];
    const salvaged = salvageLoopingOutput([text], { referenceDate: today, warnings }) as {
      work: Array<{ startDate: string }>;
    };
    expect(salvaged.work.map((w) => w.startDate)).toEqual(["2015"]);
    expect(warnings).toEqual([
      "model: removed 7 work entries that repeat another entry with dates counting in a fixed step (fabricated by the repetition loop).",
    ]);
  });
});
