/**
 * CvDoc: the view model every renderer consumes. It holds the exact strings that end up in the
 * rendered file (dates already formatted in the chosen style, section titles, contact line) and
 * the ground truth derived from the very same values, so a perfect parser can reach F1 = 1.0.
 */

import type { DatasetCountry, DatasetFormat, DatasetLayout, GroundTruth } from "../types.js";
import {
  generatePerson,
  type Person,
  type PersonOptions,
  type RoleId,
  type Study,
  type YM,
} from "./people.js";
import { Rng } from "./rng.js";

// -------------------------------------------------------------------------------------------
// Date styles

/** Work-date styles a CV can use (education may use year ranges instead). */
export type WorkDateStyle =
  | "month-name" // marzo 2021 – actualidad
  | "mm-yyyy" // 03/2021 - 06/2023
  | "abbr-dot" // mar. 2021 – jun. 2023
  | "abbr-cap" // Ene 2020 – Dic 2022
  | "two-digit" // 2019-21
  | "year-presente" // 2019 – presente
  | "a-la-fecha"; // 2018 a la fecha

export const WORK_DATE_STYLES: readonly WorkDateStyle[] = [
  "month-name",
  "mm-yyyy",
  "abbr-dot",
  "abbr-cap",
  "two-digit",
  "year-presente",
  "a-la-fecha",
];

/** Labels recorded in DatasetEntry.dateStyles. */
export const DATE_LABELS = {
  monthName: "marzo 2021",
  mmYyyy: "03/2021",
  abbrDot: "mar. 2021",
  abbrCap: "Ene 2020",
  twoDigit: "2019-21",
  yearPresente: "2019 – presente",
  aLaFecha: "2018 a la fecha",
  yearRange: "2014 – 2018",
  yearA: "2015 a 2018",
  season: "verano 2020",
  year: "2020",
} as const;

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
const ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoMonth = (ym: YM) => `${ym.year}-${pad2(ym.month)}`;
const isoYear = (ym: YM) => String(ym.year);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface FormattedRange {
  text: string;
  labels: string[];
  start: string | null;
  /** `null` = ongoing. */
  end: string | null;
}

function monthStyle(style: WorkDateStyle): boolean {
  return (
    style === "month-name" || style === "mm-yyyy" || style === "abbr-dot" || style === "abbr-cap"
  );
}

function formatMonth(style: WorkDateStyle, ym: YM): string {
  const m = ym.month - 1;
  switch (style) {
    case "month-name":
      return `${MONTHS[m]} ${ym.year}`;
    case "mm-yyyy":
      return `${pad2(ym.month)}/${ym.year}`;
    case "abbr-dot":
      return `${ABBR[m]}. ${ym.year}`;
    default:
      return `${cap(ABBR[m] as string)} ${ym.year}`;
  }
}

const MONTH_LABEL: Record<string, string> = {
  "month-name": DATE_LABELS.monthName,
  "mm-yyyy": DATE_LABELS.mmYyyy,
  "abbr-dot": DATE_LABELS.abbrDot,
  "abbr-cap": DATE_LABELS.abbrCap,
};

/** Formats a start/end range. `end === null` means ongoing. */
export function formatRange(
  style: WorkDateStyle | "year-range",
  start: YM,
  end: YM | null,
): FormattedRange {
  if (style !== "year-range" && monthStyle(style)) {
    const label = MONTH_LABEL[style] as string;
    const sep = style === "mm-yyyy" ? " - " : " – ";
    const ongoing =
      style === "abbr-cap" ? "Presente" : style === "mm-yyyy" ? "Actualidad" : "actualidad";
    return {
      text: `${formatMonth(style, start)}${sep}${end ? formatMonth(style, end) : ongoing}`,
      labels: [label],
      start: isoMonth(start),
      end: end ? isoMonth(end) : null,
    };
  }
  // Year precision from here on.
  const years = { start: isoYear(start), end: end ? isoYear(end) : null };
  if (end === null) {
    if (style === "a-la-fecha") {
      return { text: `${start.year} a la fecha`, labels: [DATE_LABELS.aLaFecha], ...years };
    }
    return { text: `${start.year} – presente`, labels: [DATE_LABELS.yearPresente], ...years };
  }
  if (style === "two-digit") {
    const short = end.year % 100;
    const sameCentury = Math.floor(start.year / 100) === Math.floor(end.year / 100);
    // "2005-07" would be July 2005; only emit two-digit ranges that cannot be read as YYYY-MM.
    if (sameCentury && end.year > start.year && short > 12) {
      return { text: `${start.year}-${pad2(short)}`, labels: [DATE_LABELS.twoDigit], ...years };
    }
  }
  if (style === "a-la-fecha") {
    return { text: `${start.year} a ${end.year}`, labels: [DATE_LABELS.yearA], ...years };
  }
  return { text: `${start.year} – ${end.year}`, labels: [DATE_LABELS.yearRange], ...years };
}

