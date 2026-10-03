import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCoverage, groundResume, parseResume, type Resume } from "../src/index.js";
import {
  detectSectionHeadings,
  detectSectionSpans,
  normalizeForMatch,
} from "../src/normalize/grounding.js";
import { fakeOcrAdapter, mockModelWithObject } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const PNG = readFileSync(join(here, "fixtures", "image", "cv-es-two-column.png"));

/** A 3-section English CV with no phone number, living in Buenos Aires. */
const EN_CV = `JORDAN EXAMPLE
Senior Full-Stack Developer
Buenos Aires, Argentina · jordan.example@example.com · linkedin.com/in/jordan-example · github.com/jexample
Languages: English (C1), Spanish (Native)

SUMMARY
Full-stack developer building web platforms for staffing companies.

EXPERIENCE
Acme Staffing — Senior Developer
2022 – Present
- Built APIs with Node.js, C# and .NET; frontend in React and Next.js.
Globex — Developer
2019 – 2022
- Worked with JavaScript, TypeScript and PostgreSQL.
Initech — Junior Developer
2017 – 2019
- Maintained internal tools.

SKILLS
JavaScript, TypeScript, Node.js, Next.js, React, C#, .NET, PostgreSQL, Docker

FEATURED PROJECTS
Talent Graph — open source candidate matcher

COURSES & CERTIFICATIONS
Cloud Practitioner, 2023
`;

/** What llama3.1 8B produced for a CV like {@link EN_CV}: hallucinated contact, place, skills. */
function hallucinated(): Resume {
  return {
    basics: {
      name: "Jordan Example",
      email: "jordan.example@example.com",
      phone: "+54 9 11 1234 5678",
      location: { city: "Montevideo", countryCode: "UY", region: "Montevideo" },
      profiles: [
        { network: "LinkedIn", url: "https://www.linkedin.com/in/jordan-example/" },
        { network: "GitHub", username: "jexample", url: "https://github.com/jexample" },
        { network: "Twitter", url: "https://twitter.com/jordan_dev" },
      ],
    },
    work: [
      { name: "Acme Staffing", position: "Senior Developer", location: "Buenos Aires, Argentina" },
      { name: "Globex", position: "Developer", location: "Buenos Aires, Argentina" },
      { name: "Initech", position: "Junior Developer", location: "Buenos Aires, Argentina" },
    ],
    skills: [
      { name: "JavaScript", level: ".NET" },
      { name: "Node.js", level: ".NET" },
      { name: "C#", level: ".NET" },
      { name: "Next.js", level: ".NET" },
      { name: ".NET", level: null },
      { name: "Azure", level: ".NET" },
      { name: "Kubernetes", level: ".NET" },
      { name: "DevOps", keywords: ["Azure", "Kubernetes"] },
    ],
    languages: [{ language: "English", fluency: "C1" }],
    x_cvparse: {
      normalizedSkills: ["javascript", "node.js", "c#", "azure", "kubernetes", ".net"],
      location: { city: "Montevideo", countryCode: "UY", raw: "Montevideo, Uruguay" },
    },
  };
}

describe("normalizeForMatch", () => {
  it("applies NFKC, strips diacritics, lowercases and collapses whitespace", () => {
    expect(normalizeForMatch("  Bogotá\n D.C.  ")).toBe("bogota d.c.");
    expect(normalizeForMatch("ＥＳＰＡÑＯＬ")).toBe("espanol");
  });
});

describe("groundResume — the llama3.1 hallucinations", () => {
  const { resume, warnings } = groundResume(hallucinated(), EN_CV);

  it("drops a phone that is not in the document", () => {
    expect(resume.basics?.phone).toBeNull();
    expect(warnings).toContain(
      'grounding: dropped basics.phone "+54 9 11 1234 5678" (not found in the document)',
    );
  });

  it("drops Montevideo when the document says Buenos Aires", () => {
    expect(resume.x_cvparse?.location).toBeNull();
    expect(resume.basics?.location).toBeNull();
    expect(warnings.some((w) => w.includes('x_cvparse.location "Montevideo, Uruguay"'))).toBe(true);
    expect(warnings.some((w) => w.includes('basics.location.city "Montevideo"'))).toBe(true);
    expect(warnings.some((w) => w.includes('basics.location.countryCode "UY"'))).toBe(true);
  });

  it("drops invented skills and keeps the real ones, including punctuated names", () => {
    const names = resume.skills?.map((s) => s.name);
    expect(names).toEqual(["JavaScript", "Node.js", "C#", "Next.js", ".NET"]);
    const summary = warnings.find((w) => w.startsWith("grounding: dropped 3 skills"));
    expect(summary).toBe(
      "grounding: dropped 3 skills not found in the document: Azure, Kubernetes, DevOps",
    );
    expect(resume.x_cvparse?.normalizedSkills).toEqual(["javascript", "node.js", "c#", ".net"]);
  });

  it("drops a level that is the name of another skill", () => {
    expect(resume.skills?.every((s) => s.level === null)).toBe(true);
    expect(warnings.some((w) => w.startsWith("grounding: dropped the level of 4 skills"))).toBe(
      true,
    );
  });

  it("drops the candidate's city copied into every work entry", () => {
    expect(resume.work?.map((w) => w.location)).toEqual([null, null, null]);
    expect(
      warnings.some((w) =>
        w.includes('dropped location "Buenos Aires, Argentina" from 3 work entries'),
      ),
    ).toBe(true);
  });

  it("keeps grounded contact data and drops an invented profile", () => {
    expect(resume.basics?.email).toBe("jordan.example@example.com");
    expect(resume.basics?.profiles?.map((p) => p.network)).toEqual(["LinkedIn", "GitHub"]);
    expect(resume.basics?.profiles?.[1]?.username).toBe("jexample");
    expect(warnings).toContain(
      'grounding: dropped basics.profiles[2].url "https://twitter.com/jordan_dev" (not found in the document)',
    );
  });

  it("keeps languages written in a header line", () => {
    expect(resume.languages).toEqual([{ language: "English", fluency: "C1" }]);
  });

  it("does not mutate the input", () => {
    const input = hallucinated();
    groundResume(input, EN_CV);
    expect(input.basics?.phone).toBe("+54 9 11 1234 5678");
  });
});

