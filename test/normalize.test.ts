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
      work: [{ startDate: "hace dos años", endDate: 2020 }],
      awards: [{ date: "Q3 2020" }],
    });
    expect(resume.work?.[0]?.startDate).toBeNull();
    expect(resume.work?.[0]?.endDate).toBeNull();
    expect(resume.awards?.[0]?.date).toBeNull();
    expect(warnings).toEqual([
      'work[0].startDate: could not normalize date "hace dos años"; set to null.',
      "work[0].endDate: expected a date string, got number; set to null.",
      'awards[0].date: could not normalize date "Q3 2020"; set to null.',
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
