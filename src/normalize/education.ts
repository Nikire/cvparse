/**
 * Degree / title normalization for Spain, Latin America, Brazil/Portugal and English-speaking
 * countries. Maps free-text `education[].studyType` values ("Lic. en Administración",
 * "Máster Universitario en IA", "Técnico Superior en DAW") to a coarse {@link EducationLevel}
 * plus a canonical Spanish label for the recognized title family.
 *
 * The matcher works on folded text (lowercase, diacritics stripped) and on word boundaries.
 * Rules are ordered from specific phrases to generic words; each match is blanked out before the
 * next rule runs, so "Ciclo Formativo de Grado Superior" is Formación Profesional and never
 * "Grado". When several title words remain, the highest-ranking one wins (Doctorado > Máster >
 * Especialización > Licenciatura > Tecnicatura > Secundario), except that words that clearly
 * denote a short course ("curso", "bootcamp", "certificado", "taller", ...) always win.
 *
 * Notes on English / Portuguese titles:
 * - "<X> Engineering", "Engineer", "Engenharia" are profession titles (bachelor, "Ingeniería") with
 *   the lowest rank, exactly like "Ingeniería" / "Ingeniero": "Engineering Technician" is technical
 *   and "Master of Engineering" is a master.
 * - "Technician", "Technologist", "Associate", "Technical degree/diploma" are technical. A
 *   technician title earned at secondary school is ambiguous: only explicit phrases ("Technical
 *   High School", "Secundario Técnico", "Ensino Médio Técnico") are consumed as secondary; in
 *   "Electronics Technician (High School)" both words survive and the higher rank (technical) wins.
 * - Unfinished / ongoing markers ("incomplete", "unfinished", "in progress", "incompleto",
 *   "en curso", "em andamento", "trancado") are blanked first and never change the level.
 */

/** Coarse education level, ordered roughly from lowest to highest formal attainment. */
export type EducationLevel =
  | "secondary"
  | "technical"
  | "bachelor"
  | "postgraduate"
  | "master"
  | "doctorate"
  | "course"
  | "unknown";

/** All {@link EducationLevel} values, in the order used by the Zod enum. */
export const EDUCATION_LEVELS = [
  "secondary",
  "technical",
  "bachelor",
  "postgraduate",
  "master",
  "doctorate",
  "course",
  "unknown",
] as const satisfies readonly EducationLevel[];

/** Result of {@link normalizeStudyType}; one entry per `education[]` item in `x_cvparse.educationLevels`. */
export interface EducationLevelInfo {
  /** Coarse level; `"unknown"` when no title family was recognized. */
  level: EducationLevel;
  /** The `studyType` exactly as the model returned it (trimmed), or `null` when it was empty. */
  original: string | null;
  /**
   * Neutral Spanish label for the recognized title family, e.g. "Licenciatura", "Máster",
   * "Técnico Superior", "Formación Profesional". `null` when the level is `"unknown"`.
   */
  canonical: string | null;
}

/** Ranks used to pick a winner when several title words appear in one string. */
const RANK: Record<Exclude<EducationLevel, "unknown">, number> = {
  doctorate: 70,
  master: 60,
  postgraduate: 50,
  bachelor: 40,
  technical: 30,
  secondary: 20,
  course: 10,
};

/**
 * Rank for profession titles ("Ingeniería", "Arquitectura", "Medicina"...). They are bachelor-level
 * degrees on their own, but next to any explicit title word ("Técnico Superior en Ingeniería
 * Informática", "Diplomado en Arquitectura de Software") they only name the area, so they rank
 * below every other rule and decide only when nothing else matched.
 */
const PROFESSION_RANK = 5;

interface Rule {
  pattern: RegExp;
  level: Exclude<EducationLevel, "unknown">;
  canonical: string;
  /** Overrides {@link RANK} for this rule. */
  rank?: number;
  /** Words that denote a short course; they beat any other title word in the same string. */
  override?: boolean;
}

/**
 * Phrases that contain a title word but do not describe the degree ("en curso" = ongoing).
 * Blanked out before any rule runs.
 */
