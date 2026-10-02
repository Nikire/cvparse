/**
 * Field-level scorer for the cvparse evaluation. Rules are documented in eval/score/README.md.
 */

import type { FieldScore, GroundTruth, Prediction, ScoredField } from "../types.js";
import {
  cityMatches,
  jaccard,
  nameTokens,
  normalizeCity,
  normalizeDateValue,
  normalizeEmail,
  normalizeLanguage,
  normalizeSkill,
  normalizeText,
  phonesMatch,
  splitPhones,
  tokens,
} from "./normalize.js";

/** A field score that also carries the raw counts, so entries can be micro-averaged. */
export interface CountedFieldScore extends FieldScore {
  tp: number;
  fp: number;
  fn: number;
}

export type FieldScores = Partial<Record<ScoredField, CountedFieldScore>>;

/** Order in which fields are reported. */
export const SCORED_FIELDS: readonly ScoredField[] = [
  "basics.name",
  "basics.email",
  "basics.phone",
  "basics.location",
  "work.entries",
  "work.dates",
  "education.entries",
  "education.dates",
  "education.level",
  "skills",
  "languages",
];

/**
 * Fields every system is scored on. `overallF1` averages these only, so systems are comparable;
 * `education.level` is a cvparse-only diagnostic.
 */
export const COMMON_FIELDS: readonly ScoredField[] = SCORED_FIELDS.filter(
  (f) => f !== "education.level",
);

/** Minimum entry similarity for a truth/predicted work or education pair to match. */
export const ENTRY_MATCH_THRESHOLD = 0.5;
/** Minimum token Jaccard for `basics.name`. */
export const NAME_MATCH_THRESHOLD = 0.8;

export interface ScoreOptions {
  /**
   * Score `education.level`. Default: only when the prediction carries `x_cvparse` (so baselines,
   * which never produce it, get no score for the field instead of zero). The runner forces it on
   * for cvparse so a failed CV still counts as missed levels.
   */
  educationLevel?: boolean;
}

/** Builds a score from counts. Precision/recall of an empty denominator follow the usual 1/0 convention. */
export function fromCounts(tp: number, fp: number, fn: number): CountedFieldScore {
  const precision = tp + fp === 0 ? (fn === 0 ? 1 : 0) : tp / (tp + fp);
  const recall = tp + fn === 0 ? (fp === 0 ? 1 : 0) : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, support: tp + fn, tp, fp, fn };
}

interface Counts {
  tp: number;
  fp: number;
  fn: number;
}

/** Scalar field: absent on both sides → not scored. */
function scalar(truth: string, predicted: string, equal: boolean): Counts | undefined {
  if (!truth && !predicted) return undefined;
  if (!truth) return { tp: 0, fp: 1, fn: 0 };
  if (!predicted) return { tp: 0, fp: 0, fn: 1 };
  return equal ? { tp: 1, fp: 0, fn: 0 } : { tp: 0, fp: 1, fn: 1 };
}

function scoreName(truth: GroundTruth, predicted: GroundTruth | null): Counts | undefined {
  const t = nameTokens(truth.basics?.name);
  const p = nameTokens(predicted?.basics?.name);
  return scalar([...t].join(" "), [...p].join(" "), jaccard(t, p) >= NAME_MATCH_THRESHOLD);
}

function scoreEmail(truth: GroundTruth, predicted: GroundTruth | null): Counts | undefined {
  const t = normalizeEmail(truth.basics?.email);
  const p = normalizeEmail(predicted?.basics?.email);
  return scalar(t, p, t === p);
}

function scorePhone(truth: GroundTruth, predicted: GroundTruth | null): Counts | undefined {
  const t = splitPhones(truth.basics?.phone).join(" / ");
  const p = splitPhones(predicted?.basics?.phone).join(" / ");
  return scalar(t, p, phonesMatch(t, p));
}

/** City and country code: `basics.location`, falling back to `x_cvparse.location` per field. */
function locationOf(resume: GroundTruth | null): { city: string; country: string } {
  const basics = resume?.basics?.location;
  const ext = resume?.x_cvparse?.location;
  return {
    city: normalizeCity(basics?.city || ext?.city),
    country: normalizeText(basics?.countryCode || ext?.countryCode),
  };
}

function scoreLocation(truth: GroundTruth, predicted: GroundTruth | null): Counts | undefined {
  const t = locationOf(truth);
  const p = locationOf(predicted);
  // The city decides presence (aliases + token subset); the country code must agree only when
  // both sides have one.
  const equal =
    cityMatches(t.city, p.city) && (!t.country || !p.country || t.country === p.country);
  return scalar(t.city, p.city, equal);
}

