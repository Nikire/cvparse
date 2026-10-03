import type { Resume } from "../schema/resume.js";
import {
  type DateOptions,
  normalizeDate,
  pickLatestDate,
  reduceDatePrecision,
  splitDateRange,
} from "./dates.js";
import { collectEducationLevels } from "./education.js";
import { normalizeForMatch } from "./grounding.js";
import { detectLanguage } from "./language.js";
import { dedupeResumeEntries } from "./repetition.js";
import { looksLikeJobTitle, looksLikeOrganization } from "./titles.js";

/** Output of {@link normalizeResume}. */
export interface NormalizeResult {
  resume: Resume;
  warnings: string[];
}

/** Options for {@link normalizeResume}. */
export interface NormalizeOptions extends DateOptions {
  /**
   * The CV text the model read. When given, dates the model padded with an invented month or day
   * ("2020" -> "2020-01", "2020-03" -> "2020-03-01") are reduced back to the precision the
   * document supports; see {@link reduceDatePrecision}. Unlike the second parameter, it never
   * triggers language detection.
   */
  sourceText?: string | undefined;
}

type DateField = { path: string; obj: Record<string, unknown>; key: string };

/** Fields that hold one date (not a start/end pair); a list of dates keeps the latest. */
const SINGLE_DATE_KEYS = new Set(["date", "releaseDate"]);

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
 * `true` when a model confidence note is readable text. Small models sometimes fill
 * `confidenceNotes` with hash-like tokens ("8e51", "e7b3"); those are dropped. A note must be at
 * least 8 characters, contain a run of 3+ letters, not be a hex string (or only hex tokens with
 * digits), and, when it is a single token, be at least 60% letters.
 */
export function isMeaningfulNote(note: string): boolean {
  const text = note.trim();
  if (text.length < 8) return false;
  if (!/\p{L}{3,}/u.test(text)) return false;
  const tokens = text.split(/\s+/);
  if (tokens.every((t) => /^[0-9a-f]+$/i.test(t)) && /\d/.test(text)) return false;
  if (tokens.length === 1) {
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    if (/^[0-9a-f]{3,}$/i.test(text) || letters / text.length < 0.6) return false;
  }
  return true;
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
 * Separators between an organization and a title written on one line: em/en dash, pipe, middle
 * dot, comma, and a hyphen only when it has a space on at least one side ("Full-Stack" is a word).
 */
const ORG_TITLE_SEPARATOR = /\s*(?:[—–|·,]|\s-|-\s)\s*/gu;

/**
 * Removes `title` from `org` when the model glued them together ("Freelance — Full-Stack
 * Developer" with position "Full-Stack Developer" -> "Freelance"). The title may be at the end
 * (after a separator) or at the start (before one). Returns `null` when nothing was removed.
 */
export function stripTitleFromOrg(org: string, title: string): string | null {
  const target = normalizeForMatch(title);
  if (target === "") return null;
  for (const match of org.matchAll(ORG_TITLE_SEPARATOR)) {
    const before = org.slice(0, match.index).trim();
    const after = org.slice(match.index + match[0].length).trim();
    if (before === "" || after === "") continue;
    if (normalizeForMatch(after) === target) return before;
    if (normalizeForMatch(before) === target) return after;
  }
  return null;
}

/** Separators that can join an organization and a title in one string ("Acme — Developer"). */
const ORG_TITLE_JOIN = /\s*[—–|·]\s*|\s+-\s+/u;

/**
 * Splits "Organization — Title" at its first separator (em/en dash, pipe, middle dot, or a hyphen
 * with spaces on both sides) into `[organization, title]`. Returns `null` when there is no
 * separator or one side is empty.
 */
export function splitOrgAndTitle(value: string): [string, string] | null {
  const match = ORG_TITLE_JOIN.exec(value);
  if (!match) return null;
  const org = value.slice(0, match.index).trim();
  const title = value.slice(match.index + match[0].length).trim();
  return org === "" || title === "" ? null : [org, title];
}

/**
 * Splits "Title, Organization" (or "Organization — Title", any {@link stripTitleFromOrg}
 * separator, comma included) into `{ title, org }` when exactly one side reads as a job title
 * ({@link looksLikeJobTitle}) and the other does not; "Científica de Datos, Telecom S.A." ->
 * title "Científica de Datos", org "Telecom S.A.". Returns `null` when unsure.
 */
export function splitTitleAndOrg(value: string): { title: string; org: string } | null {
  for (const match of value.matchAll(ORG_TITLE_SEPARATOR)) {
    const before = value.slice(0, match.index).trim();
    const after = value.slice(match.index + match[0].length).trim();
    if (before === "" || after === "") continue;
    const beforeTitle = looksLikeJobTitle(before);
    const afterTitle = looksLikeJobTitle(after);
    if (beforeTitle === afterTitle) continue;
    const [title, org] = beforeTitle ? [before, after] : [after, before];
    // A comma also separates plain phrases ("Analista de Ventas, Atención al cliente"): there the
    // other side must carry an organization marker (legal suffix, "Clínica", "Universidad", ...).
    if (match[0].trim() === "," && !looksLikeOrganization(org)) continue;
    return { title, org };
  }
  return null;
}

/**
 * Splits a list written as one string ("Agile / Scrum, Code Review; Docs") on ";" and on ", "
 * (comma followed by whitespace), never inside parentheses. "Node.js", "CI/CD", "Agile / Scrum"
 * and "1,000" stay whole.
 */
export function splitSkillList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i] as string;
    if (char === "(" || char === "[") depth++;
    else if ((char === ")" || char === "]") && depth > 0) depth--;
    const isSplit =
      depth === 0 && (char === ";" || (char === "," && /\s/.test(value[i + 1] ?? "")));
    if (isSplit) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function dedupeCaseInsensitive(items: readonly string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Splits `skills[].keywords` entries that hold several skills into separate keywords, and
 * `skills[].name` values that hold several skills into separate skill entries (the first keeps
 * the keywords; all keep the level).
 */
function splitSkills(skills: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const skill of skills) {
    if (!isRecord(skill)) {
      out.push(skill);
      continue;
    }
    if (Array.isArray(skill.keywords)) {
      const keywords = skill.keywords.flatMap((k) =>
        typeof k === "string" ? splitSkillList(k) : [],
      );
      skill.keywords = dedupeCaseInsensitive(keywords);
    }
    const names = typeof skill.name === "string" ? splitSkillList(skill.name) : [];
    if (names.length <= 1) {
      out.push(skill);
      continue;
    }
    names.forEach((name, i) => {
      out.push(
        i === 0
          ? { ...skill, name }
          : { ...skill, name, keywords: Array.isArray(skill.keywords) ? [] : skill.keywords },
      );
    });
  }
  return out;
}

