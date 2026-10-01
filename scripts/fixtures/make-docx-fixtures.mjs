#!/usr/bin/env node
/**
 * Generates the DOCX fixtures under test/fixtures/docx/ with the `docx` package (devDependency).
 *
 *   node scripts/fixtures/make-docx-fixtures.mjs
 *
 * Output is byte-for-byte deterministic: every zip entry is re-packed with a fixed timestamp,
 * core.xml dates are pinned and the random VML shape ids are replaced.
 *
 * Fixtures:
 *   simple-es.docx          headings + paragraphs + bullet lists (content of cv-es-ventas.txt)
 *   table-layout-es.docx    one borderless two-column table used as page layout
 *   textbox-es.docx         simple-es plus a VML text box (w:pict/v:textbox), which mammoth reads
 *   textbox-drawing-es.docx same box re-wrapped as DrawingML (w:drawing/wps:txbx) with no VML
 *                           fallback, which mammoth drops and the extractor must recover
 *   textbox-overlap-es.docx three DrawingML boxes whose lines are substrings of body text
 *                           ("Vehículo propio", "Licencia…", and "Inglés" twice): recovery must
 *                           keep every box line and must not dedupe across boxes
 *   document2-es.docx       simple-es with the main part saved as word/document2.xml (as Word
 *                           sometimes does); `_rels/.rels` and `[Content_Types].xml` point to it
 *   zip64-es.docx           simple-es packed with a zip64 end-of-central-directory record, the
 *                           way some archivers write it; the built-in zip reader must not choke
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  Textbox,
  TextRun,
  WidthType,
} from "docx";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "test", "fixtures", "docx");

// ---------------------------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------------------------

const heading = (text, level = HeadingLevel.HEADING_1) => new Paragraph({ text, heading: level });
const para = (text) => new Paragraph({ children: [new TextRun(text)] });
const bold = (text) => new Paragraph({ children: [new TextRun({ text, bold: true })] });
const bullet = (text) => new Paragraph({ text, bullet: { level: 0 } });
const lines = (...texts) =>
  new Paragraph({
    children: texts.map((text, i) => new TextRun({ text, break: i === 0 ? undefined : 1 })),
  });

/** The body of cv-es-ventas.txt, structured. */
function ventasBody() {
  return [
    new Paragraph({
      children: [new TextRun({ text: "Carlos Andrés Ramírez Mejía", bold: true, size: 32 })],
    }),
    para("Ejecutivo de Ventas B2B"),
    para("Medellín, Antioquia, Colombia"),
    para("Cel: 300 456 7890 | carlos.ramirez@example.com"),

    heading("OBJETIVO PROFESIONAL"),
    para(
      "Profesional en administración con 5 años de experiencia en ventas consultivas de software para el sector salud. Orientado a resultados y al cumplimiento de metas trimestrales.",
    ),

    heading("EXPERIENCIA"),
    bold("Ejecutivo de Cuentas Senior"),
    para("SaludTech Colombia S.A.S., Medellín"),
    para("enero 2022 – presente"),
    bullet("Cierre de 35 cuentas nuevas en 2023 (120% de la meta anual)."),
    bullet("Manejo de cartera de 60 clientes hospitalarios en Antioquia y Eje Cafetero."),
    bold("Asesor Comercial"),
    para("Distribuidora Médica del Norte, Barranquilla"),
    para("15/03/2019 – 12/2021"),
    bullet("Ventas de insumos médicos a clínicas y farmacias."),
    bullet("Capacitación a 3 asesores nuevos."),

    heading("EDUCACIÓN"),
    para("Administración de Empresas — Universidad de Antioquia"),
    para("Profesional, 2014 – 2018"),
    para("Diplomado en Ventas Consultivas — Cámara de Comercio de Medellín, 2020"),

    heading("HABILIDADES"),
    para("CRM (HubSpot, Salesforce) · Negociación · Excel avanzado · Presentaciones ejecutivas"),

    heading("IDIOMAS"),
    para("Español (nativo) · Inglés (B1)"),

    heading("REFERENCIAS"),
    para("Disponibles a solicitud."),
  ];
}

const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = {
  top: noBorder,
  bottom: noBorder,
  left: noBorder,
  right: noBorder,
  insideHorizontal: noBorder,
  insideVertical: noBorder,
};

