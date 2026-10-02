/**
 * DOCX renderers (docx package): simple (headings + bullets), table layouts (Word/Canva-style
 * templates) and text boxes (VML or DrawingML-only, which mammoth drops). Output is re-packed with
 * fixed zip timestamps, pinned core.xml dates and stable VML shape ids.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  type FileChild,
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
import type { CvDoc, DocJob, DocStudy } from "./doc.js";
import type { RenderResult } from "./render-pdf.js";
import { readZip, writeZip } from "./zip.js";

const heading = (
  text: string,
  level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1,
) => new Paragraph({ text, heading: level });
const para = (text: string) => new Paragraph({ children: [new TextRun(text)] });
const boldPara = (text: string) => new Paragraph({ children: [new TextRun({ text, bold: true })] });
const bullet = (text: string) => new Paragraph({ text, bullet: { level: 0 } });
const lines = (...texts: string[]) =>
  new Paragraph({
    children: texts.map((text, i) => new TextRun({ text, break: i === 0 ? undefined : 1 })),
  });
const nameParagraph = (doc: CvDoc, size = 32) =>
  new Paragraph({ children: [new TextRun({ text: doc.person.name, bold: true, size })] });

function jobBlock(job: DocJob, variant: number): Paragraph[] {
  const head =
    variant % 2 === 0
      ? [boldPara(job.position), para(`${job.company}, ${job.location}`), para(job.dates)]
      : [boldPara(`${job.company} — ${job.location}`), para(`${job.position} (${job.dates})`)];
  return [...head, ...job.highlights.map(bullet)];
}

function studyBlock(study: DocStudy, variant: number): Paragraph[] {
  return variant % 2 === 0
    ? [para(`${study.title} — ${study.institution}`), para(study.dates)]
    : [boldPara(study.title), para(`${study.institution}, ${study.dates}`)];
}

function contactParagraph(doc: CvDoc): Paragraph {
  return para(
    `${doc.locationText} | ${doc.phoneLabel}${doc.person.phone} | ${doc.emailLabel}${doc.person.email}`,
  );
}

function simpleBody(
  doc: CvDoc,
  options: { contact?: boolean; skills?: boolean } = {},
): FileChild[] {
  const t = doc.titles;
  const v = doc.spec.variant;
  return [
    nameParagraph(doc),
    para(doc.person.label),
    ...(options.contact === false ? [] : [contactParagraph(doc)]),
    ...(doc.summary ? [heading(t.profile), para(doc.summary)] : []),
    heading(t.experience),
    ...doc.jobs.flatMap((job) => jobBlock(job, v)),
    heading(t.education),
    ...doc.studies.flatMap((s) => studyBlock(s, v)),
    ...(options.skills === false
      ? []
      : [
          heading(t.skills),
          ...(v % 2 === 0 ? [para(doc.skills.join(" · "))] : doc.skills.map(bullet)),
          heading(t.languages),
          ...doc.languages.map(para),
        ]),
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

const cell = (children: Paragraph[], width: number) =>
  new TableCell({
    children,
    width: { size: width, type: WidthType.PERCENTAGE },
    borders: noBorders,
  });

/** Variant A: one borderless row, narrow left column (contact/skills) and wide right column. */
function tableSidebarBody(doc: CvDoc): FileChild[] {
  const t = doc.titles;
  const left: Paragraph[] = [
    nameParagraph(doc, 30),
    para(doc.person.label),
    heading(t.contact, HeadingLevel.HEADING_2),
    lines(doc.locationText, `${doc.phoneLabel}${doc.person.phone}`, doc.person.email),
    heading(t.skills, HeadingLevel.HEADING_2),
    ...doc.skills.map(bullet),
    heading(t.languages, HeadingLevel.HEADING_2),
    ...doc.languages.map(para),
  ];
  const right: Paragraph[] = [
    ...(doc.summary ? [heading(t.profile, HeadingLevel.HEADING_2), para(doc.summary)] : []),
    heading(t.experience, HeadingLevel.HEADING_2),
    ...doc.jobs.flatMap((job) => jobBlock(job, doc.spec.variant)),
    heading(t.education, HeadingLevel.HEADING_2),
    ...doc.studies.flatMap((s) => studyBlock(s, doc.spec.variant)),
  ];
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: noBorders,
      rows: [new TableRow({ children: [cell(left, 35), cell(right, 65)] })],
    }),
  ];
}