describe("groundResume — contact data", () => {
  it("keeps a phone when the model added a country code or reformatted it", () => {
    const src = "Ana Pérez\nTel: (011) 15 5555-1234\nana@example.com";
    const { resume, warnings } = groundResume(
      { basics: { phone: "+54 9 11 5555 1234", email: "ANA@example.com" } },
      src,
    );
    expect(resume.basics?.phone).toBe("+54 9 11 5555 1234");
    expect(resume.basics?.email).toBe("ANA@example.com");
    expect(warnings).toEqual([]);
  });

  it("does not ground a phone from a date range", () => {
    const { resume } = groundResume(
      { basics: { phone: "2019-2021" } },
      "Acme 2019-2022\nGlobex 2017-2019",
    );
    expect(resume.basics?.phone).toBeNull();
  });

  it("drops an email and a website that are not in the document", () => {
    const { resume, warnings } = groundResume(
      { basics: { email: "john.doe@example.com", url: "https://johndoe.dev" } },
      "Ana Pérez\nana@example.com",
    );
    expect(resume.basics?.email).toBeNull();
    expect(resume.basics?.url).toBeNull();
    expect(warnings).toHaveLength(2);
  });

  it("matches URLs without scheme, www or trailing slash", () => {
    const { resume, warnings } = groundResume(
      { basics: { url: "https://www.anaperez.dev/" } },
      "Portfolio: anaperez.dev",
    );
    expect(resume.basics?.url).toBe("https://www.anaperez.dev/");
    expect(warnings).toEqual([]);
  });
});

describe("groundResume — locations", () => {
  it("accepts CABA for Ciudad Autónoma de Buenos Aires", () => {
    const { resume, warnings } = groundResume(
      {
        basics: { location: { city: "Ciudad Autónoma de Buenos Aires", countryCode: "AR" } },
        x_cvparse: { location: { city: "Ciudad Autónoma de Buenos Aires", raw: "CABA" } },
      },
      "Ana Pérez — CABA",
    );
    expect(resume.basics?.location?.city).toBe("Ciudad Autónoma de Buenos Aires");
    expect(resume.x_cvparse?.location?.city).toBe("Ciudad Autónoma de Buenos Aires");
    expect(warnings).toEqual([]);
  });

  it("accepts CDMX and Bogotá D.C. aliases, accent-insensitively", () => {
    expect(
      groundResume({ x_cvparse: { location: { city: "Ciudad de México" } } }, "Vivo en CDMX")
        .warnings,
    ).toEqual([]);
    expect(
      groundResume({ x_cvparse: { location: { city: "Bogotá" } } }, "Bogota D.C., Colombia")
        .warnings,
    ).toEqual([]);
  });

  it("keeps the country code of an ungrounded city only when the country is written", () => {
    const { resume } = groundResume(
      { basics: { location: { city: "Rosario", countryCode: "AR" } } },
      "Ana Pérez — Argentina",
    );
    expect(resume.basics?.location).toEqual({
      city: null,
      region: null,
      address: null,
      postalCode: null,
      countryCode: "AR",
    });
  });

  it("drops entry locations that are not in the document, one warning per section", () => {
    const { resume, warnings } = groundResume(
      {
        work: [
          { name: "Acme", location: "Lima" },
          { name: "Globex", location: "Quito" },
          { name: "Initech", location: "Córdoba" },
        ],
        education: [{ institution: "UBA", location: "Madrid" } as never],
      },
      "Acme — Córdoba\nGlobex\nInitech — Cordoba\nUBA",
    );
    expect(resume.work?.map((w) => w.location)).toEqual([null, null, "Córdoba"]);
    expect(warnings).toContain(
      "grounding: dropped location from 2 work entries (not found in the document)",
    );
    expect(warnings).toContain(
      "grounding: dropped location from 1 education entry (not found in the document)",
    );
  });

  it("keeps a shared entry location when the document repeats it", () => {
    const { resume, warnings } = groundResume(
      {
        work: [
          { name: "Acme", location: "Buenos Aires" },
          { name: "Globex", location: "Buenos Aires" },
        ],
      },
      "Ana — Buenos Aires\nAcme — Buenos Aires\nGlobex — Buenos Aires",
    );
    expect(resume.work?.map((w) => w.location)).toEqual(["Buenos Aires", "Buenos Aires"]);
    expect(warnings).toEqual([]);
  });
});

