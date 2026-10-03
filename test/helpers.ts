import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV4 } from "ai/test";
import type { OcrAdapter, OcrInput, OcrPage } from "../src/ocr/types.js";

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

// ---------------------------------------------------------------------------------------------
// Fake OCR adapters (no engine, no network).

/** Line boxes matching `test/fixtures/image/cv-es-two-column.png` (1240x1754), top-left origin. */
export const FAKE_OCR_PAGE = { width: 1240, height: 1754 };

const OCR_HEADER = [
  "LUCÍA BEATRIZ MORALES",
  "Analista de Datos Sr. — Montevideo, Uruguay",
  "lucia.morales@example.com · +598 99 123 456",
];
const OCR_LEFT = [
  "EXPERIENCIA",
  "Analista de Datos Sr.",
  "Banco Oriental S.A.",
  "marzo 2021 – actualidad",
  "Tableros de riesgo crediticio en Power BI.",
  "Modelos de scoring con Python y SQL.",
  "Analista de Datos",
  "Retail Sur",
  "06/2017 – 02/2021",
  "Reportes de ventas semanales.",
  "Automatización de cargas ETL.",
];
const OCR_RIGHT = [
  "HABILIDADES",
  "Python",
  "SQL",
  "Power BI",
  "Excel avanzado",
  "IDIOMAS",
  "Español (nativo)",
  "Inglés (B2)",
];

function ocrLines(lines: string[], x: number, top: number) {
  return lines.map((text, i) => ({
    text,
    x,
    y: top + i * 42,
    width: Math.round(text.length * 14),
    height: 28,
    confidence: 0.95,
  }));
}

/**
 * Positioned items for the two-column fixture, in the order an engine emits blocks: header,
 * then the whole left column, then the whole right column.
 */
export function fakeTwoColumnItems() {
  return [
    ...ocrLines(OCR_HEADER, 80, 80),
    ...ocrLines(OCR_LEFT, 80, 260),
    ...ocrLines(OCR_RIGHT, 760, 260),
  ];
}

/** Options for {@link fakeOcrAdapter}. */
export interface FakeOcrOptions {
  name?: string;
  confidence?: number;
  supportsPdf?: boolean;
  /** Make `recognize` reject with this. */
  throws?: unknown;
  /** Extra adapter warnings returned with each page. */
  warnings?: string[];
  /** Return plain text instead of positioned items. */
  textOnly?: boolean;
}

/** A fake adapter that records its inputs and returns the two-column fixture content. */
export function fakeOcrAdapter(options: FakeOcrOptions = {}) {
  const calls: OcrInput[] = [];
  const adapter: OcrAdapter & { calls: OcrInput[] } = {
    name: options.name ?? (options.textOnly ? "fake-text" : "fake"),
    supports: { pdf: options.supportsPdf ?? false },
    calls,
    async recognize(input: OcrInput): Promise<OcrPage> {
      calls.push(input);
      if (options.throws !== undefined) throw options.throws;
      const page: OcrPage = {
        confidence: options.confidence ?? 0.95,
        warnings: options.warnings,
      };
      if (options.textOnly) {
        page.text = [...OCR_HEADER, ...OCR_LEFT, ...OCR_RIGHT].join("\n");
      } else {
        page.width = FAKE_OCR_PAGE.width;
        page.height = FAKE_OCR_PAGE.height;
        page.items = fakeTwoColumnItems();
      }
      return page;
    },
  };
  return adapter;
}

/** A fake adapter that only returns plain text (no boxes). */
export function fakeTextOcrAdapter(options: Omit<FakeOcrOptions, "textOnly"> = {}) {
  return fakeOcrAdapter({ ...options, textOnly: true });
}

/**
 * Shortened copy of a real llama3.1 8B output (eval CV es-pe-002, temperature 0): after three
 * correct jobs the model starts repeating the university as a work entry and never stops until
 * maxOutputTokens. The real text has ~85 repeats; this keeps 6 and the cut mid-entry.
 */
export const LOOP_HEAD = String.raw`{"basics": {"name": "Gabriela Quispe Ccori", "label": "Dise\u00f1adora UX/UI", "image": null, "email": "gabriela.quispe@example.org", "phone": "+51 979 713 662", "url": null, "summary": null, "location": {"address": "Lima, Per\u00fa", "postalCode": null, "city": "Lima", "countryCode": "PE", "region": null}, "profiles": [{"network": "LinkedIn", "username": null, "url": null}]}, "work": [{"name": "Estudio Creativo del R\u00edmac E.I.R.L.", "location": null, "description": null, "position": "Product Designer", "url": null, "startDate": "2024-02", "endDate": null, "summary": "Dise\u00f1o del checkout y la b\u00fasi con filtros.\u00a0Identidad visual para 7 marcas de consumo masivo.", "highlights": ["Dise\u00f1o del checkout y la b\u00fasi con filtros.", "Identidad visual para 7 marcas de consumo masivo."]}, {"name": "Banco Digital del R\u00edmac S.A.", "location": "Lima", "description": null, "position": "Dise\u00f1adora UX/UI", "url": null, "startDate": "2021-12", "endDate": "2023-12", "summary": "Creaci\u00f3n de un design system usado por 3 equipos.\u00a0Redise\u00f1o del onboarding m\u00f3vil que subi\u00f3 la conversi\u00f3n al 99%.", "highlights": ["Creaci\u00f3n de un design system usado por 3 equipos.", "Redise\u00f1o del onboarding m\u00f3vil que subi\u00f3 la conversi\u00f3n al 99%."]}, {"name": "Agencia Digital del Pac\u00edfico S.A.C.", "location": null, "description": null, "position": "Dise\u00f1adora Gr\u00e1fica", "url": null, "startDate": "2019-01", "endDate": "2021-11", "summary": "Investigaci\u00f3n con usuarios y pruebas de usabilidad quincenales.\u00a0Dise\u00f1o del checkout y la b\u00fasi con filtros.", "highlights": ["Investigaci\u00f3n con usuarios y pruebas de usabilidad quincenales.", "Dise\u00f1o del checkout y la b\u00fasi con filtros."]}, `;
export const LOOP_FIRST = String.raw`{"name": "Universidad Peruana de Ciencias del Pac\u00edfico", "location": null, "description": null, "position": null, "url": null, "startDate": "2015-03", "endDate": "2019-12", "summary": null, "highlights": ["Licenciatura en Dise\u00f1o Gr\u00e1fico"]}, `;
export const LOOP_UNIT = String.raw`{"name": "Universidad Peruana de Ciencias del Pac\u00edfico", "location": null, "description": null, "position": null, "url": null, "startDate": "2015-03", "endDate": "2019-12", "summary": null, "highlights": ["Dise\u00f1o Gr\u00e1fico"]}, `;
export const REAL_LOOP = `${LOOP_HEAD}${LOOP_FIRST}${LOOP_UNIT.repeat(6)}${LOOP_UNIT.slice(0, 60)}`;
