import type { Resume } from "../schema/resume.js";
import { normalizeDate } from "./dates.js";
import { collectEducationLevels } from "./education.js";
import { looksLikeJobTitle, looksLikeOrganization } from "./titles.js";

/**
 * Deterministic grounding: checks the fields a model most often invents (contact data,
 * locations, skills, spoken languages and their fluency, degree titles, job titles) against the
 * document text and drops or repairs what is not there.
 *
 * Only fields whose value must appear in the CV more or less verbatim are checked. Free text
 * (summaries, highlights, company names) and dates are left alone: models legitimately rejoin
 * broken lines, fix OCR noise and normalize dates, so a literal match would throw away good data.
 * Degree and job titles are recovered from the line of their institution / company when the
 * model rewrote them ("Bachelor's degree" for "Computer Engineering").
 */

/** Output of {@link groundResume}. */
export interface GroundResult {
  resume: Resume;
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// Text normalization and matching

/** NFKC, strip diacritics, lowercase, collapse whitespace. Used on both sides of every match. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const ALNUM = /[\p{L}\p{N}]/u;
const SEPARATORS = new Set([" ", ".", "-", "_", "/"]);

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

const termRegexCache = new Map<string, RegExp>();

/**
 * Regex for a normalized term with token boundaries, so "java" does not match "javascript" and
 * "c" does not match "c#". Separators between two alphanumerics are optional and
 * interchangeable ("next.js" matches "nextjs", "next js", "next-js"; "agile / scrum" matches
 * "agile/scrum"); leading/trailing punctuation (".net", "c#", "c++") is literal.
 */
function termRegex(term: string): RegExp {
  const cached = termRegexCache.get(term);
  if (cached) return cached;
  const chars = [...term];
  let body = "";
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] as string;
    if (SEPARATORS.has(char)) {
      let j = i;
      while (j < chars.length && SEPARATORS.has(chars[j] as string)) j++;
      const prev = chars[i - 1];
      const next = chars[j];
      if (prev && next && ALNUM.test(prev) && ALNUM.test(next)) {
        // "agile / scrum" also matches "agile/scrum" and "agile scrum".
        body += "(?:\\s?[._/-]?\\s?)";
        i = j - 1;
        continue;
      }
    }
    body += escapeRegex(char);
  }
  const first = chars[0] ?? "";
  const last = chars[chars.length - 1] ?? "";
  // A leading alphanumeric must not continue a word ("script" in "javascript") nor follow a dot
  // inside a word ("js" in "node.js"). A leading symbol (".net") may follow anything.
  const head = ALNUM.test(first) ? "(?<![\\p{L}\\p{N}])(?<![\\p{L}\\p{N}][.])" : "";
  const tail = ALNUM.test(last)
    ? "(?![\\p{L}\\p{N}+#])(?![.][\\p{L}\\p{N}])"
    : "(?![\\p{L}\\p{N}+#])";
  const regex = new RegExp(`${head}${body}${tail}`, "gu");
  termRegexCache.set(term, regex);
  return regex;
}

/** True when `term` (normalized) occurs in `haystack` (normalized) on token boundaries. */
function hasTerm(haystack: string, term: string): boolean {
  if (term === "") return false;
  const regex = termRegex(term);
  regex.lastIndex = 0;
  return regex.test(haystack);
}

function countTerm(haystack: string, term: string): number {
  if (term === "") return 0;
  return haystack.match(termRegex(term))?.length ?? 0;
}

/**
 * {@link normalizeForMatch} applied character by character, remembering where each normalized
 * character came from, so a match in the normalized text can be cut out of the original.
 */
interface MappedText {
  text: string;
  /** Original index where normalized char `i` starts. */
  start: number[];
  /** Original index right after normalized char `i`. */
  end: number[];
}

