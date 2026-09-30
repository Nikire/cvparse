import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV4 } from "ai/test";

const here = dirname(fileURLToPath(import.meta.url));

/** Reads a fixture from `test/fixtures/`. */
export function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", name), "utf8");
}

/** Sample extraction for `cv-es-backend.txt`, written the way a model would (dates not yet ISO). */
export const SPANISH_EXTRACTION = {
  basics: {
    name: "María Fernanda López García",
    label: "Desarrolladora Backend Sr.",
    email: "mfernanda.lopez@example.com",
    phone: "+54 9 11 5555-1234",
    summary:
      "Desarrolladora backend con 7 años de experiencia construyendo APIs y sistemas distribuidos en Node.js y TypeScript.",
    location: {
      city: "Ciudad Autónoma de Buenos Aires",
      region: "Buenos Aires",
      countryCode: "ar",
    },
    profiles: [
      {
        network: "LinkedIn",
        username: "mflopezgarcia",
        url: "https://linkedin.com/in/mflopezgarcia",
      },
      { network: "GitHub", username: "mflopez", url: "https://github.com/mflopez" },
    ],
  },
  work: [
    {
      name: "Fintonic Latam",
      position: "Tech Lead Backend",
      location: "Buenos Aires (híbrido)",
      startDate: "Marzo 2021",
      endDate: "Actualidad",
      highlights: [
        "Diseñé la arquitectura de pagos (NestJS, PostgreSQL, Kafka) que procesa 1,2 M de transacciones mensuales.",
      ],
    },
    {
      name: "Mercado Local S.A.",
      position: "Desarrolladora Backend Ssr.",
      location: "Córdoba",
      startDate: "06/2018",
      endDate: "02/2021",
      highlights: [],
    },
    {
      name: "Freelance",
      position: "Desarrolladora Full Stack",
      startDate: "2016",
      endDate: "2018",
      summary: "Sitios y tiendas online para pymes con React y Node.js.",
    },
  ],
  education: [
    {
      institution: "Universidad Tecnológica Nacional (UTN) — Facultad Regional Córdoba",
      area: "Ingeniería en Sistemas de Información",
      studyType: "Ingeniería",
      startDate: "2012",
      endDate: "2017",
    },
  ],
  certificates: [
    {
      name: "AWS Certified Developer – Associate",
      issuer: "Amazon Web Services",
      date: "noviembre de 2022",
    },
    { name: "Scrum Master Certified (SMC)", issuer: "SCRUMstudy", date: "2020" },
  ],
  skills: [
    {
      name: "Backend",
      keywords: ["Node.js", "TypeScript", "NestJS", "Express", "PostgreSQL", "MongoDB", "Kafka"],
    },
    { name: "DevOps", keywords: ["Docker", "Kubernetes", "GitHub Actions", "AWS"] },
  ],
  languages: [
    { language: "Español", fluency: "nativo" },
    { language: "Inglés", fluency: "avanzado (C1)" },
    { language: "Portugués", fluency: "intermedio" },
  ],
  x_cvparse: {
    detectedLanguage: "ES",
    normalizedSkills: ["Node.js", "TypeScript", "typescript", "PostgreSQL", " kafka "],
    location: {
      countryCode: "ar",
      adminRegion: "Buenos Aires",
      city: "Ciudad Autónoma de Buenos Aires",
      raw: "CABA, Argentina",
    },
    confidenceNotes: [],
  },
};

const USAGE = {
  inputTokens: { total: 1200, noCache: 1200, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 600, text: 600, reasoning: undefined },
};

/** A mock model that returns `text` as its only content part. */
export function mockModelWithText(text: string, warnings: never[] | unknown[] = []) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
      // biome-ignore lint/suspicious/noExplicitAny: test-only escape hatch for provider warning shapes
      warnings: warnings as any,
    }),
  });
}

/** A mock model that returns `object` serialized as JSON. */
export function mockModelWithObject(object: unknown) {
  return mockModelWithText(JSON.stringify(object));
}

/** A mock model whose generate call rejects with `error`. */
export function mockModelThatThrows(error: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw error;
    },
  });
}
