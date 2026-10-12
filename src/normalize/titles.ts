import { normalizeForMatch } from "./grounding.js";

/**
 * Small lexicons that tell a job title from an employer name, used to repair work entries where
 * the model put the title in `name` and left `position` empty. They are deliberately
 * conservative: a value is only classified when it carries a clear marker, and callers keep the
 * model's output when neither side (or both) matches.
 */

/** Words (normalized, no accents) that make a phrase a job title, in Spanish and English. */
const ROLE_WORDS = new Set([
  "abogado",
  "abogada",
  "accountant",
  "administrador",
  "administradora",
  "administrativo",
  "administrativa",
  "administrator",
  "analista",
  "analyst",
  "architect",
  "arquitecto",
  "arquitecta",
  "asesor",
  "asesora",
  "asistente",
  "assistant",
  "auxiliar",
  "becario",
  "becaria",
  "cajero",
  "cajera",
  "ceo",
  "cfo",
  "chef",
  "cientifico",
  "cientifica",
  "cocinero",
  "cocinera",
  "contador",
  "contadora",
  "coo",
  "coordinador",
  "coordinadora",
  "coordinator",
  "consultant",
  "consultor",
  "cto",
  "desarrollador",
  "desarrolladora",
  "designer",
  "developer",
  "devops",
  "director",
  "directora",
  "disenador",
  "disenadora",
  "docente",
  "editor",
  "editora",
  "ejecutivo",
  "ejecutiva",
  "enfermero",
  "enfermera",
  "engineer",
  "especialista",
  "founder",
  "cofounder",
  "co-founder",
  "fundador",
  "fundadora",
  "gerente",
  "head",
  "ingeniero",
  "ingeniera",
  "intern",
  "investigador",
  "investigadora",
  "jefe",
  "jefa",
  "lawyer",
  "lead",
  "lider",
  "manager",
  "medico",
  "medica",
  "nurse",
  "operario",
  "operaria",
  "owner",
  "pasante",
  "practicante",
  "profesor",
  "profesora",
  "programador",
  "programadora",
  "programmer",
  "qa",
  "recepcionista",
  "redactor",
  "redactora",
  "representante",
  "researcher",
  "responsable",
  "scientist",
  "specialist",
  "supervisor",
  "supervisora",
  "teacher",
  "technician",
  "tecnico",
  "tecnica",
  "tester",
  "vendedor",
  "vendedora",
  "writer",
]);

/** Words (normalized) that make a phrase an organization. */
const ORG_WORDS = new Set([
  "agencia",
  "agency",
  "alcaldia",
  "asamblea",
  "ayuntamiento",
  "banco",
  "bank",
  "centro",
  "clinica",
  "clinic",
  "colegio",
  "college",
  "company",
  "compania",
  "congreso",
  "consultora",
  "consultorio",
  "cooperativa",
  "empresa",
  "escuela",
  "estudio",
  "foundation",
  "fundacion",
  "gobierno",
  "group",
  "grupo",
  "hospital",
  "institute",
  "instituto",
  "intendencia",
  "laboratorio",
  "labs",
  "legislatura",
  "ministerio",
  "municipalidad",
  "mutual",
  "policlinico",
  "sanatorio",
  "school",
  "senado",
  "services",
  "servicios",
  "solutions",
  "soluciones",
  "technologies",
  "tecnologias",
  "universidad",
  "universitat",
  "university",
]);

/**
 * Legal-entity suffixes at the end: "S.A.", "S.R.L.", "S.A.S.", "S.L.", "Inc.", "GmbH", and the
 * Mexican forms "S.A. de C.V.", "S.A.P.I. de C.V.", "S.A.B. de C.V.", "S.A.S. de C.V.",
 * "S. de R.L.", "S. de R.L. de C.V.". Matched on normalized text.
 */
const LEGAL_SUFFIX =
  /(?:^|[\s,])(?:s\.?\s?a\.?(?:\s?(?:p\.?\s?i\.?|b\.?|s\.?|c\.?))?(?:\s?de c\.?\s?v\.?)?|s\.?\s?de r\.?\s?l\.?(?:\s?de c\.?\s?v\.?)?|s\.?\s?r\.?\s?l\.?(?:\s?de c\.?\s?v\.?)?|s\.?\s?l\.?|s\.?\s?c\.?|ltda\.?|inc\.?|llc\.?|ltd\.?|gmbh|corp\.?|spa|plc|co\.)$/u;

function words(norm: string): string[] {
  return norm.split(/[\s,./()·|—–-]+/u).filter((w) => w !== "");
}

/** `true` when `value` ends with a legal-entity suffix ("Telecom S.A.", "Acme Inc."). */
export function hasLegalSuffix(value: string): boolean {
  const norm = normalizeForMatch(value);
  return norm !== "" && LEGAL_SUFFIX.test(norm);
}

