/**
 * cvparse — turn CVs/resumes into typed, JSON Resume-compatible JSON using LLMs via the
 * Vercel AI SDK.
 *
 * @packageDocumentation
 */

export { CvparseError, type CvparseErrorCode } from "./errors.js";
export { type NormalizedDate, normalizeDate } from "./normalize/dates.js";
export { type DetectedLanguage, detectLanguage } from "./normalize/language.js";
export { type NormalizeResult, normalizeResume } from "./normalize/resume.js";
export { parseResume } from "./parse.js";
export { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
export {
  type Award,
  AwardSchema,
  type Basics,
  BasicsSchema,
  type Certificate,
  CertificateSchema,
  type Education,
  EducationSchema,
  type Extension,
  type ExtensionLocation,
  ExtensionLocationSchema,
  ExtensionSchema,
  type Interest,
  InterestSchema,
  ISO_DATE_REGEX,
  IsoDateSchema,
  isIsoDate,
  type Language,
  LanguageSchema,
  type Location,
  LocationSchema,
  LooseDateSchema,
  type Profile,
  ProfileSchema,
  type Project,
  ProjectSchema,
  type Publication,
  PublicationSchema,
  RESUME_EXTRACTION_JSON_SCHEMA,
  RESUME_JSON_SCHEMA,
  type Reference,
  ReferenceSchema,
  type Resume,
  ResumeExtractionSchema,
  ResumeSchema,
  type Skill,
  SkillSchema,
  type Volunteer,
  VolunteerSchema,
  type Work,
  WorkSchema,
} from "./schema/index.js";
export type { ParseLanguage, ParseOptions, ParseResult, ParseUsage } from "./types.js";
export { CVPARSE_VERSION } from "./version.js";
