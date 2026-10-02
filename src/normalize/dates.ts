import { ISO_DATE_REGEX } from "../schema/resume.js";

/** Result of {@link normalizeDate}. */
export interface NormalizedDate {
  /** ISO date (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`), or `null` when unknown / ongoing / unparseable. */
  value: string | null;
  /** `true` when the input meant "still ongoing" ("actualidad", "presente", "present", ...). */
  current: boolean;
  /** `true` when the input was non-empty but could not be understood. */
  unparsed: boolean;
  /**
   * Present when the value rests on a convention or on context: seasons are mapped to a
   * Northern-hemisphere start month, relative dates are resolved against the reference date.
   */
  note?: string;
}

/** Options for {@link normalizeDate} and {@link splitDateRange}. */
export interface DateOptions {
  /**
   * Anchor for relative dates ("hace 3 años", "2 years ago"). Defaults to `new Date()`.
   * Only the UTC year and month of the date are used.
   */
  referenceDate?: Date | undefined;
}

/** Result of {@link splitDateRange}. Both sides are already normalized ISO dates. */
export interface DateRange {
  /** ISO start of the range. */
  start: string;
  /** ISO end of the range, or `null` when ongoing ({@link DateRange.current}) or not written ("desde 2019"). */
  end: string | null;
  /** `true` when the end side was an ongoing marker ("actualidad", "present", ...). */
  current: boolean;
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
  // Still being earned (certificates, degrees): no date yet.
  "in progress",
  "en progreso",
  "em andamento",
  "em curso",
  "cursando",
]);

/** Ongoing markers, longest first, so "hasta la actualidad" wins over "actualidad" as a suffix. */
const CURRENT_WORDS_BY_LENGTH = [...CURRENT_WORDS].sort((a, b) => b.length - a.length);

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

/**
 * Season -> first month of the season in the Northern hemisphere (spring 03, summer 06,
 * autumn 09, winter 12). A CV does not say which hemisphere it was written in, and in the
 * Southern hemisphere "verano 2020" means January-March 2020; the Northern start month is a
 * convention, flagged in {@link NormalizedDate.note}.
 */
const SEASONS: Record<string, number> = {
  primavera: 3,
  spring: 3,
  verano: 6,
  verao: 6,
  summer: 6,
  otono: 9,
  autumn: 9,
  fall: 9,
  outono: 9,
  invierno: 12,
  winter: 12,
  inverno: 12,
};

/** Small number words used in relative dates ("hace un año", "a year ago", "há dois anos"). */
const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  um: 1,
  uma: 1,
  a: 1,
  an: 1,
  one: 1,
  dos: 2,
  dois: 2,
  duas: 2,
  two: 2,
  tres: 3,
  three: 3,
  cuatro: 4,
  quatro: 4,
  four: 4,
  cinco: 5,
  five: 5,
  seis: 6,
  six: 6,
  siete: 7,
  sete: 7,
  seven: 7,
  ocho: 8,
  oito: 8,
  eight: 8,
  nueve: 9,
  nove: 9,
  nine: 9,
  diez: 10,
  dez: 10,
  ten: 10,
  once: 11,
  onze: 11,
  eleven: 11,
  doce: 12,
  twelve: 12,
  quince: 15,
  fifteen: 15,
  veinte: 20,
  vinte: 20,
  twenty: 20,
};

/** Ordinal words for quarters / semesters ("primer semestre", "segundo cuatrimestre", "first quarter"). */
const ORDINAL_WORDS: Record<string, number> = {
  primer: 1,
  primero: 1,
  primera: 1,
  primeiro: 1,
  primeira: 1,
  first: 1,
  segundo: 2,
  segunda: 2,
  second: 2,
  tercer: 3,
  tercero: 3,
  tercera: 3,
  terceiro: 3,
  terceira: 3,
  third: 3,
  cuarto: 4,
  cuarta: 4,
  quarto: 4,
  quarta: 4,
  fourth: 4,
  quinto: 5,
  quinta: 5,
  fifth: 5,
  sexto: 6,
  sexta: 6,
  sixth: 6,
};

/** Period word -> months per period (quarter 3, semester 6, cuatrimestre 4, bimestre 2). */
const PERIOD_WORDS: Record<string, number> = {
  trimestre: 3,
  trimestres: 3,
  trimester: 3,
  quarter: 3,
  qtr: 3,
  semestre: 6,
  semester: 6,
  half: 6,
  mitad: 6,
  metade: 6,
  cuatrimestre: 4,
  cuadrimestre: 4,
  quadrimestre: 4,
  quadrimester: 4,
  bimestre: 2,
  bimester: 2,
};

