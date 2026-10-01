import { describe, expect, it } from "vitest";
import {
  EDUCATION_LEVELS,
  type EducationLevel,
  ExtensionEducationLevelSchema,
  normalizeStudyType,
} from "../src/index.js";

type Case = [input: string, level: EducationLevel, canonical: string | null];

const CASES: Case[] = [
  // --- secondary ---
  ["Bachillerato", "secondary", "Bachillerato"],
  ["Bachiller en Ciencias", "secondary", "Bachillerato"],
  ["Bachillerato Técnico en Informática", "secondary", "Bachillerato"],
  ["Secundario completo", "secondary", "Secundario"],
  ["Educación Secundaria", "secondary", "Secundario"],
  ["Secundario Técnico", "secondary", "Secundario"],
  ["Educación Media", "secondary", "Educación Media"],
  ["Ensino Médio", "secondary", "Educación Media"],
  ["Preparatoria", "secondary", "Preparatoria"],
  ["Educación Media Superior", "secondary", "Preparatoria"],
  ["ESO", "secondary", "ESO"],
  ["High School Diploma", "secondary", "Secundario"],
  // --- technical ---
  ["Tecnicatura Universitaria en Programación", "technical", "Tecnicatura"],
  ["Técnico Superior en Desarrollo de Aplicaciones Web", "technical", "Técnico Superior"],
  ["TECNICO SUPERIOR UNIVERSITARIO EN SISTEMAS", "technical", "Técnico Superior"],
  ["Técnico Universitario en Informática", "technical", "Tecnicatura"],
  ["Técnico en Electrónica", "technical", "Técnico"],
  ["Técnico Profesional en Sistemas", "technical", "Técnico"],
  ["Terciario", "technical", "Terciario"],
  ["Analista de Sistemas", "technical", "Analista"],
  ["Analista Programador Universitario", "technical", "Analista"],
  ["Formación Profesional de Grado Superior", "technical", "Formación Profesional"],
  ["Ciclo Formativo de Grado Medio", "technical", "Formación Profesional"],
  ["FP Superior", "technical", "Formación Profesional"],
  ["Tecnólogo em Análise e Desenvolvimento de Sistemas", "technical", "Tecnólogo"],
  ["Associate Degree in Nursing", "technical", "Tecnicatura"],
  ["Maestro Mayor de Obras", "technical", "Técnico"],
  // --- bachelor ---
  ["Licenciatura en Administración", "bachelor", "Licenciatura"],
  ["LICENCIATURA EN PSICOLOGÍA", "bachelor", "Licenciatura"],
  ["licenciatura en psicologia", "bachelor", "Licenciatura"],
  ["Lic. en Administración", "bachelor", "Licenciatura"],
  ["Licenciado en Economía", "bachelor", "Licenciatura"],
  ["Licenciada en Comunicación Social", "bachelor", "Licenciatura"],
  ["Grado en Derecho", "bachelor", "Grado"],
  ["Graduado en Administración y Dirección de Empresas", "bachelor", "Grado"],
  ["Pregrado en Economía", "bachelor", "Pregrado"],
  ["Ingeniería en Sistemas de Información", "bachelor", "Ingeniería"],
  ["Ingeniero Civil", "bachelor", "Ingeniería"],
  ["Ing. en Sistemas", "bachelor", "Ingeniería"],
  ["Ingeniero Técnico Industrial", "bachelor", "Ingeniería"],
  ["Profesorado en Matemática", "bachelor", "Profesorado"],
  ["Diplomatura en Enfermería", "bachelor", "Diplomatura"],
  ["Diplomado Universitario en Enfermería", "bachelor", "Diplomatura"],
  ["Contador Público", "bachelor", "Contador Público"],
  ["Contadora Pública Nacional", "bachelor", "Contador Público"],
  ["Abogacía", "bachelor", "Abogacía"],
  ["Abogado", "bachelor", "Abogacía"],
  ["Arquitectura", "bachelor", "Arquitectura"],
  ["Médico Cirujano", "bachelor", "Medicina"],
  ["Profesional", "bachelor", "Profesional"],
  ["Bachelor of Science in Computer Science", "bachelor", "Licenciatura"],
  ["Bachelor's Degree", "bachelor", "Licenciatura"],
  ["BSc Computer Science", "bachelor", "Licenciatura"],
  ["B.A. in History", "bachelor", "Licenciatura"],
  ["B.Eng.", "bachelor", "Ingeniería"],
  ["Bacharelado em Ciência da Computação", "bachelor", "Licenciatura"],
  ["Licenciatura em Letras", "bachelor", "Licenciatura"],
  ["Engenharia de Produção", "bachelor", "Ingeniería"],
  // --- postgraduate ---
  ["Especialización en Finanzas", "postgraduate", "Especialización"],
  ["Especialista en Cardiología", "postgraduate", "Especialización"],
  ["Posgrado en Gestión de Proyectos", "postgraduate", "Posgrado"],
  ["Postgrado en Marketing", "postgraduate", "Posgrado"],
  ["Diploma de Posgrado en Data Science", "postgraduate", "Posgrado"],
  ["Diplomado de Posgrado en Gestión Pública", "postgraduate", "Posgrado"],
  ["Postgraduate Certificate in Education", "postgraduate", "Posgrado"],
  ["Postgraduate Diploma", "postgraduate", "Posgrado"],
  ["Pós-graduação em Gestão de Projetos", "postgraduate", "Posgrado"],
  ["Especialização em Engenharia de Software", "postgraduate", "Especialización"],
  // --- master ---
  ["Maestría en Educación", "master", "Maestría"],
  ["Maestria en Educacion", "master", "Maestría"],
  ["Magíster en Ciencias", "master", "Maestría"],
  ["Magister en Administración", "master", "Maestría"],
  ["Máster Universitario en IA", "master", "Máster"],
  ["Máster propio en Big Data", "master", "Máster"],
  ["Master en Dirección de Empresas", "master", "Máster"],
  ["MBA", "master", "MBA"],
  ["Executive MBA", "master", "MBA"],
  ["Master in Business Administration (MBA)", "master", "MBA"],
  ["Master of Science", "master", "Máster"],
  ["Master's Degree in Data Science", "master", "Máster"],
  ["MSc in Computer Science", "master", "Máster"],
  ["M.Sc.", "master", "Máster"],
  ["MA in Linguistics", "master", "Máster"],
  ["MEng", "master", "Máster"],
  ["Mestrado em Engenharia", "master", "Maestría"],
  ["Grado y Máster en Derecho", "master", "Máster"],
  // --- doctorate ---
  ["Doctorado en Física", "doctorate", "Doctorado"],
  ["Doctor en Medicina", "doctorate", "Doctorado"],
  ["Doctora en Ciencias Sociales", "doctorate", "Doctorado"],
  ["PhD", "doctorate", "Doctorado"],
  ["Ph.D. in Physics", "doctorate", "Doctorado"],
  ["Doctorate in Education", "doctorate", "Doctorado"],
  ["Doutorado em Química", "doctorate", "Doctorado"],
  // --- course ---
  ["Curso de Python", "course", "Curso"],
  ["Diplomado en Marketing Digital", "course", "Diplomado"],
  ["Bootcamp Full Stack", "course", "Bootcamp"],
  ["BOOTCAMP FULL STACK", "course", "Bootcamp"],
  ["Certificación AWS Solutions Architect", "course", "Certificación"],
  ["Certificado de Profesionalidad", "course", "Certificación"],
  ["Certificate in Project Management", "course", "Certificación"],
  ["Taller de Liderazgo", "course", "Taller"],
  ["Seminario de Derecho Laboral", "course", "Seminario"],
  ["Capacitación en Ventas", "course", "Curso"],
  ["Nanodegree", "course", "Curso"],
  ["Curso de Especialización en Big Data", "course", "Curso"],
  ["Online course", "course", "Curso"],
  // --- unknown ---
  ["Otro", "unknown", null],
  ["Universidad de Buenos Aires", "unknown", null],
  ["Sistemas de Información", "unknown", null],
];

