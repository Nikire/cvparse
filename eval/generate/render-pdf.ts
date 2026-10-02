/**
 * Text-layer PDF renderers: single-column, two-column, sidebar, functional and academic
 * (Europass-like date column). Every value in the ground truth is drawn verbatim.
 */

import { type PDFPage, rgb } from "pdf-lib";
import type { CvDoc, DocJob, DocStudy } from "./doc.js";
import {
  A4,
  addPage,
  type Column,
  createPdf,
  type Fonts,
  flow,
  type Run,
  savePdf,
} from "./pdf-kit.js";

export interface RenderResult {
  bytes: Uint8Array;
  /** Extra tags discovered while rendering ("multi-page", "photo", ...). */
  tags: string[];
}

// -------------------------------------------------------------------------------------------
// Shared run builders

const heading = (title: string, rule = false, size = 11.5): Run => ({
  text: title,
  bold: true,
  size,
  before: 8,
  after: rule ? 4 : 3,
  rule,
});

function contactLine(doc: CvDoc): string {
  const p = doc.person;
  return `${doc.locationText} · ${doc.phoneLabel}${p.phone} · ${doc.emailLabel}${p.email}`;
}

/** Font size so `text` fits in `width` (capped at `max`). */
function fitSize(fonts: Fonts, text: string, width: number, max: number): number {
  const w = fonts.bold.widthOfTextAtSize(text, 1);
  return Math.min(max, Math.floor((width / w) * 10) / 10);
}

function headerRuns(
  doc: CvDoc,
  fonts: Fonts,
  width: number,
  align: "left" | "center" = "left",
): Run[] {
  return [
    {
      text: doc.person.name,
      bold: true,
      size: fitSize(fonts, doc.person.name, width, 21),
      align,
      after: 2,
    },
    { text: doc.person.label, size: 12, align, after: 2, grey: 0.3 },
    { text: contactLine(doc), size: 9, align, grey: 0.25 },
  ];
}

function jobRuns(job: DocJob, variant: number, size = 10): Run[] {
  const bullets: Run[] = job.highlights.map((h) => ({ text: h, bullet: true, size: size - 0.5 }));
  let head: Run[];
  switch (variant % 3) {
    case 0:
      head = [
        { text: `${job.position} — ${job.company}`, bold: true, size },
        { text: `${job.location} · ${job.dates}`, size: size - 1, grey: 0.35 },
      ];
      break;
    case 1:
      head = [
        { text: job.position, bold: true, size, right: job.dates },
        { text: `${job.company}, ${job.location}`, size: size - 0.5, grey: 0.3 },
      ];
      break;
    default:
      head = [
        { text: `${job.company} | ${job.location}`, bold: true, size },
        { text: `${job.position} | ${job.dates}`, size: size - 0.5 },
      ];
  }
  return [...head, ...bullets, { text: "", size: 4 }];
}

function studyRuns(study: DocStudy, variant: number, size = 10): Run[] {
  switch (variant % 3) {
    case 0:
      return [
        { text: study.title, bold: true, size },
        { text: `${study.institution} · ${study.dates}`, size: size - 1, grey: 0.35, after: 4 },
      ];
    case 1:
      return [
        { text: study.title, bold: true, size, right: study.dates },
        { text: study.institution, size: size - 0.5, after: 4 },
      ];
    default:
      return [
        { text: `${study.institution} | ${study.dates}`, bold: true, size },
        { text: study.title, size: size - 0.5, after: 4 },
      ];
  }
}

const listRuns = (items: readonly string[], size = 9.5): Run[] =>
  items.map((text) => ({ text, size }));

/** Creates "next page" callbacks for several columns that share the same page sequence. */
function pager(ctx: { doc: import("pdf-lib").PDFDocument }, first: PDFPage) {
  const pages: PDFPage[] = [first];
  return {
    pages,
    column() {
      let index = 0;
      return () => {
        index++;
        if (!pages[index]) pages[index] = addPage(ctx.doc);
        return pages[index] as PDFPage;
      };
    },
  };
}

async function finish(
  ctx: { doc: import("pdf-lib").PDFDocument },
  tags: string[],
): Promise<RenderResult> {
  if (ctx.doc.getPageCount() > 1) tags.push("multi-page");
  return { bytes: await savePdf(ctx.doc), tags };
}

// -------------------------------------------------------------------------------------------
// Layouts

