import type { Resume } from "../schema/resume.js";
import { type DateOptions, normalizeDate, splitDateRange } from "./dates.js";
import { type EducationLevelInfo, normalizeStudyType } from "./education.js";
import { detectLanguage } from "./language.js";

/** Output of {@link normalizeResume}. */
export interface NormalizeResult {
  resume: Resume;
  warnings: string[];
}

type DateField = { path: string; obj: Record<string, unknown>; key: string };

const DATE_KEYS_BY_SECTION: Record<string, readonly string[]> = {
  work: ["startDate", "endDate"],
  volunteer: ["startDate", "endDate"],
  education: ["startDate", "endDate"],
  awards: ["date"],
  certificates: ["date"],
  publications: ["releaseDate"],
  projects: ["startDate", "endDate"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects every date-bearing field in the resume, with a human-readable path. */
function collectDateFields(resume: Record<string, unknown>): DateField[] {
  const fields: DateField[] = [];
  for (const [section, keys] of Object.entries(DATE_KEYS_BY_SECTION)) {
    const entries = resume[section];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      for (const key of keys) {
        fields.push({ path: `${section}[${index}].${key}`, obj: entry, key });
      }
    });
  }
  return fields;
}

/** Recursively turns empty / whitespace-only strings into `null` and trims the rest. */
function tidyStrings(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (Array.isArray(value)) {
    return value.map(tidyStrings).filter((item) => item !== null);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = tidyStrings(v);
    return out;
  }
  return value;
}

/**
 * One {@link EducationLevelInfo} per `education[]` entry, in order. `studyType` is left as the
 * model wrote it; only the parallel `x_cvparse.educationLevels` array is produced.
 */
function collectEducationLevels(education: unknown): EducationLevelInfo[] | null {
  if (!Array.isArray(education)) return null;
  return education.map((entry) => {
    if (!isRecord(entry)) return normalizeStudyType(null);
    const studyType = typeof entry.studyType === "string" ? entry.studyType : null;
    const area = typeof entry.area === "string" ? entry.area : null;
    return normalizeStudyType(studyType, area);
  });
}

function dedupeLowercase(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Deterministic post-processing applied to whatever the model returned:
 * - trims strings and converts empty ones to `null`;
 * - normalizes every date field to ISO (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`), turning
 *   "actualidad" / "present" into `null` and warning on dates it cannot understand;
 * - lowercases and dedupes `x_cvparse.normalizedSkills`;
 * - uppercases and validates ISO country codes;
 * - fills `x_cvparse.detectedLanguage` heuristically when the model left it empty;
 * - classifies every `education[].studyType` into `x_cvparse.educationLevels` (a parallel
 *   array, same order) without touching `studyType` itself.
 *
 * Returns a new object; the input is not mutated.
 */
export function normalizeResume(
  input: unknown,
  sourceText?: string,
  options: DateOptions = {},
): NormalizeResult {
  const warnings: string[] = [];
  const tidied = tidyStrings(input);
  const resume: Record<string, unknown> = isRecord(tidied) ? tidied : {};

  for (const { path, obj, key } of collectDateFields(resume)) {
    const raw = obj[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      obj[key] = null;
      warnings.push(`${path}: expected a date string, got ${typeof raw}; set to null.`);
      continue;
    }
    const normalized = normalizeDate(raw, options);
    if (normalized.unparsed) {
      // Models sometimes put a whole range in startDate ("2019-21", "marzo 2019 – actualidad")
      // and leave endDate empty. Split it instead of discarding it.
      const endEmpty = obj.endDate === undefined || obj.endDate === null;
      const range = key === "startDate" && endEmpty ? splitDateRange(raw, options) : null;
      if (range) {
        obj.startDate = range.start;
        obj.endDate = range.end;
        continue;
      }
      warnings.push(`${path}: could not normalize date "${raw}"; set to null.`);
    }
    obj[key] = normalized.value;
  }

  const ext = isRecord(resume.x_cvparse) ? resume.x_cvparse : {};
  resume.x_cvparse = ext;

  if (Array.isArray(ext.normalizedSkills)) {
    ext.normalizedSkills = dedupeLowercase(
      ext.normalizedSkills.filter((s): s is string => typeof s === "string"),
    );
  }

  const educationLevels = collectEducationLevels(resume.education);
  if (educationLevels) {
    ext.educationLevels = educationLevels;
  } else {
    delete ext.educationLevels;
  }

  if (typeof ext.detectedLanguage === "string") {
    ext.detectedLanguage = ext.detectedLanguage.trim().toLowerCase().slice(0, 2);
  } else if (sourceText) {
    const detected = detectLanguage(sourceText);
    if (detected) {
      ext.detectedLanguage = detected;
      warnings.push(
        `x_cvparse.detectedLanguage: model did not report a language; heuristically set to "${detected}".`,
      );
    }
  }

  const countryHolders: Array<{ path: string; obj: Record<string, unknown> }> = [];
  if (isRecord(ext.location))
    countryHolders.push({ path: "x_cvparse.location", obj: ext.location });
  const basics = resume.basics;
  if (isRecord(basics) && isRecord(basics.location)) {
    countryHolders.push({ path: "basics.location", obj: basics.location });
  }
  for (const { path, obj } of countryHolders) {
    const code = obj.countryCode;
    if (typeof code !== "string") continue;
    const upper = code.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(upper)) {
      obj.countryCode = upper;
    } else {
      warnings.push(
        `${path}.countryCode: "${code}" is not an ISO 3166-1 alpha-2 code; set to null.`,
      );
      obj.countryCode = null;
    }
  }

  return { resume: resume as Resume, warnings };
}
