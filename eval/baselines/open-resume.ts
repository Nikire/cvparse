/**
 * Baseline: open-resume's rule-based PDF parser (https://github.com/xitanggg/open-resume, AGPL-3.0).
 *
 * The AGPL code is not part of this repo: `npm run eval:baselines:setup` clones it at a pinned
 * commit into eval/.cache/ and this adapter imports the parser modules from there at runtime.
 *
 * Pipeline (mirrors open-resume's src/app/lib/parse-resume-from-pdf/index.ts):
 *   1. readPdf            -> replaced by {@link readPdfTextItems} (their version needs a browser
 *                            pdf.js worker); same TextItem shape, built with pdf.js from unpdf.
 *   2. groupTextItemsIntoLines, 3. groupLinesIntoSections, 4. extractResumeFromSections
 *                         -> their code, unmodified (only import specifiers rewritten).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EvalSystem, GroundTruth } from "../types.js";
import { emptyTruth, mapDateText, mapLocationText, nonEmpty, splitSkillText } from "./map.js";
import { OPEN_RESUME_COMMIT, OPEN_RESUME_NODE_DIR } from "./setup.js";

/** open-resume's TextItem (src/app/lib/parse-resume-from-pdf/types.ts). */
export interface OpenResumeTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

/** open-resume's Resume (src/app/lib/redux/types.ts), the fields we map. */
export interface OpenResumeResume {
  profile: {
    name: string;
    email: string;
    phone: string;
    url: string;
    summary: string;
    location: string;
  };
  workExperiences: { company: string; jobTitle: string; date: string; descriptions: string[] }[];
  educations: {
    school: string;
    degree: string;
    date: string;
    gpa: string;
    descriptions: string[];
  }[];
  skills: { featuredSkills: { skill: string; rating: number }[]; descriptions: string[] };
}

type Lines = OpenResumeTextItem[][];
interface OpenResumeModules {
  groupTextItemsIntoLines(items: OpenResumeTextItem[]): Lines;
  groupLinesIntoSections(lines: Lines): Record<string, Lines>;
  extractResumeFromSections(sections: Record<string, Lines>): OpenResumeResume;
}

/** True when `npm run eval:baselines:setup` has produced the importable parser modules. */
export function isOpenResumeAvailable(): boolean {
  return existsSync(join(OPEN_RESUME_NODE_DIR, "lib", "parse-resume-from-pdf", "types.ts"));
}

async function loadModules(): Promise<OpenResumeModules> {
  if (!isOpenResumeAvailable()) {
    throw new Error("open-resume is not set up. Run `npm run eval:baselines:setup` first.");
  }
  const commit = readFileSync(join(OPEN_RESUME_NODE_DIR, "COMMIT"), "utf8").trim();
  if (commit !== OPEN_RESUME_COMMIT) {
    throw new Error(
      `eval/.cache/open-resume is at ${commit}, expected ${OPEN_RESUME_COMMIT}. Re-run \`npm run eval:baselines:setup\`.`,
    );
  }
  const lib = join(OPEN_RESUME_NODE_DIR, "lib", "parse-resume-from-pdf");
  const load = (rel: string) => import(pathToFileURL(join(lib, rel)).href);
  const [lines, sections, extract] = await Promise.all([
    load("group-text-items-into-lines.ts"),
    load("group-lines-into-sections.ts"),
    load(join("extract-resume-from-sections", "index.ts")),
  ]);
  return {
    groupTextItemsIntoLines: lines.groupTextItemsIntoLines,
    groupLinesIntoSections: sections.groupLinesIntoSections,
    extractResumeFromSections: extract.extractResumeFromSections,
  };
}

/**
 * Node port of open-resume's read-pdf.ts: same output (text, x, y, width, height, original
 * font name, hasEOL; empty non-EOL items dropped; the "-­‐" pdf.js artifact reverted),
 * using the pdf.js build bundled with unpdf instead of a browser worker. open-resume pins
 * pdfjs-dist ^3.7; unpdf ships a newer pdf.js, whose text items are equivalent for these fields.
 */
export async function readPdfTextItems(data: Uint8Array): Promise<OpenResumeTextItem[]> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
  const items: OpenResumeTextItem[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // Wait for font data so commonObjs can map loaded names ("g_d0_f1") to real ones.
      await page.getOperatorList();
      for (const raw of content.items) {
        if (!("str" in raw)) continue;
        let fontName = raw.fontName;
        try {
          const font = page.commonObjs.get(raw.fontName) as { name?: string } | undefined;
          if (font?.name) fontName = font.name;
        } catch {
          // Font not resolved: keep the loaded name (isBold() then reads false, as in the browser).
        }
        items.push({
          text: raw.str.replace(/-­‐/g, "-"),
          x: raw.transform[4] as number,
          y: raw.transform[5] as number,
          width: raw.width,
          height: raw.height,
          fontName,
          hasEOL: raw.hasEOL,
        });
      }
    }
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
  return items.filter((item) => item.hasEOL || item.text.trim() !== "");
}

/** Maps open-resume's Resume to the evaluated GroundTruth subset. */
export function mapOpenResume(resume: OpenResumeResume): GroundTruth {
  const truth = emptyTruth();
  const p = resume.profile;
  truth.basics = {
    name: nonEmpty(p.name),
    email: nonEmpty(p.email),
    phone: nonEmpty(p.phone),
    location: mapLocationText(p.location),
  };
  truth.work = resume.workExperiences
    .filter((w) => nonEmpty(w.company) || nonEmpty(w.jobTitle))
    .map((w) => ({
      name: nonEmpty(w.company),
      position: nonEmpty(w.jobTitle),
      ...mapDateText(w.date, "start"),
    }));
  truth.education = resume.educations
    .filter((e) => nonEmpty(e.school) || nonEmpty(e.degree))
    .map((e) => ({
      institution: nonEmpty(e.school),
      studyType: nonEmpty(e.degree),
      ...mapDateText(e.date, "end"),
    }));
  const featured = resume.skills.featuredSkills.map((s) => s.skill).filter((s) => s.trim());
  truth.skills = splitSkillText([...featured, ...resume.skills.descriptions]).map((name) => ({
    name,
  }));
  // open-resume has no languages section.
  truth.languages = [];
  return truth;
}

export async function createSystem(): Promise<EvalSystem> {
  const mods = await loadModules();
  return {
    info: {
      name: "open-resume (rules)",
      kind: "baseline",
      details: {
        repo: "github.com/xitanggg/open-resume",
        commit: OPEN_RESUME_COMMIT,
        license: "AGPL-3.0 (fetched at runtime, not vendored)",
        pdfReader: "Node port of read-pdf.ts on unpdf's pdf.js",
        dates: "normalized with cvparse normalizeDate/splitDateRange",
      },
    },
    supports: ["pdf"],
    async predict(file) {
      const items = await readPdfTextItems(readFileSync(file));
      const lines = mods.groupTextItemsIntoLines(items);
      const sections = mods.groupLinesIntoSections(lines);
      return mapOpenResume(mods.extractResumeFromSections(sections));
    },
  };
}
