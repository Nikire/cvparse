import { z } from "zod";
import { EDUCATION_LEVELS } from "../normalize/education.js";

/**
 * Regular expression for the ISO 8601 date subset used by JSON Resume:
 * `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.
 */
export const ISO_DATE_REGEX = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

/** Returns true when `value` is an ISO date string accepted by {@link IsoDateSchema}. */
export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_REGEX.test(value);
}

const DATE_DESCRIPTION =
  "ISO 8601 date: YYYY, YYYY-MM or YYYY-MM-DD. Use null when unknown or when the entry is ongoing (e.g. 'actualidad', 'presente', 'present').";

/** Strict ISO date string (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`). Used by the public {@link ResumeSchema}. */
export const IsoDateSchema = z
  .string()
  .regex(ISO_DATE_REGEX, "Expected an ISO date: YYYY, YYYY-MM or YYYY-MM-DD")
  .describe(DATE_DESCRIPTION);

/**
 * Lenient date string used in the schema handed to the language model.
 * The value is normalized to ISO by cvparse after extraction (Spanish month names,
 * `MM/YYYY`, "actualidad", etc.).
 */
export const LooseDateSchema = z.string().describe(DATE_DESCRIPTION);

/**
 * Builds the full resume schema family for a given date schema.
 * The public schemas use the strict {@link IsoDateSchema}; the extraction schema sent to
 * the model uses {@link LooseDateSchema}. Both infer to the same TypeScript types.
 */