describe("groundResume — skills", () => {
  it('does not ground "Java" from "JavaScript" nor "C" from "C#"', () => {
    const { resume, warnings } = groundResume(
      { skills: [{ name: "Java" }, { name: "C" }, { name: "JavaScript" }, { name: "C++" }] },
      "Skills: JavaScript, C#, C++",
    );
    expect(resume.skills?.map((s) => s.name)).toEqual(["JavaScript", "C++"]);
    expect(warnings).toEqual(["grounding: dropped 2 skills not found in the document: Java, C"]);
  });

  it("matches separator variants (NextJS / Next.js) and accents", () => {
    const { resume } = groundResume(
      { skills: [{ name: "Next.js" }, { name: "Gestión de proyectos" }] },
      "NextJS, gestion de proyectos",
    );
    expect(resume.skills).toHaveLength(2);
  });

  it("filters keywords of grouped skills and keeps the group label", () => {
    const { resume, warnings } = groundResume(
      { skills: [{ name: "Backend", keywords: ["Node.js", "Go", "PostgreSQL"] }] },
      "Node.js, PostgreSQL",
    );
    expect(resume.skills).toEqual([{ name: "Backend", keywords: ["Node.js", "PostgreSQL"] }]);
    expect(warnings).toEqual(["grounding: dropped 1 skill not found in the document: Go"]);
  });

  it("keeps a level written next to the skill (same or next line)", () => {
    const { resume, warnings } = groundResume(
      {
        skills: [
          { name: "Python", level: "Avanzado" },
          { name: "SQL", level: "Intermedio" },
          { name: "Excel", level: "Experto" },
        ],
      },
      "Python (Avanzado)\nSQL\nIntermedio\nExcel\n\n\nOtro: Experto",
    );
    expect(resume.skills?.map((s) => s.level)).toEqual(["Avanzado", "Intermedio", null]);
    expect(warnings).toEqual([
      "grounding: dropped the level of 1 skill (not written next to the skill): Excel: Experto",
    ]);
  });

  it("summarizes long lists of dropped skills", () => {
    const skills = Array.from({ length: 12 }, (_, i) => ({ name: `Fake${i}` }));
    const { warnings } = groundResume({ skills }, "Nothing here");
    expect(warnings[0]).toMatch(/dropped 12 skills .*Fake9 and 2 more$/);
  });
});

describe("groundResume — languages", () => {
  it("keeps languages written in any of es/en/pt and drops invented ones", () => {
    const { resume, warnings } = groundResume(
      {
        languages: [
          { language: "Spanish", fluency: "Native" },
          { language: "Inglés", fluency: "B2" },
          { language: "Portuguese" },
          { language: "French" },
        ],
      },
      "Idiomas: Español (nativo), English B2, Português básico",
    );
    expect(resume.languages?.map((l) => l.language)).toEqual(["Spanish", "Inglés", "Portuguese"]);
    expect(resume.languages?.map((l) => l.fluency)).toEqual(["nativo", "B2", undefined]);
    expect(warnings).toEqual([
      "grounding: dropped 1 language not found in the document: French",
      'grounding: languages[0].fluency "Native" replaced by "nativo" as written',
    ]);
  });
});

describe("checkCoverage", () => {
  it("detects headings in English and Spanish, case- and accent-insensitively", () => {
    const found = detectSectionHeadings(
      [
        "EXPERIENCIA LABORAL",
        "Formación académica",
        "• Habilidades:",
        "Featured Projects",
        "Courses & Certifications",
        "Idiomas: Español, Inglés",
      ].join("\n"),
    );
    expect([...found].sort()).toEqual(
      ["certificates", "education", "languages", "projects", "skills", "work"].sort(),
    );
  });

  it("ignores sentences that merely mention a section word", () => {
    const found = detectSectionHeadings(
      "Led 3 projects for fintech clients\nExperiencia en Node.js y React\nSkills matter",
    );
    expect(found.size).toBe(0);
  });

  it("warns when a section in the document is empty in the resume", () => {
    const warnings = checkCoverage(
      { work: [{ name: "Acme Staffing" }], skills: [{ name: "React" }], projects: [] },
      EN_CV,
    );
    expect(warnings).toEqual([
      'coverage: the document has a "Languages" section but languages[] is empty',
      'coverage: the document has a "Projects" section but projects[] is empty',
      'coverage: the document has a "Certifications" section but certificates[] is empty',
    ]);
  });

  it("is silent when every detected section has entries", () => {
    expect(
      checkCoverage(
        {
          work: [{ name: "Acme" }],
          skills: [{ name: "React" }],
          languages: [{ language: "English" }],
          projects: [{ name: "Talent Graph" }],
          certificates: [{ name: "Cloud Practitioner" }],
        },
        EN_CV,
      ),
    ).toEqual([]);
  });
});