/** A design-template CV: a single-row, two-column borderless table holds the whole page. */
function tableLayoutBody() {
  const left = [
    new Paragraph({
      children: [new TextRun({ text: "Lucía Fernández Ortiz", bold: true, size: 30 })],
    }),
    para("Diseñadora UX/UI"),
    heading("CONTACTO", HeadingLevel.HEADING_2),
    lines(
      "Santiago, Chile",
      "+56 9 8765 4321",
      "lucia.fernandez@example.com",
      "linkedin.com/in/luciafo",
    ),
    heading("HABILIDADES", HeadingLevel.HEADING_2),
    bullet("Figma"),
    bullet("Design systems"),
    bullet("Investigación con usuarios"),
    bullet("Prototipado"),
    heading("IDIOMAS", HeadingLevel.HEADING_2),
    para("Español (nativo)"),
    para("Inglés (C1)"),
  ];
  const right = [
    heading("PERFIL", HeadingLevel.HEADING_2),
    para(
      "Diseñadora de producto con 6 años de experiencia en fintech y e-commerce. Lidero equipos de diseño y construyo design systems escalables.",
    ),
    heading("EXPERIENCIA", HeadingLevel.HEADING_2),
    bold("Product Designer Senior — Banco Digital Andino"),
    para("marzo 2021 – actualidad · Santiago (híbrido)"),
    bullet("Rediseñé el onboarding de la app, subiendo la conversión de 42% a 61%."),
    bullet("Creé el design system usado por 4 squads."),
    bold("Diseñadora UX — Tienda Austral"),
    para("06/2018 – 02/2021 · Valparaíso"),
    bullet("Diseñé el checkout móvil y la búsqueda con filtros."),
    heading("EDUCACIÓN", HeadingLevel.HEADING_2),
    para("Diseño Gráfico — Universidad de Chile, 2013 – 2017"),
    para("Diplomado en UX Research — Pontificia Universidad Católica, 2020"),
  ];
  const cell = (children, width) =>
    new TableCell({
      children,
      width: { size: width, type: WidthType.PERCENTAGE },
      borders: noBorders,
    });
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: noBorders,
      rows: [new TableRow({ children: [cell(left, 35), cell(right, 65)] })],
    }),
  ];
}

/** simple-es plus a floating text box, the way Canva/Word design templates place side notes. */
function textboxBody() {
  const body = ventasBody();
  const box = new Textbox({
    alignment: AlignmentType.RIGHT,
    children: [
      new Paragraph({ children: [new TextRun({ text: "DATOS ADICIONALES", bold: true })] }),
      para("Disponibilidad inmediata"),
      para("Licencia de conducción categoría B1"),
      para("Vehículo propio"),
    ],
    style: { width: "2.5in", height: "1.2in" },
  });
  // Insert the box right after the contact line, before the first section heading.
  body.splice(4, 0, box);
  return body;
}

/**
 * simple-es plus a body line that contains two box lines as substrings, one box with those two
 * lines and two more boxes that both say "Inglés" (also a substring of the IDIOMAS line).
 */
function textboxOverlapBody() {
  const body = ventasBody();
  const box = (...texts) =>
    new Textbox({
      alignment: AlignmentType.RIGHT,
      children: texts.map((text) => para(text)),
      style: { width: "2.5in", height: "0.8in" },
    });
  body.splice(
    4,
    0,
    para("Requisito del puesto: Vehículo propio y licencia B1 vigente."),
    box("Vehículo propio", "Licencia de conducción categoría B1"),
    box("Inglés"),
    box("Inglés"),
  );
  return body;
}

function document(children) {
  return new Document({
    creator: "cvparse fixtures",
    title: "fixture",
    sections: [{ children }],
  });
}

// ---------------------------------------------------------------------------------------------
// Deterministic zip re-packing (no dependency; DOCX files are plain zip archives)
// ---------------------------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
const DOS_TIME = 0;

/** @returns {Array<{ name: string, data: Buffer }>} */
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL) throw new Error("bad central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    entries.push({ name, data });
  }
  return entries;
}

const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

/**
 * @param {Array<{ name: string, data: Buffer }>} entries
 * @param {{ zip64?: boolean }} [options] `zip64` writes a zip64 EOCD record + locator and fills
 * the classic EOCD with the 0xFFFF / 0xFFFFFFFF "look in the zip64 record" markers.
 */