function buildSchemas<D extends z.ZodType<string>>(date: D) {
  const text = (description: string) => z.string().describe(description).nullish();
  const textArray = (description: string) => z.array(z.string()).describe(description).nullish();

  /** A location, following JSON Resume `basics.location`. */
  const Location = z
    .object({
      address: text("Street address as written in the CV."),
      postalCode: text("Postal / ZIP code."),
      city: text("City or town."),
      countryCode: text("ISO 3166-1 alpha-2 country code, e.g. 'AR', 'MX', 'ES', 'US'."),
      region: text("State, province or department, e.g. 'Buenos Aires', 'Jalisco', 'Madrid'."),
    })
    .describe("Where the candidate lives.");

  /** A social network / online profile (LinkedIn, GitHub, ...). */
  const Profile = z
    .object({
      network: text("Network name, e.g. 'LinkedIn', 'GitHub', 'Twitter'."),
      username: text("Username or handle on that network."),
      url: text("Full profile URL."),
    })
    .describe("An online profile of the candidate.");

  /** Personal and contact information (JSON Resume `basics`). */
  const Basics = z
    .object({
      name: text("Full name of the candidate."),
      label: text(
        "Professional headline / title, e.g. 'Desarrollador Backend', 'Product Designer'.",
      ),
      image: text("URL to a photo, if present."),
      email: text("Primary email address."),
      phone: text(
        "Primary phone number. Keep digits and a leading '+' with country code when evident, e.g. '+54 11 5555 5555'.",
      ),
      url: text("Personal website or portfolio URL."),
      summary: text("Professional summary / 'perfil' paragraph, verbatim from the CV."),
      location: Location.nullish(),
      profiles: z.array(Profile).describe("Online profiles found in the CV.").nullish(),
    })
    .describe("Personal and contact information.");

  /** A job / work experience entry (JSON Resume `work`). */
  const Work = z
    .object({
      name: text("Employer / company name."),
      location: text("Location of the job, as written (city, country, or 'Remoto')."),
      description: text("Short description of the company, if given."),
      position: text("Job title / role."),
      url: text("Company website, if given."),
      startDate: date.nullish(),
      endDate: date.nullish(),
      summary: text("Description of the role and responsibilities, verbatim or lightly cleaned."),
      highlights: textArray("Notable achievements or bullet points for this role."),
    })
    .describe("A work experience entry.");

  /** A volunteering entry (JSON Resume `volunteer`). */
  const Volunteer = z
    .object({
      organization: text("Organization name."),
      position: text("Role held."),
      url: text("Organization website."),
      startDate: date.nullish(),
      endDate: date.nullish(),
      summary: text("Description of the volunteering work."),
      highlights: textArray("Notable achievements."),
    })
    .describe("A volunteering entry.");

  /** An education entry (JSON Resume `education`). */
  const Education = z
    .object({
      institution: text("School, university or institute name."),
      url: text("Institution website."),
      area: text("Field of study, e.g. 'Ingeniería en Sistemas', 'Computer Science'."),
      studyType: text(
        "Degree type as written in the CV, in its canonical short form when the CV writes a degree word, e.g. 'Licenciatura', 'Ingeniería', 'Tecnicatura', 'Maestría', 'Doctorado', 'Bachelor', 'Master', 'PhD'; otherwise the title as written (e.g. 'Computer Engineering'). Never a degree type the CV does not write.",
      ),
      startDate: date.nullish(),
      endDate: date.nullish(),
      score: text("Grade / GPA / 'promedio', as written."),
      courses: textArray("Relevant courses listed for this degree."),
    })
    .describe("An education entry.");

  /** An award entry (JSON Resume `awards`). */
  const Award = z
    .object({
      title: text("Award title."),
      date: date.nullish(),
      awarder: text("Who granted the award."),
      summary: text("Short description."),
    })
    .describe("An award or recognition.");

  /** A certificate entry (JSON Resume `certificates`). */
  const Certificate = z
    .object({
      name: text("Certificate name, e.g. 'AWS Certified Solutions Architect'."),
      date: date.nullish(),
      issuer: text("Issuing organization."),
      url: text("Verification or certificate URL."),
    })
    .describe("A certification or course certificate.");

  /** A publication entry (JSON Resume `publications`). */
  const Publication = z
    .object({
      name: text("Title of the publication."),
      publisher: text("Publisher, journal or conference."),
      releaseDate: date.nullish(),
      url: text("Link to the publication."),
      summary: text("Short description."),
    })
    .describe("A publication.");

  /** A skill entry (JSON Resume `skills`). */
  const Skill = z
    .object({
      name: text("Skill or skill group name, e.g. 'Backend', 'JavaScript', 'Gestión de equipos'."),
      level: text("Proficiency level as written, e.g. 'Avanzado', 'Expert', 'Intermedio'."),
      keywords: textArray("Related keywords / technologies, e.g. ['Node.js', 'PostgreSQL']."),
    })
    .describe("A skill or group of skills.");

  /** A spoken language entry (JSON Resume `languages`). */
  const Language = z
    .object({
      language: text("Language name as written, e.g. 'Español', 'Inglés', 'English'."),
      fluency: text("Fluency as written, e.g. 'Nativo', 'Avanzado (C1)', 'Fluent'."),
    })
    .describe("A spoken language.");

  /** An interest entry (JSON Resume `interests`). */
  const Interest = z
    .object({
      name: text("Interest or hobby name."),
      keywords: textArray("Related keywords."),
    })
    .describe("A personal interest.");

  /** A reference entry (JSON Resume `references`). */
  const Reference = z
    .object({
      name: text("Name of the person giving the reference."),
      reference: text("The reference text or contact details, as written."),
    })
    .describe("A professional reference.");

  /** A project entry (JSON Resume `projects`). */
  const Project = z
    .object({
      name: text("Project name."),
      description: text("What the project is / does."),
      highlights: textArray("Notable points about the project."),
      keywords: textArray("Technologies or topics involved."),
      startDate: date.nullish(),
      endDate: date.nullish(),
      url: text("Project URL or repository."),
      roles: textArray("Roles the candidate had in the project."),
      entity: text("Company, client or organization the project was for."),
      type: text("Project type, e.g. 'application', 'volunteering', 'presentation'."),
    })
    .describe("A project.");

  /** cvparse extension: normalized location with LATAM-friendly fields. */
  const ExtLocation = z
    .object({
      countryCode: text(
        "ISO 3166-1 alpha-2 country code inferred from the CV, e.g. 'AR', 'CO', 'MX'.",
      ),
      adminRegion: text(
        "First-level administrative region: state, province or department, e.g. 'Córdoba', 'Antioquia', 'Nuevo León'.",
      ),
      city: text("City with correct spelling and accents, e.g. 'Ciudad de México', 'Medellín'."),
      raw: text("The location exactly as written in the CV."),
    })
    .describe("Normalized location of the candidate.");

  /** cvparse extension: normalized level of one `education[]` entry. */
  const ExtEducationLevel = z
    .object({
      level: z
        .enum(EDUCATION_LEVELS)
        .describe(
          "Coarse education level: 'secondary', 'technical', 'bachelor', 'postgraduate', 'master', 'doctorate', 'course' or 'unknown'.",
        ),
      original: z
        .string()
        .nullable()
        .describe("The education[].studyType text exactly as extracted, or null when empty."),
      canonical: z
        .string()
        .nullable()
        .describe(
          "Neutral Spanish label for the recognized title family, e.g. 'Licenciatura', 'Grado', 'Ingeniería', 'Tecnicatura', 'Técnico Superior', 'Formación Profesional', 'Especialización', 'Maestría', 'Máster', 'MBA', 'Doctorado', 'Diplomado', 'Curso', 'Certificación', 'Bootcamp', 'Bachillerato'. Null when the level is 'unknown'.",
        ),
    })
    .describe("Normalized level of one education entry.");

  /** cvparse extension block (`x_cvparse`): normalized data that JSON Resume does not cover. */
  const Extension = z
    .object({
      detectedLanguage: text(
        "ISO 639-1 code of the language the CV is written in, e.g. 'es', 'en', 'pt'.",
      ),
      normalizedSkills: textArray(
        "Flat, deduplicated, lowercase list of the skills in `skills` (every keyword, plus the names of entries without keywords). Computed deterministically by cvparse after extraction, so leave it null during extraction.",
      ),
      location: ExtLocation.nullish(),
      confidenceNotes: textArray(
        "Short notes about ambiguous or uncertain extractions, e.g. 'End date of first job unclear'. Empty when everything was clear.",
      ),
      educationLevels: z
        .array(ExtEducationLevel)
        .describe(
          "Parallel to `education`: same length and order, one entry per education item (educationLevels[i] describes education[i]). education[].studyType keeps the original text; the normalized level lives here. Computed deterministically by cvparse after extraction, so leave it null during extraction.",
        )
        .nullish(),
    })
    .describe("cvparse extensions to JSON Resume.");

  /** Full resume: JSON Resume v1 sections plus the `x_cvparse` extension. */
  const Resume = z
    .object({
      basics: Basics.nullish(),
      work: z.array(Work).describe("Work experience, most recent first.").nullish(),
      volunteer: z.array(Volunteer).describe("Volunteering experience.").nullish(),
      education: z.array(Education).describe("Education, most recent first.").nullish(),
      awards: z.array(Award).describe("Awards and recognitions.").nullish(),
      certificates: z.array(Certificate).describe("Certifications and courses.").nullish(),
      publications: z.array(Publication).describe("Publications.").nullish(),
      skills: z.array(Skill).describe("Skills, grouped as in the CV.").nullish(),
      languages: z.array(Language).describe("Spoken languages.").nullish(),
      interests: z.array(Interest).describe("Interests and hobbies.").nullish(),
      references: z.array(Reference).describe("References.").nullish(),
      projects: z.array(Project).describe("Projects.").nullish(),
      x_cvparse: Extension.nullish(),
    })
    .describe("A resume in JSON Resume format with cvparse extensions.");

  return {
    Location,
    Profile,
    Basics,
    Work,
    Volunteer,
    Education,
    Award,
    Certificate,
    Publication,
    Skill,
    Language,
    Interest,
    Reference,
    Project,
    ExtLocation,
    ExtEducationLevel,
    Extension,
    Resume,
  };
}