/** Single-letter period markers: Q1/T1 (quarter, "trimestre"), S1/H1 (semester, "half"). */
const PERIOD_LETTERS: Record<string, number> = { q: 3, t: 3, s: 6, h: 6 };

const YEAR_UNITS = /^(?:ano|anos|anio|anios|year|years|yr|yrs)$/;
const MONTH_UNITS = /^(?:mes|meses|month|months|mo|mos)$/;

/** Range prefixes. "desde" / "from" / "since" may stand alone ("desde 2019"); the others need a pair. */
const RANGE_PREFIX = /^(desde|from|since|de|del|entre|between) /;
/** Word separators between the two sides of a range. "y" / "and" / "e" only after "entre" / "between". */
const RANGE_WORD_SEPARATORS = /\s(a|al|hasta|to|until|till|through|thru|ate|y|and|e)\s/g;
const PAIR_ONLY_SEPARATORS = new Set(["y", "and", "e"]);
/** Trailing separator left behind once an ongoing marker is cut off ("2019 - actualidad" -> "2019 -"). */
const TRAILING_SEPARATOR =
  /\s*(?:-|\ba\b|\bal\b|\bhasta\b|\bto\b|\buntil\b|\btill\b|\bthrough\b|\bthru\b|\bate\b)\s*$/;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Lowercases, strips accents, unifies dashes and collapses whitespace/punctuation noise. */