/** Single date for short courses. */
function formatSingle(style: WorkDateStyle | "year-range" | "season", ym: YM): FormattedRange {
  if (style === "season") {
    return {
      text: `verano ${ym.year}`,
      labels: [DATE_LABELS.season],
      start: null,
      end: isoYear(ym),
    };
  }
  if (style !== "year-range" && monthStyle(style)) {
    return {
      text: formatMonth(style, ym),
      labels: [MONTH_LABEL[style] as string],
      start: null,
      end: isoMonth(ym),
    };
  }
  return { text: String(ym.year), labels: [DATE_LABELS.year], start: null, end: isoYear(ym) };
}

// -------------------------------------------------------------------------------------------
// Section titles

export interface SectionTitles {
  profile: string;
  experience: string;
  education: string;
  skills: string;
  languages: string;
  contact: string;
  competencies: string;
  publications: string;
  personal: string;
}

const TITLES_ES = {
  profile: ["Perfil", "Perfil profesional", "Sobre mí", "Resumen"],
  experience: ["Experiencia", "Experiencia laboral", "Experiencia profesional"],
  education: ["Educación", "Formación", "Formación académica", "Estudios"],
  skills: ["Habilidades", "Competencias técnicas", "Conocimientos", "Aptitudes"],
  languages: ["Idiomas"],
  contact: ["Contacto", "Datos de contacto"],
  competencies: ["Competencias clave", "Áreas de experiencia"],
  publications: ["Publicaciones"],
  personal: ["Información personal", "Datos personales"],
};

const TITLES_EN = {
  profile: ["Profile", "Summary"],
  experience: ["Experience", "Work experience"],
  education: ["Education"],
  skills: ["Skills"],
  languages: ["Languages"],
  contact: ["Contact"],
  competencies: ["Key competencies"],
  publications: ["Publications"],
  personal: ["Personal information"],
};

