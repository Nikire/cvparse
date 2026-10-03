import { describe, expect, it } from "vitest";
import { detectLanguage, normalizeResume, ResumeSchema } from "../src/index.js";
import {
  splitOrgAndTitle,
  splitSkillList,
  splitTitleAndOrg,
  stripTitleFromOrg,
} from "../src/normalize/resume.js";
import { looksLikeJobTitle, looksLikeOrganization } from "../src/normalize/titles.js";
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
    // Derived from skills (group keywords), not from the model's normalizedSkills.
    expect(resume.x_cvparse?.normalizedSkills).toEqual([
      "node.js",
      "typescript",
      "nestjs",
      "express",
      "postgresql",
      "mongodb",
      "kafka",
      "docker",
      "kubernetes",
      "github actions",
      "aws",
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

describe("normalizeResume: precision, multi-date fields and confidence notes", () => {
  const SOURCE = [
    "Erik Example",
    "EDUCATION",
    "Computer Engineering — Universidad Tecnológica (2020–2021)",
    "Electronic Technician — Escuela Técnica N° 1 (2012–2017)",
    "EXPERIENCE",
    "Backend Developer, Acme — March 2022 – Present",
  ].join("\n");

  it("reduces months the document never wrote, with a precision warning", () => {
    const { resume, warnings } = normalizeResume(
      {
        education: [
          { institution: "Universidad Tecnológica", startDate: "2020-01", endDate: "2021-01" },
          { institution: "Escuela Técnica N° 1", startDate: "2012", endDate: "2017-01-01" },
        ],
        work: [{ name: "Acme", startDate: "2022-03-01", endDate: null }],
      },
      undefined,
      { sourceText: SOURCE },
    );
    expect(resume.education?.[0]).toMatchObject({ startDate: "2020", endDate: "2021" });
    expect(resume.education?.[1]).toMatchObject({ startDate: "2012", endDate: "2017" });
    expect(resume.work?.[0]?.startDate).toBe("2022-03");
    expect(warnings).toEqual([
      'precision: work[0].startDate "2022-03-01" reduced to "2022-03" (no day in the document).',
      'precision: education[0].startDate "2020-01" reduced to "2020" (no month in the document).',
      'precision: education[0].endDate "2021-01" reduced to "2021" (no month in the document).',
      'precision: education[1].endDate "2017-01-01" reduced to "2017" (no month in the document).',
    ]);
  });

  it("keeps months the document wrote and does nothing without options.sourceText", () => {
    const input = { work: [{ name: "Acme", startDate: "2021-01", endDate: null }] };
    const withMonth = normalizeResume(input, undefined, {
      sourceText: "Acme — Enero 2021 – actualidad",
    });
    expect(withMonth.resume.work?.[0]?.startDate).toBe("2021-01");
    const plain = normalizeResume({ education: [{ startDate: "2020-01" }] }, SOURCE);
    expect(plain.resume.education?.[0]?.startDate).toBe("2020-01");
    expect(plain.warnings.some((w) => w.startsWith("precision:"))).toBe(false);
  });

  it("applies the precision check to dates split from a range", () => {
    const { resume } = normalizeResume(
      { education: [{ startDate: "2020 - 2021-01" }] },
      undefined,
      {
        sourceText: SOURCE,
      },
    );
    expect(resume.education?.[0]).toMatchObject({ startDate: "2020", endDate: "2021" });
  });

  it("keeps the latest date when a single-date field lists several", () => {
    const { resume, warnings } = normalizeResume({
      awards: [
        { title: "A", date: "2010" },
        { title: "B", date: "2011" },
        { title: "C", date: "2012" },
        { title: "Hackathon winner", date: "2012, 2019" },
      ],
      certificates: [{ name: "AWS", date: "Mar 2018 y Jun 2020" }],
      publications: [{ name: "Paper", releaseDate: "2015; 2016" }],
    });
    expect(resume.awards?.[3]?.date).toBe("2019");
    expect(resume.certificates?.[0]?.date).toBe("2020-06");
    expect(resume.publications?.[0]?.releaseDate).toBe("2016");
    expect(warnings).toEqual([
      'awards[3].date: "2012, 2019" has several dates; kept the latest ("2019").',
      'certificates[0].date: "Mar 2018 y Jun 2020" has several dates; kept the latest ("2020-06").',
      'publications[0].releaseDate: "2015; 2016" has several dates; kept the latest ("2016").',
    ]);
  });

  it("does not pick the latest of a list in start/end fields", () => {
    const { resume, warnings } = normalizeResume({ work: [{ endDate: "2012, 2019" }] });
    expect(resume.work?.[0]?.endDate).toBeNull();
    expect(warnings).toEqual([
      'work[0].endDate: could not normalize date "2012, 2019"; set to null.',
    ]);
  });

  it("drops confidence notes that are not readable text (regression: hash-like notes)", () => {
    const notes = [
      "8e51",
      "e7b3",
      "e78b",
      "b4ac",
      "deadbeef01",
      "8e51 e7b3 b4ac",
      "ok",
      "a1b2c3d4e5f6",
      "x-12-99-7",
      "Two email addresses found; used the first one",
      "Dates unclear",
      "Ilegible",
    ];
    const { resume } = normalizeResume({ x_cvparse: { confidenceNotes: notes } });
    expect(resume.x_cvparse?.confidenceNotes).toEqual([
      "Two email addresses found; used the first one",
      "Dates unclear",
      "Ilegible",
    ]);
  });
});

describe("normalizeResume: second real-CV run (titles, skills, normalizedSkills, dates)", () => {
  it("removes a position glued to the company name, at the end or at the start", () => {
    const { resume, warnings } = normalizeResume({
      work: [
        { name: "Freelance — Full-Stack Developer", position: "Full-Stack Developer" },
        { name: "Senior Developer | Acme", position: "senior developer" },
        { name: "Coca-Cola", position: "Cola" },
        { name: "Full-Stack Labs", position: "Stack Labs" },
      ],
      education: [
        {
          institution: "Universidad de Buenos Aires, Computer Engineering",
          studyType: "Computer Engineering",
        },
      ],
    });
    expect(resume.work?.map((w) => w.name)).toEqual([
      "Freelance",
      "Acme",
      "Coca-Cola",
      "Full-Stack Labs",
    ]);
    expect(resume.education?.[0]?.institution).toBe("Universidad de Buenos Aires");
    expect(warnings).toContain(
      'work[0].name: removed the position from "Freelance — Full-Stack Developer"; kept "Freelance".',
    );
    expect(warnings).toHaveLength(3);
  });

  it("splits comma/semicolon-joined keywords and names without breaking Node.js, CI/CD or Agile / Scrum", () => {
    const { resume } = normalizeResume({
      skills: [
        {
          name: "Practices",
          keywords: [
            "Agile / Scrum, Code Review, Technical Documentation",
            "CI/CD; Node.js",
            "code review",
          ],
        },
        { name: "TypeScript, React", level: "Advanced", keywords: [] },
        { name: "Cloud (AWS, GCP)", keywords: [] },
      ],
    });
    expect(resume.skills).toEqual([
      {
        name: "Practices",
        keywords: ["Agile / Scrum", "Code Review", "Technical Documentation", "CI/CD", "Node.js"],
      },
      { name: "TypeScript", level: "Advanced", keywords: [] },
      { name: "React", level: "Advanced", keywords: [] },
      { name: "Cloud (AWS, GCP)", keywords: [] },
    ]);
  });

  it("derives normalizedSkills from skills and ignores the model's value", () => {
    const { resume } = normalizeResume({
      skills: [
        { name: "Backend", keywords: ["TypeScript", "Node.js, PostgreSQL"] },
        { name: "Docker", keywords: [] },
        { name: "typescript" },
      ],
      x_cvparse: {
        normalizedSkills: ['{"name":"backend","keywords":"typescript,node.js"}', "team leadership"],
      },
    });
    expect(resume.x_cvparse?.normalizedSkills).toEqual([
      "typescript",
      "node.js",
      "postgresql",
      "docker",
    ]);
  });

  it("omits normalizedSkills when there are no skills", () => {
    const { resume } = normalizeResume({ x_cvparse: { normalizedSkills: ["react"] } });
    expect(resume.x_cvparse).toEqual({});
  });

  it("turns an 'In progress' certificate date into null without a warning", () => {
    const { resume, warnings } = normalizeResume({
      certificates: [{ name: "AWS SAA", date: "In progress" }],
      awards: [{ title: "X", date: "em andamento" }],
    });
    expect(resume.certificates?.[0]?.date).toBeNull();
    expect(resume.awards?.[0]?.date).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe("splitSkillList / stripTitleFromOrg", () => {
  it("splits only on '; ' and ', ' outside parentheses", () => {
    expect(splitSkillList("Agile / Scrum, Code Review;Docs")).toEqual([
      "Agile / Scrum",
      "Code Review",
      "Docs",
    ]);
    expect(splitSkillList("Node.js")).toEqual(["Node.js"]);
    expect(splitSkillList("CI/CD")).toEqual(["CI/CD"]);
    expect(splitSkillList("1,000 users")).toEqual(["1,000 users"]);
    expect(splitSkillList("Cloud (AWS, GCP), Linux")).toEqual(["Cloud (AWS, GCP)", "Linux"]);
  });

  it("returns null when the title is not glued to the organization", () => {
    expect(stripTitleFromOrg("Freelance", "Developer")).toBeNull();
    expect(stripTitleFromOrg("Full-Stack", "Stack")).toBeNull();
    expect(stripTitleFromOrg("Acme · Developer", "developer")).toBe("Acme");
    expect(stripTitleFromOrg("Developer - Acme", "Developer")).toBe("Acme");
  });
});

describe("normalizeResume — organization and title copied into both fields", () => {
  it("splits on em/en dash, pipe, middle dot and a spaced hyphen", () => {
    expect(splitOrgAndTitle("Freelance — Full-Stack Developer")).toEqual([
      "Freelance",
      "Full-Stack Developer",
    ]);
    expect(splitOrgAndTitle("Acme – Dev")).toEqual(["Acme", "Dev"]);
    expect(splitOrgAndTitle("Acme | Dev | Remote")).toEqual(["Acme", "Dev | Remote"]);
    expect(splitOrgAndTitle("Acme · Dev")).toEqual(["Acme", "Dev"]);
    expect(splitOrgAndTitle("Acme - Dev")).toEqual(["Acme", "Dev"]);
    expect(splitOrgAndTitle("Full-Stack Developer")).toBeNull();
    expect(splitOrgAndTitle("— Dev")).toBeNull();
  });

  it("splits work name/position and education institution/studyType, with a warning", () => {
    const { resume, warnings } = normalizeResume({
      work: [
        {
          name: "Freelance — Full-Stack Developer",
          position: "Freelance — Full-Stack Developer",
        },
      ],
      education: [
        {
          institution: "Universidad de Buenos Aires | Computer Engineering",
          studyType: "universidad de buenos aires | computer engineering",
        },
      ],
    });
    expect(resume.work?.[0]).toMatchObject({ name: "Freelance", position: "Full-Stack Developer" });
    expect(resume.education?.[0]).toMatchObject({
      institution: "Universidad de Buenos Aires",
      studyType: "Computer Engineering",
    });
    expect(resume.x_cvparse?.educationLevels?.[0]?.original).toBe("Computer Engineering");
    expect(warnings).toContain(
      'work[0]: name and position were both "Freelance — Full-Stack Developer"; split into name "Freelance" and position "Full-Stack Developer".',
    );
    expect(warnings.some((w) => w.startsWith("education[0]: institution and studyType"))).toBe(
      true,
    );
  });

  it("leaves equal values without a separator alone", () => {
    const { resume, warnings } = normalizeResume({
      work: [{ name: "Freelance", position: "Freelance" }],
    });
    expect(resume.work?.[0]).toMatchObject({ name: "Freelance", position: "Freelance" });
    expect(warnings).toEqual([]);
  });
});

describe("normalizeResume — the whole entry line in work[].name, position empty", () => {
  it("tells job titles from employers", () => {
    expect(looksLikeJobTitle("Científica de Datos")).toBe(true);
    expect(looksLikeJobTitle("Analista de Datos Sr.")).toBe(true);
    expect(looksLikeJobTitle("Enfermero Asistencial")).toBe(true);
    expect(looksLikeJobTitle("Tech Lead Backend")).toBe(true);
    expect(looksLikeJobTitle("Telecom de los Andes S.A.")).toBe(false);
    expect(looksLikeJobTitle("Analítica de los Andes S.R.L.")).toBe(false);
    expect(looksLikeJobTitle("Clínica Santa Brígida del Rímac")).toBe(false);
    expect(looksLikeJobTitle("Freelance")).toBe(false);
    expect(looksLikeOrganization("Datos del Litoral S.A.S.")).toBe(true);
    expect(looksLikeOrganization("Datacenter del Pacífico S.A.C.")).toBe(true);
    expect(looksLikeOrganization("Universitat del Mediterrani Occidental")).toBe(true);
    expect(looksLikeOrganization("Analista de Datos")).toBe(false);
  });

  it("splits 'Title, Company' only when one side is a title and the other an employer", () => {
    expect(splitTitleAndOrg("Científica de Datos, Telecom de los Andes S.A.")).toEqual({
      title: "Científica de Datos",
      org: "Telecom de los Andes S.A.",
    });
    expect(splitTitleAndOrg("Analista de Datos Sr., Analítica de los Andes S.R.L.")).toEqual({
      title: "Analista de Datos Sr.",
      org: "Analítica de los Andes S.R.L.",
    });
    expect(splitTitleAndOrg("Freelance — Full-Stack Developer")).toEqual({
      title: "Full-Stack Developer",
      org: "Freelance",
    });
    // Unsure: no title word, both titles, or a comma split without an employer marker.
    expect(splitTitleAndOrg("Acme, Inc.")).toBeNull();
    expect(splitTitleAndOrg("Globant")).toBeNull();
    expect(splitTitleAndOrg("Analista, Desarrollador")).toBeNull();
    expect(splitTitleAndOrg("Analista de Ventas, Atención al cliente")).toBeNull();
  });

  it("splits the es-ar-008 shape: 'Científica de Datos, Telecom de los Andes S.A.' with position null", () => {
    // What llama3.1 returned for "septiembre 2021 – actualidad · Científica de Datos, Telecom de
    // los Andes S.A. (Remoto)".
    const { resume, warnings } = normalizeResume({
      work: [
        {
          name: "Científica de Datos, Telecom de los Andes S.A.",
          position: null,
          location: "Remoto",
          startDate: "2021-09",
        },
        {
          name: "Analista de Datos Jr., Retail del Sur S.R.L.",
          position: null,
          location: "Rosario",
        },
      ],
    });
    expect(resume.work?.map((w) => [w.name, w.position])).toEqual([
      ["Telecom de los Andes S.A.", "Científica de Datos"],
      ["Retail del Sur S.R.L.", "Analista de Datos Jr."],
    ]);
    expect(warnings).toContain(
      'work[0].name: "Científica de Datos, Telecom de los Andes S.A." holds the position too; split into name "Telecom de los Andes S.A." and position "Científica de Datos".',
    );
  });

  it("keeps the model's name when it cannot tell the title from the employer", () => {
    const { resume, warnings } = normalizeResume({
      work: [
        { name: "Acme, Inc.", position: null },
        { name: "Mercado Libre", position: null },
      ],
      education: [{ institution: "Licenciatura en Economía, Universidad del Litoral" }],
    });
    expect(resume.work?.map((w) => [w.name, w.position])).toEqual([
      ["Acme, Inc.", null],
      ["Mercado Libre", null],
    ]);
    expect(resume.education?.[0]?.institution).toBe(
      "Licenciatura en Economía, Universidad del Litoral",
    );
    expect(warnings).toEqual([]);
  });
});

describe("normalizeResume: repeated entries", () => {
  it("removes exact duplicates the model repeated, with a model: warning", () => {
    const job = {
      name: "Banco Andino",
      position: "Analista",
      startDate: "marzo 2020",
      highlights: ["Reportes", "Reportes"],
    };
    const { resume, warnings } = normalizeResume({
      work: [job, { ...job }, { ...job, name: " Banco  Andino " }, { ...job, position: "Jefe" }],
      languages: [{ language: "Inglés" }, { language: "Inglés" }],
    });
    expect(resume.work).toHaveLength(2);
    expect(resume.work?.[0]?.highlights).toEqual(["Reportes"]);
    expect(resume.work?.[0]?.startDate).toBe("2020-03");
    expect(resume.languages).toHaveLength(1);
    expect(warnings).toContain(
      "model: removed 2 repeated entries from work (the model repeated itself).",
    );
    expect(warnings).toContain(
      "model: removed 1 repeated entry from languages (the model repeated itself).",
    );
    // Dates are normalized once per remaining entry, not once per repeat.
    expect(warnings.filter((w) => w.includes("startDate"))).toEqual([]);
  });

  it("keeps entries that only share some fields", () => {
    const { resume, warnings } = normalizeResume({
      work: [
        { name: "Acme", position: "Dev", startDate: "2020" },
        { name: "Acme", position: "Dev", startDate: "2018" },
      ],
    });
    expect(resume.work).toHaveLength(2);
    expect(warnings.some((w) => w.includes("repeated"))).toBe(false);
  });
});