describe("parseResume grounding integration", () => {
  const cv = "Ana Pérez\nDesarrolladora\nana@example.com\nCABA, Argentina";

  it("drops a phone the model invented and warns", async () => {
    const model = mockModelWithObject({
      basics: { name: "Ana Pérez", email: "ana@example.com", phone: "+54 9 11 1234 5678" },
      x_cvparse: { detectedLanguage: "es" },
    });
    const result = await parseResume(cv, { model });
    expect(result.resume.basics?.phone).toBeNull();
    expect(result.resume.basics?.email).toBe("ana@example.com");
    expect(result.warnings).toContain(
      'grounding: dropped basics.phone "+54 9 11 1234 5678" (not found in the document)',
    );
  });

  it("keeps the raw model output with grounding: false", async () => {
    const model = mockModelWithObject({
      basics: { phone: "+54 9 11 1234 5678" },
      x_cvparse: { detectedLanguage: "es" },
    });
    const result = await parseResume(cv, { model, grounding: false });
    expect(result.resume.basics?.phone).toBe("+54 9 11 1234 5678");
    expect(result.warnings.some((w) => w.startsWith("grounding:"))).toBe(false);
  });

  it("adds coverage warnings for empty sections", async () => {
    const model = mockModelWithObject({ x_cvparse: { detectedLanguage: "en" } });
    const result = await parseResume(EN_CV, { model });
    expect(result.warnings).toContain(
      'coverage: the document has a "Experience" section but work[] is empty',
    );
  });

  it("grounds OCR text like any other text", async () => {
    const model = mockModelWithObject({
      basics: { phone: "+1 555 0100 999" },
      x_cvparse: { detectedLanguage: "es" },
    });
    const result = await parseResume(PNG, { model, ocr: fakeOcrAdapter() });
    expect(result.resume.basics?.phone).toBeNull();
    expect(result.warnings).toContain(
      'grounding: dropped basics.phone "+1 555 0100 999" (not found in the document)',
    );
  });

  it("skips grounding and coverage in vision mode", async () => {
    const model = mockModelWithObject({
      basics: { phone: "+1 555 0100 999", email: "lucia.morales@example.com" },
      x_cvparse: { detectedLanguage: "es" },
    });
    const result = await parseResume(PNG, { model, ocr: "vision" });
    expect(result.resume.basics?.phone).toBe("+1 555 0100 999");
    expect(result.warnings.some((w) => /^(grounding|coverage):/.test(w))).toBe(false);
  });
});

/** Shaped like the maintainer's English CV (second real-CV run with llama3.1 8B). */
const REAL_CV = `JORDAN EXAMPLE
Full-Stack Developer
Buenos Aires, Argentina · jordan.example@example.com
Languages: English (C1), Spanish (Native)

EXPERIENCE
Freelance — Full-Stack Developer (2021 – Present)
- Built hiring platforms with TypeScript and Node.js.
Acme Staffing
Senior Developer · 2019 – 2021

EDUCATION
Universidad de Buenos Aires — Computer Engineering (2020–2021)
Escuela Técnica N° 1, Electronic Technician, 2010 – 2015

SKILLS
TypeScript, Node.js, CI/CD
Agile / Scrum, Code Review, Technical Documentation

CERTIFICATIONS
AWS Solutions Architect — In progress
`;

/** What llama3.1 8B returned for {@link REAL_CV}. */
const REAL_CV_OUTPUT = {
  basics: { name: "Jordan Example", email: "jordan.example@example.com" },
  work: [
    {
      name: "Freelance — Full-Stack Developer",
      position: "Full-Stack Developer",
      startDate: "2021",
      endDate: "Present",
    },
    { name: "Acme Staffing", position: "Software Engineer", startDate: "2019", endDate: "2021" },
  ],
  education: [
    { institution: "Universidad de Buenos Aires", studyType: "Bachelor's degree" },
    { institution: "Escuela Técnica N° 1", studyType: "Certificate" },
  ],
  skills: [
    { name: "Languages", keywords: ["TypeScript", "Node.js", "CI/CD"] },
    { name: "Practices", keywords: ["Agile / Scrum, Code Review, Technical Documentation"] },
  ],
  languages: [
    { language: "English", fluency: "Intermediate" },
    { language: "Spanish", fluency: "Native speaker" },
  ],
  certificates: [{ name: "AWS Solutions Architect", date: "In progress" }],
  x_cvparse: {
    detectedLanguage: "en",
    normalizedSkills: ['{"name":"backend","keywords":"typescript,node.js"}', "team leadership"],
  },
};

describe("parseResume — second real-CV run regressions", () => {
  it("fixes fluency, titles, glued names, joined keywords, normalizedSkills and 'In progress'", async () => {
    const model = mockModelWithObject(REAL_CV_OUTPUT);
    const { resume, warnings } = await parseResume(REAL_CV, { model });

    // 1. Fluency replaced by the level written next to the language.
    expect(resume.languages).toEqual([
      { language: "English", fluency: "C1" },
      { language: "Spanish", fluency: "Native" },
    ]);
    expect(warnings).toContain(
      'grounding: languages[0].fluency "Intermediate" replaced by "C1" as written',
    );
    expect(warnings).toContain(
      'grounding: languages[1].fluency "Native speaker" replaced by "Native" as written',
    );

    // 2. Degree types and job titles recovered from the institution / company line.
    expect(resume.education?.map((e) => e.studyType)).toEqual([
      "Computer Engineering",
      "Electronic Technician",
    ]);
    expect(warnings).toContain(
      'grounding: education[0].studyType "Bachelor\'s degree" replaced by "Computer Engineering" as written',
    );
    expect(resume.x_cvparse?.educationLevels?.map((l) => [l.level, l.original])).toEqual([
      ["bachelor", "Computer Engineering"],
      ["technical", "Electronic Technician"],
    ]);
    expect(resume.work?.[1]?.position).toBe("Senior Developer");

    // 3. Company name without the position.
    expect(resume.work?.[0]?.name).toBe("Freelance");
    expect(resume.work?.[0]?.position).toBe("Full-Stack Developer");

    // 4. Joined keywords split and kept.
    expect(resume.skills?.[1]?.keywords).toEqual([
      "Agile / Scrum",
      "Code Review",
      "Technical Documentation",
    ]);

    // 5. normalizedSkills derived from skills.
    expect(resume.x_cvparse?.normalizedSkills).toEqual([
      "typescript",
      "node.js",
      "ci/cd",
      "agile / scrum",
      "code review",
      "technical documentation",
    ]);

    // 6. "In progress" is an ongoing marker, not an unparseable date.
    expect(resume.certificates?.[0]?.date).toBeNull();
    expect(warnings.some((w) => w.includes("could not normalize"))).toBe(false);
    expect(warnings.some((w) => w.startsWith("grounding: dropped"))).toBe(false);
  });
});