const NEUTRAL_PHRASES: readonly RegExp[] = [
  /\ben curso\b/,
  /\bcursando\b/,
  // "Cursó 3 años de ..." loses its accent when folded and would read as a course.
  /\bcurso (?:\d|hasta\b)/,
  /\bgrado academico\b/,
  // Portuguese "em curso" (ongoing) would otherwise read as a course.
  /\bem curso\b/,
  // Unfinished / ongoing studies: they never change the level of the title they qualify.
  /\bin progress\b/,
  /\bon-?going\b/,
  /\bun-?finished\b/,
  /\bnot (?:completed|finished)\b/,
  /\bincomplet[eoa]s?\b/,
  /\bem andamento\b/,
  /\btrancad[oa]\b/,
];

/**
 * Rules in evaluation order. Multi-word and ambiguous phrases come first so they consume their
 * words before the generic single-word rules see them. Patterns run against folded text (see
 * {@link fold}): lowercase ASCII, no diacritics, dots kept for abbreviations.
 */
const RULES: readonly Rule[] = [
  // --- Phrases that must beat the course override or a more generic word ---------------------
  {
    pattern: /\bpost-?graduate (?:certificate|diploma)\b/,
    level: "postgraduate",
    canonical: "Posgrado",
  },
  { pattern: /\bgraduate (?:certificate|diploma)\b/, level: "postgraduate", canonical: "Posgrado" },
  {
    pattern: /\bdiplomad[oa] (?:de|en) pos-?t?-?grado\b/,
    level: "postgraduate",
    canonical: "Posgrado",
  },
  { pattern: /\bdiploma (?:de|en) pos-?t?-?grado\b/, level: "postgraduate", canonical: "Posgrado" },
  {
    pattern: /\bcertificad[oa] (?:de|en) pos-?t?-?grado\b/,
    level: "postgraduate",
    canonical: "Posgrado",
  },
  { pattern: /\bdiplomad[oa] universitari[oa]\b/, level: "bachelor", canonical: "Diplomatura" },
  { pattern: /\bingenier[oa] tecnic[oa]\b/, level: "bachelor", canonical: "Ingeniería" },
  { pattern: /\bingenieria tecnica\b/, level: "bachelor", canonical: "Ingeniería" },
  { pattern: /\barquitect[oa] tecnic[oa]\b/, level: "bachelor", canonical: "Arquitectura" },
  { pattern: /\bbachiller(?:ato)? tecnic[oa]\b/, level: "secondary", canonical: "Bachillerato" },
  { pattern: /\bsecundari[oa] tecnic[oa]\b/, level: "secondary", canonical: "Secundario" },
  {
    pattern: /\b(?:educacion|ensenanza) media tecnica\b/,
    level: "secondary",
    canonical: "Educación Media",
  },
  { pattern: /\bensino medio tecnico\b/, level: "secondary", canonical: "Educación Media" },
  { pattern: /\bmedia superior\b/, level: "secondary", canonical: "Preparatoria" },
  // English technical diplomas earned at secondary school. A bare "Technician" next to
  // "(High School)" is not consumed here: both words stay and the higher rank (technical) wins.
  {
    pattern: /\btechnical (?:high|secondary) ?school\b/,
    level: "secondary",
    canonical: "Secundario",
  },
  {
    pattern: /\bvocational (?:high|secondary) ?school\b/,
    level: "secondary",
    canonical: "Secundario",
  },
  // Brazilian "Curso Técnico" is a vocational diploma, not a short course.
  { pattern: /\bcurso tecnico\b/, level: "technical", canonical: "Técnico" },
  {
    pattern: /\bcurso superior de tecnologia\b/,
    level: "technical",
    canonical: "Tecnólogo",
  },
  // English "technical certificate/diploma" is a vocational title; consumed before the course rules.
  {
    pattern: /\btechnical (?:degree|diploma|certificate|school|college|program(?:me)?|studies)\b/,
    level: "technical",
    canonical: "Técnico",
  },
  {
    pattern: /\bvocational (?:degree|diploma|certificate|training|school|college|program(?:me)?)\b/,
    level: "technical",
    canonical: "Formación Profesional",
  },
  // "Bachelor of Engineering" names the engineering family, like "B.Eng".
  {
    pattern: /\bbachelor(?:'?s)?(?: degree)? (?:of|in) engineering\b/,
    level: "bachelor",
    canonical: "Ingeniería",
  },
  { pattern: /\bmaestr[oa] mayor de obras?\b/, level: "technical", canonical: "Técnico" },

  // --- Doctorate ---------------------------------------------------------------------------
  { pattern: /\bdoctorad[oa]\b/, level: "doctorate", canonical: "Doctorado" },
  { pattern: /\bdoctoral\b/, level: "doctorate", canonical: "Doctorado" },
  { pattern: /\bdoctorates?\b/, level: "doctorate", canonical: "Doctorado" },
  { pattern: /\bdoctora?\b/, level: "doctorate", canonical: "Doctorado" },
  { pattern: /\bdoutorad[oa]\b/, level: "doctorate", canonical: "Doctorado" },
  { pattern: /\bdoutora?\b/, level: "doctorate", canonical: "Doctorado" },
  { pattern: /\bph\.?\s?d\.?/, level: "doctorate", canonical: "Doctorado" },
  { pattern: /\bd\.?phil\b/, level: "doctorate", canonical: "Doctorado" },

  // --- Master --------------------------------------------------------------------------------
  { pattern: /\b(?:executive )?mba\b/, level: "master", canonical: "MBA" },
  { pattern: /\bemba\b/, level: "master", canonical: "MBA" },
  { pattern: /\bmaster (?:of|in) business administration\b/, level: "master", canonical: "MBA" },
  { pattern: /\bmaestria\b/, level: "master", canonical: "Maestría" },
  { pattern: /\bmaestro\b/, level: "master", canonical: "Maestría" },
  { pattern: /\bmagister\b/, level: "master", canonical: "Maestría" },
  { pattern: /\bmg(?:tr|r)?\.?(?=\s|$)/, level: "master", canonical: "Maestría" },
  { pattern: /\bmestrad[oa]\b/, level: "master", canonical: "Maestría" },
  { pattern: /\bmestre\b/, level: "master", canonical: "Maestría" },
  { pattern: /\bmasters?(?:'s)?\b/, level: "master", canonical: "Máster" },
  {
    pattern: /\bm\.?(?:sc|eng|phil|fa|res|tech|ed)\.?(?=[\s(,;:/-]|$)/,
    level: "master",
    canonical: "Máster",
  },
  {
    pattern: /\bm\.?[as]\.?(?=\s+(?:in|of|en)\b|\s*\(|\s*$)/,
    level: "master",
    canonical: "Máster",
  },
  { pattern: /\bll\.?m\.?(?=[\s(,;:/-]|$)/, level: "master", canonical: "Máster" },

  // --- Postgraduate (below master) -----------------------------------------------------------
  { pattern: /\bespecializacion\b/, level: "postgraduate", canonical: "Especialización" },
  { pattern: /\bespecializacao\b/, level: "postgraduate", canonical: "Especialización" },
  { pattern: /\bespecialista\b/, level: "postgraduate", canonical: "Especialización" },
  { pattern: /\bspeciali[sz]ation\b/, level: "postgraduate", canonical: "Especialización" },
  { pattern: /\besp\.(?=\s|$)/, level: "postgraduate", canonical: "Especialización" },
  { pattern: /\blato sensu\b/, level: "postgraduate", canonical: "Especialización" },
  { pattern: /\bpos-?t?-?\s?grado\b/, level: "postgraduate", canonical: "Posgrado" },
  { pattern: /\bpos-?\s?graduacao\b/, level: "postgraduate", canonical: "Posgrado" },
  { pattern: /\bpost-?graduate\b/, level: "postgraduate", canonical: "Posgrado" },

  // --- Technical / vocational (before bachelor so "grado superior" never reads as "Grado") ----
  { pattern: /\bciclo formativo\b/, level: "technical", canonical: "Formación Profesional" },
  {
    pattern: /\bgrado (?:superior|medio)\b/,
    level: "technical",
    canonical: "Formación Profesional",
  },
  { pattern: /\bformacion profesional\b/, level: "technical", canonical: "Formación Profesional" },
  { pattern: /\bfp\b/, level: "technical", canonical: "Formación Profesional" },
  { pattern: /\btecnic[oa] superior\b/, level: "technical", canonical: "Técnico Superior" },
  { pattern: /\btsu\b/, level: "technical", canonical: "Técnico Superior" },
  { pattern: /\btecnic[oa] universitari[oa]\b/, level: "technical", canonical: "Tecnicatura" },
  { pattern: /\btecnic[oa] profesional\b/, level: "technical", canonical: "Técnico" },
  { pattern: /\btecnicatura\b/, level: "technical", canonical: "Tecnicatura" },
  { pattern: /\btecnic[oa]s?\b/, level: "technical", canonical: "Técnico" },
  { pattern: /\btec\.(?=\s|$)/, level: "technical", canonical: "Técnico" },
  { pattern: /\btecnolog[oa]\b/, level: "technical", canonical: "Tecnólogo" },
  { pattern: /\bterciari[oa]\b/, level: "technical", canonical: "Terciario" },
  { pattern: /\banalista\b/, level: "technical", canonical: "Analista" },
  { pattern: /\bassociate(?:'?s)? (?:degree|of)\b/, level: "technical", canonical: "Tecnicatura" },
  { pattern: /\bassociate(?:'?s)?\b/, level: "technical", canonical: "Tecnicatura" },
  { pattern: /\ba\.?a\.?s\.?(?=[\s(,;:/-]|$)/, level: "technical", canonical: "Tecnicatura" },
  { pattern: /\btechnicians?\b/, level: "technical", canonical: "Técnico" },
  { pattern: /\btechnologists?\b/, level: "technical", canonical: "Tecnólogo" },

  // --- Bachelor ------------------------------------------------------------------------------
  { pattern: /\blicenciatura\b/, level: "bachelor", canonical: "Licenciatura" },
  { pattern: /\blicenciad[oa]\b/, level: "bachelor", canonical: "Licenciatura" },
  { pattern: /\blic\.?(?=\s|$)/, level: "bachelor", canonical: "Licenciatura" },
  { pattern: /\bgrado\b/, level: "bachelor", canonical: "Grado" },
  { pattern: /\bgraduad[oa]\b/, level: "bachelor", canonical: "Grado" },
  { pattern: /\bpre-?grado\b/, level: "bachelor", canonical: "Pregrado" },
  { pattern: /\bprofesorado\b/, level: "bachelor", canonical: "Profesorado" },
  { pattern: /\bdiplomatura\b/, level: "bachelor", canonical: "Diplomatura" },
  { pattern: /\bprofesional\b/, level: "bachelor", canonical: "Profesional" },
  { pattern: /\bbachelors?(?:'s)?\b/, level: "bachelor", canonical: "Licenciatura" },
  { pattern: /\bundergraduate\b/, level: "bachelor", canonical: "Grado" },
  { pattern: /\bgraduacao\b/, level: "bachelor", canonical: "Grado" },
  { pattern: /\bensino superior\b/, level: "bachelor", canonical: "Grado" },
  { pattern: /\bbacharel(?:ado)?\b/, level: "bachelor", canonical: "Licenciatura" },
  { pattern: /\bb\.?eng\.?(?=[\s(,;:/-]|$)/, level: "bachelor", canonical: "Ingeniería" },
  {
    pattern: /\bb\.?(?:sc|ba|fa|com|tech|ed)\.?(?=[\s(,;:/-]|$)/,
    level: "bachelor",
    canonical: "Licenciatura",
  },
  {
    pattern: /\bb\.?[as]\.?(?=\s+(?:in|of|en)\b|\s*\(|\s*$)/,
    level: "bachelor",
    canonical: "Licenciatura",
  },
  { pattern: /\bll\.?b\.?(?=[\s(,;:/-]|$)/, level: "bachelor", canonical: "Abogacía" },
  // Profession titles: bachelor level, but weaker than an explicit technical/secondary title.
  {
    pattern: /\bingenier(?:ia|[oa])\b/,
    level: "bachelor",
    canonical: "Ingeniería",
    rank: PROFESSION_RANK,
  },
  {
    pattern: /\bing\.?(?=\s|$)/,
    level: "bachelor",
    canonical: "Ingeniería",
    rank: PROFESSION_RANK,
  },
  {
    pattern: /\bengenh(?:aria|eir[oa])\b/,
    level: "bachelor",
    canonical: "Ingeniería",
    rank: PROFESSION_RANK,
  },
  {
    // "Computer Engineering", "Engineering degree", "Software Engineer".
    pattern: /\bengineer(?:ing|s)?\b/,
    level: "bachelor",
    canonical: "Ingeniería",
    rank: PROFESSION_RANK,
  },
  {
    pattern: /\bcontador(?:a)? public[oa]\b/,
    level: "bachelor",
    canonical: "Contador Público",
    rank: PROFESSION_RANK,
  },
  {
    pattern: /\bcontaduria\b/,
    level: "bachelor",
    canonical: "Contador Público",
    rank: PROFESSION_RANK,
  },
  {
    pattern: /\bc\.?p\.?n?\.?(?=\s+en\b|\s*$)/,
    level: "bachelor",
    canonical: "Contador Público",
    rank: PROFESSION_RANK,
  },
  { pattern: /\babogacia\b/, level: "bachelor", canonical: "Abogacía", rank: PROFESSION_RANK },
  { pattern: /\babogad[oa]\b/, level: "bachelor", canonical: "Abogacía", rank: PROFESSION_RANK },
  { pattern: /\babog\.(?=\s|$)/, level: "bachelor", canonical: "Abogacía", rank: PROFESSION_RANK },
  {
    pattern: /\barquitect(?:ura|[oa])\b/,
    level: "bachelor",
    canonical: "Arquitectura",
    rank: PROFESSION_RANK,
  },
  {
    pattern: /\barq\.(?=\s|$)/,
    level: "bachelor",
    canonical: "Arquitectura",
    rank: PROFESSION_RANK,
  },
  { pattern: /\bmedicina\b/, level: "bachelor", canonical: "Medicina", rank: PROFESSION_RANK },
  {
    pattern: /\bmedic[oa] cirujan[oa]\b/,
    level: "bachelor",
    canonical: "Medicina",
    rank: PROFESSION_RANK,
  },

  // --- Secondary -----------------------------------------------------------------------------
  { pattern: /\bbachiller(?:ato)?\b/, level: "secondary", canonical: "Bachillerato" },
  { pattern: /\bsecundari[oa]\b/, level: "secondary", canonical: "Secundario" },
  {
    pattern: /\b(?:educacion|ensenanza|ensino) medi[oa]\b/,
    level: "secondary",
    canonical: "Educación Media",
  },
  { pattern: /\bpreparatoria\b/, level: "secondary", canonical: "Preparatoria" },
  { pattern: /\bprepa\b/, level: "secondary", canonical: "Preparatoria" },
  { pattern: /\beso\b/, level: "secondary", canonical: "ESO" },
  { pattern: /\bpolimodal\b/, level: "secondary", canonical: "Secundario" },
  { pattern: /\bhigh ?school\b/, level: "secondary", canonical: "Secundario" },
  { pattern: /\bsecondary (?:school|education)\b/, level: "secondary", canonical: "Secundario" },

  // --- Course: explicit short-course words override everything else ---------------------------
  { pattern: /\bbootcamp\b/, level: "course", canonical: "Bootcamp", override: true },
  { pattern: /\bcursos?\b/, level: "course", canonical: "Curso", override: true },
  { pattern: /\bcourse\b/, level: "course", canonical: "Curso", override: true },
  { pattern: /\bcertificad[oa]\b/, level: "course", canonical: "Certificación", override: true },
  { pattern: /\bcertificacion\b/, level: "course", canonical: "Certificación", override: true },
  {
    pattern: /\bcertifica(?:te|tion|ted)\b/,
    level: "course",
    canonical: "Certificación",
    override: true,
  },
  { pattern: /\btaller(?:es)?\b/, level: "course", canonical: "Taller", override: true },
  { pattern: /\bworkshop\b/, level: "course", canonical: "Taller", override: true },
  { pattern: /\bseminario\b/, level: "course", canonical: "Seminario", override: true },
  { pattern: /\bcapacitacion\b/, level: "course", canonical: "Curso", override: true },
  { pattern: /\bnanodegree\b/, level: "course", canonical: "Curso", override: true },
  // "Diplomado" (LATAM) is a short program; it does not override a real degree in the same string.
  { pattern: /\bdiplomad[oa]\b/, level: "course", canonical: "Diplomado" },
  { pattern: /\bdiploma\b/, level: "course", canonical: "Diplomado" },
];

/** Lowercases, strips diacritics (NFD) and collapses whitespace. Keeps dots for abbreviations. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

interface Candidate {
  rule: Rule;
  index: number;
}

/** Blanks every occurrence of `pattern` in `text`, preserving length so indexes stay valid. */
function blank(text: string, pattern: RegExp): string {
  return text.replace(new RegExp(pattern.source, "g"), (m) => " ".repeat(m.length));
}

/** Runs every rule over `folded`, consuming matches, and returns the winning candidate. */
function pickCandidate(folded: string): Candidate | null {
  let text = folded;
  for (const phrase of NEUTRAL_PHRASES) text = blank(text, phrase);

  const candidates: Candidate[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    candidates.push({ rule, index: match.index });
    text = blank(text, rule.pattern);
  }
  if (candidates.length === 0) return null;

  const override = candidates.filter((c) => c.rule.override).sort((a, b) => a.index - b.index)[0];
  if (override) return override;

  const rankOf = (c: Candidate) => c.rule.rank ?? RANK[c.rule.level];
  return candidates.reduce((best, c) => {
    const diff = rankOf(c) - rankOf(best);
    if (diff > 0) return c;
    if (diff === 0 && c.index < best.index) return c;
    return best;
  });
}

function emptyToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Classifies a degree / title string into an {@link EducationLevel} with a canonical Spanish
 * label. Matching is case- and accent-insensitive and works for Spanish (Spain and LATAM),
 * Portuguese and English titles and common abbreviations ("Lic.", "Ing.", "MSc", "PhD").
 *
 * When `studyType` is empty, the beginning of `area` is tried instead, because models sometimes
 * put "Licenciatura en Sistemas" in `area` and leave `studyType` blank. A title is accepted from
 * `area` only when it starts the string. `original` always mirrors `studyType` (never `area`).
 *
 * @example
 * normalizeStudyType("Máster Universitario en IA");
 * // => { level: "master", canonical: "Máster", original: "Máster Universitario en IA" }
 * normalizeStudyType("Diplomado en Marketing Digital");
 * // => { level: "course", canonical: "Diplomado", original: "Diplomado en Marketing Digital" }
 * normalizeStudyType(null, "Ingeniería en Sistemas");
 * // => { level: "bachelor", canonical: "Ingeniería", original: null }
 */
export function normalizeStudyType(
  studyType: string | null | undefined,
  area?: string | null,
): EducationLevelInfo {
  const original = emptyToNull(studyType);

  if (original !== null) {
    const candidate = pickCandidate(fold(original));
    if (candidate) {
      return { level: candidate.rule.level, canonical: candidate.rule.canonical, original };
    }
    return { level: "unknown", canonical: null, original };
  }

  const areaText = emptyToNull(area);
  if (areaText !== null) {
    const candidate = pickCandidate(fold(areaText));
    if (candidate && candidate.index === 0) {
      return { level: candidate.rule.level, canonical: candidate.rule.canonical, original: null };
    }
  }
  return { level: "unknown", canonical: null, original: null };
}

/**
 * One {@link EducationLevelInfo} per `education[]` entry, in order (the parallel
 * `x_cvparse.educationLevels` array). `null` when `education` is not an array.
 */
export function collectEducationLevels(education: unknown): EducationLevelInfo[] | null {
  if (!Array.isArray(education)) return null;
  return education.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return normalizeStudyType(null);
    }
    const record = entry as Record<string, unknown>;
    const studyType = typeof record.studyType === "string" ? record.studyType : null;
    const area = typeof record.area === "string" ? record.area : null;
    return normalizeStudyType(studyType, area);
  });
}