/** Text similarity used for entry matching: token Jaccard without articles/legal suffixes. */
function similarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number | undefined {
  const ta = tokens(a, true);
  const tb = tokens(b, true);
  if (ta.size === 0 && tb.size === 0) return undefined;
  return jaccard(ta, tb);
}

/** Mean of the defined similarities; 0 when none is defined. */
function mean(values: (number | undefined)[]): number {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length === 0 ? 0 : defined.reduce((a, b) => a + b, 0) / defined.length;
}

/**
 * Optimal one-to-one assignment maximizing total similarity over pairs with similarity
 * ≥ `threshold`. Exact (DP over a bitmask of predicted entries) up to 16 predicted entries,
 * greedy by best score beyond that. Deterministic: ties go to the lowest indices.
 * Returns pairs `[truthIndex, predictedIndex]` sorted by truth index.
 */
export function assign(matrix: number[][], threshold = ENTRY_MATCH_THRESHOLD): [number, number][] {
  const rows = matrix.length;
  const cols = rows === 0 ? 0 : (matrix[0]?.length ?? 0);
  if (rows === 0 || cols === 0) return [];
  const at = (i: number, j: number) => matrix[i]?.[j] ?? 0;

  if (cols > 16) {
    const candidates: [number, number, number][] = [];
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < cols; j++) if (at(i, j) >= threshold) candidates.push([at(i, j), i, j]);
    candidates.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
    const usedRows = new Set<number>();
    const usedCols = new Set<number>();
    const pairs: [number, number][] = [];
    for (const [, i, j] of candidates) {
      if (usedRows.has(i) || usedCols.has(j)) continue;
      usedRows.add(i);
      usedCols.add(j);
      pairs.push([i, j]);
    }
    return pairs.sort((a, b) => a[0] - b[0]);
  }

  // best(i, mask): max total similarity assigning rows i.. given the used columns `mask`.
  const memo = new Map<number, number>();
  const best = (i: number, mask: number): number => {
    if (i === rows) return 0;
    const k = i * 2 ** cols + mask;
    const cached = memo.get(k);
    if (cached !== undefined) return cached;
    let value = best(i + 1, mask); // row i unmatched
    for (let j = 0; j < cols; j++) {
      if (mask & (1 << j) || at(i, j) < threshold) continue;
      value = Math.max(value, at(i, j) + best(i + 1, mask | (1 << j)));
    }
    memo.set(k, value);
    return value;
  };
  const EPS = 1e-9;
  const pairs: [number, number][] = [];
  let mask = 0;
  for (let i = 0; i < rows; i++) {
    const target = best(i, mask);
    for (let j = 0; j < cols; j++) {
      if (mask & (1 << j) || at(i, j) < threshold) continue;
      if (Math.abs(target - (at(i, j) + best(i + 1, mask | (1 << j)))) < EPS) {
        pairs.push([i, j]);
        mask |= 1 << j;
        break;
      }
    }
  }
  return pairs;
}

interface Dated {
  startDate?: string | null;
  endDate?: string | null;
}

const TP: Counts = { tp: 1, fp: 0, fn: 0 };
const FN: Counts = { tp: 0, fp: 0, fn: 1 };
const FP: Counts = { tp: 0, fp: 1, fn: 0 };
const MISMATCH: Counts = { tp: 0, fp: 1, fn: 1 };

/** A known truth date vs a prediction, at the truth's precision. */
function compareKnown(truthValue: string, predictedValue: string | null): Counts {
  if (predictedValue === null) return FN;
  return /^\d{4}/.test(truthValue) && predictedValue.startsWith(truthValue) ? TP : MISMATCH;
}

/**
 * Date counts for one matched pair (rules in eval/score/README.md):
 * - truth with start (+ end or ongoing): start and end slots are compared; an ongoing truth end
 *   (null) is a TP only when the prediction also has no end AND has a start date, so an entry
 *   with no dates at all does not get credit for "ongoing";
 * - truth with a single date (short courses, graduation-only education: endDate, no startDate):
 *   the prediction's single date may sit in either slot (endDate preferred); a predicted start
 *   on top of a predicted end is an extra FP;
 * - truth without dates: predicted dates are FP.
 */