describe("groundResume — language fluency", () => {
  const ground = (fluency: string, source: string, language = "English") =>
    groundResume({ languages: [{ language, fluency }] }, source);

  it("keeps a fluency equal to (or part of) the level written after the language", () => {
    expect(ground("C1", "Languages: English (C1), Spanish (Native)").warnings).toEqual([]);
    expect(ground("Avanzado (C1)", "Inglés: avanzado (C1)", "Inglés").warnings).toEqual([]);
    expect(ground("C1", "Inglés: avanzado (C1)", "Inglés").warnings).toEqual([]);
  });

  it("replaces the fluency with the level written after the language name", () => {
    expect(ground("Advanced", "Inglés - B2", "Inglés").resume.languages?.[0]?.fluency).toBe("B2");
    expect(ground("Fluent", "Inglés: avanzado", "Inglés").resume.languages?.[0]?.fluency).toBe(
      "avanzado",
    );
    expect(
      ground("Native", "IDIOMAS\nEspañol\nLengua materna", "Spanish").resume.languages?.[0]
        ?.fluency,
    ).toBe("Lengua materna");
    expect(ground("C2", "English: Advanced (C1)").resume.languages?.[0]?.fluency).toBe(
      "Advanced (C1)",
    );
  });

  it("keeps a fluency written on the language's line in another position", () => {
    const { resume, warnings } = ground("Fluent", "Fluent in English and Spanish");
    expect(resume.languages?.[0]?.fluency).toBe("Fluent");
    expect(warnings).toEqual([]);
  });

  it("sets an invented fluency to null and warns", () => {
    const { resume, warnings } = ground("Native", "Languages: English, Spanish");
    expect(resume.languages?.[0]?.fluency).toBeNull();
    expect(warnings).toEqual([
      'grounding: dropped languages[0].fluency "Native" (not written next to the language)',
    ]);
  });

  it("does not take the level of the next line when it names another language", () => {
    const { resume } = ground("Native", "English\nSpanish (Native)");
    expect(resume.languages?.[0]?.fluency).toBeNull();
  });
});

describe("groundResume — degree and job titles", () => {
  it("keeps a title that is in the document", () => {
    const { resume, warnings } = groundResume(
      { education: [{ institution: "UTN", studyType: "Ingeniería" }] },
      "UTN\nIngeniería en Sistemas · 2012 – 2017",
    );
    expect(resume.education?.[0]?.studyType).toBe("Ingeniería");
    expect(warnings).toEqual([]);
  });

  it("recovers the title before the institution, or from the next line", () => {
    const before = groundResume(
      { education: [{ institution: "Universidad de Chile", studyType: "Bachelor" }] },
      "Computer Science — Universidad de Chile (2015)",
    );
    expect(before.resume.education?.[0]?.studyType).toBe("Computer Science");
    const next = groundResume(
      { work: [{ name: "Globex", position: "Engineer" }] },
      "Globex — Remote\nPlatform Developer · Marzo 2021 – Actualidad",
    );
    expect(next.resume.work?.[0]?.position).toBe("Platform Developer");
  });

  it("does not recover places, acronyms, months or ongoing markers", () => {
    const { resume, warnings } = groundResume(
      {
        education: [{ institution: "Universidad de Buenos Aires", studyType: "Bachelor's degree" }],
      },
      "Universidad de Buenos Aires (UBA), Buenos Aires — Marzo 2015 – Present",
    );
    expect(resume.education?.[0]?.studyType).toBeNull();
    expect(warnings).toEqual([
      'grounding: dropped education[0].studyType "Bachelor\'s degree" (not found in the document)',
    ]);
  });

  it("does not take an entry's location for its title", () => {
    const { resume } = groundResume(
      { work: [{ name: "Mercado Local S.A.", position: "Backend Dev", location: "Córdoba" }] },
      "Mercado Local S.A. — Córdoba\nDesarrolladora Backend Ssr. · 06/2018 – 02/2021",
    );
    expect(resume.work?.[0]?.position).toBe("Desarrolladora Backend Ssr.");
  });

  it("keeps an unrecoverable job title with a warning", () => {
    const { resume, warnings } = groundResume(
      { work: [{ name: "Initech", position: "Software Engineer" }] },
      "Initech 2017 – 2019",
    );
    expect(resume.work?.[0]?.position).toBe("Software Engineer");
    expect(warnings).toEqual([
      'grounding: work[0].position "Software Engineer" not found in the document (kept)',
    ]);
  });

  it("recomputes educationLevels from the grounded studyType", () => {
    const { resume } = groundResume(
      {
        education: [{ institution: "ET 1", studyType: "Bachelor" }],
        x_cvparse: {
          educationLevels: [{ level: "bachelor", canonical: "Licenciatura", original: "Bachelor" }],
        },
      },
      "ET 1 — Electronic Technician",
    );
    expect(resume.x_cvparse?.educationLevels?.[0]?.level).toBe("technical");
    expect(resume.x_cvparse?.educationLevels?.[0]?.original).toBe("Electronic Technician");
  });
});