export async function renderSingleColumn(doc: CvDoc): Promise<RenderResult> {
  const ctx = await createPdf(`CV ${doc.person.name}`);
  const page = addPage(ctx.doc);
  const v = doc.spec.variant;
  const t = doc.titles;
  const margin = 50;
  const width = A4.width - margin * 2;
  const tags: string[] = [];
  if (v % 3 === 1) tags.push("right-aligned-dates");
  const rule = v % 3 === 2;
  const runs: Run[] = [
    ...headerRuns(doc, ctx.fonts, width, v % 3 === 2 ? "center" : "left"),
    ...(doc.summary ? [heading(t.profile, rule), { text: doc.summary, size: 10 }] : []),
    heading(t.experience, rule),
    ...doc.jobs.flatMap((job) => jobRuns(job, v)),
    heading(t.education, rule),
    ...doc.studies.flatMap((s) => studyRuns(s, v)),
    heading(t.skills, rule),
    { text: doc.skills.join(v % 2 === 0 ? ", " : " · "), size: 10 },
    heading(t.languages, rule),
    ...listRuns(doc.languages, 10),
  ];
  const p = pager(ctx, page);
  flow(ctx.fonts, page, { x: margin, width, top: A4.height - margin, bottom: margin }, runs, {
    newPage: p.column(),
  });
  return finish(ctx, tags);
}

export async function renderTwoColumn(doc: CvDoc): Promise<RenderResult> {
  const ctx = await createPdf(`CV ${doc.person.name}`);
  const page = addPage(ctx.doc);
  const v = doc.spec.variant;
  const t = doc.titles;
  const margin = 44;
  const gutter = 26;
  const inner = A4.width - margin * 2 - gutter;
  // v even: equal columns, experience left. v odd: narrow left (skills/edu), experience right.
  const leftWidth = v % 2 === 0 ? inner / 2 : inner * 0.38;
  const rightWidth = inner - leftWidth;
  const header = flow(
    ctx.fonts,
    page,
    { x: margin, width: A4.width - margin * 2, top: A4.height - margin, bottom: margin },
    headerRuns(doc, ctx.fonts, A4.width - margin * 2, v % 4 === 1 ? "center" : "left"),
  );
  page.drawLine({
    start: { x: margin, y: header.y - 8 },
    end: { x: A4.width - margin, y: header.y - 8 },
    thickness: 1,
    color: rgb(0.6, 0.6, 0.6),
  });
  const top = header.y - 16;
  const experience: Run[] = [
    ...(doc.summary ? [heading(t.profile), { text: doc.summary, size: 9.5 }] : []),
    heading(t.experience),
    ...doc.jobs.flatMap((job) => jobRuns(job, v + 1, 9.5)),
  ];
  const side: Run[] = [
    heading(t.education),
    ...doc.studies.flatMap((s) => studyRuns(s, v, 9.5)),
    heading(t.skills),
    ...(v % 3 === 0
      ? [{ text: doc.skills.join(", "), size: 9.5 }]
      : doc.skills.map((s): Run => ({ text: s, size: 9.5, bullet: true }))),
    heading(t.languages),
    ...listRuns(doc.languages),
  ];
  const [leftRuns, rightRuns] = v % 2 === 0 ? [experience, side] : [side, experience];
  const p = pager(ctx, page);
  const bottom = margin;
  flow(ctx.fonts, page, { x: margin, width: leftWidth, top, bottom }, leftRuns, {
    newPage: p.column(),
  });
  flow(
    ctx.fonts,
    page,
    { x: margin + leftWidth + gutter, width: rightWidth, top, bottom },
    rightRuns,
    { newPage: p.column() },
  );
  return finish(ctx, ["two-columns"]);
}