const strict = buildSchemas(IsoDateSchema);
const loose = buildSchemas(LooseDateSchema);

/** JSON Resume `basics.location`. */
export const LocationSchema = strict.Location;
/** JSON Resume `basics.profiles[]` item. */
export const ProfileSchema = strict.Profile;
/** JSON Resume `basics`. */
export const BasicsSchema = strict.Basics;
/** JSON Resume `work[]` item. */
export const WorkSchema = strict.Work;
/** JSON Resume `volunteer[]` item. */
export const VolunteerSchema = strict.Volunteer;
/** JSON Resume `education[]` item. */
export const EducationSchema = strict.Education;
/** JSON Resume `awards[]` item. */
export const AwardSchema = strict.Award;
/** JSON Resume `certificates[]` item. */
export const CertificateSchema = strict.Certificate;
/** JSON Resume `publications[]` item. */
export const PublicationSchema = strict.Publication;
/** JSON Resume `skills[]` item. */
export const SkillSchema = strict.Skill;
/** JSON Resume `languages[]` item. */
export const LanguageSchema = strict.Language;
/** JSON Resume `interests[]` item. */
export const InterestSchema = strict.Interest;
/** JSON Resume `references[]` item. */
export const ReferenceSchema = strict.Reference;
/** JSON Resume `projects[]` item. */
export const ProjectSchema = strict.Project;
/** cvparse extension: `x_cvparse.location`. */
export const ExtensionLocationSchema = strict.ExtLocation;
/** cvparse extension: `x_cvparse.educationLevels[]` item (parallel to `education[]`). */
export const ExtensionEducationLevelSchema = strict.ExtEducationLevel;
/** cvparse extension block: `x_cvparse`. */
export const ExtensionSchema = strict.Extension;