/**
 * `x_cvparse.normalizedSkills` derived from `skills`: every keyword, plus the name of entries
 * without keywords (a name with keywords is a group label such as "Backend", not a skill).
 * Lowercased and deduplicated, in order.
 */
export function deriveNormalizedSkills(skills: unknown): string[] | null {
  if (!Array.isArray(skills)) return null;
  const items: string[] = [];
  for (const skill of skills) {
    if (!isRecord(skill)) continue;
    const keywords = Array.isArray(skill.keywords)
      ? skill.keywords.filter((k): k is string => typeof k === "string")
      : [];
    if (keywords.length > 0) items.push(...keywords);
    else if (typeof skill.name === "string") items.push(skill.name);
  }
  return dedupeLowercase(items);
}

/** Pairs (section, organization key, title key) whose organization may swallow the title. */
const ORG_TITLE_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ["work", "name", "position"],
  ["volunteer", "organization", "position"],
  ["education", "institution", "studyType"],
];

function stripTitlesFromOrgs(resume: Record<string, unknown>, warnings: string[]): void {
  for (const [section, orgKey, titleKey] of ORG_TITLE_PAIRS) {
    const entries = resume[section];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, i) => {
      if (!isRecord(entry)) return;
      const org = entry[orgKey];
      const title = entry[titleKey];
      if (section !== "education" && typeof org === "string" && (title ?? null) === null) {
        // The model copied a whole "Científica de Datos, Telecom S.A." line into name and left
        // position empty.
        const parts = splitTitleAndOrg(org);
        if (!parts) return;
        entry[orgKey] = parts.org;
        entry[titleKey] = parts.title;
        warnings.push(
          `${section}[${i}].${orgKey}: "${org}" holds the ${titleKey} too; split into ${orgKey} "${parts.org}" and ${titleKey} "${parts.title}".`,
        );
        return;
      }
      if (typeof org !== "string" || typeof title !== "string") return;
      if (normalizeForMatch(org) === normalizeForMatch(title)) {
        // The model copied "Freelance — Full-Stack Developer" into both fields.
        const parts = splitOrgAndTitle(org);
        if (!parts) return;
        [entry[orgKey], entry[titleKey]] = parts;
        warnings.push(
          `${section}[${i}]: ${orgKey} and ${titleKey} were both "${org}"; split into ${orgKey} "${parts[0]}" and ${titleKey} "${parts[1]}".`,
        );
        return;
      }
      const stripped = stripTitleFromOrg(org, title);
      if (stripped === null) return;
      entry[orgKey] = stripped;
      warnings.push(
        `${section}[${i}].${orgKey}: removed the ${titleKey} from "${org}"; kept "${stripped}".`,
      );
    });
  }
}