export async function renderSidebar(doc: CvDoc): Promise<RenderResult> {
  const ctx = await createPdf(`CV ${doc.person.name}`);
  const page = addPage(ctx.doc);
  const v = doc.spec.variant;
  const t = doc.titles;
  const tags: string[] = [];
  const sidebarWidth = 158;
  const pad = 22;
  const sidebarRight = v % 2 === 1;
  if (sidebarRight) tags.push("sidebar-right");
  const barX = sidebarRight ? A4.width - sidebarWidth - pad * 2 : 0;
  page.drawRectangle({
    x: barX,
    y: 0,
    width: sidebarWidth + pad * 2,
    height: A4.height,
    color: rgb(0.9, 0.92, 0.95),
  });
  let sideTop = A4.height - 40;
  if (v % 4 < 2) {
    tags.push("photo");
    page.drawCircle({
      x: barX + pad + sidebarWidth / 2,
      y: A4.height - 40 - 50,
      size: 48,
      color: rgb(0.72, 0.75, 0.8),
    });
    sideTop -= 112;
  }
  const side: Run[] = [
    heading(t.contact, false, 10.5),
    { text: doc.locationText, size: 9 },
    { text: `${doc.phoneLabel}${doc.person.phone}`, size: 9 },
    { text: doc.person.email, size: 9, after: 4 },
    heading(t.skills, false, 10.5),
    ...doc.skills.map((s): Run => ({ text: s, size: 9 })),
    heading(t.languages, false, 10.5),
    ...listRuns(doc.languages, 9),
    heading(t.education, false, 10.5),
    ...doc.studies.flatMap((s): Run[] => [
      { text: s.title, bold: true, size: 9 },
      { text: s.institution, size: 8.5 },
      { text: s.dates, size: 8.5, grey: 0.35, after: 4 },
    ]),
  ];
  const mainX = sidebarRight ? 40 : sidebarWidth + pad * 2 + 26;
  const mainWidth = A4.width - (sidebarWidth + pad * 2) - 26 - 40;
  const main: Run[] = [
    {
      text: doc.person.name,
      bold: true,
      size: fitSize(ctx.fonts, doc.person.name, mainWidth, 22),
      after: 2,
    },
    { text: doc.person.label, size: 12.5, grey: 0.35, after: 6 },
    ...(doc.summary ? [heading(t.profile, true), { text: doc.summary, size: 10 }] : []),
    heading(t.experience, true),
    ...doc.jobs.flatMap((job) => jobRuns(job, v + 2)),
  ];
  const p = pager(ctx, page);
  flow(ctx.fonts, page, { x: barX + pad, width: sidebarWidth, top: sideTop, bottom: 30 }, side, {
    newPage: p.column(),
    lineHeight: 1.45,
  });
  flow(ctx.fonts, page, { x: mainX, width: mainWidth, top: A4.height - 40, bottom: 40 }, main, {
    newPage: p.column(),
  });
  return finish(ctx, tags);
}

const COMPETENCY_HEADINGS = [
  "Gestión y liderazgo",
  "Resultados y mejora continua",
  "Procesos y herramientas",
];

/** Skills-first CV: competencies with achievements, then a compact chronology. */
export async function renderFunctional(doc: CvDoc): Promise<RenderResult> {
  const ctx = await createPdf(`CV ${doc.person.name}`);
  const page = addPage(ctx.doc);
  const t = doc.titles;
  const margin = 52;
  const width = A4.width - margin * 2;
  const achievements = doc.person.jobs.flatMap((j) => j.highlights);
  const groups = COMPETENCY_HEADINGS.map((title, i) => ({
    title,
    items: achievements.filter((_, k) => k % 3 === i),
  })).filter((g) => g.items.length > 0);
  const runs: Run[] = [
    ...headerRuns(doc, ctx.fonts, width),
    ...(doc.summary ? [heading(t.profile, true), { text: doc.summary, size: 10 }] : []),
    heading(t.competencies, true),
    ...groups.flatMap((g): Run[] => [
      { text: g.title, bold: true, size: 10, before: 2 },
      ...g.items.map((text): Run => ({ text, bullet: true, size: 9.5 })),
    ]),
    heading(t.skills, true),
    { text: doc.skills.join(" · "), size: 10 },
    heading(t.experience, true),
    ...doc.jobs.map(
      (j): Run => ({ text: `${j.dates} · ${j.position}, ${j.company} (${j.location})`, size: 9.5 }),
    ),
    heading(t.education, true),
    ...doc.studies.map(
      (s): Run => ({ text: `${s.dates} · ${s.title}, ${s.institution}`, size: 9.5 }),
    ),
    heading(t.languages, true),
    { text: doc.languages.join(" · "), size: 10 },
  ];
  const p = pager(ctx, page);
  flow(ctx.fonts, page, { x: margin, width, top: A4.height - margin, bottom: margin }, runs, {
    newPage: p.column(),
  });
  return finish(ctx, ["functional"]);
}

const JOURNALS = [
  "Revista Latinoamericana de Educación",
  "Cuadernos de Investigación Aplicada",
  "Actas del Congreso Iberoamericano de Ciencias",
  "Revista de Estudios Sociales del Sur",
];