/**
 * The public resume schema: JSON Resume v1 sections (`basics`, `work`, `volunteer`, `education`,
 * `awards`, `certificates`, `publications`, `skills`, `languages`, `interests`, `references`,
 * `projects`) plus cvparse extensions under `x_cvparse`. All fields are optional and accept
 * `null`; dates must be ISO strings (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`).
 */
export const ResumeSchema = strict.Resume;

/**
 * Rewrites a schema so every object property is required-but-nullable instead of optional.
 * Structured-output APIs with strict JSON Schema (OpenAI, and providers that copy it) reject
 * optional properties, and required fields also push the model to consider every field.
 */
function toRequiredNullable(schema: z.ZodType): z.ZodType {
  const description = schema.description;
  const keep = <T extends z.ZodType>(next: T): T =>
    description === undefined ? next : (next.describe(description) as T);

  if (schema instanceof z.ZodOptional) return toRequiredNullable(schema.unwrap() as z.ZodType);
  if (schema instanceof z.ZodNullable) {
    return keep(toRequiredNullable(schema.unwrap() as z.ZodType).nullable());
  }
  if (schema instanceof z.ZodArray) {
    return keep(z.array(toRequiredNullable(schema.element as z.ZodType)));
  }
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
      const inner = toRequiredNullable(value);
      shape[key] = inner instanceof z.ZodNullable ? inner : inner.nullable();
    }
    return keep(z.object(shape));
  }
  return schema;
}

/**
 * Zod schema used to validate what the model returns. Same shape as {@link ResumeSchema} but
 * with lenient date strings, so a model that writes "marzo 2021" does not fail validation;
 * cvparse normalizes dates to ISO afterwards. Exported for callers that run their own extraction.
 */
export const ResumeExtractionSchema = loose.Resume;

/**
 * JSON Schema (draft-07) sent to the model as the structured-output format. It is
 * {@link ResumeExtractionSchema} with every property required-but-nullable, which strict
 * structured-output modes (OpenAI `strict: true`) demand and which nudges models to consider
 * every field. Validation of the response still uses the lenient {@link ResumeExtractionSchema}.
 */
export const RESUME_EXTRACTION_JSON_SCHEMA = z.toJSONSchema(toRequiredNullable(loose.Resume), {
  target: "draft-7",
  unrepresentable: "any",
}) as Record<string, unknown>;

export type Location = z.infer<typeof LocationSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Basics = z.infer<typeof BasicsSchema>;
export type Work = z.infer<typeof WorkSchema>;
export type Volunteer = z.infer<typeof VolunteerSchema>;
export type Education = z.infer<typeof EducationSchema>;
export type Award = z.infer<typeof AwardSchema>;
export type Certificate = z.infer<typeof CertificateSchema>;
export type Publication = z.infer<typeof PublicationSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type Language = z.infer<typeof LanguageSchema>;
export type Interest = z.infer<typeof InterestSchema>;
export type Reference = z.infer<typeof ReferenceSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ExtensionLocation = z.infer<typeof ExtensionLocationSchema>;
export type ExtensionEducationLevel = z.infer<typeof ExtensionEducationLevelSchema>;
export type Extension = z.infer<typeof ExtensionSchema>;
/** A parsed resume. Inferred from {@link ResumeSchema}. */
export type Resume = z.infer<typeof ResumeSchema>;

/**
 * JSON Schema (draft 2020-12) equivalent of {@link ResumeSchema}, generated with Zod's built-in
 * converter. Handy for non-TypeScript consumers, docs and validation in other languages.
 */
export const RESUME_JSON_SCHEMA = z.toJSONSchema(ResumeSchema, {
  target: "draft-2020-12",
  unrepresentable: "any",
}) as Record<string, unknown>;