/** Shaped like the maintainer's English CV (third real-CV run with llama3.1 8B). */
const PLACEMENT_CV = `JORDAN EXAMPLE
Full-Stack Developer · Buenos Aires, Argentina

Experience
Freelance — Full-Stack Developer (January 2021 - Present)
- Built hiring platforms with TypeScript and Node.js.
Acme Staffing — Senior Developer (March 2019 - December 2020)

Education
Universidad de Buenos Aires — Computer Engineering (2020–2021)
EEST N°2 Paula Albarracín — Electronic Technician (2010–2015)

Courses & Certifications
Platzi — Node.js Course (2022)
`;

describe("detectSectionSpans", () => {
  it("maps each heading to the lines until the next heading", () => {
    const spans = detectSectionSpans(PLACEMENT_CV);
    expect(spans.map((s) => [s.key, s.heading, s.start, s.end])).toEqual([
      ["work", "Experience", 3, 8],
      ["education", "Education", 8, 12],
      ["certificates", "Courses & Certifications", 12, 15],
    ]);
  });

  it("ends a span at a heading cvparse does not track", () => {
    const spans = detectSectionSpans("EDUCATION\nUBA\nVOLUNTEERING\nRed Cross — Volunteer");
    expect(spans.map((s) => [s.key, s.end])).toEqual([
      ["education", 2],
      ["other", 4],
    ]);
  });
});

describe("groundResume — section placement", () => {
  it("moves work entries written under Education into education[], filling the shells", () => {
    const { resume, warnings } = groundResume(
      {
        work: [
          { name: "Freelance", position: "Full-Stack Developer", startDate: "2021-01" },
          { name: "Acme Staffing", position: "Senior Developer", startDate: "2019-03" },
          {
            name: "Universidad de Buenos Aires",
            position: "Computer Engineering",
            startDate: "2020",
            endDate: "2021",
          },
          {
            name: "EEST N°2 Paula Albarracín",
            position: "Electronic Technician",
            startDate: "2010",
            endDate: "2015",
          },
        ],
        education: [{ studyType: null }, { studyType: null }],
        x_cvparse: { educationLevels: [] },
      },
      PLACEMENT_CV,
    );
    expect(resume.work?.map((w) => w.name)).toEqual(["Freelance", "Acme Staffing"]);
    expect(resume.education).toEqual([
      {
        institution: "Universidad de Buenos Aires",
        studyType: "Computer Engineering",
        startDate: "2020",
        endDate: "2021",
      },
      {
        institution: "EEST N°2 Paula Albarracín",
        studyType: "Electronic Technician",
        startDate: "2010",
        endDate: "2015",
      },
    ]);
    expect(resume.x_cvparse?.educationLevels?.map((l) => l.level)).toEqual([
      "bachelor",
      "technical",
    ]);
    expect(warnings).toEqual([
      'placement: moved work[2] "Universidad de Buenos Aires" to education (it is under the "Education" heading)',
      'placement: moved work[3] "EEST N°2 Paula Albarracín" to education (it is under the "Education" heading)',
    ]);
  });

  it("merges with an education entry of the same institution or the same dates", () => {
    const { resume } = groundResume(
      {
        work: [
          { name: "Universidad de Buenos Aires", position: "Computer Engineering" },
          {
            name: "EEST N°2 Paula Albarracín",
            position: "Electronic Technician",
            startDate: "2010",
            endDate: "2015",
          },
        ],
        education: [
          { institution: "Universidad de Buenos Aires", studyType: null, startDate: "2020" },
          { institution: null, studyType: null, startDate: "2010", endDate: "2015" },
        ],
      },
      PLACEMENT_CV,
    );
    expect(resume.education).toHaveLength(2);
    expect(resume.education?.[0]).toMatchObject({
      institution: "Universidad de Buenos Aires",
      studyType: "Computer Engineering",
      startDate: "2020",
    });
    expect(resume.education?.[1]).toMatchObject({
      institution: "EEST N°2 Paula Albarracín",
      studyType: "Electronic Technician",
    });
  });

  it("moves work entries written under Courses & Certifications into certificates[]", () => {
    const { resume, warnings } = groundResume(
      { work: [{ name: "Platzi", position: "Node.js Course", startDate: "2022" }] },
      PLACEMENT_CV,
    );
    expect(resume.work).toEqual([]);
    expect(resume.certificates).toEqual([
      { name: "Node.js Course", issuer: "Platzi", url: null, date: "2022" },
    ]);
    expect(warnings).toEqual([
      'placement: moved work[0] "Platzi" to certificates (it is under the "Courses & Certifications" heading)',
    ]);
  });

  it("moves education entries written under Experience into work[]", () => {
    const { resume, warnings } = groundResume(
      {
        work: [{ name: "Freelance", position: "Full-Stack Developer" }],
        education: [
          { institution: "Acme Staffing", studyType: "Senior Developer", startDate: "2019-03" },
          { institution: "Universidad de Buenos Aires", studyType: "Computer Engineering" },
        ],
      },
      PLACEMENT_CV,
    );
    expect(resume.work?.map((w) => [w.name, w.position, w.startDate])).toEqual([
      ["Freelance", "Full-Stack Developer", undefined],
      ["Acme Staffing", "Senior Developer", "2019-03"],
    ]);
    expect(resume.education?.map((e) => e.institution)).toEqual(["Universidad de Buenos Aires"]);
    expect(warnings).toEqual([
      'placement: moved education[0] "Acme Staffing" to work (it is under the "Experience" heading)',
    ]);
  });

  it("does not move an organization also written under Experience, or without headings", () => {
    const both = groundResume(
      { work: [{ name: "Universidad de Buenos Aires", position: "Teaching Assistant" }] },
      "Experience\nUniversidad de Buenos Aires — Teaching Assistant\nEducation\nUniversidad de Buenos Aires — Computer Engineering",
    );
    expect(both.resume.work).toHaveLength(1);
    expect(both.warnings.some((w) => w.startsWith("placement:"))).toBe(false);
    const flat = groundResume(
      { work: [{ name: "Universidad de Buenos Aires", position: "Computer Engineering" }] },
      "Universidad de Buenos Aires — Computer Engineering",
    );
    expect(flat.resume.work).toHaveLength(1);
  });
});