function clean(input: string): string {
  return (
    input
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      // En/em dashes, figure dashes and the minus sign all mean "-" in a date.
      .replace(/[‐-―−]/g, "-")
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

function yearMonth(y: number, mo: number): string | null {
  return validYear(y) && validMonth(mo) ? `${y}-${pad2(mo)}` : null;
}

/** Strict forms: ISO-like numerics, day-first numerics and month names. */
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

  return null;
}

/**
 * Loose fallback: a bare year inside a short phrase, e.g. "año 2019", "2019 (aprox.)", "desde 2015".
 * The remainder must not look like a second date, so range tokens ("2019 - 2021") never land here.
 */
function parseLooseYear(text: string): string | null {
  const m = /^(?:ano |year |desde |from |since |en |in )?(\d{4})(?: (.*))?$/.exec(text);
  if (!m?.[1] || text.length > 24) return null;
  const rest = m[2] ?? "";
  if (/\d/.test(rest) || /^[-/]/.test(rest)) return null;
  const y = Number(m[1]);
  return validYear(y) ? String(y) : null;
}

function parseAmount(token: string): number | null {
  if (/^\d{1,3}$/.test(token)) return Number(token);
  return NUMBER_WORDS[token] ?? null;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Relative dates: "hace 3 años", "hace 6 meses", "hace un año", "desde hace 2 años",
 * "3 years ago", "a year ago", "há 2 anos", "2 anos atrás". Years give `YYYY`, months `YYYY-MM`.
 */
function parseRelative(text: string, ref: Date): NormalizedDate | null {
  const m =
    /^(?:desde |since |from )?(?:hace|ha) (\S+) (\S+)$/.exec(text) ??
    /^(?:desde |since |from )?(\S+) (\S+) (?:ago|atras)$/.exec(text);
  if (!m?.[1] || !m[2]) return null;
  const n = parseAmount(m[1]);
  if (n === null) return null;

  let value: string | null = null;
  if (YEAR_UNITS.test(m[2])) {
    const y = ref.getUTCFullYear() - n;
    value = validYear(y) ? String(y) : null;
  } else if (MONTH_UNITS.test(m[2])) {
    const total = ref.getUTCFullYear() * 12 + ref.getUTCMonth() - n;
    const y = Math.floor(total / 12);
    value = yearMonth(y, total - y * 12 + 1);
  }
  if (value === null) return null;
  return {
    value,
    current: false,
    unparsed: false,
    note: `Relative date resolved against ${isoDate(ref)}`,
  };
}

/** Seasons: "verano 2020", "verano de 2020", "summer 2020", "2020 verano", "verão 2020". */
function parseSeason(text: string): NormalizedDate | null {
  const m =
    /^([a-z]+)(?: de| del| of)? (\d{4}|\d{2})$/.exec(text) ?? /^(\d{4}) ([a-z]+)$/.exec(text);
  if (!m?.[1] || !m[2]) return null;
  const [season, year] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
  const mo = SEASONS[season];
  if (mo === undefined) return null;
  const value = yearMonth(expandYear(year), mo);
  if (value === null) return null;
  return {
    value,
    current: false,
    unparsed: false,
    note: "Season mapped to its Northern-hemisphere start month; the hemisphere is ambiguous",
  };
}

/** "1er", "2do", "3º", "4th", "1.er" -> "1"; leaves plain digits untouched. */
function stripOrdinalSuffix(text: string): string {
  return text.replace(
    /(\d)\.?(?:er|ero|era|do|da|ro|ra|to|ta|vo|va|mo|ma|no|na|st|nd|rd|th|o|a|°|º|ª)(?= |$)/g,
    "$1",
  );
}

function ordinalNumber(token: string): number | null {
  if (/^\d$/.test(token)) return Number(token);
  return ORDINAL_WORDS[token] ?? null;
}

function periodStart(year: string, n: number, span: number): string | null {
  const mo = (n - 1) * span + 1;
  return n >= 1 && mo <= 12 ? yearMonth(expandYear(year), mo) : null;
}

/**
 * Quarters, semesters, cuatrimestres: "Q1 2021", "2021 Q3", "1T 2021", "2020-S1", "H1 2021",
 * "1er trimestre 2021", "primer semestre 2020", "2° cuatrimestre 2020", "second half of 2020".
 * The value is the first month of the period.
 */
function parsePeriod(text: string): string | null {
  const t = stripOrdinalSuffix(text.replace(/\s*([°ºª])/g, "$1"));

  // "q1 2021", "s2-2020", "h1/2021", "t1 de 2021"
  let m = /^([qsht])(\d)(?: |-|\/)(?:de |del |of )?(\d{4}|\d{2})$/.exec(t);
  if (m?.[1] && m[2] && m[3]) return periodStart(m[3], Number(m[2]), PERIOD_LETTERS[m[1]] ?? 0);

  // "1t 2021", "1s 2020", "2q-2021"
  m = /^(\d)([qsht])(?: |-|\/)(?:de |del |of )?(\d{4}|\d{2})$/.exec(t);
  if (m?.[1] && m[2] && m[3]) return periodStart(m[3], Number(m[1]), PERIOD_LETTERS[m[2]] ?? 0);

  // "2021 q3", "2020-s1", "2020/s2", "2021q3"
  m = /^(\d{4})(?: |-|\/)?([qsht])(\d)$/.exec(t);
  if (m?.[1] && m[2] && m[3]) return periodStart(m[1], Number(m[3]), PERIOD_LETTERS[m[2]] ?? 0);

  // "2020 1s", "2020-1t"
  m = /^(\d{4})(?: |-|\/)?(\d)([qsht])$/.exec(t);
  if (m?.[1] && m[2] && m[3]) return periodStart(m[1], Number(m[2]), PERIOD_LETTERS[m[3]] ?? 0);

  // "1 trimestre 2021", "primer semestre 2020", "segundo semestre de 2020", "first quarter of 2021"
  m = /^([a-z]+|\d) ([a-z]+) (?:de |del |of )?(\d{4}|\d{2})$/.exec(t);
  if (m?.[1] && m[2] && m[3]) {
    const n = ordinalNumber(m[1]);
    const span = PERIOD_WORDS[m[2]];
    if (n !== null && span !== undefined) return periodStart(m[3], n, span);
  }

  // "trimestre 1 2021", "semestre 2 de 2020"
  m = /^([a-z]+) (\d) (?:de |del |of )?(\d{4}|\d{2})$/.exec(t);
  if (m?.[1] && m[2] && m[3]) {
    const span = PERIOD_WORDS[m[1]];
    if (span !== undefined) return periodStart(m[3], Number(m[2]), span);
  }

  return null;
}

const UNKNOWN: NormalizedDate = { value: null, current: false, unparsed: false };
const UNPARSED: NormalizedDate = { value: null, current: false, unparsed: true };
const CURRENT: NormalizedDate = { value: null, current: true, unparsed: false };

/**
 * Resolves one already-cleaned token. `loose` enables the bare-year fallback
 * ("2019 (aprox)"), which is withheld while deciding whether a token is a range.
 */
function resolve(text: string, ref: Date, loose: boolean): NormalizedDate {
  if (CURRENT_WORDS.has(text) || CURRENT_WORDS.has(text.replace(/^(hasta|until|to) /, ""))) {
    return CURRENT;
  }
  const relative = parseRelative(text, ref);
  if (relative) return relative;
  const season = parseSeason(text);
  if (season) return season;
  const period = parsePeriod(text);
  if (period !== null) return { value: period, current: false, unparsed: false };
  const value = parseCore(text) ?? (loose ? parseLooseYear(text) : null);
  return value !== null ? { value, current: false, unparsed: false } : UNPARSED;
}

/**
 * Resolves the end side of a range. A two-digit end ("2019-21") is a year only when it is
 * greater than the start's last two digits, so "1998-99" gives 1999 but "2019-03" never gets here
 * (the whole token is a valid YYYY-MM and is rejected as a range before reaching this point).
 */
function resolveEnd(endText: string, start: string, ref: Date): NormalizedDate | null {
  if (/^\d{2}$/.test(endText)) {
    const startYear = Number(start.slice(0, 4));
    const nn = Number(endText);
    if (nn <= startYear % 100) return null;
    const y = Math.floor(startYear / 100) * 100 + nn;
    return validYear(y) ? { value: String(y), current: false, unparsed: false } : null;
  }
  const end = resolve(endText, ref, true);
  return end.value !== null || end.current ? end : null;
}

function buildRange(startText: string, endText: string, ref: Date): DateRange | null {
  if (startText === "" || endText === "") return null;
  const start = resolve(startText, ref, true);
  if (start.value === null) return null;
  const end = resolveEnd(endText, start.value, ref);
  if (end === null) return null;
  return { start: start.value, end: end.value, current: end.current };
}

function splitRangeText(text: string, ref: Date, singleChecked: boolean): DateRange | null {
  if (!singleChecked) {
    const single = resolve(text, ref, false);
    if (single.value !== null || single.current) return null;
  }

  const prefix = RANGE_PREFIX.exec(text);
  const body = prefix ? text.slice(prefix[0].length) : text;
  const prefixWord = prefix?.[1] ?? "";
  const openEnded = prefixWord === "desde" || prefixWord === "from" || prefixWord === "since";
  const pairPrefix = prefixWord === "entre" || prefixWord === "between";
  if (body === "") return null;

  // "2019 - actualidad", "marzo 2019 a la fecha", "2019 to date"
  for (const word of CURRENT_WORDS_BY_LENGTH) {
    if (body === word) return null;
    if (!body.endsWith(` ${word}`) && !body.endsWith(`-${word}`)) continue;
    const startText = body.slice(0, -word.length).trim().replace(TRAILING_SEPARATOR, "").trim();
    if (startText === "") return null;
    const start = resolve(startText, ref, true);
    return start.value !== null ? { start: start.value, end: null, current: true } : null;
  }

  // "2019 a 2021", "2019 hasta 2021", "2019 to 2021", "2019 até 2021", "entre 2019 y 2021"
  for (const m of body.matchAll(RANGE_WORD_SEPARATORS)) {
    const sep = m[1] ?? "";
    if (PAIR_ONLY_SEPARATORS.has(sep) && !pairPrefix) continue;
    const range = buildRange(body.slice(0, m.index), body.slice(m.index + m[0].length), ref);
    if (range) return range;
  }

  // "2019-21", "2019-2021", "2019 - 2021", "mar 2019 - jun 2021", "03/2019-06/2021"
  for (let i = body.indexOf("-"); i !== -1; i = body.indexOf("-", i + 1)) {
    const range = buildRange(body.slice(0, i).trim(), body.slice(i + 1).trim(), ref);
    if (range) return range;
  }

  // "2019/2021", "2019/21" (a slash elsewhere is a date separator, never a range)
  const slash = /^(\d{4})\/(\d{4}|\d{2})$/.exec(body);
  if (slash?.[1] && slash[2]) return buildRange(slash[1], slash[2], ref);

  // "desde 2019", "from 2019": an open-ended start
  if (openEnded) {
    const start = resolve(body, ref, true);
    if (start.value !== null) return { start: start.value, end: null, current: false };
  }

  return null;
}

/**
 * Normalizes a human-written date into the ISO subset used by JSON Resume.
 *
 * Handles ISO input, `MM/YYYY`, `DD/MM/YYYY`, Spanish / English / Portuguese month names
 * ("marzo de 2020", "Mar 2020", "15 de marzo de 2020", "March 15, 2020"), "ongoing" words
 * ("actualidad", "presente", "a la fecha", "present", "current"), relative dates ("hace 3 años",
 * "2 years ago", "há 2 anos"; anchored on `options.referenceDate`), seasons ("verano 2020",
 * "summer 2020"; Northern-hemisphere start month by convention) and quarters / semesters /
 * cuatrimestres ("Q1 2021", "1T 2021", "2020-S1", "primer semestre 2020"; first month of the period).
 *
 * A token that spells a whole range ("2019-21", "2019 - actualidad") is reported as unparsed so the
 * caller can fall back to {@link splitDateRange}.
 */
export function normalizeDate(
  input: string | null | undefined,
  options: DateOptions = {},
): NormalizedDate {
  if (input === null || input === undefined) return { ...UNKNOWN };

  const trimmed = input.trim();
  if (trimmed === "") return { ...UNKNOWN };

  if (ISO_DATE_REGEX.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    return validYear(year) ? { value: trimmed, current: false, unparsed: false } : { ...UNPARSED };
  }

  const text = clean(trimmed);
  if (text === "" || text === "null" || text === "n/a" || text === "-") return { ...UNKNOWN };

  const ref = options.referenceDate ?? new Date();
  const strict = resolve(text, ref, false);
  if (strict.value !== null || strict.current) return { ...strict };

  const range = splitRangeText(text, ref, true);
  if (range !== null && (range.end !== null || range.current)) return { ...UNPARSED };

  const loose = parseLooseYear(text);
  return loose !== null ? { value: loose, current: false, unparsed: false } : { ...UNPARSED };
}

/**
 * Splits a range written as a single token into its two sides, each normalized with
 * {@link normalizeDate}: "2019-21", "2019–2021", "2019/2021", "2019 - 2021", "2019 a 2021",
 * "2019 hasta 2021", "de 2019 a 2021", "entre 2019 y 2021", "2019 to 2021", "2019 até 2021",
 * "mar 2019 - jun 2021", "03/2019-06/2021", "2019 - actualidad", "2019–presente", "2019 - current"
 * (`current: true`, `end: null`) and "desde 2019" / "from 2019" (`end: null`, `current: false`).
 *
 * Two-digit end years: the second part of "2019-21" is read as 2021 only when the whole token is
 * not a valid `YYYY-MM` and the two digits are greater than the start's last two digits.
 * "2019-03" and "1998-02" therefore stay months (not ranges), while "1998-99" is 1998 to 1999.
 *
 * Returns `null` when the input is not a range (including a single date), so callers can fall
 * back to {@link normalizeDate}.
 */
export function splitDateRange(
  input: string | null | undefined,
  options: DateOptions = {},
): DateRange | null {
  if (input === null || input === undefined) return null;
  const trimmed = input.trim();
  if (trimmed === "" || ISO_DATE_REGEX.test(trimmed)) return null;
  const text = clean(trimmed);
  if (text === "") return null;
  return splitRangeText(text, options.referenceDate ?? new Date(), false);
}

/**
 * Picks the latest date of a value that lists several ("2012, 2019", "Mar 2018 y Jun 2020",
 * "2015 / 2017") for single-date fields such as `awards[].date`. Parts are split on commas,
 * semicolons, "&", "+", " / " and "y" / "and" / "e"; each part goes through {@link normalizeDate}.
 *
 * Returns `null` unless at least two parts normalize to a date. Ranges ("2019-2021") are not lists
 * and also return `null`.
 */
export function pickLatestDate(
  input: string | null | undefined,
  options: DateOptions = {},
): string | null {
  if (typeof input !== "string") return null;
  const parts = input
    .split(/\s*(?:[,;&+]|\s\/\s|\s(?:y|and|e|und)\s)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length < 2) return null;
  const values: string[] = [];
  for (const part of parts) {
    const date = normalizeDate(part, options);
    if (date.value !== null && !date.unparsed) values.push(date.value);
  }
  if (values.length < 2) return null;
  // ISO strings sort chronologically; a more precise value of the same year sorts after it.
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

/** Lowercase, no diacritics, unified dashes and whitespace; used to look dates up in the CV. */
function foldSource(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ");
}

const MONTH_ALT = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");
const SEASON_ALT = Object.keys(SEASONS).join("|");
const PERIOD_ALT = `${SEASON_ALT}|q[1-4]|[1-4][tq]|semestre|cuatrimestre|trimestre|bimestre|quarter|semester`;
const ORDINAL = "(?:st|nd|rd|th|º|°|o)?";
const MAX_LOOKBEHIND = 32;

/** Text right before the year that names its month: "marzo de ", "Mar. ", "03/", "verano ", "Q1 ". */
const MONTH_BEFORE = new RegExp(
  [
    String.raw`\b(?:${MONTH_ALT})\.?\s*(?:de |del |of )?[,/.-]?\s*$`,
    String.raw`\b(?:${MONTH_ALT})\.? \d{1,2}${ORDINAL},? ?$`,
    String.raw`\b(?:${PERIOD_ALT})\.?\s*(?:de |del |of )?[,/.-]?\s*$`,
    String.raw`(?<!\d)(?:0?[1-9]|1[0-2]) ?[/.-] ?$`,
  ].join("|"),
);
/**
 * Text right after the year that names its month: "-03", "/03", "-S1", " Q2", ", marzo". A month
 * name further away ("2019 - marzo 2020") belongs to the next date, not to this year.
 */
const MONTH_AFTER = new RegExp(
  String.raw`^(?: ?[/.-] ?(?:0?[1-9]|1[0-2])(?!\d)| ?[/-]? ?(?:q[1-4]|s[12]|[1-4][tq])\b|,? (?:${MONTH_ALT})\b)`,
);
/** Text right before the year that names its day: "15/03/", "15 de marzo de ", "March 15, ". */
const DAY_BEFORE = new RegExp(
  [
    String.raw`(?<!\d)\d{1,2} ?[/.-] ?\d{1,2} ?[/.-] ?$`,
    String.raw`(?<!\d)\d{1,2}${ORDINAL} (?:de |of )?(?:${MONTH_ALT})\.?\s*(?:de |del |of )?,? ?$`,
    String.raw`\b(?:${MONTH_ALT})\.? \d{1,2}${ORDINAL},? ?$`,
  ].join("|"),
);
/** Text right after the year that names its day: "-03-15", "/03/15". */
const DAY_AFTER = /^ ?[/.-] ?\d{1,2} ?[/.-] ?\d{1,2}(?!\d)/;

/** Windows of text around every standalone occurrence of `year` in `folded`. */
function yearContexts(folded: string, year: string): Array<{ before: string; after: string }> {
  const contexts: Array<{ before: string; after: string }> = [];
  const pattern = new RegExp(String.raw`(?<!\d)${year}(?!\d)`, "g");
  for (const match of folded.matchAll(pattern)) {
    const index = match.index;
    contexts.push({
      before: folded.slice(Math.max(0, index - MAX_LOOKBEHIND), index),
      after: folded.slice(index + year.length, index + year.length + MAX_LOOKBEHIND),
    });
  }
  return contexts;
}

/** Result of {@link reduceDatePrecision}. */
export interface PrecisionReduction {
  /** The reduced ISO date. */
  value: string;
  /** Which invented component was removed. */
  reason: "month" | "day";
}

/**
 * Undoes precision a model invented: models often pad "2020" to "2020-01" (or "2020-03" to
 * "2020-03-01"). When `iso` ends in `-01` and `sourceText` contains its year but never next to a
 * month (or day) expression — month names / abbreviations in Spanish, English and Portuguese,
 * seasons and quarters, `MM/YYYY`, `MM-YYYY`, `YYYY-MM` — the padded component is dropped:
 * "2020-01" -> "2020", "2020-03-01" -> "2020-03", "2020-01-01" -> "2020".
 *
 * Returns `null` when nothing changes, including when the year does not appear in the text at
 * all (nothing to compare against).
 */
export function reduceDatePrecision(iso: string, sourceText: string): PrecisionReduction | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(iso);
  if (!m) return null;
  const [, year, month, day] = m as unknown as [string, string, string, string | undefined];
  // Only trailing "-01" padding is suspicious: "2020-01-15" or "2020-03" stay as they are.
  if (day !== undefined ? day !== "01" : month !== "01") return null;

  const contexts = yearContexts(foldSource(sourceText), year);
  if (contexts.length === 0) return null;

  let value = iso;
  let reason: PrecisionReduction["reason"] | null = null;
  if (day === "01") {
    const hasDay = contexts.some((c) => DAY_BEFORE.test(c.before) || DAY_AFTER.test(c.after));
    if (hasDay) return null;
    value = `${year}-${month}`;
    reason = "day";
  }
  if (month === "01") {
    const hasMonth = contexts.some((c) => MONTH_BEFORE.test(c.before) || MONTH_AFTER.test(c.after));
    if (!hasMonth) {
      value = year;
      reason = "month";
    }
  }
  return reason === null ? null : { value, reason };
}
