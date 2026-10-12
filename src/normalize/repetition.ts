/**
 * Defences against a model that repeats itself: loop detection on the raw output, repair of a
 * JSON object cut by the output limit, and removal of repeated entries.
 *
 * Small local models (llama3.1 8B at temperature 0) sometimes fall into a deterministic loop,
 * emitting the same array element until they hit `maxOutputTokens`. The raw text then ends in
 * many copies of one block; the tail of the text occurs over and over in the text before it.
 */

/** Sections that hold an array of entries (records). */
const ENTRY_SECTIONS = [
  "work",
  "volunteer",
  "education",
  "awards",
  "certificates",
  "publications",
  "skills",
  "languages",
  "interests",
  "references",
  "projects",
] as const;

/** String lists inside entries where a repeated value is never meaningful. */
const STRING_LIST_KEYS = ["highlights", "keywords", "courses", "roles"] as const;

/**
 * Fields that identify an entry: two entries of the same section with equal values for these are
 * the same entry even when their free text (highlights, summary) differs. Used only when salvaging
 * a looping output, where the repeats drift slightly ("Licenciatura en Diseño" / "Diseño").
 */
const IDENTITY_KEYS: Record<string, readonly string[]> = {
  work: ["name", "position", "startDate", "endDate"],
  volunteer: ["organization", "position", "startDate", "endDate"],
  education: ["institution", "area", "studyType", "startDate", "endDate"],
  awards: ["title", "date", "awarder"],
  certificates: ["name", "date", "issuer"],
  publications: ["name", "publisher", "releaseDate"],
  skills: ["name"],
  languages: ["language"],
  interests: ["name"],
  references: ["name"],
  projects: ["name", "startDate", "endDate"],
  profiles: ["network", "username", "url"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RepetitionOptions {
  /** Length of the trailing chunk that must repeat. Defaults to 200 characters. */
  window?: number;
  /** How many times the chunk must occur (non-overlapping). Defaults to 3. */
  repeats?: number;
}

/**
 * True when `text` ends in a repetition loop: its last `window` characters occur at least
 * `repeats` times (non-overlapping) in the text. A 200-character chunk of JSON resume output does
 * not legitimately occur three times (keys interleave with distinct values), while a looping model
 * repeats whole entries, so any trailing chunk recurs once per repeated entry.
 */
export function detectRepetitionLoop(text: string, options: RepetitionOptions = {}): boolean {
  const window = options.window ?? 200;
  const repeats = options.repeats ?? 3;
  if (text.length < window * repeats) return false;
  const tail = text.slice(-window);
  let count = 0;
  let index = text.indexOf(tail);
  while (index !== -1) {
    count++;
    if (count >= repeats) return true;
    index = text.indexOf(tail, index + window);
  }
  return false;
}

/**
 * Parses a JSON object that was cut mid-stream (for example by the output token limit). The text
 * is cut right after the last complete array element or object value (`}` or `]`), a trailing
 * comma is dropped and the brackets / braces still open are closed. Earlier cut points are tried
 * when the latest one does not parse. Returns `undefined` when nothing usable can be recovered.
 */
export function repairTruncatedJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;

  // Cut points: index just after a `}` / `]` that closes a nested container, with the closers
  // still needed at that point.
  const cuts: Array<{ end: number; closers: string }> = [];
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return undefined;
      if (stack.length === 0) {
        // The whole object closed: the text was not truncated after all.
        return parseObject(text.slice(start, i + 1));
      }
      cuts.push({ end: i + 1, closers: stack.slice().reverse().join("") });
    }
  }

  for (let k = cuts.length - 1, tries = 0; k >= 0 && tries < 50; k--, tries++) {
    const cut = cuts[k] as { end: number; closers: string };
    const parsed = parseObject(text.slice(start, cut.end) + cut.closers);
    if (parsed) return parsed;
  }
  return undefined;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Key-order-insensitive serialization; strings are trimmed and whitespace-collapsed. */
function canonical(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.trim().replace(/\s+/g, " "));
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function identity(section: string, entry: unknown): string {
  const keys = IDENTITY_KEYS[section];
  if (!keys || !isRecord(entry)) return canonical(entry);
  const values = keys.map((key) => {
    const value = entry[key];
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : null;
  });
  // An entry with none of its identity fields is only a duplicate if it is identical.
  if (values.every((value) => value === null)) return canonical(entry);
  return JSON.stringify(values);
}

/** Removes repeated items (first occurrence wins); returns how many were removed. */
function dedupeArray(items: unknown[], keyOf: (item: unknown) => string): number {
  const seen = new Set<string>();
  let removed = 0;
  for (let i = 0; i < items.length; ) {
    const key = keyOf(items[i]);
    if (seen.has(key)) {
      items.splice(i, 1);
      removed++;
    } else {
      seen.add(key);
      i++;
    }
  }
  return removed;
}

export interface DedupeOptions {
  /**
   * Also treat entries with the same identifying fields (company + position + dates, institution
   * + degree + dates, skill name, ...) as repeats, keeping the first. Meant for output salvaged
   * from a repetition loop; by default only identical entries are removed.
   */
  similar?: boolean;
}

/**
 * Removes repeated entries from every section array (`work`, `education`, `skills`, ...,
 * `basics.profiles`) and repeated strings from the lists inside entries (`highlights`,
 * `keywords`, `courses`, `roles`). Mutates `resume`; returns one warning per section that changed.
 */
