import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { DatasetEntry } from "../types.js";
import { mapDateText, mapLocationText, splitSkillText } from "./map.js";
import { isOpenResumeAvailable, mapOpenResume, type OpenResumeResume } from "./open-resume.js";
import {
  isResumeParserAvailable,
  mapResumeParser,
  prepareText,
  splitLanguageText,
} from "./resume-parser.js";

const ENTRY = {} as DatasetEntry;
const fixture = (name: string) => join(import.meta.dirname, "..", "..", "test", "fixtures", name);

describe("mapDateText", () => {
  it("splits English and Spanish ranges", () => {
    expect(mapDateText("Jun 2022 - Present")).toEqual({ startDate: "2022-06", endDate: null });
    expect(mapDateText("2019 – 2021")).toEqual({ startDate: "2019", endDate: "2021" });
    expect(mapDateText("marzo 2021 – actualidad")).toEqual({ startDate: "2021-03", endDate: null });
    expect(mapDateText("06/2018 - 02/2021")).toEqual({ startDate: "2018-06", endDate: "2021-02" });
  });

  it("puts a single date on the requested side", () => {
    expect(mapDateText("May 2018")).toEqual({ startDate: "2018-05" });
    expect(mapDateText("May 2018", "end")).toEqual({ endDate: "2018-05" });
    expect(mapDateText("Present", "end")).toEqual({ endDate: null });
  });

  it("returns nothing for empty or unparseable text", () => {
    expect(mapDateText("")).toEqual({});
    expect(mapDateText(undefined)).toEqual({});
    expect(mapDateText("sometime")).toEqual({});
  });
});

describe("splitSkillText", () => {
  it("splits on commas, bullets and semicolons and drops category labels", () => {
    expect(
      splitSkillText(["Backend: Node.js, TypeScript; NestJS", "• Docker • Kubernetes", "node.js"]),
    ).toEqual(["Node.js", "TypeScript", "NestJS", "Docker", "Kubernetes"]);
  });

  it("ignores empty pieces", () => {
    expect(splitSkillText(["", " , ", "Go."])).toEqual(["Go"]);
  });
});

describe("mapLocationText", () => {
  it("maps a free-text location", () => {
    expect(mapLocationText("CABA, Argentina")).toEqual({ city: "CABA", region: undefined });
    expect(mapLocationText("Zapopan, Jalisco, México")).toEqual({
      city: "Zapopan",
      region: "Jalisco",
    });
    expect(mapLocationText("  ")).toBeUndefined();
  });
});

describe("mapOpenResume", () => {
  it("maps profile, work, education and skills", () => {
    const resume: OpenResumeResume = {
      profile: {
        name: "Jane Doe",
        email: "jane@example.com",
        phone: "",
        url: "",
        summary: "",
        location: "Austin, TX",
      },
      workExperiences: [
        { company: "Acme", jobTitle: "Engineer", date: "Jun 2022 - Present", descriptions: [] },
        { company: "", jobTitle: "", date: "", descriptions: [] },
      ],
      educations: [
        {
          school: "MIT",
          degree: "BS Computer Science",
          date: "May 2018",
          gpa: "",
          descriptions: [],
        },
      ],
      skills: {
        featuredSkills: [
          { skill: "Go", rating: 4 },
          { skill: "", rating: 4 },
        ],
        descriptions: ["Languages: TypeScript, Python"],
      },
    };
    expect(mapOpenResume(resume)).toEqual({
      basics: {
        name: "Jane Doe",
        email: "jane@example.com",
        phone: undefined,
        location: { city: "Austin", region: undefined },
      },
      work: [{ name: "Acme", position: "Engineer", startDate: "2022-06", endDate: null }],
      education: [{ institution: "MIT", studyType: "BS Computer Science", endDate: "2018-05" }],
      skills: [{ name: "Go" }, { name: "TypeScript" }, { name: "Python" }],
      languages: [],
    });
  });
});

describe("resume-parser mapping", () => {
  it("prepares text like its processing.js", () => {
    expect(prepareText("  Jane Doe \n\n\tEXPERIENCE\n")).toBe("Jane Doe\nEXPERIENCE\n{end}");
  });

  it("splits a languages blob", () => {
    expect(splitLanguageText("Español: nativo\nInglés - C1\nPortugués (intermedio)\n")).toEqual([
      { language: "Español", fluency: "nativo" },
      { language: "Inglés", fluency: "C1" },
      { language: "Portugués", fluency: "intermedio" },
    ]);
  });

  it("maps its flat output", () => {
    expect(
      mapResumeParser({
        name: "Jane Doe",
        email: "jane@example.com",
        experience: "Acme 2020-2021",
        skills: "Go, Rust\nDocker",
        languages: "English",
      }),
    ).toEqual({
      basics: { name: "Jane Doe", email: "jane@example.com", phone: undefined },
      work: [],
      education: [],
      skills: [{ name: "Go" }, { name: "Rust" }, { name: "Docker" }],
      languages: [{ language: "English" }],
    });
  });
});

/** Small English one-column CV, the case open-resume is designed for. */
async function englishPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 740;
  const line = (text: string, isBold = false, size = 11) => {
    page.drawText(text, { x: 50, y, size, font: isBold ? bold : regular });
    y -= size + 8;
  };
  line("Jane Doe", true, 20);
  line("jane.doe@example.com | (512) 555-0134 | Austin, TX");
  line("EXPERIENCE", true);
  line("Acme Corp", true);
  line("Software Engineer");
  line("Jun 2022 - Present");
  line("• Built payment APIs in TypeScript");
  line("EDUCATION", true);
  line("University of Texas", true);
  line("Bachelor of Science in Computer Science");
  line("May 2018");
  line("SKILLS", true);
  line("• TypeScript, Python, Docker");
  return doc.save();
}

describe.skipIf(!isOpenResumeAvailable())(
  "open-resume baseline (needs eval:baselines:setup)",
  () => {
    it("parses an English PDF through the Node read-pdf port", async () => {
      const { createSystem } = await import("./open-resume.js");
      const system = await createSystem();
      const dir = await mkdtemp(join(tmpdir(), "cvparse-baseline-"));
      try {
        const file = join(dir, "en.pdf");
        await writeFile(file, await englishPdf());
        const out = await system.predict(file, ENTRY);
        expect(out.basics?.name).toBe("Jane Doe");
        expect(out.basics?.email).toBe("jane.doe@example.com");
        expect(out.work?.[0]).toMatchObject({ name: "Acme Corp", startDate: "2022-06" });
        expect(out.education?.[0]?.institution).toBe("University of Texas");
        expect(out.skills?.map((s) => s.name)).toContain("Python");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("returns at least the email on a Spanish fixture", async () => {
      const { createSystem } = await import("./open-resume.js");
      const system = await createSystem();
      const out = await system.predict(fixture("pdf/single-column-es.pdf"), ENTRY);
      expect(out.basics?.email).toBe("mfernanda.lopez@example.com");
    });
  },
);

describe.skipIf(!isResumeParserAvailable())(
  "resume-parser baseline (needs eval:baselines:setup)",
  () => {
    it("returns at least the email on single-column-es.pdf", async () => {
      const { createSystem } = await import("./resume-parser.js");
      const system = await createSystem();
      const out = await system.predict(fixture("pdf/single-column-es.pdf"), ENTRY);
      expect(out.basics?.email).toBe("mfernanda.lopez@example.com");
    });
  },
);
