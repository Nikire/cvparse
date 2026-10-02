#!/usr/bin/env node
/**
 * Generates the OCR fixtures with @napi-rs/canvas and pdf-lib (devDependencies).
 *
 *   node scripts/fixtures/make-image-fixtures.mjs
 *
 * Output is deterministic on a given machine (text rendering depends on the installed fonts, so
 * the committed files are the reference; regenerate only when the content changes).
 *
 * Fixtures:
 *   test/fixtures/image/cv-es-two-column.png  1240x1754 (A4 at 150 DPI), black on white, 28px:
 *                                             full-width header, left column EXPERIENCIA (2 jobs),
 *                                             right column HABILIDADES / IDIOMAS
 *   test/fixtures/image/cv-es-two-column.jpg  same image, JPEG quality 80
 *   test/fixtures/pdf/scanned-es.pdf          one A4 page with the PNG drawn full-page, no text layer
 *   test/fixtures/pdf/scanned-stamp-es.pdf    the scanned page plus a real-text footer
 *                                             "Escaneado con CamScanner" (24 chars, like scanner apps add)
 *   test/fixtures/pdf/mixed-es.pdf            page 1 = page 1 of single-column-es.pdf (text layer),
 *                                             page 2 = the scanned page (image only)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const imageDir = join(root, "test", "fixtures", "image");
const pdfDir = join(root, "test", "fixtures", "pdf");

const WIDTH = 1240;
const HEIGHT = 1754;
const FONT_SIZE = 28;
const LINE = 42;
const MARGIN = 80;
const RIGHT_X = 760;
const EPOCH = new Date(0);

const HEADER = [
  { text: "LUCÍA BEATRIZ MORALES", bold: true, size: 44 },
  { text: "Analista de Datos Sr. — Montevideo, Uruguay" },
  { text: "lucia.morales@example.com · +598 99 123 456" },
];

const LEFT = [
  { text: "EXPERIENCIA", bold: true },
  { text: "" },
  { text: "Analista de Datos Sr.", bold: true },
  { text: "Banco Oriental S.A." },
  { text: "marzo 2021 – actualidad" },
  { text: "Tableros de riesgo crediticio en Power BI." },
  { text: "Modelos de scoring con Python y SQL." },
  { text: "" },
  { text: "Analista de Datos", bold: true },
  { text: "Retail Sur" },
  { text: "06/2017 – 02/2021" },
  { text: "Reportes de ventas semanales." },
  { text: "Automatización de cargas ETL." },
];

const RIGHT = [
  { text: "HABILIDADES", bold: true },
  { text: "" },
  { text: "Python" },
  { text: "SQL" },
  { text: "Power BI" },
  { text: "Excel avanzado" },
  { text: "" },
  { text: "IDIOMAS", bold: true },
  { text: "" },
  { text: "Español (nativo)" },
  { text: "Inglés (B2)" },
];

function font(line) {
  return `${line.bold ? "bold " : ""}${line.size ?? FONT_SIZE}px sans-serif`;
}

function drawLines(ctx, lines, x, top) {
  let y = top;
  for (const line of lines) {
    if (line.text) {
      ctx.font = font(line);
      ctx.fillText(line.text, x, y);
    }
    y += line.size ? line.size + 18 : LINE;
  }
  return y;
}

function renderCanvas() {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "#000000";
  ctx.textBaseline = "top";
  const bodyTop = drawLines(ctx, HEADER, MARGIN, MARGIN) + LINE;
  drawLines(ctx, LEFT, MARGIN, bodyTop);
  drawLines(ctx, RIGHT, RIGHT_X, bodyTop);
  return canvas;
}

async function newDoc() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle("cvparse fixture");
  doc.setProducer("cvparse fixtures");
  doc.setCreator("cvparse fixtures");
  doc.setCreationDate(EPOCH);
  doc.setModificationDate(EPOCH);
  return doc;
}

/** Adds an A4 page with `png` drawn full-page (a "scan"). */
async function addScannedPage(doc, png) {
  const image = await doc.embedPng(png);
  const page = doc.addPage([595.28, 841.89]);
  page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
  return page;
}

async function makePdf(png) {
  const doc = await newDoc();
  await addScannedPage(doc, png);
  return doc.save({ useObjectStreams: false });
}

async function makeStampPdf(png) {
  const doc = await newDoc();
  const page = await addScannedPage(doc, png);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Escaneado con CamScanner", { x: 230, y: 20, size: 9, font });
  return doc.save({ useObjectStreams: false });
}

async function makeMixedPdf(png) {
  const doc = await newDoc();
  const source = await PDFDocument.load(readFileSync(join(pdfDir, "single-column-es.pdf")));
  const [first] = await doc.copyPages(source, [0]);
  doc.addPage(first);
  await addScannedPage(doc, png);
  return doc.save({ useObjectStreams: false });
}

mkdirSync(imageDir, { recursive: true });
mkdirSync(pdfDir, { recursive: true });

const canvas = renderCanvas();
const png = canvas.toBuffer("image/png");
const jpg = canvas.toBuffer("image/jpeg", 80);
writeFileSync(join(imageDir, "cv-es-two-column.png"), png);
writeFileSync(join(imageDir, "cv-es-two-column.jpg"), jpg);
writeFileSync(join(pdfDir, "scanned-es.pdf"), await makePdf(png));
writeFileSync(join(pdfDir, "scanned-stamp-es.pdf"), await makeStampPdf(png));
writeFileSync(join(pdfDir, "mixed-es.pdf"), await makeMixedPdf(png));

console.log(
  `png ${png.length} B, jpg ${jpg.length} B -> ${imageDir}; scanned-es.pdf, scanned-stamp-es.pdf, mixed-es.pdf -> ${pdfDir}`,
);
