/**
 * The dataset plan: 60 entries across layouts, formats and countries. Pure and deterministic, so
 * tests can rebuild the view models (rendered date strings, truth) without touching the files.
 */

import type { DatasetCountry, DatasetFormat, DatasetLayout } from "../types.js";
import { buildDoc, type CvDoc, type EntrySpec } from "./doc.js";
import { ROLES, type RoleId } from "./people.js";

/** Bump on any change that alters generated files or truth. Written to eval/dataset/VERSION. */
export const DATASET_VERSION = "1.0.0";

export interface PlanGroup {
  layout: DatasetLayout;
  format: DatasetFormat;
  count: number;
  /** Variants (0-based, within the group) rendered as Spanish CVs with English section titles. */
  mixed?: readonly number[];
}

export const PLAN: readonly PlanGroup[] = [
  { layout: "single-column", format: "pdf", count: 11, mixed: [3] },
  { layout: "two-column", format: "pdf", count: 11 },
  { layout: "sidebar", format: "pdf", count: 8 },
  { layout: "single-column", format: "docx", count: 6, mixed: [2] },
  { layout: "table", format: "docx", count: 6 },
  { layout: "textbox", format: "docx", count: 4 },
  { layout: "functional", format: "pdf", count: 4 },
  { layout: "academic", format: "pdf", count: 4 },
  { layout: "scanned", format: "image", count: 4 },
  { layout: "scanned", format: "pdf", count: 2 },
];

/** Round-robin order; the first 60 % 7 countries get one extra CV. */
export const COUNTRIES: readonly DatasetCountry[] = ["AR", "MX", "ES", "CO", "CL", "PE", "UY"];

export const EXTENSIONS: Record<DatasetFormat, string> = {
  pdf: "pdf",
  docx: "docx",
  image: "png",
  text: "txt",
};

export function planSpecs(): EntrySpec[] {
  const specs: EntrySpec[] = [];
  const perCountry = new Map<DatasetCountry, number>();
  let index = 0;
  for (const group of PLAN) {
    for (let variant = 0; variant < group.count; variant++) {
      const country = COUNTRIES[index % COUNTRIES.length] as DatasetCountry;
      const n = (perCountry.get(country) ?? 0) + 1;
      perCountry.set(country, n);
      const role: RoleId =
        group.layout === "academic"
          ? variant % 2 === 0
            ? "docencia"
            : "data"
          : (ROLES[index % ROLES.length] as RoleId);
      specs.push({
        id: `es-${country.toLowerCase()}-${String(n).padStart(3, "0")}`,
        index,
        country,
        role,
        layout: group.layout,
        format: group.format,
        language: group.mixed?.includes(variant) ? "mixed" : "es",
        variant,
      });
      index++;
    }
  }
  return specs;
}

export function buildDocs(): CvDoc[] {
  return planSpecs().map(buildDoc);
}