export function dedupeResumeEntries(
  resume: Record<string, unknown>,
  options: DedupeOptions = {},
): string[] {
  const warnings: string[] = [];
  const sections: Array<{ path: string; section: string; items: unknown[] }> = [];
  for (const section of ENTRY_SECTIONS) {
    const items = resume[section];
    if (Array.isArray(items)) sections.push({ path: section, section, items });
  }
  if (isRecord(resume.basics) && Array.isArray(resume.basics.profiles)) {
    sections.push({ path: "basics.profiles", section: "profiles", items: resume.basics.profiles });
  }

  for (const { path, section, items } of sections) {
    const removed = dedupeArray(items, (item) =>
      options.similar ? identity(section, item) : canonical(item),
    );
    let removedStrings = 0;
    for (const entry of items) {
      if (!isRecord(entry)) continue;
      for (const key of STRING_LIST_KEYS) {
        const list = entry[key];
        if (!Array.isArray(list)) continue;
        removedStrings += dedupeArray(list, (item) =>
          typeof item === "string" ? canonical(item).toLowerCase() : canonical(item),
        );
      }
    }
    if (removed > 0) {
      // Not blamed on the model: the document itself may list the same entry twice.
      warnings.push(
        `model: removed ${removed} duplicate ${removed === 1 ? "entry" : "entries"} from ${path}.`,
      );
    }
    if (removedStrings > 0) {
      warnings.push(
        `model: removed ${removedStrings} repeated ${removedStrings === 1 ? "item" : "items"} inside ${path} entries (highlights, keywords, courses or roles).`,
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// Fabricated entries left by a repetition loop

/** Sections pruned after a salvage, with their organization, title and date keys. */
const DATED_SECTIONS: ReadonlyArray<{
  section: "work" | "education";
  orgKey: string;
  titleKey: string;
}> = [
  { section: "work", orgKey: "name", titleKey: "position" },
  { section: "education", orgKey: "institution", titleKey: "studyType" },
];

/** Salvaged arrays are cut to this many entries: a looping model, not a CV, produces more. */
export const SALVAGE_MAX_ENTRIES = 40;

/** Earliest plausible year for a date in a CV. */
const MIN_PLAUSIBLE_YEAR = 1950;

/** The year of a model date string ("2020", "2020-03", "marzo 2020"), or `null`. */
function yearOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /(?<!\d)(\d{4})(?!\d)/.exec(value);
  return match ? Number(match[1]) : null;
}

function fieldKey(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

/** `true` when 3+ numbers form an arithmetic progression with a non-zero step. */
function isArithmeticSequence(values: readonly number[]): boolean {
  if (values.length < 3) return false;
  const step = (values[1] as number) - (values[0] as number);
  if (step === 0) return false;
  return values.every((v, i) => i === 0 || v - (values[i - 1] as number) === step);
}

/**
 * Removes the entries a repetition loop fabricates and the salvage cannot tell apart by identity:
 * `work[]` / `education[]` entries dated before 1950 or more than a year after `referenceDate`,
 * entries that repeat another entry's organization + title with dates that count up or down in a
 * fixed step (the loop drifting its dates), and anything past {@link SALVAGE_MAX_ENTRIES} entries
 * in a section. Mutates `resume`; returns one warning per change.
 */
export function pruneSalvagedEntries(
  resume: Record<string, unknown>,
  referenceDate: Date = new Date(),
): string[] {
  const warnings: string[] = [];
  const maxYear = referenceDate.getUTCFullYear() + 1;
  for (const { section, orgKey, titleKey } of DATED_SECTIONS) {
    const items = resume[section];
    if (!Array.isArray(items)) continue;

    let implausible = 0;
    for (let i = 0; i < items.length; ) {
      const entry = items[i];
      const years = isRecord(entry)
        ? [yearOf(entry.startDate), yearOf(entry.endDate)].filter((y): y is number => y !== null)
        : [];
      if (years.some((y) => y < MIN_PLAUSIBLE_YEAR || y > maxYear)) {
        items.splice(i, 1);
        implausible++;
      } else i++;
    }
    if (implausible > 0) {
      warnings.push(
        `model: removed ${implausible} ${section} ${implausible === 1 ? "entry" : "entries"} with dates before ${MIN_PLAUSIBLE_YEAR} or after ${maxYear} (fabricated by the repetition loop).`,
      );
    }

    // Same organization + title, dates in a fixed step: keep the first of the run.
    const groups = new Map<string, number[]>();
    items.forEach((entry, i) => {
      if (!isRecord(entry)) return;
      const key = `${fieldKey(entry[orgKey])}|${fieldKey(entry[titleKey])}`;
      if (key === "|") return;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    });
    const drop = new Set<number>();
    for (const indexes of groups.values()) {
      if (indexes.length < 3) continue;
      for (const dateKey of ["startDate", "endDate"]) {
        const years = indexes.map((i) => yearOf((items[i] as Record<string, unknown>)[dateKey]));
        if (years.every((y): y is number => y !== null) && isArithmeticSequence(years)) {
          for (const i of indexes.slice(1)) drop.add(i);
          break;
        }
      }
    }
    if (drop.size > 0) {
      for (const i of [...drop].sort((a, b) => b - a)) items.splice(i, 1);
      warnings.push(
        `model: removed ${drop.size} ${section} ${drop.size === 1 ? "entry" : "entries"} that repeat another entry with dates counting in a fixed step (fabricated by the repetition loop).`,
      );
    }

    if (items.length > SALVAGE_MAX_ENTRIES) {
      const extra = items.length - SALVAGE_MAX_ENTRIES;
      items.splice(SALVAGE_MAX_ENTRIES);
      warnings.push(
        `model: kept the first ${SALVAGE_MAX_ENTRIES} ${section} entries and dropped ${extra} more (a salvaged output is not trusted past that).`,
      );
    }
  }
  return warnings;
}
