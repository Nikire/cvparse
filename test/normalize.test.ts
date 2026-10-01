import { describe, expect, it } from "vitest";
import { detectLanguage, normalizeResume, ResumeSchema } from "../src/index.js";
import { fixture, SPANISH_EXTRACTION } from "./helpers.js";

describe("normalizeResume", () => {
  it("normalizes model output into a valid ResumeSchema object", () => {
    const { resume, warnings } = normalizeResume(SPANISH_EXTRACTION, fixture("cv-es-backend.txt"));
    expect(ResumeSchema.safeParse(resume).success).toBe(true);
    expect(warnings).toEqual([]);

    expect(resume.work?.[0]?.startDate).toBe("2021-03");
    expect(resume.work?.[0]?.endDate).toBeNull();
    expect(resume.work?.[1]?.startDate).toBe("2018-06");
    expect(resume.work?.[1]?.endDate).toBe("2021-02");
    expect(resume.work?.[2]?.startDate).toBe("2016");
    expect(resume.certificates?.[0]?.date).toBe("2022-11");
    expect(resume.certificates?.[1]?.date).toBe("2020");

    expect(resume.x_cvparse?.detectedLanguage).toBe("es");
    expect(resume.x_cvparse?.normalizedSkills).toEqual([
      "node.js",
      "typescript",
      "postgresql",
      "kafka",
    ]);
    expect(resume.x_cvparse?.location?.countryCode).toBe("AR");
    expect(resume.basics?.location?.countryCode).toBe("AR");
    expect(resume.education?.[0]?.studyType).toBe("Ingeniería");
    expect(resume.x_cvparse?.educationLevels).toEqual([
      { level: "bachelor", canonical: "Ingeniería", original: "Ingeniería" },
    ]);
  });

  it("does not mutate its input", () => {
    const input = structuredClone(SPANISH_EXTRACTION);
    normalizeResume(input);
    expect(input).toEqual(SPANISH_EXTRACTION);
  });

  it("turns empty strings into null and drops empty list items", () => {
    const { resume } = normalizeResume({
      basics: { name: "  Ana  ", email: "", phone: "   " },
      work: [{ highlights: ["ok", "", "  "] }],
    });
    expect(resume.basics).toEqual({ name: "Ana", email: null, phone: null });
    expect(resume.work?.[0]?.highlights).toEqual(["ok"]);
  });

  it("warns and nulls dates it cannot understand", () => {
    const { resume, warnings } = normalizeResume({
      work: [{ startDate: "en algún momento", endDate: 2020 }],
      awards: [{ date: "fecha ilegible" }],
    });
    expect(resume.work?.[0]?.startDate).toBeNull();
    expect(resume.work?.[0]?.endDate).toBeNull();
    expect(resume.awards?.[0]?.date).toBeNull();
    expect(warnings).toEqual([
      'work[0].startDate: could not normalize date "en algún momento"; set to null.',
      "work[0].endDate: expected a date string, got number; set to null.",
      'awards[0].date: could not normalize date "fecha ilegible"; set to null.',
    ]);
    expect(ResumeSchema.safeParse(resume).success).toBe(true);
  });

  it("rejects bogus country codes with a warning", () => {
    const { resume, warnings } = normalizeResume({
      basics: { location: { countryCode: "Argentina" } },
      x_cvparse: { location: { countryCode: "co" } },
    });
    expect(resume.basics?.location?.countryCode).toBeNull();
    expect(resume.x_cvparse?.location?.countryCode).toBe("CO");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("basics.location.countryCode");
  });

  it("falls back to heuristic language detection when the model omits it", () => {
    const { resume, warnings } = normalizeResume({}, fixture("cv-en-designer.txt"));
    expect(resume.x_cvparse?.detectedLanguage).toBe("en");
    expect(warnings[0]).toContain("heuristically");
  });

  it("fills x_cvparse.educationLevels in order and leaves studyType untouched", () => {
    const { resume, warnings } = normalizeResume({
      education: [
        { institution: "UTN", area: "Sistemas", studyType: "Ingeniería en Sistemas" },
        { institution: "UBA", area: "Licenciatura en Economía", studyType: "" },
        { institution: "Coderhouse", area: "Frontend", studyType: "Bootcamp Full Stack" },
        { institution: "ISEP", area: "Enfermería", studyType: "Diplomatura" },
        { institution: "Platzi", area: "Marketing", studyType: "Diplomado en Marketing Digital" },
        { institution: "Colegio Nacional", area: null, studyType: "Otro" },
        "garbage",
      ],
    });
    expect(warnings).toEqual([]);
    expect(resume.education?.map((e) => (typeof e === "object" ? e?.studyType : e))).toEqual([
      "Ingeniería en Sistemas",
      null,
      "Bootcamp Full Stack",
      "Diplomatura",
      "Diplomado en Marketing Digital",
      "Otro",
      "garbage",
    ]);
    expect(resume.education?.[1]?.area).toBe("Licenciatura en Economía");
    expect(resume.x_cvparse?.educationLevels).toEqual([
      { level: "bachelor", canonical: "Ingeniería", original: "Ingeniería en Sistemas" },
      { level: "bachelor", canonical: "Licenciatura", original: null },
      { level: "course", canonical: "Bootcamp", original: "Bootcamp Full Stack" },
      { level: "bachelor", canonical: "Diplomatura", original: "Diplomatura" },
      { level: "course", canonical: "Diplomado", original: "Diplomado en Marketing Digital" },
      { level: "unknown", canonical: null, original: "Otro" },
      { level: "unknown", canonical: null, original: null },
    ]);
  });

  it("recomputes educationLevels from scratch and drops it when there is no education", () => {
    const stale = [{ level: "doctorate", canonical: "Doctorado", original: "x" }];
    const withEducation = normalizeResume({
      education: [{ studyType: "Tecnicatura en Redes" }],
      x_cvparse: { educationLevels: stale },
    });
    expect(withEducation.resume.x_cvparse?.educationLevels).toEqual([
      { level: "technical", canonical: "Tecnicatura", original: "Tecnicatura en Redes" },
    ]);
    const withoutEducation = normalizeResume({ x_cvparse: { educationLevels: stale } });
    expect(withoutEducation.resume.x_cvparse).toEqual({});
    expect(ResumeSchema.safeParse(withEducation.resume).success).toBe(true);
  });

  it("tolerates garbage input", () => {
    expect(normalizeResume(null).resume).toEqual({ x_cvparse: {} });
    expect(normalizeResume("nope").resume).toEqual({ x_cvparse: {} });
    expect(normalizeResume({ work: "not a list" }).resume.work).toBe("not a list");
  });
});