function pickTitles(rng: Rng, english: boolean, upper: boolean): SectionTitles {
  const source = english ? TITLES_EN : TITLES_ES;
  const out = {} as SectionTitles;
  for (const key of Object.keys(source) as (keyof SectionTitles)[]) {
    const value = rng.pick(source[key]);
    out[key] = upper ? value.toUpperCase() : value;
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// The view model

export interface DocJob {
  company: string;
  position: string;
  location: string;
  dates: string;
  highlights: string[];
}

export interface DocStudy {
  /** "Licenciatura en Psicología". */
  title: string;
  institution: string;
  dates: string;
}

export interface EntrySpec {
  id: string;
  index: number;
  country: DatasetCountry;
  role: RoleId;
  layout: DatasetLayout;
  format: DatasetFormat;
  language: "es" | "mixed";
  /** Free-form renderer variant (0-based) inside the layout. */
  variant: number;
}

export interface CvDoc {
  spec: EntrySpec;
  person: Person;
  titles: SectionTitles;
  /** "Medellín, Antioquia, Colombia" — x_cvparse.location.raw. */
  locationText: string;
  phoneLabel: string;
  emailLabel: string;
  summary: string | null;
  jobs: DocJob[];
  studies: DocStudy[];
  skills: string[];
  /** "Inglés: C1", "Inglés (C1)", ... */
  languages: string[];
  dateStyles: string[];
  tags: string[];
  truth: GroundTruth;
  /** Seeded generator for renderer-level choices. */
  rng: Rng;
}

function personOptions(spec: EntrySpec, rng: Rng): PersonOptions {
  const base: PersonOptions = {
    jobs: rng.int(2, 4),
    highlights: [2, 3],
    ongoing: 0.7,
    postgraduate: rng.chance(0.4),
    doctorate: false,
    course: rng.chance(0.5),
    technical: rng.chance(0.2),
    skills: rng.int(7, 10),
  };
  switch (spec.layout) {
    case "single-column":
      return spec.format === "docx" ? { ...base, highlights: [1, 3] } : base;
    case "two-column":
      return { ...base, jobs: rng.int(2, 3), highlights: [1, 2], skills: rng.int(6, 8) };
    case "sidebar":
      return { ...base, jobs: rng.int(2, 3), highlights: [1, 2], skills: rng.int(6, 9) };
    case "table":
    case "textbox":
      return { ...base, jobs: rng.int(2, 3), highlights: [1, 2] };
    case "functional":
      return { ...base, jobs: rng.int(3, 4), highlights: [1, 2], skills: 8 };
    case "academic":
      return {
        ...base,
        jobs: rng.int(2, 3),
        highlights: [1, 2],
        doctorate: true,
        technical: false,
        course: rng.chance(0.3),
      };
    case "scanned":
      return {
        ...base,
        jobs: 2,
        highlights: [1, 1],
        postgraduate: false,
        course: rng.chance(0.4),
        technical: false,
        skills: 6,
      };
  }
}

function studyTitle(study: Study): string {
  return `${study.studyType} ${study.connector} ${study.area}`;
}

export function buildDoc(spec: EntrySpec): CvDoc {
  const rng = new Rng(`cvparse-eval/${spec.id}`);
  const person = generatePerson(rng, spec.country, spec.role, personOptions(spec, rng));
  const english = spec.language === "mixed";
  const titles = pickTitles(rng, english, rng.chance(0.65));

  // --- Date styles: rotate through the work styles so all of them are well represented. -----
  const workStyle = WORK_DATE_STYLES[
    (spec.index * 3 + rng.int(0, 1)) % WORK_DATE_STYLES.length
  ] as WorkDateStyle;
  const mixed = rng.chance(0.2);
  const altStyle = rng.pick(WORK_DATE_STYLES.filter((s) => s !== workStyle));
  const eduStyle: WorkDateStyle | "year-range" = rng.chance(0.6) ? "year-range" : workStyle;
  const labels = new Set<string>();
  const tags = new Set<string>();

  const truthWork: NonNullable<GroundTruth["work"]> = [];
  const jobs: DocJob[] = person.jobs.map((job, i) => {
    const style =
      mixed && i === person.jobs.length - 1 && person.jobs.length > 1 ? altStyle : workStyle;
    const range = formatRange(style, job.start, job.end);
    for (const l of range.labels) labels.add(l);
    if (range.end === null) tags.add("ongoing-role");
    const highlights = spec.layout === "functional" ? [] : job.highlights;
    truthWork.push({
      name: job.company,
      position: job.position,
      location: job.location,
      startDate: range.start,
      endDate: range.end,
      ...(highlights.length > 0 ? { highlights } : {}),
    });
    return {
      company: job.company,
      position: job.position,
      location: job.location,
      dates: range.text,
      highlights,
    };
  });
  if (mixed && person.jobs.length > 1) tags.add("mixed-date-styles");

  const truthEducation: NonNullable<GroundTruth["education"]> = [];
  const studies: DocStudy[] = person.studies.map((study) => {
    let range: FormattedRange;
    if (study.kind === "course" || study.start === null) {
      const style = rng.chance(0.35) ? "season" : eduStyle;
      range = formatSingle(style, study.end as YM);
      tags.add("short-course");
    } else {
      range = formatRange(eduStyle, study.start, study.end);
    }
    for (const l of range.labels) labels.add(l);
    if (study.start !== null && study.end === null) tags.add("ongoing-education");
    truthEducation.push({
      institution: study.institution,
      area: study.area,
      studyType: study.studyType,
      ...(range.start !== null ? { startDate: range.start } : {}),
      endDate: range.end,
    });
    if (study.level === "postgraduate" || study.level === "master") tags.add("postgraduate");
    if (study.level === "doctorate") tags.add("doctorate");
    if (study.level === "technical") tags.add("technical-degree");
    return { title: studyTitle(study), institution: study.institution, dates: range.text };
  });

  // --- Contact --------------------------------------------------------------------------------
  const locationText =
    person.city === person.region
      ? `${person.city}, ${person.countryName}`
      : `${person.city}, ${person.region}, ${person.countryName}`;
  const phoneLabel = rng.pick(english ? ["", "Phone: "] : ["", "Tel.: ", "Cel.: ", "Teléfono: "]);
  const emailLabel = rng.pick(["", "", "Email: ", "E-mail: "]);

  const langFormat = rng.int(0, 2);
  const languages = person.languages.map(({ language, fluency }) =>
    langFormat === 0
      ? `${language}: ${fluency}`
      : langFormat === 1
        ? `${language} (${fluency})`
        : `${language} – ${fluency}`,
  );

  const summary = spec.layout === "scanned" ? null : person.summary;

  // --- Tags ------------------------------------------------------------------------------------
  if (/[áéíóúÁÉÍÓÚüÜ]/.test(person.name)) tags.add("accented-name");
  if (/[ñÑ]/.test(person.name)) tags.add("enie");
  if (person.lastNames.includes(" ")) tags.add("two-surnames");
  if (person.firstNames.includes(" ")) tags.add("compound-first-name");
  if (english) tags.add("english-headings");
  if (labels.has(DATE_LABELS.twoDigit)) tags.add("two-digit-range");
  if (labels.has(DATE_LABELS.season)) tags.add("season-date");
  if (person.jobs.some((j) => j.location === "Remoto")) tags.add("remote-role");

  const truth: GroundTruth = {
    basics: {
      name: person.name,
      label: person.label,
      email: person.email,
      phone: person.phone,
      ...(summary ? { summary } : {}),
      location: { city: person.city, region: person.region, countryCode: person.country },
    },
    work: truthWork,
    education: truthEducation,
    skills: person.skills.map((name) => ({ name })),
    languages: person.languages.map(({ language, fluency }) => ({ language, fluency })),
    x_cvparse: {
      educationLevels: person.studies.map((s) => ({
        level: s.level,
        original: s.studyType,
        canonical: s.canonical,
      })),
      location: {
        city: person.city,
        adminRegion: person.region,
        countryCode: person.country,
        raw: locationText,
      },
    },
  };

  return {
    spec,
    person,
    titles,
    locationText,
    phoneLabel,
    emailLabel,
    summary,
    jobs,
    studies,
    skills: person.skills,
    languages,
    dateStyles: [...labels].sort(),
    tags: [...tags].sort(),
    truth,
    rng: new Rng(`cvparse-eval/${spec.id}/render`),
  };
}
