/**
 * Evaluation contract (0.3). Everything under eval/ is a dev-only harness: it is not part of the
 * published package (package.json `files` ships only dist/).
 *
 * Layout:
 *   eval/dataset/manifest.json      DatasetEntry[]  (committed)
 *   eval/dataset/truth/<id>.json    ground truth Resume per CV (committed)
 *   eval/dataset/files/<id>.<ext>   the rendered CV: .pdf | .docx | .png | .txt (committed)
 *   eval/results/<run>.json         RunResult (committed for published runs)
 *   eval/.cache/                    model outputs and third-party baselines (gitignored)
 */

import type { Resume } from "../src/schema/resume.js";

/** Visual/structural layout of a dataset CV. */
export type DatasetLayout =
  | "single-column"
  | "two-column"
  | "sidebar"
  | "table" // DOCX table used as layout (Word/Canva templates)
  | "textbox" // DOCX with DrawingML text boxes
  | "functional" // skills-first, little chronology
  | "academic" // long education/publications, Europass-like date column
  | "scanned"; // image or image-only PDF

export type DatasetFormat = "pdf" | "docx" | "image" | "text";

/** Spanish-speaking market variant the CV imitates (ISO 3166-1 alpha-2). */
export type DatasetCountry = "ES" | "AR" | "MX" | "CO" | "CL" | "PE" | "UY";

export interface DatasetEntry {
  /** Stable id, e.g. "es-ar-001". Also the file stem. */
  id: string;
  country: DatasetCountry;
  /** Main language of the CV text; "mixed" for Spanish CVs with English sections. */
  language: "es" | "mixed";
  layout: DatasetLayout;
  format: DatasetFormat;
  /** Path relative to eval/dataset/, e.g. "files/es-ar-001.pdf". */
  file: string;
  /** Path relative to eval/dataset/, e.g. "truth/es-ar-001.json". */
  truth: string;
  /** Date formats used in the rendered text, for slicing results ("marzo 2021", "03/2021", "2019-21", ...). */
  dateStyles: string[];
  /** Free-form difficulty tags: "ongoing-role", "spanish-degree", "two-digit-range", "photo", ... */
  tags: string[];
}

/** Ground truth: the subset of Resume fields the scorer evaluates. */
export type GroundTruth = Pick<Resume, "basics" | "work" | "education" | "skills" | "languages"> & {
  x_cvparse?: Pick<NonNullable<Resume["x_cvparse"]>, "educationLevels" | "location">;
};

/**
 * What a system returns: the ground-truth subset plus `certificates`, which the scorer appends
 * to the predicted education list (short courses may be routed there; see eval/score/README.md).
 */
export type Prediction = GroundTruth & Pick<Resume, "certificates">;

/** Field groups reported by the scorer. */
export type ScoredField =
  | "basics.name"
  | "basics.email"
  | "basics.phone"
  | "basics.location"
  | "work.entries" // entry-level match (company + position)
  | "work.dates" // start/end on matched entries
  | "education.entries"
  | "education.dates"
  | "education.level" // x_cvparse.educationLevels on matched entries (cvparse-only diagnostic, not in overallF1)
  | "skills"
  | "languages";

export interface FieldScore {
  precision: number;
  recall: number;
  f1: number;
  /** Number of truth items (or 1 for scalar fields) the score is computed over. */
  support: number;
}

export interface EntryScore {
  id: string;
  ok: boolean;
  /** Error message when the system failed on this CV (counts as empty output). */
  error?: string;
  /**
   * Set when the CV was not attempted because the system cannot read its format. Skipped entries
   * are excluded from every field score (they lower coverage, not F1).
   */
  skipped?: "unsupported-format";
  seconds?: number;
  fields: Partial<Record<ScoredField, FieldScore>>;
}

/** A system under test: cvparse with a given model/OCR setting, or a baseline. */
export interface SystemInfo {
  /** Display name, e.g. "cvparse + llama3.1 (8B, local)" or "open-resume (rules)". */
  name: string;
  kind: "cvparse" | "baseline";
  /**
   * Model id / OCR engine / version details. The runner adds provenance: `command` (exact CLI
   * argv), `cvparseCommit`, `cvparseSrcHash`, `datasetVersion`, `datasetHash`, `node`,
   * `hardware` and, when relevant, `ollamaVersion`, `modelDigest`, `tesseract.js`.
   */
  details: Record<string, string>;
}

export interface RunResult {
  system: SystemInfo;
  /** ISO timestamp when the run finished. */
  finishedAt: string;
  cvparseVersion: string;
  datasetVersion: string;
  entries: EntryScore[];
  /** Micro-averaged per field across entries. */
  fields: Partial<Record<ScoredField, FieldScore>>;
  /** Mean of the per-field F1 values over the fields common to every system (excludes education.level). */
  overallF1: number;
}

/** A system adapter used by the runner: CV file → predicted resume (GroundTruth shape). */
export interface EvalSystem {
  info: SystemInfo;
  /** Formats the system can read; entries in other formats are skipped (see EntryScore.skipped). */
  supports: readonly DatasetFormat[];
  predict(file: string, entry: DatasetEntry): Promise<Prediction>;
  dispose?(): Promise<void>;
}