describe("detectLanguage", () => {
  it("detects Spanish fixtures", () => {
    expect(detectLanguage(fixture("cv-es-backend.txt"))).toBe("es");
    expect(detectLanguage(fixture("cv-es-ventas.txt"))).toBe("es");
  });

  it("detects the English fixture", () => {
    expect(detectLanguage(fixture("cv-en-designer.txt"))).toBe("en");
  });

  it("returns null without enough signal", () => {
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage("Juan Pérez")).toBeNull();
    expect(detectLanguage("1234 5678 9012 3456 7890 abc def")).toBeNull();
  });
});

describe("normalizeResume: single-token date ranges", () => {
  const ref = { referenceDate: new Date("2026-10-01T00:00:00Z") };

  it("splits a range the model left in startDate when endDate is empty", () => {
    const { resume, warnings } = normalizeResume(
      {
        work: [
          { name: "A", startDate: "2019-21", endDate: null },
          { name: "B", startDate: "marzo 2019 – actualidad" },
          { name: "C", startDate: "2019 - 2021", endDate: "2022" },
        ],
      },
      undefined,
      ref,
    );
    expect(resume.work?.[0]).toMatchObject({ startDate: "2019", endDate: "2021" });
    expect(resume.work?.[1]).toMatchObject({ startDate: "2019-03", endDate: null });
    // endDate already set: the range token is not split, it is reported instead.
    expect(resume.work?.[2]).toMatchObject({ startDate: null, endDate: "2022" });
    expect(warnings.some((w) => w.includes("work[2].startDate"))).toBe(true);
    expect(warnings.some((w) => w.includes("work[0]") || w.includes("work[1]"))).toBe(false);
  });

  it("resolves relative dates against the reference date", () => {
    const { resume } = normalizeResume(
      { work: [{ name: "A", startDate: "hace 3 años", endDate: "hace 6 meses" }] },
      undefined,
      ref,
    );
    expect(resume.work?.[0]).toMatchObject({ startDate: "2023", endDate: "2026-04" });
  });
});
