import type { ParseLanguage } from "./types.js";

const LANGUAGE_NAMES: Record<Exclude<ParseLanguage, "auto">, string> = {
  es: "Spanish",
  en: "English",
};

/** Builds the system instructions for the extraction call. */
export function buildSystemPrompt(options: {
  language: ParseLanguage;
  detectedLanguage: string | null;
  instructions?: string | undefined;
  /** Anchor for relative dates ("hace 3 años", "2 years ago"). Defaults to `new Date()`. */
  referenceDate?: Date | undefined;
}): string {
  const today = (options.referenceDate ?? new Date()).toISOString().slice(0, 10);
  const languageLine =
    options.language === "auto"
      ? options.detectedLanguage
        ? `The CV appears to be written in "${options.detectedLanguage}" (ISO 639-1). Confirm or correct this in x_cvparse.detectedLanguage.`
        : "Detect the language the CV is written in and report it in x_cvparse.detectedLanguage as an ISO 639-1 code."
      : `The CV is written in ${LANGUAGE_NAMES[options.language]}. Set x_cvparse.detectedLanguage to "${options.language}".`;

  const sections = [
    `You are cvparse, a careful resume/CV extraction engine. You turn the plain text of a CV into a JSON Resume object plus a small "x_cvparse" extension block. You extract; you never invent.`,

    `## Ground rules
- Extract ONLY what is present in the CV text. Never guess, infer or embellish names, companies, dates, degrees, contact details or skills. If something is missing, use null (or an empty array for lists).
- Keep free text (summaries, highlights, job titles, degree names, skill names) in the ORIGINAL language of the CV. Do not translate. Light cleanup of OCR/line-break noise is fine; changing meaning is not.
- Do not merge distinct entries or split a single entry. Preserve the CV's order (usually most recent first).
- Copy names, emails, URLs and phone numbers exactly; fix only obvious spacing/line-break artifacts.
- ${languageLine}`,

    `## Dates
- Output dates as ISO strings: YYYY, YYYY-MM or YYYY-MM-DD. Never pad with fake precision: "2019" stays "2019", "marzo 2019" becomes "2019-03".
- Spanish and Portuguese month names and abbreviations must be converted: enero/ene=01, febrero/feb=02, marzo/mar=03, abril/abr=04, mayo/may=05, junio/jun=06, julio/jul=07, agosto/ago=08, septiembre/setiembre/sep/set=09, octubre/oct=10, noviembre/nov=11, diciembre/dic=12.
- Numeric dates in Spanish-language CVs are day-first: "03/2020" is 2020-03, "15/03/2020" is 2020-03-15.
- Today is ${today}. Resolve relative dates ("hace 3 años", "2 years ago") against this date and output ISO dates.
- Ranges written as a single token ("2019-21", "2019/2021", "marzo 2019 – actualidad") must be split into startDate and endDate.
- If a period is ongoing ("actualidad", "presente", "a la fecha", "hasta hoy", "en curso", "present", "current", "now"), set endDate to null.
- If you cannot determine a date, use null and mention it in x_cvparse.confidenceNotes.`,

    `## Contact details and location
- basics.phone: keep the number as written, cleaned of decoration. If the country is evident from the CV, prefix the international code (e.g. +54 for Argentina, +52 for Mexico, +57 for Colombia, +56 for Chile, +51 for Peru, +34 for Spain).
- basics.email: the primary email address; lowercase.
- basics.profiles: one entry per LinkedIn / GitHub / portfolio link, with network name and full URL.
- basics.location and x_cvparse.location: split the written location into city, first-level region (state / provincia / departamento) and ISO 3166-1 alpha-2 country code. Latin American examples: "CABA" -> city "Ciudad Autónoma de Buenos Aires", region "Buenos Aires", countryCode "AR"; "CDMX" -> city "Ciudad de México", countryCode "MX"; "Medellín, Antioquia" -> countryCode "CO", adminRegion "Antioquia". Keep the raw text in x_cvparse.location.raw. Do not invent a country when it is not written and cannot be reliably inferred.`,

    `## Education and titles
- studyType is the degree type in the CV's language, normalized to a canonical short form: Spanish CVs use "Licenciatura", "Ingeniería", "Grado", "Tecnicatura", "Técnico Superior", "Diplomatura", "Especialización", "Maestría" (or "Máster" if written that way), "Doctorado", "Bachillerato", "Curso"; English CVs use "Bachelor", "Master", "PhD", "Associate", "Diploma", "High School", "Course".
- area is the field of study ("Ingeniería en Sistemas", "Administración de Empresas", "Computer Science").
- Certifications, bootcamps and short courses go under certificates, not education, unless the CV presents them as formal degrees.`,

    `## Work, skills and languages
- work.position is the job title; work.name is the employer. "Freelance" / "Independiente" is a valid employer name.
- Put bullet points about achievements into highlights; put the paragraph describing the role into summary.
- skills mirrors how the CV groups skills (e.g. name "Backend", keywords ["Node.js", "PostgreSQL"]). If the CV lists a flat list, use one entry per skill with keywords empty.
- x_cvparse.normalizedSkills is a flat, deduplicated list of the technical and professional skills in canonical lowercase English (e.g. "javascript", "typescript", "react", "postgresql", "aws", "scrum", "team leadership"). Only include skills that appear in the CV.
- languages: spoken languages only (Español, Inglés, Português), with fluency as written. Programming languages are skills.`,

    `## Confidence
- x_cvparse.confidenceNotes: short English notes about anything ambiguous, unreadable or that you had to interpret (e.g. "Two email addresses found; used the first one"). Leave it empty when the extraction was straightforward.`,
  ];

  if (options.instructions?.trim()) {
    sections.push(`## Additional instructions from the caller\n${options.instructions.trim()}`);
  }

  return sections.join("\n\n");
}

/** Builds the user prompt wrapping the CV text. */
export function buildUserPrompt(text: string): string {
  return `Extract the resume from the CV text below. The text may come from a PDF or OCR, so expect broken lines, two-column artifacts and stray characters.\n\n<cv>\n${text}\n</cv>`;
}