/** Europass-like CV: a left column carries the dates and labels, the right column the entries. */
export async function renderAcademic(doc: CvDoc): Promise<RenderResult> {
  const ctx = await createPdf(`CV ${doc.person.name}`);
  const { fonts } = ctx;
  let page = addPage(ctx.doc);
  const t = doc.titles;
  const left = { x: 44, width: 120 };
  const right: Column = { x: 180, width: A4.width - 180 - 44, top: A4.height - 50, bottom: 50 };
  let y = A4.height - 50;
  const ensure = (needed: number) => {
    if (y - needed < 50) {
      page = addPage(ctx.doc);
      y = A4.height - 50;
    }
  };
  /** A row: left label right-aligned in the date column, runs in the right column. */
  const row = (label: string, runs: Run[], labelBold = false) => {
    ensure(24);
    const size = 9;
    const font = labelBold ? fonts.bold : fonts.regular;
    const lines = label.length > 0 ? label.split("\n") : [];
    lines.forEach((line, i) => {
      const w = font.widthOfTextAtSize(line, size);
      page.drawText(line, {
        x: left.x + left.width - w,
        y: y - (runs[0]?.size ?? 10) - i * 11,
        size,
        font,
        color: rgb(0.25, 0.3, 0.45),
      });
    });
    const res = flow(fonts, page, right, runs, {
      startY: y,
      newPage: () => {
        page = addPage(ctx.doc);
        return page;
      },
    });
    page = res.page;
    y = Math.min(res.y, y - lines.length * 11) - 6;
  };
  const section = (title: string) => {
    ensure(40);
    y -= 6;
    const size = 11;
    page.drawText(title.toUpperCase(), {
      x: left.x,
      y: y - size,
      size,
      font: fonts.bold,
      color: rgb(0.15, 0.25, 0.5),
    });
    page.drawLine({
      start: { x: right.x, y: y - size + 3 },
      end: { x: right.x + right.width, y: y - size + 3 },
      thickness: 0.8,
      color: rgb(0.15, 0.25, 0.5),
    });
    y -= size + 10;
  };

  // Name block.
  const name = {
    text: doc.person.name,
    bold: true,
    size: fitSize(fonts, doc.person.name, right.width, 20),
  };
  const res = flow(fonts, page, right, [name, { text: doc.person.label, size: 11.5, grey: 0.35 }], {
    startY: y,
  });
  page.drawText("CURRICULUM VITAE", {
    x: left.x,
    y: y - 14,
    size: 9,
    font: fonts.bold,
    color: rgb(0.15, 0.25, 0.5),
  });
  y = res.y - 10;

  section(t.personal);
  row("Ubicación", [{ text: doc.locationText, size: 9.5 }]);
  row("Teléfono", [{ text: doc.person.phone, size: 9.5 }]);
  row("Correo electrónico", [{ text: doc.person.email, size: 9.5 }]);
  if (doc.summary) {
    section(t.profile);
    row("", [{ text: doc.summary, size: 9.5 }]);
  }
  section(t.experience);
  for (const job of doc.jobs) {
    row(job.dates, [
      { text: job.position, bold: true, size: 10 },
      { text: `${job.company} — ${job.location}`, size: 9.5 },
      ...job.highlights.map((h): Run => ({ text: h, bullet: true, size: 9 })),
    ]);
  }
  section(t.education);
  for (const s of doc.studies) {
    row(s.dates, [
      { text: s.title, bold: true, size: 10 },
      { text: s.institution, size: 9.5 },
    ]);
  }
  section(t.languages);
  for (const l of doc.languages) row("", [{ text: l, size: 9.5 }]);
  section(t.skills);
  row("", [{ text: doc.skills.join(", "), size: 9.5 }]);

  // Publications are not part of the ground truth (scored fields only), but make the CV academic.
  section(t.publications);
  const surname = doc.person.lastNames.split(" ")[0] as string;
  const initial = doc.person.firstNames.charAt(0);
  const pubs = doc.rng.sample(JOURNALS, 2);
  pubs.forEach((journal, i) => {
    const year = 2018 + doc.rng.int(0, 7);
    row(String(year), [
      {
        text: `${surname}, ${initial}. (${year}). "${i === 0 ? "Estudio exploratorio sobre prácticas" : "Análisis comparado de indicadores"} en contextos latinoamericanos". ${journal}, ${doc.rng.int(3, 40)}(${doc.rng.int(1, 4)}).`,
        size: 9,
      },
    ]);
  });
  return finish(ctx, ["date-column", "publications"]);
}