describe("normalizeStudyType", () => {
  it.each(CASES)("%j -> %s / %s", (input, level, canonical) => {
    expect(normalizeStudyType(input)).toEqual({ level, canonical, original: input });
  });

  it("covers every level in the table", () => {
    const covered = new Set(CASES.map(([, level]) => level));
    for (const level of EDUCATION_LEVELS) expect(covered.has(level), level).toBe(true);
  });

  it("trims the original and treats empty / null / undefined as unknown", () => {
    expect(normalizeStudyType("  Licenciatura en Sistemas  ")).toEqual({
      level: "bachelor",
      canonical: "Licenciatura",
      original: "Licenciatura en Sistemas",
    });
    const unknown = { level: "unknown", canonical: null, original: null };
    expect(normalizeStudyType("")).toEqual(unknown);
    expect(normalizeStudyType("   ")).toEqual(unknown);
    expect(normalizeStudyType(null)).toEqual(unknown);
    expect(normalizeStudyType(undefined)).toEqual(unknown);
  });

  it("falls back to the beginning of `area` when studyType is empty", () => {
    expect(normalizeStudyType(null, "Licenciatura en Sistemas")).toEqual({
      level: "bachelor",
      canonical: "Licenciatura",
      original: null,
    });
    expect(normalizeStudyType("", "Ingeniería en Sistemas de Información")).toEqual({
      level: "bachelor",
      canonical: "Ingeniería",
      original: null,
    });
    expect(normalizeStudyType(undefined, "Máster en Ciberseguridad").level).toBe("master");
  });

  it("ignores `area` when the title is not at its start or when studyType is present", () => {
    expect(normalizeStudyType(null, "Sistemas de Información (Licenciatura)").level).toBe(
      "unknown",
    );
    expect(normalizeStudyType(null, "Administración de Empresas").level).toBe("unknown");
    // studyType wins even when area carries a stronger-looking title.
    expect(normalizeStudyType("Tecnicatura", "Doctorado en Física").level).toBe("technical");
    // An unrecognized studyType is not rescued by area.
    expect(normalizeStudyType("Otro", "Licenciatura en Letras")).toEqual({
      level: "unknown",
      canonical: null,
      original: "Otro",
    });
  });

  it("picks the highest-ranking title when several appear", () => {
    expect(normalizeStudyType("Licenciatura y Doctorado en Química").level).toBe("doctorate");
    expect(normalizeStudyType("Grado + Máster en Ingeniería Industrial").canonical).toBe("Máster");
    expect(normalizeStudyType("Licenciatura en Ingeniería Química").canonical).toBe("Licenciatura");
    expect(normalizeStudyType("Grado en Ingeniería Informática").canonical).toBe("Grado");
  });

  it("keeps profession words below explicit technical or secondary titles", () => {
    expect(normalizeStudyType("Técnico Superior en Ingeniería Informática")).toMatchObject({
      level: "technical",
      canonical: "Técnico Superior",
    });
    expect(normalizeStudyType("Técnico en Medicina Nuclear").level).toBe("technical");
    expect(normalizeStudyType("Bachillerato en Arquitectura").level).toBe("secondary");
  });

  it("lets short-course words win over any degree word", () => {
    expect(normalizeStudyType("Curso de Especialización en Big Data").level).toBe("course");
    expect(normalizeStudyType("Certificado en Maestría de Ventas").level).toBe("course");
    expect(normalizeStudyType("Bootcamp de Ingeniería de Datos").canonical).toBe("Bootcamp");
  });

  it("does not read 'en curso' or 'cursó' as a course", () => {
    expect(normalizeStudyType("Licenciatura en Sistemas (en curso)").level).toBe("bachelor");
    expect(normalizeStudyType("Ingeniería, cursando 4to año").level).toBe("bachelor");
    expect(normalizeStudyType("Cursó 3 años de Abogacía").level).toBe("bachelor");
  });

  it("does not confuse 'posgrado' with 'grado' or 'bachiller' with 'bachelor'", () => {
    expect(normalizeStudyType("Post-grado en Finanzas")).toMatchObject({
      level: "postgraduate",
      canonical: "Posgrado",
    });
    expect(normalizeStudyType("Bachiller").level).toBe("secondary");
    expect(normalizeStudyType("Bachelor").level).toBe("bachelor");
  });

  it("matches on word boundaries", () => {
    expect(normalizeStudyType("Tecnología en Sistemas").level).toBe("unknown");
    expect(normalizeStudyType("Análisis de Sistemas").level).toBe("unknown");
    expect(normalizeStudyType("Medicinal").level).toBe("unknown");
  });

  it("produces objects that validate against ExtensionEducationLevelSchema", () => {
    for (const [input] of CASES) {
      const result = ExtensionEducationLevelSchema.safeParse(normalizeStudyType(input));
      expect(result.success, input).toBe(true);
    }
  });
});
