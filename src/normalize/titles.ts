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
  "banco",
  "bank",
  "clinica",
  "clinic",
  "colegio",
  "college",
  "company",
  "compania",
  "consultora",
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
  "laboratorio",
  "labs",
  "ministerio",
  "municipalidad",
  "sanatorio",
  "school",
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

/** Legal-entity suffixes ("S.A.", "S.R.L.", "S.A.S.", "S.A. de C.V.", "Inc.", "GmbH"), at the end. */
const LEGAL_SUFFIX =
  /(?:^|[\s,])(?:s\.?\s?a\.?(?:\s?[sc]\.?)?|s\.?\s?a\.? de c\.?\s?v\.?|s\.?\s?r\.?\s?l\.?|s\.?\s?l\.?|s\.?\s?c\.?|ltda\.?|inc\.?|llc\.?|ltd\.?|gmbh|corp\.?|spa|plc|co\.)$/u;

function words(norm: string): string[] {
  return norm.split(/[\s,./()·|—–-]+/u).filter((w) => w !== "");
}

/** `true` when `value` carries an organization marker (legal suffix or a word like "Universidad"). */
export function looksLikeOrganization(value: string): boolean {
  const norm = normalizeForMatch(value);
  if (norm === "") return false;
  if (LEGAL_SUFFIX.test(norm)) return true;
  return words(norm).some((w) => ORG_WORDS.has(w));
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