/** Variant B: a dates column; one table row per job/degree (Europass-ish Word templates). */
function tableDatesBody(doc: CvDoc): FileChild[] {
  const t = doc.titles;
  const row = (left: string, right: Paragraph[]) =>
    new TableRow({ children: [cell([para(left)], 25), cell(right, 75)] });
  const sectionRow = (title: string) =>
    new TableRow({
      children: [
        cell(
          [new Paragraph({ children: [new TextRun({ text: title.toUpperCase(), bold: true })] })],
          25,
        ),
        cell([para("")], 75),
      ],
    });
  const rows: TableRow[] = [
    sectionRow(t.experience),
    ...doc.jobs.map((job) =>
      row(job.dates, [
        boldPara(job.position),
        para(`${job.company} — ${job.location}`),
        ...job.highlights.map(bullet),
      ]),
    ),
    sectionRow(t.education),
    ...doc.studies.map((s) => row(s.dates, [boldPara(s.title), para(s.institution)])),
    sectionRow(t.skills),
    row("", [para(doc.skills.join(", "))]),
    sectionRow(t.languages),
    ...doc.languages.map((l) => row("", [para(l)])),
  ];
  return [
    nameParagraph(doc),
    para(doc.person.label),
    contactParagraph(doc),
    ...(doc.summary ? [heading(t.profile), para(doc.summary)] : []),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: noBorders, rows }),
  ];
}

/** Simple body with the contact block (or skills + languages) moved into floating text boxes. */
function textboxBody(doc: CvDoc): FileChild[] {
  const t = doc.titles;
  const contactInBox = doc.spec.variant % 2 === 0;
  const body = simpleBody(doc, contactInBox ? { contact: false } : { skills: false });
  const box = (children: Paragraph[], height: `${number}in`) =>
    new Textbox({
      alignment: AlignmentType.RIGHT,
      children,
      style: { width: "2.8in", height },
    });
  const boxes = contactInBox
    ? [
        box(
          [
            new Paragraph({
              children: [new TextRun({ text: t.contact.toUpperCase(), bold: true })],
            }),
            para(doc.locationText),
            para(`${doc.phoneLabel}${doc.person.phone}`),
            para(doc.person.email),
          ],
          "1.1in",
        ),
      ]
    : [
        box(
          [
            new Paragraph({
              children: [new TextRun({ text: t.skills.toUpperCase(), bold: true })],
            }),
            ...doc.skills.map(para),
          ],
          "2.4in",
        ),
        box(
          [
            new Paragraph({
              children: [new TextRun({ text: t.languages.toUpperCase(), bold: true })],
            }),
            ...doc.languages.map(para),
          ],
          "1in",
        ),
      ];
  // After name + label (+ contact line when it stays in the body).
  body.splice(contactInBox ? 2 : 3, 0, ...boxes);
  return body;
}

// -------------------------------------------------------------------------------------------
// Packing

/** Pins the non-deterministic bits the `docx` package emits. */
function pin(name: string, xml: string): string {
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

/** Re-wraps every VML text box as a DrawingML shape with no VML fallback (mammoth ignores it). */
function vmlToDrawingML(xml: string): string {
  const pattern =
    /<w:pict><v:shape\b[^>]*><v:textbox\b[^>]*>(<w:txbxContent>[\s\S]*?<\/w:txbxContent>)<\/v:textbox><\/v:shape><\/w:pict>/g;
  let replaced = 0;
  const out = xml.replace(pattern, (_whole, content: string) => {
    replaced++;
    return (
      '<w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2560320" cy="1005840"/>' +
      `<wp:docPr id="${replaced}" name="Cuadro de texto ${replaced}"/>` +
      '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      `<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2560320" cy="1005840"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:txbx>${content}</wps:txbx><wps:bodyPr/></wps:wsp>` +
      "</a:graphicData></a:graphic></wp:inline></w:drawing>"
    );
  });
  if (replaced === 0) throw new Error("no VML text box found to convert");
  return out;
}

async function pack(doc: CvDoc, children: FileChild[], drawingML = false): Promise<Uint8Array> {
  const document = new Document({
    creator: "cvparse eval dataset",
    title: `CV ${doc.person.name}`,
    sections: [{ children }],
  });
  const packed = await Packer.toBuffer(document);
  const parts = readZip(packed).map(({ name, data }) => {
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) return { name, data };
    let xml = pin(name, data.toString("utf8"));
    if (drawingML && name === "word/document.xml") xml = vmlToDrawingML(xml);
    return { name, data: Buffer.from(xml, "utf8") };
  });
  return new Uint8Array(writeZip(parts));
}

export async function renderDocxSimple(doc: CvDoc): Promise<RenderResult> {
  return { bytes: await pack(doc, simpleBody(doc)), tags: [] };
}

export async function renderDocxTable(doc: CvDoc): Promise<RenderResult> {
  const datesColumn = doc.spec.variant % 2 === 1;
  const body = datesColumn ? tableDatesBody(doc) : tableSidebarBody(doc);
  return {
    bytes: await pack(doc, body),
    tags: datesColumn ? ["date-column", "table-layout"] : ["table-layout"],
  };
}

export async function renderDocxTextbox(doc: CvDoc): Promise<RenderResult> {
  // Variants 0-1: VML text boxes (w:pict); 2-3: DrawingML only (w:drawing/wps:txbx).
  const drawingML = doc.spec.variant >= 2;
  return {
    bytes: await pack(doc, textboxBody(doc), drawingML),
    tags: [drawingML ? "drawingml-textbox" : "vml-textbox"],
  };
}