export function scoreDates(truth: Dated, predicted: Dated): Counts {
  const ts = normalizeDateValue(truth.startDate);
  const te = normalizeDateValue(truth.endDate);
  const ps = normalizeDateValue(predicted.startDate);
  const pe = normalizeDateValue(predicted.endDate);
  const out: Counts = { tp: 0, fp: 0, fn: 0 };
  if (ts === null && te === null) {
    out.fp = (ps === null ? 0 : 1) + (pe === null ? 0 : 1);
    return out;
  }
  if (ts === null && te !== null) {
    add(out, compareKnown(te, pe ?? ps));
    if (pe !== null && ps !== null) add(out, FP);
    return out;
  }
  add(out, compareKnown(ts as string, ps));
  if (te === null) add(out, pe !== null ? MISMATCH : ps !== null ? TP : FN);
  else add(out, compareKnown(te, pe));
  return out;
}

/** Date slots an unmatched truth entry would have been scored on (all count as FN). */
function truthDateSlots(entry: Dated): number {
  const start = normalizeDateValue(entry.startDate) !== null;
  const end = normalizeDateValue(entry.endDate) !== null;
  if (!start) return end ? 1 : 0;
  return 2; // start + end (an ongoing end is a value)
}

function add(into: Counts, more: Counts | undefined): void {
  if (!more) return;
  into.tp += more.tp;
  into.fp += more.fp;
  into.fn += more.fn;
}

interface SectionScores {
  entries?: Counts;
  dates?: Counts;
  pairs: [number, number][];
}

function scoreSection<T extends Dated>(
  truth: readonly T[],
  predicted: readonly T[],
  fields: ((entry: T) => string | null | undefined)[],
): SectionScores {
  if (truth.length === 0 && predicted.length === 0) return { pairs: [] };
  const matrix = truth.map((t) =>
    predicted.map((p) => mean(fields.map((field) => similarity(field(t), field(p))))),
  );
  const pairs = assign(matrix);
  const entries: Counts = {
    tp: pairs.length,
    fp: predicted.length - pairs.length,
    fn: truth.length - pairs.length,
  };
  const dates: Counts = { tp: 0, fp: 0, fn: 0 };
  const matchedTruth = new Set(pairs.map(([i]) => i));
  for (const [i, j] of pairs) {
    const t = truth[i] as T;
    const p = predicted[j] as T;
    add(dates, scoreDates(t, p));
  }
  truth.forEach((t, i) => {
    if (!matchedTruth.has(i)) dates.fn += truthDateSlots(t);
  });
  const hasDates = dates.tp + dates.fp + dates.fn > 0;
  return hasDates ? { entries, dates, pairs } : { entries, pairs };
}

/**
 * Predicted education plus `certificates[]` mapped to education entries
 * ({ institution: issuer, studyType: name, endDate: date }). Short courses and bootcamps are
 * education in the truth; a parser that files them under certificates still gets credit, and
 * duplicates (a course in both lists) cost one FP.
 */
export function educationWithCertificates(predicted: Prediction | null): {
  entries: NonNullable<GroundTruth["education"]>;
  fromCertificates: number;
} {
  const education = predicted?.education ?? [];
  const certificates = (predicted?.certificates ?? []).map((c) => ({
    institution: c.issuer ?? null,
    studyType: c.name ?? null,
    endDate: c.date ?? null,
  }));
  return { entries: [...education, ...certificates], fromCertificates: certificates.length };
}

/** Skill set: every keyword, plus the group name when the group has no keywords. */
function skillSet(resume: GroundTruth | null): Set<string> {
  const out = new Set<string>();
  for (const skill of resume?.skills ?? []) {
    const keywords = (skill.keywords ?? []).map(normalizeSkill).filter(Boolean);
    if (keywords.length > 0) for (const k of keywords) out.add(k);
    else {
      const name = normalizeSkill(skill.name);
      if (name) out.add(name);
    }
  }
  return out;
}

function languageSet(resume: GroundTruth | null): Set<string> {
  const out = new Set<string>();
  for (const language of resume?.languages ?? []) {
    const code = normalizeLanguage(language.language);
    if (code) out.add(code);
  }
  return out;
}

function setCounts(truth: Set<string>, predicted: Set<string>): Counts | undefined {
  if (truth.size === 0 && predicted.size === 0) return undefined;
  let tp = 0;
  for (const item of predicted) if (truth.has(item)) tp++;
  return { tp, fp: predicted.size - tp, fn: truth.size - tp };
}