/** `true` when `value` carries an organization marker (legal suffix or a word like "Universidad"). */
export function looksLikeOrganization(value: string): boolean {
  const norm = normalizeForMatch(value);
  if (norm === "") return false;
  if (LEGAL_SUFFIX.test(norm)) return true;
  return words(norm).some((w) => ORG_WORDS.has(w));
}

/** Lowercase connectors a Title Case name may contain ("Ministerio de Cultura", "Bank of Ireland"). */
const NAME_CONNECTORS = new Set([
  "de",
  "del",
  "la",
  "las",
  "los",
  "el",
  "y",
  "e",
  "&",
  "of",
  "the",
  "and",
  "for",
]);

/**
 * `true` when `value` is written like a proper name: at least `minWords` words starting with a
 * capital letter, and every other word a connector ("Telecom Argentina", "Ministerio de Cultura";
 * not "sistemas embebidos" nor "Atención al cliente"). Digits never qualify.
 */
export function isTitleCaseName(value: string, minWords = 2): boolean {
  const words = value.trim().split(/\s+/);
  let capitalized = 0;
  for (const word of words) {
    if (/^[^\p{L}\p{N}]*\p{Lu}/u.test(word)) capitalized++;
    else if (!NAME_CONNECTORS.has(word.toLowerCase())) return false;
  }
  return capitalized >= minWords;
}

/**
 * `true` when `value` reads as a job title: it contains a role word ("Analista", "Enfermero",
 * "Developer", "Lead") and no organization marker.
 */
export function looksLikeJobTitle(value: string): boolean {
  const norm = normalizeForMatch(value);
  if (norm === "" || /\d/.test(norm)) return false;
  if (looksLikeOrganization(value)) return false;
  return words(norm).some((w) => ROLE_WORDS.has(w));
}

/**
 * `true` when the FIRST word of `value` is a role word ("Supervisora de Enfermería", "Médico
 * Cirujano"). Tie-break when two sides of a line both contain a role word: a title starts with
 * its role; an organization carries it inside ("Residencia Médica San José").
 */
export function startsWithRoleWord(value: string): boolean {
  const first = words(normalizeForMatch(value))[0];
  return first !== undefined && ROLE_WORDS.has(first);
}

/**
 * Words (normalized) that name a degree rather than a job: "Máster en Derecho" is a degree whose
 * field is "Derecho", never a title at an employer called "Derecho".
 */
const DEGREE_WORDS = new Set([
  "master",
  "maestria",
  "magister",
  "licenciatura",
  "licenciado",
  "licenciada",
  "doctorado",
  "especializacion",
  "tecnico",
  "tecnica",
  "tecnicatura",
  "grado",
  "posgrado",
  "postgrado",
  "diplomado",
  "diplomatura",
  "bachillerato",
  "bachelor",
  "bachelors",
  "phd",
  "degree",
  "mba",
]);

/**
 * `true` when `value` is a bare degree word, optionally with one qualifier ("Máster", "Máster
 * Universitario", "Técnico Superior", "Bachelor's"): the left side of "<degree> en <field>".
 * Longer phrases ("Técnico de Sistemas") are left to the title rules, and so is a lone word
 * that is also a role ("Técnico": a job as often as a degree).
 */
export function isDegreePhrase(value: string): boolean {
  const parts = words(normalizeForMatch(value).replace(/'s\b/g, "s"));
  if (parts.length === 0 || parts.length > 2) return false;
  const first = parts[0] as string;
  if (!DEGREE_WORDS.has(first)) return false;
  return parts.length === 2 || !ROLE_WORDS.has(first);
}

/**
 * `true` when the right side of "Title <link> Employer" reads as an employer: never a job
 * title; an organization marker or legal suffix ({@link looksLikeOrganization}), or a Title Case
 * name of 2+ words ("Telecom Argentina"; 1 word after "at" / "@" / "with": "Developer at
 * Globex"). After a bare "de" / "del" (`strict`), which also joins a title to its department
 * ("Jefe de Proyecto", "Técnico de Laboratorio"), only a legal suffix or an organization marker
 * with 2+ words on each side counts.
 */
export function employerLike(after: string, link: string, before: string): boolean {
  if (!/\p{L}/u.test(after) || looksLikeJobTitle(after)) return false;
  const strict = link === "de" || link === "del";
  if (strict) {
    if (hasLegalSuffix(after)) return true;
    const count = (value: string) => value.split(/\s+/).length;
    return looksLikeOrganization(after) && count(after) >= 2 && count(before) >= 2;
  }
  if (looksLikeOrganization(after)) return true;
  return isTitleCaseName(after, link === "at" || link === "@" || link === "with" ? 1 : 2);
}