function normalizeWithMap(original: string): MappedText {
  let text = "";
  const start: number[] = [];
  const end: number[] = [];
  let index = 0;
  for (const char of original) {
    const from = index;
    index += char.length;
    if (/\s/u.test(char)) {
      if (text !== "" && !text.endsWith(" ")) {
        text += " ";
        start.push(from);
        end.push(index);
      }
      continue;
    }
    const norm = normalizeForMatch(char);
    for (const c of norm) {
      text += c;
      start.push(from);
      end.push(index);
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    start.pop();
    end.pop();
  }
  return { text, start, end };
}

/** Original [start, end) span of the first occurrence of a normalized term in `original`. */
function findTermSpan(original: string, term: string): { start: number; end: number } | null {
  if (term === "") return null;
  const mapped = normalizeWithMap(original);
  const regex = termRegex(term);
  regex.lastIndex = 0;
  const match = regex.exec(mapped.text);
  if (!match || match[0].length === 0) return null;
  const last = match.index + match[0].length - 1;
  return { start: mapped.start[match.index] ?? 0, end: mapped.end[last] ?? original.length };
}

/** The document, pre-normalized in the shapes the rules need. */
interface Source {
  /** Whole document, normalized, whitespace collapsed. */
  text: string;
  /** Same, with every whitespace removed (OCR inserts spaces inside emails and URLs). */
  compact: string;
  /** Normalized with URL schemes and `www.` removed. */
  urls: string;
  /** Each line normalized (for "same line" checks). */
  lines: string[];
  /** Each line as written (same indexes as `lines`), for recovering values with their casing. */
  rawLines: string[];
  /** Digit sequences of every phone-like span. */
  digitRuns: string[];
  /** Original text, for case-sensitive country code tokens. */
  original: string;
}

function buildSource(sourceText: string): Source {
  const text = normalizeForMatch(sourceText);
  const urls = text.replace(/\bhttps?:\/\//g, "").replace(/\bwww\./g, "");
  const digitRuns: string[] = [];
  for (const match of sourceText.matchAll(/\+?\(?\d[\d\s().\-/]{4,}\d/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 5) digitRuns.push(digits);
  }
  return {
    text,
    compact: text.replace(/\s/g, ""),
    urls,
    lines: sourceText.split(/\r?\n/).map(normalizeForMatch),
    rawLines: sourceText.split(/\r?\n/),
    digitRuns,
    original: sourceText,
  };
}

function stripUrl(value: string): string {
  return normalizeForMatch(value)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#]+$/, "");
}

function urlGrounded(src: Source, value: string): boolean {
  const url = stripUrl(value);
  if (url === "") return false;
  return src.urls.includes(url) || src.compact.includes(url.replace(/\s/g, ""));
}

function emailGrounded(src: Source, value: string): boolean {
  const email = normalizeForMatch(value).replace(/^mailto:/, "");
  if (email === "") return false;
  return src.text.includes(email) || src.compact.includes(email.replace(/\s/g, ""));
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/**
 * A phone is grounded when its last 7+ digits end one of the document's phone-like digit runs
 * (the model may add a country code or drop a trunk prefix). Short numbers must match whole.
 */
function phoneGrounded(src: Source, value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 0) return false;
  const needed = Math.min(7, digits.length);
  return src.digitRuns.some(
    (run) => commonSuffixLength(run, digits) >= needed || run.includes(digits),
  );
}

// ---------------------------------------------------------------------------------------------
// Places

/** Alternative names for the same city; any spelling in the document grounds the others. */
const CITY_ALIASES: readonly (readonly string[])[] = [
  [
    "buenos aires",
    "caba",
    "c.a.b.a.",
    "capital federal",
    "ciudad autonoma de buenos aires",
    "ciudad de buenos aires",
  ],
  ["mexico city", "ciudad de mexico", "cdmx", "mexico d.f.", "mexico df"],
  ["bogota", "bogota d.c.", "bogota dc", "santa fe de bogota"],
  ["sao paulo", "san pablo"],
  ["new york", "new york city", "nyc", "nueva york"],
  ["london", "londres"],
];

/** Country names (normalized) by ISO 3166-1 alpha-2 code. */
const COUNTRY_NAMES: Record<string, readonly string[]> = {
  AR: ["argentina"],
  BO: ["bolivia"],
  BR: ["brasil", "brazil"],
  CA: ["canada"],
  CL: ["chile"],
  CO: ["colombia"],
  CR: ["costa rica"],
  CU: ["cuba"],
  DE: ["germany", "alemania", "alemanha", "deutschland"],
  DO: ["republica dominicana", "dominican republic"],
  EC: ["ecuador"],
  ES: ["espana", "spain", "espanha"],
  FR: ["france", "francia", "franca"],
  GB: ["united kingdom", "reino unido", "england", "inglaterra", "uk"],
  GT: ["guatemala"],
  HN: ["honduras"],
  IE: ["ireland", "irlanda"],
  IT: ["italy", "italia"],
  MX: ["mexico"],
  NI: ["nicaragua"],
  NL: ["netherlands", "paises bajos", "holanda", "holland"],
  PA: ["panama"],
  PE: ["peru"],
  PR: ["puerto rico"],
  PT: ["portugal"],
  PY: ["paraguay"],
  SV: ["el salvador"],
  US: ["united states", "estados unidos", "usa", "eeuu", "ee.uu.", "ee. uu."],
  UY: ["uruguay"],
  VE: ["venezuela"],
};

function cityVariants(city: string): string[] {
  const norm = normalizeForMatch(city);
  const head = norm.split(/[,(]/)[0]?.trim() ?? "";
  const variants = new Set([norm, head].filter((v) => v !== ""));
  for (const group of CITY_ALIASES) {
    if (group.includes(norm) || group.includes(head)) for (const v of group) variants.add(v);
  }
  return [...variants];
}

function placeGrounded(src: Source, value: string): boolean {
  return cityVariants(value).some((v) => hasTerm(src.text, v));
}

/** Occurrences of a place in the document, counting its best-matching spelling. */
function placeCount(src: Source, value: string): number {
  const whole = countTerm(src.text, normalizeForMatch(value));
  if (whole > 0) return whole;
  return Math.max(0, ...cityVariants(value).map((v) => countTerm(src.text, v)));
}

function countryGrounded(src: Source, code: string): boolean {
  const upper = code.trim().toUpperCase();
  if (new RegExp(`(?<![A-Za-z])${upper}(?![A-Za-z])`).test(src.original)) return true;
  return (COUNTRY_NAMES[upper] ?? []).some((name) => hasTerm(src.text, name));
}

/** "Ciudad de Cusco" -> "Cusco": a generic "city of" prefix the model added. */
const CITY_PREFIX = /^\s*(?:ciudad de|city of)\s+/iu;

function isCountryName(norm: string): boolean {
  return Object.values(COUNTRY_NAMES).some((names) => names.includes(norm));
}

/**
 * A city that IS in the document, recovered from location values the model wrote: the model's
 * city without a "Ciudad de" prefix, else the first part of an address / raw location ("Mendoza,
 * Argentina" -> "Mendoza"). Used when the model's city is not in the document (llama3.1 answers
 * "Ciudad Autónoma de Buenos Aires" for "Córdoba, Argentina", copying the prompt's example).
 */
function recoverCity(
  src: Source,
  city: string,
  sources: readonly (string | null)[],
): string | null {
  const candidates = [city.replace(CITY_PREFIX, "").trim()];
  for (const value of sources) {
    if (value) candidates.push(value.split(/[,(·|—–]/u)[0]?.trim() ?? "");
  }
  for (const candidate of candidates) {
    const norm = normalizeForMatch(candidate);
    if (norm === "" || norm === normalizeForMatch(city) || /\d/.test(norm)) continue;
    if (isCountryName(norm) || WORK_MODES.has(norm)) continue;
    if (placeGrounded(src, candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Languages

const LANGUAGE_NAMES: readonly (readonly string[])[] = [
  ["english", "ingles", "anglais", "englisch"],
  ["spanish", "espanol", "castellano", "espanhol", "castilian"],
  ["portuguese", "portugues"],
  ["french", "frances", "francais", "franzosisch"],
  ["german", "aleman", "alemao", "deutsch"],
  ["italian", "italiano"],
  ["chinese", "mandarin", "mandarin chinese", "chino", "chino mandarin", "chines", "cantonese"],
  ["japanese", "japones"],
  ["korean", "coreano"],
  ["russian", "ruso", "russo"],
  ["arabic", "arabe"],
  ["hebrew", "hebreo", "hebraico"],
  ["dutch", "neerlandes", "holandes"],
  ["catalan", "catala"],
  ["guarani"],
  ["quechua"],
  ["hindi"],
  ["polish", "polaco"],
];

/** Every spelling of a language name (all known translations when the language is known). */
function languageVariants(value: string): string[] {
  const norm = normalizeForMatch(value);
  const head = norm.split(/[(,:\-–/]/)[0]?.trim() ?? "";
  const group = LANGUAGE_NAMES.find((g) => g.includes(norm) || g.includes(head));
  return group ? [...group] : [norm, head].filter((v) => v !== "");
}

function languageGrounded(src: Source, value: string): boolean {
  return languageVariants(value).some((v) => hasTerm(src.text, v));
}

/** Level words (normalized) a CV writes next to a language, longest first. */
const LEVEL_WORDS = [
  "native or bilingual proficiency",
  "full professional proficiency",
  "professional working proficiency",
  "limited working proficiency",
  "elementary proficiency",
  "idioma materno",
  "lengua materna",
  "lingua materna",
  "lingua nativa",
  "mother tongue",
  "native speaker",
  "upper intermediate",
  "upper-intermediate",
  "pre-intermediate",
  "conversational",
  "conversacional",
  "intermediario",
  "intermediate",
  "intermedio",
  "intermedia",
  "principiante",
  "elementary",
  "proficient",
  "bilingual",
  "bilingue",
  "avanzado",
  "avanzada",
  "avancado",
  "advanced",
  "elemental",
  "beginner",
  "materno",
  "materna",
  "nativo",
  "nativa",
  "native",
  "fluent",
  "fluido",
  "fluida",
  "fluente",
  "basico",
  "basica",
  "basic",
] as const;

const LEVEL = String.raw`(?:[abc][12]\+?|${LEVEL_WORDS.map((w) => w.replace(/[-]/g, "[- ]")).join("|")})(?![\p{L}\p{N}])`;
/**
 * A level written right after a language name: "English (C1)", "Inglés: avanzado", "Inglés - B2",
 * "Inglés avanzado (C1)", "English C1 - Advanced". Matched on normalized text.
 */
const LEVEL_AFTER_NAME = new RegExp(
  String.raw`^[\s(:\-–—|=]*(${LEVEL}(?:\s*[(\-–—/,]?\s*\(?\s*${LEVEL}\s*\)?)?)`,
  "u",
);

/** The level written at the start of `text` (original casing), or `null`. */
function leadingLevel(text: string): string | null {
  const mapped = normalizeWithMap(text);
  const match = LEVEL_AFTER_NAME.exec(mapped.text);
  const captured = match?.[1];
  if (!match || !captured) return null;
  const from = match[0].length - captured.length;
  const to = match[0].length - 1;
  let written = text.slice(mapped.start[from] ?? 0, mapped.end[to] ?? text.length).trim();
  if (written.endsWith(")") && !written.includes("(")) written = written.slice(0, -1).trim();
  return written === "" ? null : written;
}

interface LevelEvidence {
  /** Level written right after the language name, as written. */
  written: string | null;
  /** True when the model's fluency appears on a line of the language (or the next line). */
  verbatim: boolean;
}

/**
 * Looks for the fluency of a language in the document: a level written right after the language
 * name (same line, or the start of the next line when the name ends its line), and the model's
 * value anywhere on the language's line or the next one (unless that line names another language).
 */
function levelEvidence(src: Source, language: string, fluency: string): LevelEvidence {
  const variants = languageVariants(language);
  const fluencyNorm = normalizeForMatch(fluency);
  const otherLanguages = LANGUAGE_NAMES.filter((g) => !g.some((n) => variants.includes(n))).flat();
  let written: string | null = null;
  let verbatim = false;
  src.lines.forEach((line, i) => {
    if (!variants.some((v) => hasTerm(line, v))) return;
    const raw = src.rawLines[i] ?? "";
    const next = src.lines[i + 1] ?? "";
    const nextNamesOther = otherLanguages.some((n) => hasTerm(next, n));
    if (hasTerm(line, fluencyNorm) || (!nextNamesOther && hasTerm(next, fluencyNorm))) {
      verbatim = true;
    }
    if (written !== null) return;
    for (const v of variants) {
      const span = findTermSpan(raw, v);
      if (!span) continue;
      const rest = raw.slice(span.end);
      written = leadingLevel(rest);
      if (written === null && /^[\s:\-–—|=]*$/u.test(rest) && !nextNamesOther) {
        written = leadingLevel(src.rawLines[i + 1] ?? "");
      }
      if (written !== null) break;
    }
  });
  return { written, verbatim };
}

/**
 * `languages[].fluency`: a level written right after the language name is authoritative; the
 * model's value is kept when it is (part of) that text, and replaced by it otherwise. Without
 * such a level, the model's value is kept only if it is written on the language's line (or the
 * next one); else it is set to null.
 */
function groundFluency(
  entry: { language?: string | null; fluency?: string | null },
  path: string,
  src: Source,
  warnings: string[],
): void {
  const language = str(entry.language);
  const fluency = str(entry.fluency);
  if (!language || !fluency) return;
  const { written, verbatim } = levelEvidence(src, language, fluency);
  if (written !== null) {
    const fluencyNorm = normalizeForMatch(fluency);
    if (hasTerm(normalizeForMatch(written), fluencyNorm)) return;
    entry.fluency = written;
    warnings.push(`grounding: ${path} "${fluency}" replaced by "${written}" as written`);
    return;
  }
  if (verbatim) return;
  entry.fluency = null;
  warnings.push(dropped(path, fluency, "not written next to the language"));
}

// ---------------------------------------------------------------------------------------------
// Rules

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function dropped(path: string, value: string, why = "not found in the document"): string {
  return `grounding: dropped ${path} "${value}" (${why})`;
}

function listNames(names: readonly string[], max = 10): string {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, max).join(", ");
  return unique.length > max ? `${shown} and ${unique.length - max} more` : shown;
}

function groundBasics(resume: Resume, src: Source, warnings: string[]): void {
  const basics = resume.basics;
  if (!basics) return;

  const email = str(basics.email);
  if (email && !emailGrounded(src, email)) {
    basics.email = null;
    warnings.push(dropped("basics.email", email));
  }
  const phone = str(basics.phone);
  if (phone && !phoneGrounded(src, phone)) {
    basics.phone = null;
    warnings.push(dropped("basics.phone", phone));
  }
  const url = str(basics.url);
  if (url && !urlGrounded(src, url)) {
    basics.url = null;
    warnings.push(dropped("basics.url", url));
  }

  if (Array.isArray(basics.profiles)) {
    const kept: NonNullable<typeof basics.profiles> = [];
    basics.profiles.forEach((profile, i) => {
      if (!isRecord(profile)) return;
      const path = `basics.profiles[${i}]`;
      const pUrl = str(profile.url);
      if (pUrl && !urlGrounded(src, pUrl)) {
        profile.url = null;
        warnings.push(dropped(`${path}.url`, pUrl));
      }
      const user = str(profile.username);
      if (user) {
        const handle = normalizeForMatch(user).replace(/^@/, "");
        if (!src.text.includes(handle) && !src.compact.includes(handle)) {
          profile.username = null;
          warnings.push(dropped(`${path}.username`, user));
        }
      }
      // A profile with neither URL nor username is kept only if the network is written.
      const network = str(profile.network);
      if (!str(profile.url) && !str(profile.username)) {
        if (!network || !hasTerm(src.text, normalizeForMatch(network))) {
          if (pUrl || user) warnings.push(`grounding: dropped ${path} (nothing left to keep)`);
          return;
        }
      }
      kept.push(profile);
    });
    basics.profiles = kept;
  }

  const loc = basics.location;
  if (loc) {
    const city = str(loc.city);
    const recovered =
      city && !placeGrounded(src, city)
        ? recoverCity(src, city, [str(loc.address), str(resume.x_cvparse?.location?.raw)])
        : null;
    if (city && recovered) {
      loc.city = recovered;
      warnings.push(
        `grounding: basics.location.city "${city}" replaced by "${recovered}" as written`,
      );
      const region = str(loc.region);
      if (region && !placeGrounded(src, region)) {
        loc.region = null;
        warnings.push(dropped("basics.location.region", region));
      }
      const address = str(loc.address);
      if (address && !placeGrounded(src, address)) {
        loc.address = null;
        warnings.push(dropped("basics.location.address", address));
      }
    } else if (city) {
      if (!placeGrounded(src, city)) {
        warnings.push(dropped("basics.location.city", city));
        loc.city = null;
        loc.region = null;
        loc.address = null;
        loc.postalCode = null;
        const code = str(loc.countryCode);
        if (code && !countryGrounded(src, code)) {
          loc.countryCode = null;
          warnings.push(dropped("basics.location.countryCode", code));
        }
      }
    } else {
      const address = str(loc.address);
      if (address && !placeGrounded(src, address)) {
        loc.address = null;
        warnings.push(dropped("basics.location.address", address));
      }
      const region = str(loc.region);
      if (region && !placeGrounded(src, region)) {
        loc.region = null;
        warnings.push(dropped("basics.location.region", region));
      }
      const code = str(loc.countryCode);
      if (code && !countryGrounded(src, code)) {
        loc.countryCode = null;
        warnings.push(dropped("basics.location.countryCode", code));
      }
    }
    if (Object.values(loc).every((v) => v === null || v === undefined)) basics.location = null;
  }
}

function groundExtensionLocation(resume: Resume, src: Source, warnings: string[]): void {
  const ext = resume.x_cvparse;
  const loc = ext?.location;
  if (!ext || !loc) return;
  const city = str(loc.city);
  const raw = str(loc.raw);
  const label = raw ?? city ?? "";
  if (city) {
    if (placeGrounded(src, city)) return;
    const recovered = recoverCity(src, city, [raw]);
    if (recovered) {
      loc.city = recovered;
      warnings.push(
        `grounding: x_cvparse.location.city "${city}" replaced by "${recovered}" as written`,
      );
      const region = str(loc.adminRegion);
      if (region && !placeGrounded(src, region)) {
        loc.adminRegion = null;
        warnings.push(dropped("x_cvparse.location.adminRegion", region));
      }
    } else if (!(raw && placeGrounded(src, raw))) {
      ext.location = null;
      warnings.push(dropped("x_cvparse.location", label, "city not found in the document"));
    }
    return;
  }
  const region = str(loc.adminRegion);
  if (raw && !placeGrounded(src, raw) && !(region && placeGrounded(src, region))) {
    ext.location = null;
    warnings.push(dropped("x_cvparse.location", label));
    return;
  }
  const code = str(loc.countryCode);
  if (code && !countryGrounded(src, code)) {
    loc.countryCode = null;
    warnings.push(dropped("x_cvparse.location.countryCode", code));
  }
  if (Object.values(loc).every((v) => v === null || v === undefined)) ext.location = null;
}

/**
 * Entry locations (`work[].location`, `education[].location`). Dropped when not in the
 * document, and also when one value is claimed by more entries than it occurs in the document:
 * that is the signature of the candidate's address copied into every entry.
 */
function groundEntryLocations(
  entries: Array<{ location?: string | null | undefined }> | null | undefined,
  section: string,
  src: Source,
  warnings: string[],
): void {
  if (!Array.isArray(entries)) return;
  const claims = new Map<string, number>();
  for (const entry of entries) {
    const loc = isRecord(entry) ? str(entry.location) : null;
    if (loc) claims.set(normalizeForMatch(loc), (claims.get(normalizeForMatch(loc)) ?? 0) + 1);
  }
  let missing = 0;
  const copied = new Map<string, number>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const loc = str(entry.location);
    if (!loc) continue;
    if (!placeGrounded(src, loc)) {
      entry.location = null;
      missing++;
      continue;
    }
    const claimed = claims.get(normalizeForMatch(loc)) ?? 0;
    if (claimed >= 2 && placeCount(src, loc) < claimed) {
      entry.location = null;
      copied.set(loc, (copied.get(loc) ?? 0) + 1);
    }
  }
  const plural = (n: number) => (n === 1 ? "entry" : "entries");
  if (missing > 0) {
    warnings.push(
      `grounding: dropped location from ${missing} ${section} ${plural(missing)} (not found in the document)`,
    );
  }
  for (const [loc, n] of copied) {
    warnings.push(
      `grounding: dropped location "${loc}" from ${n} ${section} ${plural(n)} (it appears fewer times in the document than entries claim it; probably copied from the candidate's address)`,
    );
  }
}

function skillGrounded(src: Source, value: string): boolean {
  return hasTerm(src.text, normalizeForMatch(value));
}

/** Indexes of the lines where `term` occurs. */
function linesWith(src: Source, term: string): number[] {
  const out: number[] = [];
  src.lines.forEach((line, i) => {
    if (hasTerm(line, term)) out.push(i);
  });
  return out;
}

/**
 * Skills. An entry without keywords is kept only if its name is in the document. For grouped
 * skills, keywords are filtered one by one; the entry survives if any keyword survives (its name
 * may be a label the model chose, e.g. "Backend") or if its name is in the document.
 *
 * A level is kept only if it is written on the same line as the skill (or one of its keywords),
 * or the line right after (tables split by PDF extraction); when the skill cannot be located on
 * any line, anywhere in the document is enough. A level that is itself the name of a skill
 * (".NET" as the level of "React") is always dropped.
 */
function groundSkills(resume: Resume, src: Source, warnings: string[]): void {
  const skills = resume.skills;
  if (!Array.isArray(skills)) {
    groundNormalizedSkills(resume, src, new Set(), warnings);
    return;
  }

  const allNames = new Set<string>();
  for (const skill of skills) {
    if (!isRecord(skill)) continue;
    const name = str(skill.name);
    if (name) allNames.add(normalizeForMatch(name));
    for (const k of skill.keywords ?? []) if (str(k)) allNames.add(normalizeForMatch(k));
  }

  const droppedNames: string[] = [];
  const droppedLevels: string[] = [];
  const keptNames = new Set<string>();
  const kept: typeof skills = [];

  for (const skill of skills) {
    if (!isRecord(skill)) continue;
    const name = str(skill.name);
    const nameOk = name ? skillGrounded(src, name) : false;
    const keywords = (skill.keywords ?? []).filter((k): k is string => str(k) !== null);
    const keptKeywords = keywords.filter((k) => {
      const ok = skillGrounded(src, k);
      if (!ok) droppedNames.push(k);
      return ok;
    });
    if (keywords.length > 0) skill.keywords = keptKeywords;

    const keep = nameOk || keptKeywords.length > 0;
    if (!keep) {
      if (name) droppedNames.push(name);
      continue;
    }

    const level = str(skill.level);
    if (level) {
      const levelNorm = normalizeForMatch(level);
      let ok: boolean;
      if (allNames.has(levelNorm)) {
        ok = false;
      } else {
        const anchors = [...(nameOk && name ? [name] : []), ...keptKeywords].map(normalizeForMatch);
        const lines = [...new Set(anchors.flatMap((a) => linesWith(src, a)))];
        ok =
          lines.length === 0
            ? hasTerm(src.text, levelNorm)
            : lines.some(
                (i) =>
                  hasTerm(src.lines[i] ?? "", levelNorm) ||
                  hasTerm(src.lines[i + 1] ?? "", levelNorm),
              );
      }
      if (!ok) {
        skill.level = null;
        droppedLevels.push(`${name ?? "?"}: ${level}`);
      }
    }

    if (name && nameOk) keptNames.add(normalizeForMatch(name));
    for (const k of keptKeywords) keptNames.add(normalizeForMatch(k));
    kept.push(skill);
  }
  resume.skills = kept;

  if (droppedNames.length > 0) {
    const n = new Set(droppedNames).size;
    warnings.push(
      `grounding: dropped ${n} skill${n === 1 ? "" : "s"} not found in the document: ${listNames(droppedNames)}`,
    );
  }
  if (droppedLevels.length > 0) {
    warnings.push(
      `grounding: dropped the level of ${droppedLevels.length} skill${droppedLevels.length === 1 ? "" : "s"} (not written next to the skill): ${listNames(droppedLevels)}`,
    );
  }
  groundNormalizedSkills(resume, src, keptNames, warnings);
}

/**
 * `x_cvparse.normalizedSkills` keeps entries that are in the document or that equal a kept
 * skill name/keyword. Canonical English translations of Spanish skills that are not written in
 * the document ("team leadership" for "Liderazgo de equipos") are dropped too: grounding cannot
 * tell a translation from an invention.
 */
function groundNormalizedSkills(
  resume: Resume,
  src: Source,
  keptNames: Set<string>,
  warnings: string[],
): void {
  const ext = resume.x_cvparse;
  if (!ext || !Array.isArray(ext.normalizedSkills)) return;
  const removed: string[] = [];
  ext.normalizedSkills = ext.normalizedSkills.filter((s) => {
    const norm = normalizeForMatch(s);
    const ok = keptNames.has(norm) || hasTerm(src.text, norm);
    if (!ok) removed.push(s);
    return ok;
  });
  if (removed.length > 0) {
    warnings.push(
      `grounding: dropped ${removed.length} x_cvparse.normalizedSkills entr${removed.length === 1 ? "y" : "ies"} not found in the document: ${listNames(removed)}`,
    );
  }
}

function groundLanguages(resume: Resume, src: Source, warnings: string[]): void {
  if (!Array.isArray(resume.languages)) return;
  const removed: string[] = [];
  resume.languages = resume.languages.filter((entry) => {
    if (!isRecord(entry)) return false;
    const language = str(entry.language);
    if (!language) return true;
    const ok = languageGrounded(src, language);
    if (!ok) removed.push(language);
    return ok;
  });
  if (removed.length > 0) {
    warnings.push(
      `grounding: dropped ${removed.length} language${removed.length === 1 ? "" : "s"} not found in the document: ${listNames(removed)}`,
    );
  }
  resume.languages.forEach((entry, i) => {
    groundFluency(entry, `languages[${i}].fluency`, src, warnings);
  });
}

// ---------------------------------------------------------------------------------------------
// Degree and job titles

/** Separators between the parts of an entry line: "UBA — Computer Engineering (2020–2021)". */
const LINE_PARTS = /\s*(?:[—–|·•()[\],;\t]|\s-\s|\s-$|^-\s)\s*/u;

/** Work-mode words that sit next to a company name but are not titles. */
const WORK_MODES = new Set([
  "remote",
  "remoto",
  "remota",
  "hybrid",
  "hibrido",
  "hibrida",
  "on-site",
  "onsite",
  "presencial",
  "full-time",
  "part-time",
  "tiempo completo",
  "medio tiempo",
  "contract",
  "contractor",
]);

function isPlaceName(norm: string): boolean {
  if (CITY_ALIASES.some((group) => group.includes(norm))) return true;
  return Object.values(COUNTRY_NAMES).some((names) => names.includes(norm));
}

/** A part of an entry line that can be a title: has letters, no digits, is not a date word or a place. */
function titleCandidate(part: string, exclude: readonly string[]): boolean {
  if (!/\p{L}{2,}/u.test(part) || /\d/.test(part) || part.length > 100) return false;
  // Acronyms are the organization's short name ("Universidad de Buenos Aires (UBA)").
  if (/^[\p{Lu}.&]{2,8}$/u.test(part)) return false;
  const norm = normalizeForMatch(part);
  if (exclude.includes(norm) || isPlaceName(norm) || WORK_MODES.has(norm)) return false;
  // Ongoing markers ("Present", "Actualidad") and bare month names ("Marzo").
  if (normalizeDate(part).current) return false;
  if (normalizeDate(`${part} 2000`).value?.startsWith("2000-")) return false;
  return true;
}

function splitLineParts(text: string): string[] {
  return text
    .split(LINE_PARTS)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/**
 * The title written next to an organization: the first title-like part after it on its line
 * ("UBA — Computer Engineering (2020–2021)"), else the last one before it ("Computer
 * Engineering, UBA"), else the first one on the next line when the organization line has nothing
 * else ("UBA\nComputer Engineering · 2020 – 2021").
 */
export function recoverTitleNearOrg(
  sourceText: string,
  org: string,
  exclude: readonly string[] = [],
): string | null {
  const orgNorm = normalizeForMatch(org);
  if (orgNorm === "") return null;
  const excluded = [orgNorm, ...exclude.map(normalizeForMatch)];
  const rawLines = sourceText.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? "";
    const span = findTermSpan(raw, orgNorm);
    if (!span) continue;
    const after = splitLineParts(raw.slice(span.end));
    const before = splitLineParts(raw.slice(0, span.start));
    const found =
      after.find((p) => titleCandidate(p, excluded)) ??
      before.reverse().find((p) => titleCandidate(p, excluded));
    if (found) return found;
    const next = (rawLines[i + 1] ?? "").trim();
    if (next === "" || /^[-•*·▪●◦]/u.test(next)) continue;
    const fromNext = splitLineParts(next).find((p) => titleCandidate(p, excluded));
    if (fromNext) return fromNext;
  }
  return null;
}

/** A part of an entry line that can be an employer: like a title, but acronyms are fine. */
function orgCandidate(part: string, exclude: readonly string[]): boolean {
  if (!/\p{L}{2,}/u.test(part) || /\d/.test(part) || part.length > 100) return false;
  const norm = normalizeForMatch(part);
  if (exclude.includes(norm) || isPlaceName(norm) || WORK_MODES.has(norm)) return false;
  if (normalizeDate(part).current) return false;
  if (normalizeDate(`${part} 2000`).value?.startsWith("2000-")) return false;
  return !looksLikeJobTitle(part);
}

/** Separators that may sit right before a title written as its own part of a line. */
const PART_START = /(?:^|[—–|·•,;([\t:]|\s-)$/u;

/**
 * `true` when the `span` of `raw` is a whole part of the line: preceded by the line start or a
 * separator, and followed by a separator, the line end or a date ("Enfermero Asistencial febrero
 * 2024 – julio 2025"). Rules out a title quoted inside a sentence ("Desarrolladora Backend con 9
 * años de experiencia").
 */
function isWholePart(raw: string, span: { start: number; end: number }): boolean {
  if (!PART_START.test(raw.slice(0, span.start).trimEnd())) return false;
  const rest = (raw.slice(span.end).split(LINE_PARTS)[0] ?? "").trim();
  if (rest === "" || /^\d/.test(rest)) return true;
  return normalizeDate(rest.split(/\s+/).slice(0, 2).join(" ")).value !== null;
}

/**
 * The employer written next to a job title: the first employer-like part after it on its line
 * ("septiembre 2021 – actualidad · Científica de Datos, Telecom S.A. (Remoto)"), else the last one
 * before it, else the first part of the next non-blank line ("Enfermero Asistencial\nClínica Santa
 * Brígida — Cusco"). The title must be a whole part of its line, and only lines for which
 * `within` is true are searched. Parts that read as job titles, places in `exclude`, dates and
 * work modes are never returned.
 */
export function recoverOrgNearTitle(
  sourceText: string,
  title: string,
  exclude: readonly string[] = [],
  within: (line: number) => boolean = () => true,
): string | null {
  const titleNorm = normalizeForMatch(title);
  if (titleNorm === "") return null;
  const excluded = [titleNorm, ...exclude.map(normalizeForMatch)];
  const rawLines = sourceText.split(/\r?\n/);
  const headings = new Set(detectSectionSpans(sourceText).map((s) => s.start));
  const isOrg = (part: string) => orgCandidate(part, excluded);
  for (let i = 0; i < rawLines.length; i++) {
    if (!within(i)) continue;
    const raw = rawLines[i] ?? "";
    const span = findTermSpan(raw, titleNorm);
    if (!span || !isWholePart(raw, span)) continue;
    const after = splitLineParts(raw.slice(span.end));
    const before = splitLineParts(raw.slice(0, span.start));
    const found = after.find(isOrg) ?? before.reverse().find(isOrg);
    if (found) return found;
    let j = i + 1;
    while (j < rawLines.length && j <= i + 2 && (rawLines[j] ?? "").trim() === "") j++;
    const next = (rawLines[j] ?? "").trim();
    if (next === "" || headings.has(j) || /^[-•*·▪●◦]/u.test(next)) continue;
    // Only the first part of the next line: later parts are its city or dates.
    const first = splitLineParts(next)[0];
    if (first && isOrg(first)) return first;
  }
  return null;
}

/**
 * Work entries whose `name` is the job title (position empty, or the same value in both): the
 * employer is recovered from the document ({@link recoverOrgNearTitle}), searching the
 * Experience section when the document has one. The model's `name` must read as a job title
 * ({@link looksLikeJobTitle}, or contain `basics.label`); otherwise nothing changes. When the
 * model put the employer in `location` ("Clínica Santa Brígida — Cusco"), it is removed from
 * there. Entries where nothing can be recovered are kept as the model wrote them.
 */
function recoverEmployers(
  resume: Resume,
  src: Source,
  places: readonly string[],
  warnings: string[],
) {
  if (!Array.isArray(resume.work)) return;
  const spans = detectSectionSpans(src.original).filter((s) => s.key === "work");
  const within =
    spans.length > 0
      ? (line: number) => spans.some((s) => line > s.start && line < s.end)
      : undefined;
  const label = str(resume.basics?.label);
  const labelNorm = label ? normalizeForMatch(label) : "";
  // The model's entry locations may hold the employer ("Pagos del Rímac S.A., Trujillo").
  const exclude = places.filter((p) => !looksLikeOrganization(p));
  resume.work.forEach((entry, i) => {
    if (!isRecord(entry)) return;
    const name = str(entry.name);
    if (!name) return;
    const position = str(entry.position);
    if (position && normalizeForMatch(position) !== normalizeForMatch(name)) return;
    const nameNorm = normalizeForMatch(name);
    const titleLike =
      looksLikeJobTitle(name) ||
      (labelNorm !== "" && !looksLikeOrganization(name) && hasTerm(nameNorm, labelNorm));
    if (!titleLike) return;
    const org = recoverOrgNearTitle(src.original, name, exclude, within);
    if (!org || normalizeForMatch(org) === nameNorm) {
      if (!position) {
        warnings.push(
          `grounding: work[${i}].name "${name}" looks like a job title and position is empty; no employer found next to it (kept)`,
        );
      }
      return;
    }
    entry.name = org;
    entry.position = position ?? name;
    const loc = str(entry.location);
    const orgNorm = normalizeForMatch(org);
    if (loc && hasTerm(normalizeForMatch(loc), orgNorm)) {
      const rest = splitLineParts(loc).filter((p) => normalizeForMatch(p) !== orgNorm);
      entry.location = rest.length > 0 ? rest.join(", ") : null;
    }
    warnings.push(
      `grounding: work[${i}].name "${name}" is the job title; set position to it and name to the employer "${org}" as written`,
    );
  });
}

/** Every location string the resume mentions, and its comma-separated parts. */
function knownPlaces(resume: Resume): string[] {
  const values: unknown[] = [];
  const basics = resume.basics?.location;
  if (basics) values.push(basics.city, basics.region, basics.address);
  const ext = resume.x_cvparse?.location;
  if (ext) values.push(ext.city, ext.adminRegion, ext.raw);
  for (const section of [resume.work, resume.education, resume.volunteer] as unknown[]) {
    if (!Array.isArray(section)) continue;
    for (const entry of section) if (isRecord(entry)) values.push(entry.location);
  }
  return values.flatMap((v) => {
    const value = str(v);
    return value ? [value, ...value.split(/[,(]/).map((p) => p.replace(/\)/g, "").trim())] : [];
  });
}

/**
 * A title (`education[].studyType`, `work[].position`) that is not in the document is replaced
 * by the title written next to its organization ({@link recoverTitleNearOrg}). When nothing can
 * be recovered, a degree type is set to null (models invent "Bachelor's degree" for a written
 * "Computer Engineering"), while a job title is kept with a warning (it is the core of the entry).
 */
function groundTitles(
  entries: unknown,
  section: "education" | "work",
  src: Source,
  places: readonly string[],
  warnings: string[],
): void {
  if (!Array.isArray(entries)) return;
  const orgKey = section === "education" ? "institution" : "name";
  const titleKey = section === "education" ? "studyType" : "position";
  entries.forEach((entry, i) => {
    if (!isRecord(entry)) return;
    const title = str(entry[titleKey]);
    if (!title || hasTerm(src.text, normalizeForMatch(title))) return;
    const path = `${section}[${i}].${titleKey}`;
    const org = str(entry[orgKey]);
    const recovered = org ? recoverTitleNearOrg(src.original, org, places) : null;
    if (recovered) {
      entry[titleKey] = recovered;
      warnings.push(`grounding: ${path} "${title}" replaced by "${recovered}" as written`);
    } else if (section === "education") {
      entry[titleKey] = null;
      warnings.push(dropped(path, title));
    } else {
      warnings.push(`grounding: ${path} "${title}" not found in the document (kept)`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Placement: entries the model put in the wrong section

type PlacementTarget = "work" | "education" | "certificates";

/**
 * The section an organization is written under: every line that names it (outside the lines
 * before the first heading, e.g. a summary) must be inside spans of `allowed` sections. Returns
 * the target section and the heading it is under, or `null` when the evidence is mixed or absent.
 */
function writtenUnder(
  src: Source,
  spans: readonly SectionSpan[],
  org: string,
  allowed: readonly SectionKey[],
): { key: SectionKey; heading: string } | null {
  const term = normalizeForMatch(org);
  if (term === "") return null;
  const found: SectionSpan[] = [];
  for (const line of linesWith(src, term)) {
    const span = spans.find((s) => line > s.start && line < s.end);
    if (span) found.push(span);
    else if (spans.some((s) => s.start === line)) return null; // the name is a heading line
  }
  if (found.length === 0) return null;
  if (!found.every((s) => s.key !== "other" && allowed.includes(s.key))) return null;
  // Education wins over certificates when the name is under both.
  const first = found.find((s) => s.key === allowed[0]) ?? (found[0] as SectionSpan);
  return { key: first.key as SectionKey, heading: first.heading };
}

function isBlankEntry(entry: Record<string, unknown>): boolean {
  return Object.values(entry).every((v) => (Array.isArray(v) ? v.length === 0 : str(v) === null));
}

/**
 * Adds `candidate` to `list`, filling an existing entry instead of duplicating it: one with the
 * same organization, else one without organization and the same dates, else a blank shell.
 * Only fields the existing entry leaves empty are filled.
 */
function mergeEntry(
  list: unknown[],
  candidate: Record<string, unknown>,
  orgKey: string,
  dateKeys: readonly string[],
): void {
  const org = normalizeForMatch(str(candidate[orgKey]) ?? "");
  const records = list.filter(isRecord);
  const sameDates = (e: Record<string, unknown>) =>
    dateKeys.some((k) => str(candidate[k]) !== null) &&
    dateKeys.every((k) => (str(e[k]) ?? null) === (str(candidate[k]) ?? null));
  const target =
    records.find((e) => {
      const own = str(e[orgKey]);
      return own !== null && org !== "" && normalizeForMatch(own) === org;
    }) ??
    records.find((e) => str(e[orgKey]) === null && sameDates(e)) ??
    records.find(isBlankEntry);
  if (!target) {
    list.push(candidate);
    return;
  }
  for (const [key, value] of Object.entries(candidate)) {
    if (value === null || value === undefined) continue;
    if (str(target[key]) === null) target[key] = value;
  }
}

function moveWarning(from: string, index: number, org: string, to: string, heading: string) {
  return `placement: moved ${from}[${index}] "${org}" to ${to} (it is under the "${heading}" heading)`;
}

/**
 * Moves entries the model put in the wrong section, judging by the heading their organization is
 * written under: a `work[]` entry whose company only appears under an Education heading becomes an
 * `education[]` entry (institution = name, studyType = position), or a `certificates[]` entry when
 * the heading is Courses / Certifications (name = position, issuer = name); an `education[]` entry
 * whose institution only appears under an Experience heading becomes a `work[]` entry. Moved
 * entries fill an existing entry of the same organization (or an empty shell) instead of
 * duplicating it. Does nothing when the document has no recognizable headings.
 */
function fixPlacement(resume: Resume, src: Source, warnings: string[]): void {
  const spans = detectSectionSpans(src.original);
  if (spans.length === 0) return;
  const record = resume as Record<string, unknown>;
  const listOf = (key: PlacementTarget): unknown[] => {
    if (!Array.isArray(record[key])) record[key] = [];
    return record[key] as unknown[];
  };

  if (Array.isArray(resume.work)) {
    const kept: unknown[] = [];
    resume.work.forEach((entry, i) => {
      const name = isRecord(entry) ? str(entry.name) : null;
      const under = name ? writtenUnder(src, spans, name, ["education", "certificates"]) : null;
      if (!isRecord(entry) || !name || !under) {
        kept.push(entry);
        return;
      }
      const position = str(entry.position);
      if (under.key === "education") {
        const candidate = {
          institution: name,
          studyType: position,
          url: str(entry.url),
          startDate: str(entry.startDate),
          endDate: str(entry.endDate),
        };
        mergeEntry(listOf("education"), candidate, "institution", ["startDate", "endDate"]);
      } else {
        const candidate = {
          name: position ?? name,
          issuer: position ? name : null,
          url: str(entry.url),
          date: str(entry.endDate) ?? str(entry.startDate),
        };
        mergeEntry(listOf("certificates"), candidate, "name", ["date"]);
      }
      warnings.push(moveWarning("work", i, name, under.key, under.heading));
    });
    resume.work = kept as typeof resume.work;
  }

  if (Array.isArray(resume.education)) {
    const kept: unknown[] = [];
    resume.education.forEach((entry, i) => {
      const institution = isRecord(entry) ? str(entry.institution) : null;
      const under = institution ? writtenUnder(src, spans, institution, ["work"]) : null;
      if (!isRecord(entry) || !institution || !under) {
        kept.push(entry);
        return;
      }
      const candidate = {
        name: institution,
        position: str(entry.studyType) ?? str(entry.area),
        url: str(entry.url),
        startDate: str(entry.startDate),
        endDate: str(entry.endDate),
      };
      mergeEntry(listOf("work"), candidate, "name", ["startDate", "endDate"]);
      warnings.push(moveWarning("education", i, institution, "work", under.heading));
    });
    resume.education = kept as typeof resume.education;
  }
}

/**
 * Drops values the model wrote that are not in `sourceText`: contact data (email, phone, URLs,
 * profiles), locations (basics, `x_cvparse.location`, per-entry `work`/`education` locations),
 * skills and skill levels (plus `x_cvparse.normalizedSkills`), spoken languages and their
 * fluency (replaced by the level written next to the language when there is one). Degree types
 * (`education[].studyType`) and job titles (`work[].position`) that are not in the document are
 * replaced by the title written next to their institution / company; `x_cvparse.educationLevels`
 * is recomputed from the grounded `studyType`s. A candidate city that is not in the document is
 * replaced by the city the model's own address / raw location writes ("Mendoza, Argentina"), or
 * the city without a "Ciudad de" prefix, before being dropped. A `work[]` entry whose `name` is a
 * job title (position empty or equal to it) gets the employer written next to that title (see
 * `recoverEmployers`). Before all that, entries the model put in the
 * wrong section are moved by the heading their organization is written under (a university in
 * `work[]` that only appears under "Education" goes to `education[]`; see `fixPlacement`), with
 * `placement:` warnings. Both sides are compared after NFKC, diacritic
 * stripping, lowercasing and whitespace collapsing.
 *
 * Only meaningful when the model saw the same text: skip it when the CV was sent as images.
 * Returns a new object; the input is not mutated.
 */
export function groundResume(resume: Resume, sourceText: string): GroundResult {
  const out = structuredClone(resume);
  const warnings: string[] = [];
  const src = buildSource(sourceText);
  // Placement first: moved entries go through the rules of their new section, and the
  // educationLevels recomputed at the end must include them.
  fixPlacement(out, src, warnings);
  // Titles next: their recovery must not mistake a location for a title, so it needs the
  // locations before grounding drops them.
  const places = knownPlaces(out);
  // Before the titles: an employer recovered here makes its title a grounded position.
  recoverEmployers(out, src, places, warnings);
  groundTitles(out.education, "education", src, places, warnings);
  groundTitles(out.work, "work", src, places, warnings);
  groundBasics(out, src, warnings);
  groundExtensionLocation(out, src, warnings);
  groundEntryLocations(out.work, "work", src, warnings);
  groundEntryLocations(
    out.education as Array<{ location?: string | null }> | null | undefined,
    "education",
    src,
    warnings,
  );
  groundSkills(out, src, warnings);
  groundLanguages(out, src, warnings);
  // studyType may have changed: the levels must describe the grounded titles.
  if (out.x_cvparse && Array.isArray(out.education)) {
    out.x_cvparse.educationLevels = collectEducationLevels(out.education);
  }
  return { resume: out, warnings };
}

// ---------------------------------------------------------------------------------------------
// Coverage: section headings in the document whose resume section came back empty

type SectionKey = "work" | "education" | "skills" | "languages" | "projects" | "certificates";

interface HeadingRule {
  key: SectionKey;
  label: string;
  /** Normalized heading words (the line may add a modifier before or a qualifier after). */
  keywords: readonly string[];
}

const HEADINGS: readonly HeadingRule[] = [
  {
    key: "work",
    label: "Experience",
    keywords: [
      "experience",
      "work experience",
      "professional experience",
      "work history",
      "employment history",
      "employment",
      "experiencia",
      "experiencia laboral",
      "experiencia profesional",
      "antecedentes laborales",
      "trayectoria profesional",
      "experiencia de trabajo",
    ],
  },
  {
    key: "education",
    label: "Education",
    keywords: [
      "education",
      "academic background",
      "educacion",
      "formacion",
      "formacion academica",
      "estudios",
    ],
  },
  {
    key: "skills",
    label: "Skills",
    keywords: [
      "skills",
      "technical skills",
      "habilidades",
      "aptitudes",
      "competencias",
      "conocimientos",
      "tech stack",
    ],
  },
  { key: "languages", label: "Languages", keywords: ["languages", "idiomas", "lenguas"] },
  {
    key: "projects",
    label: "Projects",
    keywords: ["projects", "proyectos", "featured projects", "personal projects", "side projects"],
  },
  {
    key: "certificates",
    label: "Certifications",
    keywords: [
      "certifications",
      "certificates",
      "certificaciones",
      "certificados",
      "courses",
      "cursos",
      "licenses & certifications",
      "licenses and certifications",
    ],
  },
];

/** Words a heading may start with ("Selected Projects", "Mis proyectos"). */
const HEADING_PREFIX = String.raw`(?:(?:featured|selected|key|relevant|other|personal|professional|technical|academic|additional|recent|principales|otros|otras|mis)\s+)?`;
/** Words a heading may end with ("Experiencia laboral", "Proyectos destacados"). */
const HEADING_SUFFIX = String.raw`(?:\s+(?:laboral|laborales|profesional|profesionales|academica|academicos|tecnicas|tecnicos|tecnicas|personales|destacados|destacadas|relevante|relevantes|complementaria|complementarios|history|summary))?`;
/** A second heading joined with "&", "and", "y", "e", "/" or "," ("Courses & Certifications"). */
const HEADING_JOIN = String.raw`(?:\s*(?:&|and|y|e|/|,)\s*[\p{L} ]{2,30})?`;

function headingRegex(keywords: readonly string[]): RegExp {
  const words = keywords.map((k) => k.split("").map(escapeRegex).join("")).join("|");
  return new RegExp(`^${HEADING_PREFIX}(?:${words})${HEADING_SUFFIX}${HEADING_JOIN}$`, "u");
}

const HEADING_REGEXES = HEADINGS.map((rule) => ({ rule, regex: headingRegex(rule.keywords) }));
const INLINE_LANGUAGES = /^(?:languages|idiomas|lenguas)\s*:\s*\S/u;

/**
 * Headings of sections cvparse does not check for coverage. They only end the span of the
 * previous section ({@link detectSectionSpans}), so that, e.g., a volunteering entry written after
 * "Education" is not taken for part of the education section.
 */
const BOUNDARY_HEADING_REGEX = headingRegex([
  "summary",
  "profile",
  "about",
  "about me",
  "objective",
  "perfil",
  "resumen",
  "sobre mi",
  "acerca de mi",
  "objetivo",
  "objetivos",
  "volunteer",
  "volunteering",
  "volunteer experience",
  "voluntariado",
  "awards",
  "honors",
  "premios",
  "reconocimientos",
  "references",
  "referencias",
  "interests",
  "hobbies",
  "intereses",
  "publications",
  "publicaciones",
  "contact",
  "contacto",
  "datos personales",
  "personal information",
  "informacion personal",
]);

/** The line normalized for heading detection, or `null` when it is too long to be one. */
function headingCandidate(rawLine: string): string | null {
  const line = normalizeForMatch(rawLine)
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  return line === "" || line.length > 60 ? null : line;
}

/** Section keys whose heading regex matches the (normalized) line. */
function headingKeys(line: string): SectionKey[] {
  const heading = line.replace(/[\s:.\-–—|]+$/u, "");
  if (/\d/.test(heading) || heading.split(" ").length > 6) return [];
  return HEADING_REGEXES.filter(({ regex }) => regex.test(heading)).map(({ rule }) => rule.key);
}

/** Sections whose heading (or, for languages, an inline "Languages:" label) is in the text. */
export function detectSectionHeadings(sourceText: string): Set<SectionKey> {
  const found = new Set<SectionKey>();
  for (const rawLine of sourceText.split(/\r?\n/)) {
    const line = headingCandidate(rawLine);
    if (line === null) continue;
    if (INLINE_LANGUAGES.test(line)) found.add("languages");
    for (const key of headingKeys(line)) found.add(key);
  }
  return found;
}

/** The section a line of the document belongs to. */
export interface SectionSpan {
  /** Section key, or `"other"` for a heading cvparse does not track ("Summary", "Volunteering"). */
  key: SectionKey | "other";
  /** The heading as written, without leading bullets or trailing punctuation. */
  heading: string;
  /** Line index of the heading. */
  start: number;
  /** Line index right after the section (the next heading, or the number of lines). */
  end: number;
}

/**
 * Splits the document into sections: each recognized heading line opens a span that runs until
 * the next heading. Lines before the first heading belong to no span.
 */
export function detectSectionSpans(sourceText: string): SectionSpan[] {
  const rawLines = sourceText.split(/\r?\n/);
  const spans: SectionSpan[] = [];
  rawLines.forEach((rawLine, i) => {
    const line = headingCandidate(rawLine);
    if (line === null) return;
    const keys = headingKeys(line);
    const isBoundary =
      keys.length === 0 && BOUNDARY_HEADING_REGEX.test(line.replace(/[\s:.\-–—|]+$/u, ""));
    if (keys.length === 0 && !isBoundary) return;
    const heading = rawLine
      .trim()
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/[\s:.\-–—|]+$/u, "");
    const previous = spans[spans.length - 1];
    if (previous) previous.end = i;
    spans.push({ key: keys[0] ?? "other", heading, start: i, end: rawLines.length });
  });
  return spans;
}

function isEmptySection(value: unknown): boolean {
  if (!Array.isArray(value)) return true;
  return !value.some(
    (entry) =>
      isRecord(entry) &&
      Object.values(entry).some((v) => (Array.isArray(v) ? v.length > 0 : str(v) !== null)),
  );
}

/**
 * Warnings for sections the document clearly has (a heading line such as "Projects" /
 * "Proyectos", or an inline "Languages:" label) but the extracted resume left empty: a common
 * symptom of a model that stopped early or skipped a section.
 */
export function checkCoverage(resume: Resume, sourceText: string): string[] {
  const found = detectSectionHeadings(sourceText);
  const warnings: string[] = [];
  for (const rule of HEADINGS) {
    if (!found.has(rule.key)) continue;
    if (isEmptySection(resume[rule.key])) {
      warnings.push(
        `coverage: the document has a "${rule.label}" section but ${rule.key}[] is empty`,
      );
    }
  }
  return warnings;
}
