/**
 * cvparse — turn CVs/resumes into typed, JSON Resume-compatible JSON using LLMs via the
 * Vercel AI SDK.
 *
 * @packageDocumentation
 */

export { CvparseError, type CvparseErrorCode } from "./errors.js";
export {
  type DetectedFormat,
  type DetectedLayout,
  type DocumentInput,
  detectFormat,
  type ExtractedDocument,
  type ExtractTextOptions,
  extractText,
  type InputFormat,
  imageMimeType,
  type TextItem,
} from "./extract/index.js";
export { type OrderedPage, orderTextItems, type PageSize } from "./extract/layout.js";
export { recognizeWithAdapter } from "./extract/ocr.js";
export {
  type RenderedPage,
  type RenderPdfOptions,
  type RenderPdfResult,
  renderPdfPages,
} from "./extract/raster.js";
export {
  type DateOptions,
  type DateRange,
  type NormalizedDate,
  normalizeDate,
  splitDateRange,
} from "./normalize/dates.js";
export {
  EDUCATION_LEVELS,
  type EducationLevel,
  type EducationLevelInfo,
  normalizeStudyType,
} from "./normalize/education.js";
export { checkCoverage, type GroundResult, groundResume } from "./normalize/grounding.js";
export { type DetectedLanguage, detectLanguage } from "./normalize/language.js";
export { type NormalizeResult, normalizeResume } from "./normalize/resume.js";
export {
  type OcrAdapter,
  type OcrInput,
  type OcrItem,
  type OcrMimeType,
  type OcrPage,
  ocrItemsToTextItems,
} from "./ocr/types.js";
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
  type ExtensionEducationLevel,
  ExtensionEducationLevelSchema,
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
export type {
  ExtractionSource,
  OcrSource,
  ParseLanguage,
  ParseOptions,
  ParseResult,
  ParseUsage,
  ResumeInput,
} from "./types.js";
export { CVPARSE_VERSION } from "./version.js";