/**
 * Scores one prediction against its ground truth. `predicted = null` (the system failed) scores
 * every truth item as a false negative. Fields with nothing on either side are omitted.
 */
export function scoreEntry(
  truth: GroundTruth,
  predicted: Prediction | null,
  options: ScoreOptions = {},
): FieldScores {
  const out: FieldScores = {};
  const set = (field: ScoredField, counts: Counts | undefined) => {
    if (counts) out[field] = fromCounts(counts.tp, counts.fp, counts.fn);
  };

  set("basics.name", scoreName(truth, predicted));
  set("basics.email", scoreEmail(truth, predicted));
  set("basics.phone", scorePhone(truth, predicted));
  set("basics.location", scoreLocation(truth, predicted));

  const work = scoreSection(truth.work ?? [], predicted?.work ?? [], [
    (w) => w.name,
    (w) => w.position,
  ]);
  set("work.entries", work.entries);
  set("work.dates", work.dates);

  const truthEducation = truth.education ?? [];
  const predictedEducation = educationWithCertificates(predicted).entries;
  const firstCertificate = predicted?.education?.length ?? 0;
  const education = scoreSection(truthEducation, predictedEducation, [
    (e) => e.institution,
    (e) => [e.studyType, e.area].filter(Boolean).join(" "),
  ]);
  set("education.entries", education.entries);
  set("education.dates", education.dates);

  const scoreLevel = options.educationLevel ?? predicted?.x_cvparse != null;
  const truthLevels = truth.x_cvparse?.educationLevels ?? [];
  if (scoreLevel && truthLevels.length > 0) {
    const predictedLevels = predicted?.x_cvparse?.educationLevels ?? [];
    const counts: Counts = { tp: 0, fp: 0, fn: 0 };
    const matched = new Set<number>();
    for (const [i, j] of education.pairs) {
      const t = truthLevels[i]?.level;
      if (!t) continue;
      matched.add(i);
      // Entries that came from certificates[] are courses by construction.
      const p = j >= firstCertificate ? "course" : predictedLevels[j]?.level;
      if (!p) counts.fn++;
      else if (p === t) counts.tp++;
      else {
        counts.fp++;
        counts.fn++;
      }
    }
    truthLevels.forEach((level, i) => {
      if (level?.level && !matched.has(i) && i < truthEducation.length) counts.fn++;
    });
    if (counts.tp + counts.fp + counts.fn > 0) set("education.level", counts);
  }

  set("skills", setCounts(skillSet(truth), skillSet(predicted)));
  set("languages", setCounts(languageSet(truth), languageSet(predicted)));
  return out;
}

/** Recovers counts from a score that lacks them (e.g. hand-written results). */
function countsOf(score: FieldScore): Counts {
  const s = score as Partial<CountedFieldScore>;
  if (typeof s.tp === "number" && typeof s.fp === "number" && typeof s.fn === "number")
    return { tp: s.tp, fp: s.fp, fn: s.fn };
  const tp = Math.round(score.recall * score.support);
  const fn = score.support - tp;
  const fp = score.precision > 0 ? Math.round(tp / score.precision - tp) : 0;
  return { tp, fp, fn };
}

/**
 * Micro-average: sums TP/FP/FN per field across entries. Skipped entries (format the system
 * cannot read) are left out. `overallF1` is the mean of the per-field F1 values over
 * {@link COMMON_FIELDS} that are present (education.level is excluded).
 */
export function aggregate(
  entries: readonly { fields: Partial<Record<ScoredField, FieldScore>>; skipped?: string }[],
): { fields: FieldScores; overallF1: number } {
  const totals = new Map<ScoredField, Counts>();
  for (const entry of entries) {
    if (entry.skipped) continue;
    for (const field of SCORED_FIELDS) {
      const score = entry.fields[field];
      if (!score) continue;
      const total = totals.get(field) ?? { tp: 0, fp: 0, fn: 0 };
      add(total, countsOf(score));
      totals.set(field, total);
    }
  }
  const fields: FieldScores = {};
  const f1s: number[] = [];
  for (const field of SCORED_FIELDS) {
    const total = totals.get(field);
    if (!total) continue;
    const score = fromCounts(total.tp, total.fp, total.fn);
    fields[field] = score;
    if (COMMON_FIELDS.includes(field)) f1s.push(score.f1);
  }
  const overallF1 = f1s.length === 0 ? 0 : f1s.reduce((a, b) => a + b, 0) / f1s.length;
  return { fields, overallF1 };
}
