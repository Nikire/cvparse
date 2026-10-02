/**
 * Baseline: npm `resume-parser` 1.1.0 (https://github.com/perminder-klair/resume-parser, ISC),
 * a regex/dictionary parser whose last release is from 2022.
 *
 * How it is run:
 * - It is installed by `npm run eval:baselines:setup` into eval/.cache/resume-parser/, not as a
 *   devDependency: its dependency tree (textract -> got@5 with `engines: node <7`, request) does not
 *   install under this repo's `engine-strict`, and would put deprecated packages in our lockfile.
 * - Its own file reading goes through `textract`, which shells out to `pdftotext` (poppler) for
 *   PDFs, a system binary. To keep the benchmark portable it is fed the reading-order text from
 *   cvparse's `extractText` instead, prepared exactly like its `processing.js` does (rows trimmed,
 *   empty rows dropped, "{end}" sentinel), and handed to its `parser.parse`. It therefore benefits
 *   from our PDF/DOCX reading (two-column ordering included).
 * - Its GitHub/LinkedIn profile handlers download the profile page over the network; they are
 *   removed before parsing (the profile URL is still detected, just not fetched).
 *
 * Output: `{ name, email, phone, profiles, <section>: "raw section text", ... }`. Sections are
 * matched by English titles only ("experience", "education", "skills", "languages", ...), and are
 * raw text blobs, so work/education entries cannot be mapped without parsing them ourselves; they
 * stay empty. Skills and languages are split into items (see `mapResumeParser`).
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { extractText } from "../../src/index.js";
import type { EvalSystem, GroundTruth } from "../types.js";
import { emptyTruth, nonEmpty, splitSkillText } from "./map.js";
import { RESUME_PARSER_DIR, RESUME_PARSER_VERSION } from "./setup.js";

/** What resume-parser returns (`Resume.parts`); every key is optional. */
export type ResumeParserParts = Record<string, unknown> & {
  name?: string;
  email?: string;
  phone?: string;
  skills?: string;
  languages?: string;
};

type ParseFn = (file: { raw: string }, cb: (resume: { parts: ResumeParserParts }) => void) => void;

const PACKAGE_DIR = join(RESUME_PARSER_DIR, "package");

/** True when `npm run eval:baselines:setup` has installed resume-parser. */
export function isResumeParserAvailable(): boolean {
  return existsSync(join(PACKAGE_DIR, "node_modules", "underscore"));
}

function loadParser(): ParseFn {
  if (!isResumeParserAvailable()) {
    throw new Error("resume-parser is not set up. Run `npm run eval:baselines:setup` first.");
  }
  const req = createRequire(join(PACKAGE_DIR, "package.json"));
  const version = (req("./package.json") as { version: string }).version;
  if (version !== RESUME_PARSER_VERSION) {
    throw new Error(
      `eval/.cache/resume-parser is ${version}, expected ${RESUME_PARSER_VERSION}. Re-run \`npm run eval:baselines:setup\`.`,
    );
  }
  const parser = req("./src/utils/libs/parser.js") as { parse: ParseFn };
  // parser.js has already compiled the dictionary in place; drop the network handlers.
  const dictionary = req("./src/dictionary.js") as { profiles: unknown[] };
  dictionary.profiles = dictionary.profiles.map((p) => (Array.isArray(p) ? p[0] : p));
  return parser.parse;
}

/** Replicates resume-parser's processing.js text preparation (cleanTextByRows + leading-space strip). */
export function prepareText(text: string): string {
  const rows = text
    .split("\n")
    .map((row) => row.replace(/\r?\n|\r|\t|\n/g, "").trim())
    .filter(Boolean);
  return `${rows.join("\n")}\n{end}`.replace(/^\s/gm, "");
}

/** Splits a raw "languages" blob into entries: "Inglés: avanzado", "Inglés - C1", "Inglés (C1)". */
export function splitLanguageText(blob: string): { language: string; fluency?: string }[] {
  const out: { language: string; fluency?: string }[] = [];
  for (const line of blob.split(/\n|[•●▪·]/)) {
    for (const chunk of line.split(/[,;|]/)) {
      const m = /^\s*([^:(–—-]+?)\s*(?:[:–—-]\s*(.+?)|\((.+?)\))?\s*$/.exec(chunk);
      const language = nonEmpty(m?.[1]);
      if (language === undefined || language === "{end}") continue;
      const fluency = nonEmpty(m?.[2] ?? m?.[3]);
      out.push(fluency ? { language, fluency } : { language });
    }
  }
  return out;
}

/** Maps resume-parser's flat output to the evaluated GroundTruth subset. */
export function mapResumeParser(parts: ResumeParserParts): GroundTruth {
  const truth = emptyTruth();
  const str = (v: unknown) => (typeof v === "string" ? nonEmpty(v) : undefined);
  truth.basics = { name: str(parts.name), email: str(parts.email), phone: str(parts.phone) };
  const skills = str(parts.skills);
  truth.skills = skills ? splitSkillText(skills.split("\n")).map((name) => ({ name })) : [];
  const languages = str(parts.languages);
  truth.languages = languages ? splitLanguageText(languages) : [];
  return truth;
}

export async function createSystem(): Promise<EvalSystem> {
  const parse = loadParser();
  return {
    info: {
      name: "resume-parser (regex)",
      kind: "baseline",
      details: {
        package: `resume-parser@${RESUME_PARSER_VERSION}`,
        license: "ISC",
        input: "plain text from cvparse extractText (its textract/pdftotext reader is bypassed)",
        dates: "not extracted (sections are raw text)",
      },
    },
    supports: ["pdf", "docx", "text"],
    async predict(file) {
      const doc = await extractText({ data: readFileSync(file), filename: basename(file) });
      const parts = await new Promise<ResumeParserParts>((resolve) =>
        parse({ raw: prepareText(doc.text) }, (resume) => resolve(resume.parts)),
      );
      return mapResumeParser(parts);
    },
  };
}