describe("parseResume — third real-CV run regressions", () => {
  it("moves education out of work[] and splits a name copied into the position", async () => {
    const model = mockModelWithObject({
      basics: { name: "Jordan Example" },
      work: [
        {
          name: "Freelance — Full-Stack Developer",
          position: "Freelance — Full-Stack Developer",
          startDate: "January 2021",
          endDate: "Present",
        },
        {
          name: "Acme Staffing",
          position: "Senior Developer",
          startDate: "March 2019",
          endDate: "December 2020",
        },
        {
          name: "Universidad de Buenos Aires",
          position: "Computer Engineering",
          startDate: "2020",
          endDate: "2021",
        },
        {
          name: "EEST N°2 Paula Albarracín",
          position: "Electronic Technician",
          startDate: "2010",
          endDate: "2015",
        },
      ],
      education: [{ studyType: null }, { studyType: null }],
      certificates: [{ name: "Node.js Course", issuer: "Platzi", date: "2022" }],
      x_cvparse: { detectedLanguage: "en" },
    });
    const { resume, warnings } = await parseResume(PLACEMENT_CV, { model });

    expect(resume.work?.map((w) => [w.name, w.position])).toEqual([
      ["Freelance", "Full-Stack Developer"],
      ["Acme Staffing", "Senior Developer"],
    ]);
    expect(
      resume.education?.map((e) => [e.institution, e.studyType, e.startDate, e.endDate]),
    ).toEqual([
      ["Universidad de Buenos Aires", "Computer Engineering", "2020", "2021"],
      ["EEST N°2 Paula Albarracín", "Electronic Technician", "2010", "2015"],
    ]);
    expect(resume.x_cvparse?.educationLevels?.map((l) => [l.level, l.original])).toEqual([
      ["bachelor", "Computer Engineering"],
      ["technical", "Electronic Technician"],
    ]);
    expect(warnings).toContain(
      'work[0]: name and position were both "Freelance — Full-Stack Developer"; split into name "Freelance" and position "Full-Stack Developer".',
    );
    expect(warnings).toContain(
      'placement: moved work[2] "Universidad de Buenos Aires" to education (it is under the "Education" heading)',
    );
    expect(warnings).toContain(
      'placement: moved work[3] "EEST N°2 Paula Albarracín" to education (it is under the "Education" heading)',
    );
    // Coverage is judged after placement: education[] is no longer empty.
    expect(warnings.some((w) => w.startsWith("coverage:"))).toBe(false);
  });
});

