/**
 * Mapping helpers shared by the baseline adapters. They only reshape what a baseline already
 * produced; they never extract anything the baseline did not.
 *
 * Fairness: dates are normalized with cvparse's own `splitDateRange` / `normalizeDate`, so the
 * benchmark compares extraction (did the system find the right date text?) rather than date
 * formatting (rule-based parsers return the date text verbatim).
 */
import { normalizeDate, splitDateRange } from "../../src/index.js";
import type { GroundTruth } from "../types.js";

/** ISO start/end of a date string written by a baseline. `endDate: null` means ongoing. */
export interface MappedDates {
  startDate?: string;
  endDate?: string | null;
}

/**
 * Turns a baseline's raw date text ("Jun 2022 - Present", "2019 – 2021", "marzo 2020") into ISO
 * start/end. A single date goes to `single` ("start" for jobs; "end" for education, where a lone
 * date is the graduation date).
 */
export function mapDateText(
  text: string | null | undefined,
  single: "start" | "end" = "start",
): MappedDates {
  const raw = (text ?? "").trim();
  if (raw === "") return {};
  const range = splitDateRange(raw);
  if (range !== null) {
    return { startDate: range.start, endDate: range.current ? null : (range.end ?? undefined) };
  }
  const date = normalizeDate(raw);
  if (date.current) return single === "end" ? { endDate: null } : {};
  if (date.value === null) return {};
  return single === "end" ? { endDate: date.value } : { startDate: date.value };
}

const BULLETS = /[•●▪■◦‣∙·⦁○*]/g;

/**
 * Splits free-text skill lines into skill names: on bullets, commas, semicolons, pipes and slashes
 * surrounded by spaces. A leading "Category:" label is dropped ("Lenguajes: TypeScript, Go" ->
 * TypeScript, Go). Case-insensitive duplicates are removed, first occurrence wins.
 */
export function splitSkillText(lines: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const withoutLabel = line.replace(/^[^:,;]{1,40}:\s*/, "");
    for (const part of withoutLabel.replace(BULLETS, ",").split(/[,;|]|\s\/\s|\s[-–—]\s/)) {
      const name = part.replace(/\.$/, "").trim();
      if (name === "" || name.length > 60) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

/** Trims; empty / whitespace-only strings become `undefined`. */
export function nonEmpty(value: string | null | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

/** Location written as one string ("Córdoba, Argentina") -> JSON Resume location. */
export function mapLocationText(
  text: string | null | undefined,
): NonNullable<GroundTruth["basics"]>["location"] {
  const raw = nonEmpty(text);
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return { city: parts[0], region: parts.length > 2 ? parts[1] : undefined };
}

/** A GroundTruth with every evaluated section present and empty. */
export function emptyTruth(): GroundTruth {
  return { basics: {}, work: [], education: [], skills: [], languages: [] };
}
