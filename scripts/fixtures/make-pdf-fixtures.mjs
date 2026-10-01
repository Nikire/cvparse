#!/usr/bin/env node
/**
 * Generates the PDF fixtures under test/fixtures/pdf/ with pdf-lib (devDependency).
 *
 *   node scripts/fixtures/make-pdf-fixtures.mjs
 *
 * Output is deterministic: metadata dates are pinned and only standard (WinAnsi) fonts are used,
 * so nothing is embedded. Spanish accents and the em/en dashes are all inside WinAnsi.
 *
 * Fixtures:
 *   single-column-es.pdf  classic one-column CV (content of cv-es-backend.txt), one page
 *   two-column-es.pdf     full-width header (name/contact) then two columns:
 *                         left = Experiencia (3 jobs), right = Habilidades / Idiomas / Educación
 *   sidebar-es.pdf        narrow left sidebar (contact/skills) spanning the full page height,
 *                         wide right main column (perfil + experiencia)
 *   two-pages-es.pdf      single column that flows onto a second page
 *   no-text.pdf           one page with a drawn rectangle and no text layer
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const outDir = join(root, "test", "fixtures", "pdf");

const A4 = { width: 595.28, height: 841.89 };
const EPOCH = new Date(0);

// ---------------------------------------------------------------------------------------------
// Helpers

async function createDoc() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle("cvparse fixture");
  doc.setProducer("cvparse fixtures");
  doc.setCreator("cvparse fixtures");
  doc.setCreationDate(EPOCH);
  doc.setModificationDate(EPOCH);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, regular, bold };
}

/** Greedy word wrap at `maxWidth` points for the given font/size. */
function wrap(text, font, size, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

/**
 * Flows a list of "runs" ({ text, bold?, size?, after? }) into a column, adding pages through
 * `newPage()` when the bottom is reached. An empty `text` is a blank line.
 */
function flow({ x, top, bottom, width, fonts, runs, page, newPage, lineHeight = 1.3 }) {
  let y = top;
  let current = page;
  for (const run of runs) {
    const size = run.size ?? 10;
    const font = run.bold ? fonts.bold : fonts.regular;
    const step = size * lineHeight;
    const lines = run.text === "" ? [""] : wrap(run.text, font, size, width);
    for (const line of lines) {
      if (y - size < bottom) {
        if (!newPage) {
          throw new Error(`column overflow at: ${line}`);
        }
        current = newPage();
        y = top;
      }
      y -= size;
      if (line) {
        current.drawText(line, { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
      }
      y -= step - size;
    }
    y -= run.after ?? 0;
  }
  return { y, page: current };
}

/** Turns the plain-text fixture into runs: UPPERCASE lines become bold headings. */
function runsFromPlainText(text, { size = 10, headingSize = 11 } = {}) {
  const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  return lines.map((line, index) => {
    if (index === 0) {
      return { text: line, bold: true, size: 18, after: 2 };
    }
    if (line === "") {
      return { text: "", size };
    }
    const isHeading = line === line.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{3,}/.test(line);
    return isHeading ? { text: line, bold: true, size: headingSize } : { text: line, size };
  });
}

async function save(doc, name) {
  const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  writeFileSync(join(outDir, name), bytes);
  console.log(`${name}: ${bytes.length} bytes, ${doc.getPageCount()} page(s)`);
}

// ---------------------------------------------------------------------------------------------
// Content

const plainCv = readFileSync(join(root, "test", "fixtures", "cv-es-backend.txt"), "utf8");

const HEADER = [
  { text: "MARÍA FERNANDA LÓPEZ GARCÍA", bold: true, size: 20 },
  { text: "Desarrolladora Backend Sr.", size: 12 },
  {
    text: "CABA, Argentina · +54 9 11 5555-1234 · mfernanda.lopez@example.com · linkedin.com/in/mflopezgarcia",
    size: 9,
  },
];

const EXPERIENCE = [
  { text: "EXPERIENCIA", bold: true, size: 12, after: 2 },
  { text: "Fintonic Latam — Buenos Aires", bold: true },
  { text: "Tech Lead Backend · marzo 2021 – actualidad" },
  {
    text: "Diseñé la arquitectura de pagos (NestJS, PostgreSQL, Kafka) que procesa 1,2 M de transacciones mensuales.",
  },
  { text: "Reduje el tiempo de despliegue de 40 a 8 minutos con GitHub Actions y Kubernetes." },
  { text: "Mentoría de 4 desarrolladores junior.", after: 6 },
  { text: "Mercado Local S.A. — Córdoba", bold: true },
  { text: "Desarrolladora Backend Ssr. · junio 2018 – febrero 2021" },
  { text: "Desarrollo de APIs REST en Express y MongoDB para el carrito y el checkout." },
  { text: "Integración con Mercado Pago y AFIP para facturación electrónica.", after: 6 },
  { text: "Freelance", bold: true },
  { text: "Desarrolladora Full Stack · 2016 – 2018" },
  { text: "Sitios y tiendas online para pymes con React y Node.js." },
];

const SKILLS = [
  { text: "HABILIDADES", bold: true, size: 12, after: 2 },
  { text: "Node.js, TypeScript, NestJS" },
  { text: "Express, PostgreSQL, MongoDB" },
  { text: "Kafka, Docker, Kubernetes" },
  { text: "GitHub Actions, AWS", after: 10 },
  { text: "IDIOMAS", bold: true, size: 12, after: 2 },
  { text: "Español: nativo" },
  { text: "Inglés: avanzado (C1)" },
  { text: "Portugués: intermedio", after: 10 },
  { text: "EDUCACIÓN", bold: true, size: 12, after: 2 },
  { text: "Ingeniería en Sistemas de Información" },
  { text: "Universidad Tecnológica Nacional (UTN), Córdoba" },
  { text: "2012 – 2017" },
];

// ---------------------------------------------------------------------------------------------
// Fixtures

async function singleColumn() {
  const { doc, regular, bold } = await createDoc();
  const page = doc.addPage([A4.width, A4.height]);
  flow({
    x: 48,
    top: A4.height - 48,
    bottom: 48,
    width: A4.width - 96,
    fonts: { regular, bold },
    runs: runsFromPlainText(plainCv),
    page,
    lineHeight: 1.25,
  });
  await save(doc, "single-column-es.pdf");
}

async function twoColumn() {
  const { doc, regular, bold } = await createDoc();
  const page = doc.addPage([A4.width, A4.height]);
  const fonts = { regular, bold };
  const margin = 48;
  const gutter = 30;
  const columnWidth = (A4.width - margin * 2 - gutter) / 2;

  const header = flow({
    x: margin,
    top: A4.height - margin,
    bottom: 48,
    width: A4.width - margin * 2,
    fonts,
    runs: HEADER,
    page,
  });
  const columnsTop = header.y - 24;
  flow({
    x: margin,
    top: columnsTop,
    bottom: 48,
    width: columnWidth,
    fonts,
    runs: EXPERIENCE,
    page,
  });
  flow({
    x: margin + columnWidth + gutter,
    top: columnsTop,
    bottom: 48,
    width: columnWidth,
    fonts,
    runs: SKILLS,
    page,
  });
  await save(doc, "two-column-es.pdf");
}

async function sidebar() {
  const { doc, regular, bold } = await createDoc();
  const page = doc.addPage([A4.width, A4.height]);
  const fonts = { regular, bold };
  const sidebarX = 36;
  const sidebarWidth = 150;
  const mainX = sidebarX + sidebarWidth + 28;
  const mainWidth = A4.width - mainX - 36;

  // Sidebar background, then its text: contact + skills + languages, spanning the whole height.
  page.drawRectangle({
    x: 0,
    y: 0,
    width: sidebarX + sidebarWidth + 10,
    height: A4.height,
    color: rgb(0.93, 0.94, 0.96),
  });
  const sidebarRuns = [
    { text: "CONTACTO", bold: true, size: 11, after: 2 },
    { text: "CABA, Argentina", size: 9 },
    { text: "+54 9 11 5555-1234", size: 9 },
    { text: "mfernanda.lopez@example.com", size: 9 },
    { text: "linkedin.com/in/mflopezgarcia", size: 9 },
    { text: "github.com/mflopez", size: 9, after: 14 },
    { text: "HABILIDADES", bold: true, size: 11, after: 2 },
    ...[
      "Node.js",
      "TypeScript",
      "NestJS",
      "Express",
      "PostgreSQL",
      "MongoDB",
      "Kafka",
      "Docker",
      "Kubernetes",
      "GitHub Actions",
      "AWS",
    ].map((text) => ({ text, size: 9 })),
    { text: "", size: 9 },
    { text: "IDIOMAS", bold: true, size: 11, after: 2 },
    { text: "Español: nativo", size: 9 },
    { text: "Inglés: avanzado (C1)", size: 9 },
    { text: "Portugués: intermedio", size: 9, after: 14 },
    { text: "EDUCACIÓN", bold: true, size: 11, after: 2 },
    { text: "Ingeniería en Sistemas de Información", size: 9 },
    { text: "UTN Facultad Regional Córdoba", size: 9 },
    { text: "2012 – 2017", size: 9, after: 14 },
    { text: "CERTIFICACIONES", bold: true, size: 11, after: 2 },
    { text: "AWS Certified Developer – Associate (2022)", size: 9 },
    { text: "Scrum Master Certified, SCRUMstudy (2020)", size: 9 },
  ];
  flow({
    x: sidebarX,
    top: A4.height - 40,
    bottom: 36,
    width: sidebarWidth,
    fonts,
    runs: sidebarRuns,
    page,
    lineHeight: 1.6,
  });

  const mainRuns = [
    { text: "MARÍA FERNANDA LÓPEZ GARCÍA", bold: true, size: 20 },
    { text: "Desarrolladora Backend Sr.", size: 12, after: 14 },
    { text: "PERFIL", bold: true, size: 12, after: 2 },
    {
      text: "Desarrolladora backend con 7 años de experiencia construyendo APIs y sistemas distribuidos en Node.js y TypeScript. Lideré equipos de hasta 5 personas y migraciones a microservicios en fintech y e-commerce.",
      after: 12,
    },
    ...EXPERIENCE,
  ];
  flow({
    x: mainX,
    top: A4.height - 40,
    bottom: 36,
    width: mainWidth,
    fonts,
    runs: mainRuns,
    page,
  });
  await save(doc, "sidebar-es.pdf");
}

async function twoPages() {
  const { doc, regular, bold } = await createDoc();
  const first = doc.addPage([A4.width, A4.height]);
  flow({
    x: 56,
    top: A4.height - 56,
    bottom: 56,
    width: A4.width - 112,
    fonts: { regular, bold },
    runs: runsFromPlainText(plainCv, { size: 12, headingSize: 13 }),
    page: first,
    newPage: () => doc.addPage([A4.width, A4.height]),
    lineHeight: 1.4,
  });
  await save(doc, "two-pages-es.pdf");
}

async function noText() {
  const { doc } = await createDoc();
  const page = doc.addPage([A4.width, A4.height]);
  page.drawRectangle({
    x: 60,
    y: 120,
    width: A4.width - 120,
    height: A4.height - 240,
    borderColor: rgb(0.2, 0.2, 0.2),
    borderWidth: 2,
    color: rgb(0.85, 0.85, 0.85),
  });
  await save(doc, "no-text.pdf");
}

mkdirSync(outDir, { recursive: true });
await singleColumn();
await twoColumn();
await sidebar();
await twoPages();
await noText();