describe("groundResume — employer recovered when work[].name is the job title", () => {
  /** es-pe-008 (OCR of a PNG): title line, then "Company — City", then dates. */
  const PE_008 = `Jhon Ccori Gutiérrez

Enfermero
Cusco, Perú
Teléfono: +51 983 742 473 - jhon. ccoriQexample.com

EXPERIENCIA PROFESIONAL
Enfermero Asistencial
Clinica Santa Brígida del Rímac — Cusco
jun. 2022 — actualidad
- Capacitación al personal en bioseguridad.

Enfermero de Terapia Intensiva
Clínica del Parque del Pacífico — Cusco
ago. 2020 — feb. 2022
- Registro clínico en historia electrónica.

FORMACIÓN
Licenciatura en Enfermería
Universidad Andina de Chachani, 2014 — 2020
`;

  it("es-pe-008: moves the title to position and takes the employer out of location", () => {
    // What llama3.1 returned: title in name, "Company — City" in location, position null.
    const { resume, warnings } = groundResume(
      {
        basics: {
          name: "Jhon Ccori Gutiérrez",
          label: "Enfermero",
          location: { city: "Cusco", countryCode: "PE" },
        },
        work: [
          {
            name: "Enfermero Asistencial",
            position: null,
            location: "Clinica Santa Brígida del Rímac — Cusco",
            startDate: "2022-06",
          },
          {
            name: "Enfermero de Terapia Intensiva",
            position: null,
            location: "Clínica del Parque del Pacífico — Cusco",
            startDate: "2020-08",
          },
        ],
      },
      PE_008,
    );
    expect(resume.work?.map((w) => [w.name, w.position, w.location])).toEqual([
      ["Clinica Santa Brígida del Rímac", "Enfermero Asistencial", "Cusco"],
      ["Clínica del Parque del Pacífico", "Enfermero de Terapia Intensiva", "Cusco"],
    ]);
    expect(warnings).toContain(
      'grounding: work[0].name "Enfermero Asistencial" is the job title; set position to it and name to the employer "Clinica Santa Brígida del Rímac" as written',
    );
  });

  /** es-pe-006 (DOCX): blank lines between title, "Company, City" and dates; the title also in the header and summary. */
  const PE_006 = `Yesenia Mamani Gutiérrez

Desarrolladora Backend

DATOS DE CONTACTO

Lima, Perú

PERFIL

Desarrolladora Backend con 9 años de experiencia construyendo APIs y sistemas distribuidos. Me interesan la calidad del código, la observabilidad y el trabajo en equipo.

EXPERIENCIA

Tech Lead Backend

Pagos del Rímac S.A., Trujillo

oct. 2024 – dic. 2025

- Migración de un monolito a microservicios con Docker y Kubernetes.

Desarrolladora Backend Sr.

Fintech del Pacífico S.A., Lima

abr. 2020 – jun. 2024

Desarrolladora Backend

Datacenter del Pacífico S.A.C., Lima

feb. 2017 – dic. 2019

EDUCACIÓN

Licenciatura en Informática – Universidad Peruana de Ciencias del Pacífico
`;

  it("es-pe-006: recovers employers across blank lines, ignoring the header and the summary", () => {
    const { resume } = groundResume(
      {
        basics: { name: "Yesenia Mamani Gutiérrez", label: "Desarrolladora Backend" },
        work: [
          // name == position, employer dropped (location kept only the city).
          { name: "Tech Lead Backend", position: "Tech Lead Backend", location: "Trujillo" },
          { name: "Desarrolladora Backend Sr.", position: null, location: "Lima" },
          // The v0.3.0 prompt's shape: "Company, City" in location.
          {
            name: "Desarrolladora Backend",
            position: "Desarrolladora Backend",
            location: "Datacenter del Pacífico S.A.C., Lima",
          },
        ],
      },
      PE_006,
    );
    expect(resume.work?.map((w) => [w.name, w.position, w.location])).toEqual([
      ["Pagos del Rímac S.A.", "Tech Lead Backend", "Trujillo"],
      ["Fintech del Pacífico S.A.", "Desarrolladora Backend Sr.", "Lima"],
      ["Datacenter del Pacífico S.A.C.", "Desarrolladora Backend", "Lima"],
    ]);
  });

  it("es-ar-003 / es-ar-008: title and dates on one line, employer on the same or the next line", () => {
    const text = `EXPERIENCIA PROFESIONAL

Supervisor de Enfermería agosto 2025 – actualidad
Clínica del Parque del Litoral, Mendoza
• Coordinación de turnos de 7 enfermeros.

septiembre 2021 – actualidad · Científica de Datos, Telecom de los Andes S.A. (Remoto)
`;
    const { resume } = groundResume(
      {
        work: [
          { name: "Supervisor de Enfermería", position: null, location: null },
          { name: "Científica de Datos", position: "Científica de Datos", location: "Remoto" },
        ],
      },
      text,
    );
    expect(resume.work?.map((w) => [w.name, w.position, w.location])).toEqual([
      ["Clínica del Parque del Litoral", "Supervisor de Enfermería", null],
      ["Telecom de los Andes S.A.", "Científica de Datos", "Remoto"],
    ]);
  });

  it("keeps the model's entry when the name is an employer or no employer is written", () => {
    const text = `EXPERIENCE
Globant
Senior Developer · 2020 – 2023
Analista de Datos
2018 – 2020
`;
    const { resume, warnings } = groundResume(
      {
        work: [
          // "Company\nTitle" layout with the company in name: never turned into a title.
          { name: "Globant", position: null },
          { name: "Analista de Datos", position: null },
        ],
      },
      text,
    );
    expect(resume.work?.map((w) => [w.name, w.position])).toEqual([
      ["Globant", null],
      ["Analista de Datos", null],
    ]);
    expect(warnings).toContain(
      'grounding: work[1].name "Analista de Datos" looks like a job title and position is empty; no employer found next to it (kept)',
    );
  });
});

describe("groundResume — candidate city the model replaced with the prompt's example", () => {
  it("es-ar-003 / es-ar-008: recovers the written city from the address / raw location", () => {
    const text = `Ramiro Rossi
Enfermero
Mendoza, Argentina · Cel.: +54 9 261 543-7794 · ramiro.rossi@example.org
`;
    const { resume, warnings } = groundResume(
      {
        basics: {
          name: "Ramiro Rossi",
          location: {
            address: "Mendoza, Argentina",
            city: "Ciudad Autónoma de Buenos Aires",
            region: "Buenos Aires",
            countryCode: "AR",
          },
        },
        x_cvparse: {
          location: {
            city: "Ciudad Autónoma de Buenos Aires",
            adminRegion: "Buenos Aires",
            countryCode: "AR",
            raw: "Mendoza, Argentina",
          },
        },
      },
      text,
    );
    expect(resume.basics?.location).toMatchObject({
      city: "Mendoza",
      region: null,
      countryCode: "AR",
      address: "Mendoza, Argentina",
    });
    expect(resume.x_cvparse?.location).toMatchObject({
      city: "Mendoza",
      adminRegion: null,
      raw: "Mendoza, Argentina",
    });
    expect(warnings).toContain(
      'grounding: basics.location.city "Ciudad Autónoma de Buenos Aires" replaced by "Mendoza" as written',
    );
  });

  it("es-pe-008: strips a 'Ciudad de' prefix the document does not write", () => {
    const { resume } = groundResume(
      { basics: { location: { city: "Ciudad de Cusco", countryCode: "PE" } } },
      "Jhon Ccori\nEnfermero\nCusco, Perú\n",
    );
    expect(resume.basics?.location?.city).toBe("Cusco");
  });

  it("still drops a city with nothing written to recover", () => {
    const { resume, warnings } = groundResume(
      { basics: { location: { city: "Montevideo", address: "Argentina", countryCode: "AR" } } },
      "Ana Pérez\nArgentina\n",
    );
    expect(resume.basics?.location?.city ?? null).toBeNull();
    expect(warnings).toContain(
      'grounding: dropped basics.location.city "Montevideo" (not found in the document)',
    );
  });
});
