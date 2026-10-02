/**
 * Text normalization shared by the scorer. See eval/score/README.md for the rules.
 */

const DIACRITICS = /\p{M}/gu;

/**
 * NFD, strip diacritics, lowercase, replace punctuation with spaces (keeping the characters in
 * `keep`), collapse whitespace and trim.
 */
export function normalizeText(value: string | null | undefined, keep = ""): string {
  if (!value) return "";
  const escaped = keep.replace(/[\\\]^-]/g, "\\$&");
  const punctuation = new RegExp(`[^\\p{L}\\p{N}\\s${escaped}]`, "gu");
  return value
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(punctuation, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words ignored when comparing organization / title tokens (articles, legal suffixes). */
const STOPWORDS = new Set([
  "de",
  "del",
  "la",
  "las",
  "el",
  "los",
  "y",
  "e",
  "en",
  "the",
  "of",
  "and",
  "at",
  "a",
  // legal-entity suffixes, after punctuation is stripped ("S.A." -> "s a")
  "s",
  "sa",
  "srl",
  "sl",
  "sas",
  "sac",
  "spa",
  "ltda",
  "inc",
  "llc",
  "ltd",
  "cv",
  "r",
  "l",
  "c",
  "v",
]);

/** Normalized token set; `stopwords` drops articles and legal suffixes. */
export function tokens(value: string | null | undefined, stopwords = false): Set<string> {
  const out = new Set<string>();
  for (const token of normalizeText(value).split(" ")) {
    if (!token) continue;
    if (stopwords && STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

/** Jaccard similarity of two token sets. Two empty sets → 0 (nothing to compare). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Email: trimmed, lowercased, diacritics removed; keeps `@ . + _ -`. */
export function normalizeEmail(value: string | null | undefined): string {
  return normalizeText(value, "@.+_-").replace(/\s+/g, "");
}

/** Phone: digits only, last 8 digits (the fallback used when only one side has a country code). */
export function normalizePhone(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length > 8 ? digits.slice(-8) : digits;
}

/**
 * Calling codes recognized after a leading `+` or `00` (dataset countries, the rest of Latin
 * America and a few common others). Longest prefix wins.
 */
const COUNTRY_CODES = [
  "1",
  "7",
  "33",
  "34",
  "39",
  "44",
  "49",
  "51",
  "52",
  "53",
  "54",
  "55",
  "56",
  "57",
  "58",
  "351",
  "502",
  "503",
  "504",
  "505",
  "506",
  "507",
  "591",
  "593",
  "595",
  "598",
].sort((a, b) => b.length - a.length);

export interface ParsedPhone {
  /** Calling code without `+`, or "" when the number is written without one. */
  country: string;
  /** Remaining digits, with a leading trunk `0` removed. */
  national: string;
}

/** Splits one phone number into calling code and national digits. */
export function parsePhone(value: string): ParsedPhone {
  const trimmed = value.trim();
  let digits = trimmed.replace(/\D/g, "");
  let international = trimmed.startsWith("+");
  if (!international && digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }
  const country = international ? (COUNTRY_CODES.find((c) => digits.startsWith(c)) ?? "") : "";
  const national = digits.slice(country.length).replace(/^0+/, "");
  return { country, national };
}

/** One printed phone field may hold several numbers ("+56 9 1234 5678 / 2 2345 6789"). */
export function splitPhones(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/[/,;|]/)
    .map((s) => s.trim())
    .filter((s) => s.replace(/\D/g, "").length >= 6);
}

/**
 * Phone equality: when both sides carry a country code, the codes and the full national digit
 * strings must agree; when only one side has a code, the last 8 digits are compared; when neither
 * has one, the full digit strings. With several numbers on a side, the best pair counts.
 */
export function phonesMatch(
  truth: string | null | undefined,
  predicted: string | null | undefined,
): boolean {
  for (const t of splitPhones(truth)) {
    for (const p of splitPhones(predicted)) {
      const a = parsePhone(t);
      const b = parsePhone(p);
      if (a.country && b.country) {
        if (a.country === b.country && a.national === b.national) return true;
      } else if (a.country || b.country) {
        if (normalizePhone(a.national) === normalizePhone(b.national)) return true;
      } else if (a.national === b.national) return true;
    }
  }
  return false;
}

/** Name particles ignored by the name Jaccard ("de", "del", "de la", "y"). */
const NAME_PARTICLES = new Set(["de", "del", "la", "las", "los", "y"]);

/** Name tokens without particles: "María de la Paz Gómez y Ruiz" → maria, paz, gomez, ruiz. */
export function nameTokens(value: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const token of normalizeText(value).split(" "))
    if (token && !NAME_PARTICLES.has(token)) out.add(token);
  return out;
}

/** City aliases, already normalized (lowercase, no accents, punctuation as spaces). Longest first. */
const CITY_ALIASES: [string, string][] = (
  [
    ["ciudad autonoma de buenos aires", "buenos aires"],
    ["ciudad de buenos aires", "buenos aires"],
    ["capital federal", "buenos aires"],
    ["caba", "buenos aires"],
    ["ciudad de mexico", "ciudad de mexico"],
    ["mexico d f", "ciudad de mexico"],
    ["mexico df", "ciudad de mexico"],
    ["cdmx", "ciudad de mexico"],
    ["bogota d c", "bogota"],
    ["bogota dc", "bogota"],
  ] as [string, string][]
).sort((a, b) => b[0].length - a[0].length);

/**
 * City text for comparison: normalized, with known aliases replaced by their canonical name
 * ("Ciudad Autónoma de Buenos Aires" → "buenos aires", "Bogotá D.C." → "bogota").
 */
export function normalizeCity(value: string | null | undefined): string {
  let text = normalizeText(value);
  if (!text) return "";
  for (const [alias, canonical] of CITY_ALIASES) {
    text = ` ${text} `.split(` ${alias} `).join(` ${canonical} `).trim();
  }
  return text.replace(/\s+/g, " ");
}

/** True when every token of the truth city appears in the predicted city (both after aliases). */
export function cityMatches(
  truth: string | null | undefined,
  predicted: string | null | undefined,
): boolean {
  const t = normalizeCity(truth).split(" ").filter(Boolean);
  if (t.length === 0) return false;
  const p = new Set(normalizeCity(predicted).split(" ").filter(Boolean));
  return t.every((token) => p.has(token));
}

/** Skill name: like {@link normalizeText} but keeps `+ # .` so "C++", "C#" and "C" differ. */
export function normalizeSkill(value: string | null | undefined): string {
  return normalizeText(value, "+#.").replace(/\.+$/, "").replace(/^\.+/, "").trim();
}

/** Spoken language names (es/en/pt, accents already stripped) → ISO 639-1. */
const LANGUAGE_CODES: Record<string, string> = {
  espanol: "es",
  castellano: "es",
  spanish: "es",
  espanhol: "es",
  ingles: "en",
  english: "en",
  portugues: "pt",
  portuguese: "pt",
  frances: "fr",
  french: "fr",
  francais: "fr",
  aleman: "de",
  german: "de",
  deutsch: "de",
  alemao: "de",
  italiano: "it",
  italian: "it",
  catalan: "ca",
  catala: "ca",
  gallego: "gl",
  galician: "gl",
  euskera: "eu",
  vasco: "eu",
  basque: "eu",
  chino: "zh",
  mandarin: "zh",
  chinese: "zh",
  japones: "ja",
  japanese: "ja",
  coreano: "ko",
  korean: "ko",
  ruso: "ru",
  russian: "ru",
  arabe: "ar",
  arabic: "ar",
  hebreo: "he",
  hebrew: "he",
  neerlandes: "nl",
  holandes: "nl",
  dutch: "nl",
  guarani: "gn",
  quechua: "qu",
  aimara: "ay",
  aymara: "ay",
};

const ISO_639_1 = new Set(Object.values(LANGUAGE_CODES));

/**
 * Language name → ISO 639-1 when recognized ("Inglés (C1)" → "en"); otherwise the normalized
 * text. Two-letter codes that are in the table's value set pass through.
 */
export function normalizeLanguage(value: string | null | undefined): string {
  const text = normalizeText(value);
  if (!text) return "";
  if (ISO_639_1.has(text)) return text;
  for (const token of text.split(" ")) {
    const code = LANGUAGE_CODES[token];
    if (code) return code;
  }
  return text;
}

const ISO_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const ONGOING =
  /^(present|presente|actual|actualidad|actualmente|hoy|now|current|currently|(a |hasta )?la fecha|en curso|hasta hoy|hasta la actualidad)$/;

/**
 * Date value used for comparison: an ISO prefix (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`), `null` for
 * ongoing/empty, or the normalized raw text when it is neither (counts as a mismatch).
 */
export function normalizeDateValue(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (ISO_DATE.test(trimmed)) return trimmed;
  const text = normalizeText(trimmed);
  if (ONGOING.test(text)) return null;
  return text;
}