/**
 * Deterministic post-processing applied to whatever the model returned:
 * - trims strings and converts empty ones to `null`;
 * - removes identical repeated entries from every section (and repeated highlights / keywords
 *   inside an entry), with a `model:` warning ({@link dedupeResumeEntries});
 * - normalizes every date field to ISO (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`), turning
 *   "actualidad" / "present" into `null` and warning on dates it cannot understand;
 * - removes a title glued to its organization (`work[].name` "Freelance — Developer" with
 *   position "Developer" -> "Freelance"; same for `volunteer[]` and `education[].institution`),
 *   splits an organization and title that are the same "Org — Title" string
 *   ({@link splitOrgAndTitle}), and splits a `work[]`/`volunteer[]` organization that holds the
 *   whole "Title, Company" line while the position is empty ({@link splitTitleAndOrg});
 * - splits comma/semicolon-joined `skills[].keywords` and `skills[].name` values into separate
 *   items ({@link splitSkillList});
 * - derives `x_cvparse.normalizedSkills` from `skills` ({@link deriveNormalizedSkills}), ignoring
 *   whatever the model wrote there;
 * - uppercases and validates ISO country codes;
 * - fills `x_cvparse.detectedLanguage` heuristically when the model left it empty;
 * - classifies every `education[].studyType` into `x_cvparse.educationLevels` (a parallel
 *   array, same order) without touching `studyType` itself;
 * - for single-date fields (`awards[].date`, `certificates[].date`, `publications[].releaseDate`)
 *   that list several dates ("2012, 2019"), keeps the latest, with a warning;
 * - with `options.sourceText`, reduces dates padded with an invented month / day ("2020-01" when
 *   the CV only says "2020") to the precision the document supports, with a `precision:` warning;
 * - drops `x_cvparse.confidenceNotes` that are not readable text ({@link isMeaningfulNote}).
 *
 * `sourceText` (second parameter) only feeds language detection; pass `options.sourceText` for
 * the precision check.
 *
 * Returns a new object; the input is not mutated.
 */
export function normalizeResume(
  input: unknown,
  sourceText?: string,
  options: NormalizeOptions = {},
): NormalizeResult {
  const warnings: string[] = [];
  const tidied = tidyStrings(input);
  const resume: Record<string, unknown> = isRecord(tidied) ? tidied : {};

  // A repeated entry is never valid in a CV: it is the model repeating itself.
  warnings.push(...dedupeResumeEntries(resume));

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
      const latest = SINGLE_DATE_KEYS.has(key) ? pickLatestDate(raw, options) : null;
      if (latest !== null) {
        obj[key] = latest;
        warnings.push(`${path}: "${raw}" has several dates; kept the latest ("${latest}").`);
        continue;
      }
      warnings.push(`${path}: could not normalize date "${raw}"; set to null.`);
    }
    obj[key] = normalized.value;
  }

  if (options.sourceText) {
    for (const { path, obj, key } of collectDateFields(resume)) {
      const value = obj[key];
      if (typeof value !== "string") continue;
      const reduced = reduceDatePrecision(value, options.sourceText);
      if (!reduced) continue;
      obj[key] = reduced.value;
      warnings.push(
        `precision: ${path} "${value}" reduced to "${reduced.value}" (no ${reduced.reason} in the document).`,
      );
    }
  }

  const ext = isRecord(resume.x_cvparse) ? resume.x_cvparse : {};
  resume.x_cvparse = ext;

  if (Array.isArray(ext.confidenceNotes)) {
    ext.confidenceNotes = ext.confidenceNotes.filter(
      (note): note is string => typeof note === "string" && isMeaningfulNote(note),
    );
  }

  stripTitlesFromOrgs(resume, warnings);

  if (Array.isArray(resume.skills)) resume.skills = splitSkills(resume.skills);
  // Always derived from skills: what the model writes here is ignored (small models return
  // stringified objects or translations that are not in the CV).
  const normalizedSkills = deriveNormalizedSkills(resume.skills);
  if (normalizedSkills) {
    ext.normalizedSkills = normalizedSkills;
  } else {
    delete ext.normalizedSkills;
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