function writeZip(entries, { zip64 = false } = {}) {
  const locals = [];
  const centrals = [];
  let position = 0;
  for (const { name, data } of entries) {
    if (name.endsWith("/")) continue; // directory placeholders are not needed
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(position, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    position += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const fileCount = centrals.length / 2;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(zip64 ? 0xffff : fileCount, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : fileCount, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : centralSize, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : position, 16);
  eocd.writeUInt16LE(0, 20);
  if (!zip64) return Buffer.concat([...locals, ...centrals, eocd]);

  // Zip64 end of central directory record (56 bytes, no extensible data).
  const zip64Eocd = Buffer.alloc(56);
  zip64Eocd.writeUInt32LE(SIG_ZIP64_EOCD, 0);
  zip64Eocd.writeBigUInt64LE(44n, 4); // size of the rest of the record
  zip64Eocd.writeUInt16LE(45, 12); // version made by
  zip64Eocd.writeUInt16LE(45, 14); // version needed
  zip64Eocd.writeUInt32LE(0, 16); // this disk
  zip64Eocd.writeUInt32LE(0, 20); // disk with the central directory
  zip64Eocd.writeBigUInt64LE(BigInt(fileCount), 24);
  zip64Eocd.writeBigUInt64LE(BigInt(fileCount), 32);
  zip64Eocd.writeBigUInt64LE(BigInt(centralSize), 40);
  zip64Eocd.writeBigUInt64LE(BigInt(position), 48);
  // Zip64 end of central directory locator (20 bytes).
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
  locator.writeUInt32LE(0, 4); // disk with the zip64 EOCD
  locator.writeBigUInt64LE(BigInt(position + centralSize), 8);
  locator.writeUInt32LE(1, 16); // total disks
  return Buffer.concat([...locals, ...centrals, zip64Eocd, locator, eocd]);
}

/**
 * Moves the main document part to `word/document2.xml`, keeping the package consistent:
 * `_rels/.rels` Target, `[Content_Types].xml` Override and the part's own `.rels` file.
 */
function renameMainPart(entries) {
  return entries.map(({ name, data }) => {
    if (name === "word/document.xml") return { name: "word/document2.xml", data };
    if (name === "word/_rels/document.xml.rels") {
      return { name: "word/_rels/document2.xml.rels", data };
    }
    if (name === "_rels/.rels" || name === "[Content_Types].xml") {
      const xml = data.toString("utf8").replace(/word\/document\.xml/g, "word/document2.xml");
      if (xml === data.toString("utf8"))
        throw new Error(`${name} does not reference the main part`);
      return { name, data: Buffer.from(xml, "utf8") };
    }
    return { name, data };
  });
}

/** Pins the non-deterministic bits the `docx` package emits. */
function pin(name, xml) {
  if (name === "docProps/core.xml") {
    return xml.replace(
      /(<dcterms:(created|modified)[^>]*>)[^<]*(<\/dcterms:\2>)/g,
      "$12026-01-01T00:00:00.000Z$3",
    );
  }
  if (name === "word/document.xml") {
    let n = 0;
    return xml.replace(/<v:shape id="[^"]*"/g, () => `<v:shape id="cvparse-textbox-${++n}"`);
  }
  return xml;
}

/**
 * Re-wraps the VML text box (w:pict/v:shape/v:textbox) as a DrawingML shape
 * (w:drawing/wp:inline/a:graphic/wps:wsp/wps:txbx) with no mc:AlternateContent fallback.
 * This is what some modern exporters emit; mammoth 1.13 ignores it.
 */
function vmlToDrawingML(xml) {
  const pattern =
    /<w:pict><v:shape\b[^>]*><v:textbox\b[^>]*>(<w:txbxContent>[\s\S]*?<\/w:txbxContent>)<\/v:textbox><\/v:shape><\/w:pict>/g;
  let replaced = 0;
  const out = xml.replace(pattern, (_whole, content) => {
    replaced++;
    return (
      '<w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2286000" cy="1097280"/>' +
      `<wp:docPr id="${replaced}" name="Cuadro de texto ${replaced}"/>` +
      '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      `<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2286000" cy="1097280"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:txbx>${content}</wps:txbx><wps:bodyPr/></wps:wsp>` +
      "</a:graphicData></a:graphic></wp:inline></w:drawing>"
    );
  });
  if (replaced === 0) throw new Error("no VML text box found to convert");
  return out;
}

/**
 * @param {Document} doc
 * @param {{
 *   transform?: (name: string, xml: string) => string,
 *   entries?: (entries: Array<{ name: string, data: Buffer }>) => Array<{ name: string, data: Buffer }>,
 *   zip64?: boolean,
 * }} [options]
 */
async function build(doc, { transform = (_name, xml) => xml, entries = (e) => e, zip64 } = {}) {
  const packed = await Packer.toBuffer(doc);
  const parts = readZip(packed).map(({ name, data }) => {
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) return { name, data };
    const xml = transform(name, pin(name, data.toString("utf8")));
    return { name, data: Buffer.from(xml, "utf8") };
  });
  return writeZip(entries(parts), { zip64 });
}

const drawingMlBoxes = (name, xml) => (name === "word/document.xml" ? vmlToDrawingML(xml) : xml);

// ---------------------------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });

const fixtures = [
  ["simple-es.docx", await build(document(ventasBody()))],
  ["table-layout-es.docx", await build(document(tableLayoutBody()))],
  ["textbox-es.docx", await build(document(textboxBody()))],
  ["textbox-drawing-es.docx", await build(document(textboxBody()), { transform: drawingMlBoxes })],
  [
    "textbox-overlap-es.docx",
    await build(document(textboxOverlapBody()), { transform: drawingMlBoxes }),
  ],
  ["document2-es.docx", await build(document(ventasBody()), { entries: renameMainPart })],
  ["zip64-es.docx", await build(document(ventasBody()), { zip64: true })],
];

for (const [name, bytes] of fixtures) {
  writeFileSync(join(outDir, name), bytes);
  console.log(`${name}\t${bytes.length} bytes`);
}
