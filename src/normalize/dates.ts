import { ISO_DATE_REGEX } from "../schema/resume.js";

/** Result of {@link normalizeDate}. */
export interface NormalizedDate {
  /** ISO date (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`), or `null` when unknown / ongoing / unparseable. */
  value: string | null;
  /** `true` when the input meant "still ongoing" ("actualidad", "presente", "present", ...). */
  current: boolean;
  /** `true` when the input was non-empty but could not be understood. */
  unparsed: boolean;
}

/** Words meaning "still ongoing" in Spanish, English and Portuguese. Matched after stripping accents. */
const CURRENT_WORDS = new Set([
  "actualidad",
  "actual",
  "actualmente",
  "presente",
  "present",
  "a la fecha",
  "hasta la fecha",
  "hasta el presente",
  "hasta la actualidad",
  "hasta hoy",
  "hoy",
  "en curso",
  "vigente",
  "current",
  "currently",
  "now",
  "ongoing",
  "to date",
  "till date",
  "today",
  "atualmente",
  "atual",
  "presente momento",
  "ate o momento",
]);

const MONTHS: Record<string, number> = {
  // Spanish
  enero: 1,
  ene: 1,
  febrero: 2,
  feb: 2,
  marzo: 3,
  mar: 3,
  abril: 4,
  abr: 4,
  mayo: 5,
  may: 5,
  junio: 6,
  jun: 6,
  julio: 7,
  jul: 7,
  agosto: 8,
  ago: 8,
  septiembre: 9,
  setiembre: 9,
  sep: 9,
  sept: 9,
  set: 9,
  octubre: 10,
  oct: 10,
  noviembre: 11,
  nov: 11,
  diciembre: 12,
  dic: 12,
  // English
  january: 1,
  jan: 1,
  february: 2,
  march: 3,
  april: 4,
  apr: 4,
  june: 6,
  july: 7,
  august: 8,
  aug: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  dec: 12,
  // Portuguese (differs from Spanish)
  janeiro: 1,
  fevereiro: 2,
  fev: 2,
  marco: 3,
  maio: 5,
  junho: 6,
  julho: 7,
  setembro: 9,
  outubro: 10,
  out: 10,
  novembro: 11,
  dezembro: 12,
  dez: 12,
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Lowercases, strips accents and collapses whitespace/punctuation noise. */
function clean(input: string): string {
  return (
    input
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      // Abbreviation dots ("mar. 2021") go away; dots inside numeric dates ("06.2018") stay.
      .replace(/\.(?=\s|$)/g, "")
      .replace(/[,;:()[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function validMonth(m: number): boolean {
  return m >= 1 && m <= 12;
}

function validDay(d: number): boolean {
  return d >= 1 && d <= 31;
}

function validYear(y: number): boolean {
  return y >= 1900 && y <= 2100;
}

/** Expands two-digit years: 24 -> 2024, 98 -> 1998. */
function expandYear(raw: string): number {
  const n = Number(raw);
  if (raw.length === 4) return n;
  return n <= 49 ? 2000 + n : 1900 + n;
}

function parseCore(text: string): string | null {
  // YYYY, YYYY-M, YYYY-M-D (also with / or . as separators)
  let m = /^(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?$/.exec(text);
  if (m?.[1]) {
    const y = Number(m[1]);
    if (!validYear(y)) return null;
    if (m[2] === undefined) return String(y);
    const mo = Number(m[2]);
    if (!validMonth(mo)) return null;
    if (m[3] === undefined) return `${y}-${pad2(mo)}`;
    const d = Number(m[3]);
    return validDay(d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
  }

  // M/YYYY or M-YYYY (Spanish / LATAM convention: month first when only two parts)
  m = /^(\d{1,2})[-/.](\d{4}|\d{2})$/.exec(text);
  if (m?.[1] && m[2]) {
    const mo = Number(m[1]);
    const y = expandYear(m[2]);
    return validMonth(mo) && validYear(y) ? `${y}-${pad2(mo)}` : null;
  }

  // D/M/YYYY (day first, as used in Spanish-speaking countries)
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(text);
  if (m?.[1] && m[2] && m[3]) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = expandYear(m[3]);
    if (validYear(y) && validMonth(mo) && validDay(d)) return `${y}-${pad2(mo)}-${pad2(d)}`;
    // Fallback for US-style M/D/YYYY when the first number cannot be a month
    if (validYear(y) && validMonth(d) && validDay(mo)) return `${y}-${pad2(d)}-${pad2(mo)}`;
    return null;
  }

  // "marzo 2020", "marzo de 2020", "mar 2020", "March 2020", "March, 2020"
  m = /^([a-z]+) (?:de |del )?(\d{4}|\d{2})$/.exec(text);
  if (m?.[1] && m[2]) {
    const mo = MONTHS[m[1]];
    const y = expandYear(m[2]);
    if (mo !== undefined && validYear(y)) return `${y}-${pad2(mo)}`;
  }

  // "2020 marzo" (rare, but seen in tables)
  m = /^(\d{4}) ([a-z]+)$/.exec(text);
  if (m?.[1] && m[2]) {
    const mo = MONTHS[m[2]];
    const y = Number(m[1]);
    if (mo !== undefined && validYear(y)) return `${y}-${pad2(mo)}`;
  }

  // "15 de marzo de 2020", "15 marzo 2020", "15 mar 2020"
  m = /^(\d{1,2}) (?:de )?([a-z]+) (?:de |del )?(\d{4}|\d{2})$/.exec(text);
  if (m?.[1] && m[2] && m[3]) {
    const d = Number(m[1]);
    const mo = MONTHS[m[2]];
    const y = expandYear(m[3]);
    if (mo !== undefined && validYear(y) && validDay(d)) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  // "March 15, 2020", "March 15 2020"
  m = /^([a-z]+) (\d{1,2}) (\d{4})$/.exec(text);
  if (m?.[1] && m[2] && m[3]) {
    const mo = MONTHS[m[1]];
    const d = Number(m[2]);
    const y = Number(m[3]);
    if (mo !== undefined && validYear(y) && validDay(d)) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  // Full ISO datetime, e.g. "2020-03-15T00:00:00Z"
  m = /^(\d{4}-\d{2}-\d{2})t/.exec(text);
  if (m?.[1] && ISO_DATE_REGEX.test(m[1])) return m[1];

  // Bare year anywhere in a short phrase, e.g. "año 2019", "2019 (verano)"
  m = /^(?:ano |year |desde |from |en |in )?(\d{4})(?: .*)?$/.exec(text);
  if (m?.[1] && text.length <= 24) {
    const y = Number(m[1]);
    return validYear(y) ? String(y) : null;
  }

  return null;
}

/**
 * Normalizes a human-written date into the ISO subset used by JSON Resume.
 *
 * Handles ISO input, `MM/YYYY`, `DD/MM/YYYY`, Spanish / English / Portuguese month names
 * ("marzo de 2020", "Mar 2020", "15 de marzo de 2020", "March 15, 2020") and "ongoing" words
 * ("actualidad", "presente", "a la fecha", "present", "current").
 */
export function normalizeDate(input: string | null | undefined): NormalizedDate {
  if (input === null || input === undefined)
    return { value: null, current: false, unparsed: false };

  const trimmed = input.trim();
  if (trimmed === "") return { value: null, current: false, unparsed: false };

  if (ISO_DATE_REGEX.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    return validYear(year)
      ? { value: trimmed, current: false, unparsed: false }
      : { value: null, current: false, unparsed: true };
  }

  const text = clean(trimmed);
  if (text === "" || text === "null" || text === "n/a" || text === "-") {
    return { value: null, current: false, unparsed: false };
  }
  if (CURRENT_WORDS.has(text) || CURRENT_WORDS.has(text.replace(/^(hasta|until|to) /, ""))) {
    return { value: null, current: true, unparsed: false };
  }

  const value = parseCore(text);
  if (value !== null) return { value, current: false, unparsed: false };
  return { value: null, current: false, unparsed: true };
}
