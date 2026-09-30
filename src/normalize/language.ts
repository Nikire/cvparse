/** Languages cvparse can detect heuristically. */
export type DetectedLanguage = "es" | "en" | "pt";

const STOPWORDS: Record<DetectedLanguage, readonly string[]> = {
  es: [
    "el",
    "la",
    "los",
    "las",
    "de",
    "del",
    "con",
    "para",
    "por",
    "una",
    "experiencia",
    "educacion",
    "habilidades",
    "idiomas",
    "actualidad",
    "desarrollador",
    "desarrolladora",
    "ingeniero",
    "ingeniera",
    "licenciatura",
    "universidad",
    "trabajo",
    "empresa",
    "años",
    "anos",
    "perfil",
    "formacion",
    "cursos",
    "certificaciones",
    "referencias",
    "nivel",
    "avanzado",
    "intermedio",
    "nativo",
  ],
  en: [
    "the",
    "and",
    "with",
    "for",
    "of",
    "experience",
    "education",
    "skills",
    "languages",
    "present",
    "developer",
    "engineer",
    "bachelor",
    "university",
    "work",
    "company",
    "years",
    "summary",
    "profile",
    "courses",
    "certifications",
    "references",
    "level",
    "advanced",
    "intermediate",
    "native",
    "fluent",
  ],
  pt: [
    "o",
    "os",
    "as",
    "do",
    "da",
    "dos",
    "das",
    "com",
    "para",
    "uma",
    "experiencia",
    "educacao",
    "formacao",
    "habilidades",
    "idiomas",
    "atualmente",
    "desenvolvedor",
    "desenvolvedora",
    "engenheiro",
    "engenheira",
    "universidade",
    "trabalho",
    "empresa",
    "anos",
    "cursos",
    "certificacoes",
    "referencias",
    "nivel",
    "avancado",
    "intermediario",
    "nativo",
    "fluente",
    "não",
    "nao",
  ],
};

function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9ñ]+/)
    .filter((t) => t.length > 0);
}

/**
 * Cheap stopword-based language detection for CV text. Returns `null` when there is not
 * enough signal. Only used as a hint for the model and as a fallback for
 * `x_cvparse.detectedLanguage`; it is not meant to be a general-purpose detector.
 */
export function detectLanguage(text: string): DetectedLanguage | null {
  const tokens = tokenize(text);
  if (tokens.length < 5) return null;

  const scores: Record<DetectedLanguage, number> = { es: 0, en: 0, pt: 0 };
  const sets = {
    es: new Set(STOPWORDS.es),
    en: new Set(STOPWORDS.en),
    pt: new Set(STOPWORDS.pt),
  };
  for (const token of tokens) {
    if (sets.es.has(token)) scores.es += 1;
    if (sets.en.has(token)) scores.en += 1;
    if (sets.pt.has(token)) scores.pt += 1;
  }

  const ranked = (Object.entries(scores) as Array<[DetectedLanguage, number]>).sort(
    (a, b) => b[1] - a[1],
  );
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best[1] === 0) return null;
  // Require a clear margin; Spanish and Portuguese share many tokens.
  if (second && best[1] - second[1] < Math.max(2, best[1] * 0.2)) return null;
  return best[0];
}
