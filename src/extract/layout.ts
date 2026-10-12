/**
 * Reading-order reconstruction for positioned text items (PDF user space, origin bottom-left).
 *
 * Pure and dependency-free so it can be unit-tested with synthetic items and reused by any
 * extractor that yields `TextItem`s. The algorithm is a recursive XY-cut tuned for CVs:
 *
 * 1. Look for a vertical whitespace gutter across the whole region (two columns, sidebar).
 * 2. If none, retry after peeling lines off the top (full-width header: name/contact) and/or
 *    the bottom (full-width footer), since those lines cross the gutter. A few lines may be
 *    peeled off both ends at once; one end alone may be peeled to any depth, which is how a
 *    single-column body followed by two short blocks side by side ("IDIOMAS" next to
 *    "HABILIDADES") gets its bottom band split even without a vertical gap above it.
 * 3. If still none, split the region into horizontal bands at large vertical gaps and recurse.
 * 4. A region with no gutter and no gap is a leaf: group items into lines, lines into text.
 *    Words hyphenated at a line break are joined back (`dehyphenate`).
 *
 * Trying the gutter before the bands matters: two columns that share a blank line at the same
 * height would otherwise be cut horizontally first and the columns would interleave.
 *
 * Geometry alone cannot tell two columns from a table whose rows happen to leave a vertical
 * hole ("Empresa ........ 2019 – 2021"), so a candidate gutter is also checked against the
 * content-stream order of the items (their index in the `items` argument, which pdf.js keeps):
 * producers emit columns as contiguous runs and table rows cell by cell. See `isColumnSplit`.
 */

import type { DetectedLayout, TextItem } from "./types.js";

/** Page size in PDF points. */
export interface PageSize {
  width: number;
  height: number;
}

/** Result of ordering one page. */
export interface OrderedPage {
  text: string;
  layout: DetectedLayout;
}

/** Items grouped on one baseline. */
interface Line {
  /** Baseline of the first (topmost) item. */
  y: number;
  /** Tallest item height on the line. */
  height: number;
  items: TextItem[];
}

/** Items on either side of a detected vertical gutter. */
interface GutterSplit {
  left: TextItem[];
  right: TextItem[];
}

/** A vertical whitespace hole that may split a region. */
interface GutterCandidate {
  start: number;
  end: number;
  width: number;
  /** Lines each side needs; higher for holes that only pass the page-relative width floor. */
  minLines: number;
}

/** Two items are on the same baseline when their y differ by less than this × line height. */
const LINE_TOLERANCE_RATIO = 0.5;
/** Baseline tolerance when heights are unknown (0). */
const LINE_TOLERANCE_FALLBACK = 2;
/** Horizontal gap wider than this × average char width becomes a space. */
const SPACE_GAP_RATIO = 1 / 3;
/** Baseline-to-baseline distance larger than this × median line height starts a new band. */
const BAND_GAP_RATIO = 1.5;
/** Minimum gutter width as a fraction of the page width. */
const GUTTER_MIN_WIDTH_RATIO = 0.02;
/** A gutter must sit between these fractions of the region width... */
const GUTTER_MIN_POSITION = 0.2;
const GUTTER_MAX_POSITION = 0.8;
/** ...unless it is at least this fraction of the PAGE width (narrow sidebars). */
const PAGE_GUTTER_MIN_WIDTH_RATIO = 0.05;
/** Each side of a gutter needs at least this many lines. */
const MIN_LINES_PER_SIDE = 2;
/** Each side of a gutter accepted only by the page-relative floor needs this many lines. */
const PAGE_GUTTER_MIN_LINES = 4;
/**
 * How many leading/trailing lines may be peeled off BOTH ends at once to find a gutter under a
 * header and above a footer. One end alone may be peeled to any depth (a single-column body
 * followed by two short blocks side by side); the other end stays within this cap.
 */
const MAX_PEEL_LINES = 8;
const MAX_PEEL_RATIO = 0.4;
/**
 * Items with the same text closer than this are one overprinted glyph run (fake bold, drop
 * shadow): at least this many points, or `OVERPRINT_HEIGHT_RATIO` × the glyph height.
 */
const OVERPRINT_TOLERANCE = 2;
const OVERPRINT_HEIGHT_RATIO = 0.15;
/** A side-by-side block heading: this many letters, none lowercase... */
const HEADING_MIN_LETTERS = 3;
/** ...or a first line taller than the rest of its block by this factor. */
const HEADING_HEIGHT_RATIO = 1.15;
/** Top-aligned blocks of different length: the longer one has this many unpaired trailing lines. */
const BLOCK_MIN_TRAILING_LINES = 2;
/** De-hyphenation at a line break needs this many letters before the hyphen and after the break. */
const HYPHEN_MIN_LETTERS = 3;
/** Sides are columns when walking the items in stream order switches side at most this often. */
const COLUMN_MAX_SWITCHES = 2;
const COLUMN_MAX_SWITCH_RATIO = 0.1;
/** Edges within this many points are aligned. */
const ALIGNMENT_TOLERANCE = 2;
/** Interleaved sides still count as columns when the gutter is this wide (× page width)... */
const WIDE_GUTTER_RATIO = 0.03;
/** ...and both sides have this many lines of free text (median chars per line). */
const FREE_TEXT_MIN_LINES = 4;
const FREE_TEXT_MIN_CHARS = 30;

/**
 * Orders positioned text items into reading-order plain text and reports the detected layout.
 *
 * @param items Text fragments of one page, in content-stream order (the order the producer
 *   drew them; pdf.js preserves it). Whitespace-only fragments are ignored.
 * @param page Page size in points; only the width is used (gutter thresholds).
 */
export function orderTextItems(items: TextItem[], page: PageSize): OrderedPage {
  const order = new Map<TextItem, number>();
  items.forEach((item, index) => {
    if (!order.has(item)) {
      order.set(item, index);
    }
  });

  const usable = dropOverprint(
    items.filter(
      (item) =>
        item.str.trim().length > 0 &&
        Number.isFinite(item.x) &&
        Number.isFinite(item.y) &&
        Number.isFinite(item.width) &&
        Number.isFinite(item.height),
    ),
  );
  if (usable.length === 0) {
    return { text: "", layout: "unknown" };
  }

  const state: CutState = {
    multiColumn: false,
    pageWidth: page.width > 0 ? page.width : 612,
    order,
  };
  const blocks = cut(usable, state);
  const text = blocks
    .map((lines) => dehyphenate(lines).join("\n"))
    .filter((block) => block.length > 0)
    .join("\n\n")
    .trim();

  return { text, layout: state.multiColumn ? "multi-column" : "single-column" };
}

interface CutState {
  multiColumn: boolean;
  pageWidth: number;
  /** Content-stream position of each item. */
  order: Map<TextItem, number>;
}

/**
 * Drops items that repeat the same text at (almost) the same position: producers overprint a
 * run slightly offset to fake bold or a drop shadow, which would otherwise render as
 * "NOMBRENOMBRE". The offset tolerance scales with the glyph height (a shadow on a 30 pt name is
 * offset further than one on 10 pt body text). Runs the shadow pass split differently are caught
 * later, per line, by `renderLine`.
 */
function dropOverprint(items: TextItem[]): TextItem[] {
  const kept: TextItem[] = [];
  const byText = new Map<string, TextItem[]>();
  for (const item of items) {
    const key = item.str.trim();
    const same = byText.get(key) ?? [];
    const duplicate = same.some((other) => isOverprint(other, item));
    if (duplicate) {
      continue;
    }
    same.push(item);
    byText.set(key, same);
    kept.push(item);
  }
  return kept;
}

/** Two items with the same text sit within the overprint tolerance of each other on both axes. */
function isOverprint(a: TextItem, b: TextItem): boolean {
  const tolerance = overprintTolerance(a, b);
  return Math.abs(a.x - b.x) < tolerance && Math.abs(a.y - b.y) < tolerance;
}

function overprintTolerance(a: TextItem, b: TextItem): number {
  return Math.max(OVERPRINT_TOLERANCE, Math.max(a.height, b.height) * OVERPRINT_HEIGHT_RATIO);
}

/**
 * Joins a word hyphenated at a line break ("Comunica-" / "ción efectiva" -> "Comunicación
 * efectiva"). Conservative: the fragment before the hyphen and the continuation must both be at
 * least `HYPHEN_MIN_LETTERS` letters and the continuation must be lowercase, so "Full-" / "Stack"
 * and "2019-" / "2020" are left alone.
 */
export function dehyphenate(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev !== undefined && HYPHENATED_LINE_END.test(prev) && LOWERCASE_CONTINUATION.test(line)) {
      out[out.length - 1] = prev.slice(0, -1) + line;
      continue;
    }
    out.push(line);
  }
  return out;
}

const HYPHENATED_LINE_END = new RegExp(`\\p{L}{${HYPHEN_MIN_LETTERS},}[-‐]$`, "u");
const LOWERCASE_CONTINUATION = new RegExp(`^\\p{Ll}{${HYPHEN_MIN_LETTERS},}`, "u");

/** Recursive XY-cut. Returns blocks (arrays of rendered lines) in reading order. */
function cut(items: TextItem[], state: CutState): string[][] {
  const lines = groupLines(items);
  if (lines.length === 0) {
    return [];
  }

  // 1. Whole-region gutter.
  const whole = findGutter(items, state);
  if (whole) {
    state.multiColumn = true;
    return [...cut(whole.left, state), ...cut(whole.right, state)];
  }

  // 2. Gutter under a full-width header and/or above a full-width footer. Pairs (top, bottom)
  //    are tried by total peeled lines, fewest first, top-heavy first within a total. One end
  //    may be peeled to any depth (a single-column body followed by two blocks side by side);
  //    the other end stays within `maxPeel`, which bounds the search to O(lines × maxPeel).
  const maxPeel = Math.min(MAX_PEEL_LINES, Math.floor(lines.length * MAX_PEEL_RATIO));
  for (const [top, bottom] of peelCandidates(lines, maxPeel, state)) {
    const header = lines.slice(0, top).flatMap((line) => line.items);
    const footer = lines.slice(lines.length - bottom).flatMap((line) => line.items);
    const rest = lines.slice(top, lines.length - bottom).flatMap((line) => line.items);
    const split = findGutter(rest, state);
    if (split) {
      state.multiColumn = true;
      return [
        ...cut(header, state),
        ...cut(split.left, state),
        ...cut(split.right, state),
        ...cut(footer, state),
      ];
    }
  }

  // 3. Horizontal bands at large vertical gaps.
  const bands = splitBands(lines);
  if (bands.length > 1) {
    return bands.flatMap((band) =>
      cut(
        band.flatMap((line) => line.items),
        state,
      ),
    );
  }

  // 4. Leaf.
  return [lines.flatMap(renderLine)];
}

/** Groups items into baseline lines, top to bottom. Items within a line are sorted left to right. */
function groupLines(items: TextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  let current: Line | undefined;

  for (const item of sorted) {
    if (current && Math.abs(item.y - current.y) <= lineTolerance(item.height, current.height)) {
      current.items.push(item);
      current.height = Math.max(current.height, item.height);
    } else {
      current = { y: item.y, height: item.height, items: [item] };
      lines.push(current);
    }
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
  }
  return lines;
}

function lineTolerance(a: number, b: number): number {
  const positive = [a, b].filter((h) => h > 0);
  if (positive.length === 0) {
    return LINE_TOLERANCE_FALLBACK;
  }
  return Math.min(...positive) * LINE_TOLERANCE_RATIO;
}

/**
 * Finds the widest vertical whitespace gutter in a region that splits it into two sides with
 * enough lines each and that reads as columns (see `isColumnSplit`), or `undefined` when the
 * region reads as a single column.
 */
function findGutter(items: TextItem[], state: CutState): GutterSplit | undefined {
  if (items.length < MIN_LINES_PER_SIDE * 2) {
    return undefined;
  }

  // Merge x-intervals; the holes between merged intervals are the zero-coverage columns.
  const merged = mergeIntervals(items.map((item) => ({ start: item.x, end: item.x + item.width })));
  const candidates = gutterCandidates(merged, state);
  candidates.sort((a, b) => b.width - a.width);

  for (const candidate of candidates) {
    const left: TextItem[] = [];
    const right: TextItem[] = [];
    for (const item of items) {
      (item.x + item.width <= candidate.start ? left : right).push(item);
    }
    const leftLines = groupLines(left);
    const rightLines = groupLines(right);
    if (leftLines.length < candidate.minLines || rightLines.length < candidate.minLines) {
      continue;
    }
    if (!isColumnSplit(left, right, leftLines, rightLines, candidate.width, state)) {
      continue;
    }
    return { left, right };
  }
  return undefined;
}

interface Interval {
  start: number;
  end: number;
}

/** Sorts intervals and merges the overlapping/touching ones. */
function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * Holes between merged x-intervals that may be gutters: wide enough and inside the position
 * window of the region's extent, or wide relative to the page (narrow sidebars leave the
 * gutter outside the window; those need more lines per side).
 */
function gutterCandidates(merged: Interval[], state: CutState): GutterCandidate[] {
  const first = merged[0];
  const last = merged[merged.length - 1];
  if (!first || !last) {
    return [];
  }
  const x0 = first.start;
  const regionWidth = last.end - x0;
  if (regionWidth <= 0) {
    return [];
  }
  const minWidth = Math.max(state.pageWidth * GUTTER_MIN_WIDTH_RATIO, 1);
  const pageFloorWidth = state.pageWidth * PAGE_GUTTER_MIN_WIDTH_RATIO;
  const minCenter = x0 + regionWidth * GUTTER_MIN_POSITION;
  const maxCenter = x0 + regionWidth * GUTTER_MAX_POSITION;
  const candidates: GutterCandidate[] = [];
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1];
    const next = merged[i];
    if (!prev || !next) {
      continue;
    }
    const width = next.start - prev.end;
    const center = prev.end + width / 2;
    const positioned = width >= minWidth && center >= minCenter && center <= maxCenter;
    const wide = width >= pageFloorWidth;
    if (positioned || wide) {
      candidates.push({
        start: prev.end,
        end: next.start,
        width,
        minLines: positioned ? MIN_LINES_PER_SIDE : PAGE_GUTTER_MIN_LINES,
      });
    }
  }
  return candidates;
}

/**
 * (top, bottom) peel pairs worth a `findGutter` call, by total peeled lines, fewest first,
 * top-heavy first within a total. One end may be peeled to any depth while the other stays
 * within `maxPeel`. A pair is kept only when the x-coverage of the remaining lines leaves a hole
 * that passes `gutterCandidates`; the coverage is accumulated incrementally per line, so a dense
 * single-column page rejects every pair without sorting its items O(lines × maxPeel) times.
 * A deep peel (beyond `maxPeel`) must also remove a line that crosses that hole: peeling lines
 * that leave the hole open cannot expose a gutter the shallower pairs already rejected (a long
 * table whose rows are all interleaved would otherwise be re-tested at every depth).
 */
function peelCandidates(lines: Line[], maxPeel: number, state: CutState): [number, number][] {
  const n = lines.length;
  const coverage = lines.map((line) =>
    mergeIntervals(line.items.map((item) => ({ start: item.x, end: item.x + item.width }))),
  );
  const pairs: [number, number][] = [];
  const consider = (top: number, bottom: number, union: Interval[], peeled: Interval[]) => {
    if (n - bottom - top < MIN_LINES_PER_SIDE) {
      return;
    }
    const holes = gutterCandidates(union, state);
    if (holes.length === 0) {
      return;
    }
    if (Math.max(top, bottom) > maxPeel && !crossesAny(peeled, holes)) {
      return;
    }
    pairs.push([top, bottom]);
  };

  // rest = lines[top .. n-1-bottom]; walking `top` down (deep top) or `bottom` down (deep
  // bottom) adds one line to the rest each step, so its coverage union grows incrementally.
  for (let bottom = 0; bottom <= maxPeel; bottom++) {
    let union: Interval[] = [];
    for (let top = n - 1 - bottom; top >= 0; top--) {
      union = mergeIntervals([...union, ...(coverage[top] ?? [])]);
      if (top + bottom > 0) {
        consider(top, bottom, union, coverage[top - 1] ?? []);
      }
    }
  }
  for (let top = 0; top <= maxPeel; top++) {
    let union: Interval[] = [];
    for (let bottom = n - 1 - top; bottom > maxPeel; bottom--) {
      union = mergeIntervals([...union, ...(coverage[n - 1 - bottom] ?? [])]);
      consider(top, bottom, union, coverage[n - bottom] ?? []);
    }
  }

  return pairs.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || b[0] - a[0]);
}

/** Some interval in `intervals` overlaps some hole. */
function crossesAny(intervals: Interval[], holes: GutterCandidate[]): boolean {
  return intervals.some((interval) =>
    holes.some((hole) => interval.start < hole.end && interval.end > hole.start),
  );
}

/**
 * Decides whether a gutter separates two columns (read one after the other) or the cells of
 * table rows ("Empresa ........ 2019 – 2021", a Europass date column: keep each row joined).
 *
 * Primary signal: content-stream order. Walking the items in stream order, count how often
 * the side changes. Columns are emitted as (mostly) contiguous runs, so there are few switches
 * (≤ 2, or ≤ 10% of the line count); table rows are emitted cell by cell, so there are about
 * as many switches as rows.
 *
 * When the sides are interleaved, two secondary signals decide:
 * - a right-aligned value column (equal right edges, varying x) next to a left-aligned text
 *   column is a table;
 * - otherwise, a wide gutter with ≥ 4 lines of free text (median ≥ 30 chars) on both sides,
 *   whose sides do not pair up line for line, is still two columns (producers such as Canva
 *   sometimes emit a two-column page row by row);
 * - anything else interleaved is a table.
 */
function isColumnSplit(
  left: TextItem[],
  right: TextItem[],
  leftLines: Line[],
  rightLines: Line[],
  gutterWidth: number,
  state: CutState,
): boolean {
  const switches = countSideSwitches(left, right, state.order);
  const totalLines = leftLines.length + rightLines.length;
  const maxSwitches = Math.max(
    COLUMN_MAX_SWITCHES,
    Math.ceil(totalLines * COLUMN_MAX_SWITCH_RATIO),
  );
  if (switches <= maxSwitches) {
    return true;
  }
  if (isValueColumn(leftLines, rightLines) || isValueColumn(rightLines, leftLines)) {
    return false;
  }
  if (looksLikeSideBySideBlocks(leftLines, rightLines)) {
    return true;
  }
  return looksLikeFreeTextColumns(leftLines, rightLines, gutterWidth, state.pageWidth);
}

/**
 * Interleaved sides that are two short blocks placed side by side ("IDIOMAS" with three lines
 * next to "HABILIDADES" with six, at the bottom of a Canva page) rather than table rows. Both
 * blocks start on the same baseline and their first `min(lines)` lines pair up one to one; then
 * either both open with a heading (all caps, or taller than the rest of the block: side-by-side
 * section titles are never a table row) or the longer block runs on for at least
 * `BLOCK_MIN_TRAILING_LINES` lines with nothing beside them. A table whose rows have multi-line
 * cells leaves its unpaired lines BETWEEN the other side's lines, so it does not match.
 */
function looksLikeSideBySideBlocks(leftLines: Line[], rightLines: Line[]): boolean {
  const paired = Math.min(leftLines.length, rightLines.length);
  for (let i = 0; i < paired; i++) {
    const a = leftLines[i];
    const b = rightLines[i];
    if (!a || !b || Math.abs(a.y - b.y) > lineTolerance(a.height, b.height)) {
      return false;
    }
  }
  if (isHeadingLine(leftLines, 0) && isHeadingLine(rightLines, 0)) {
    return true;
  }
  const trailing = Math.max(leftLines.length, rightLines.length) - paired;
  return trailing >= BLOCK_MIN_TRAILING_LINES;
}

/** Line `index` reads as a section heading of its block: all caps, or taller than the others. */
function isHeadingLine(lines: Line[], index: number): boolean {
  const line = lines[index];
  if (!line) {
    return false;
  }
  const text = lineText(line);
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length >= HEADING_MIN_LETTERS && !/\p{Ll}/u.test(text)) {
    return true;
  }
  const others = lines.filter((_, i) => i !== index).map((other) => other.height);
  const reference = median(others.filter((h) => h > 0));
  return reference > 0 && line.height >= reference * HEADING_HEIGHT_RATIO;
}

function lineText(line: Line): string {
  return line.items.map((item) => item.str).join(" ");
}

/** Number of times the side changes when walking both sides' items in stream order. */
function countSideSwitches(
  left: TextItem[],
  right: TextItem[],
  order: Map<TextItem, number>,
): number {
  const sequence = [
    ...left.map((item) => ({ position: order.get(item) ?? 0, side: 0 })),
    ...right.map((item) => ({ position: order.get(item) ?? 0, side: 1 })),
  ].sort((a, b) => a.position - b.position);

  let switches = 0;
  for (let i = 1; i < sequence.length; i++) {
    const prev = sequence[i - 1];
    const cur = sequence[i];
    if (prev && cur && prev.side !== cur.side) {
      switches++;
    }
  }
  return switches;
}

/** `values` are right-aligned (equal right edge, varying x) and `labels` are left-aligned. */
function isValueColumn(values: Line[], labels: Line[]): boolean {
  if (values.length < MIN_LINES_PER_SIDE || labels.length < MIN_LINES_PER_SIDE) {
    return false;
  }
  const rightEdges = values.map(lineRight);
  const valueLefts = values.map(lineLeft);
  const labelLefts = labels.map(lineLeft);
  return (
    spread(rightEdges) <= ALIGNMENT_TOLERANCE &&
    spread(valueLefts) > ALIGNMENT_TOLERANCE &&
    spread(labelLefts) <= ALIGNMENT_TOLERANCE
  );
}

/**
 * Interleaved sides that still look like two columns of running text: wide gutter, both sides
 * with several lines of long text, and no line-for-line pairing (different line counts, or
 * baselines that do not all match).
 */
function looksLikeFreeTextColumns(
  leftLines: Line[],
  rightLines: Line[],
  gutterWidth: number,
  pageWidth: number,
): boolean {
  if (gutterWidth < pageWidth * WIDE_GUTTER_RATIO) {
    return false;
  }
  if (leftLines.length < FREE_TEXT_MIN_LINES || rightLines.length < FREE_TEXT_MIN_LINES) {
    return false;
  }
  if (
    medianLineChars(leftLines) < FREE_TEXT_MIN_CHARS ||
    medianLineChars(rightLines) < FREE_TEXT_MIN_CHARS
  ) {
    return false;
  }
  if (leftLines.length !== rightLines.length) {
    return true;
  }
  return !allBaselinesPaired(leftLines, rightLines);
}

/** Every line on one side shares a baseline with a line on the other side. */
function allBaselinesPaired(a: Line[], b: Line[]): boolean {
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  return small.every((line) =>
    big.some((other) => Math.abs(line.y - other.y) <= lineTolerance(line.height, other.height)),
  );
}

function lineLeft(line: Line): number {
  return Math.min(...line.items.map((item) => item.x));
}

function lineRight(line: Line): number {
  return Math.max(...line.items.map((item) => item.x + item.width));
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function medianLineChars(lines: Line[]): number {
  return median(
    lines.map((line) => line.items.reduce((sum, item) => sum + item.str.trim().length, 0)),
  );
}

/** Splits top-to-bottom lines into bands wherever the baseline distance is unusually large. */
function splitBands(lines: Line[]): Line[][] {
  if (lines.length < 2) {
    return [lines];
  }
  const medianHeight = median(lines.map((line) => line.height).filter((h) => h > 0));
  const distances: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    if (prev && cur) {
      distances.push(prev.y - cur.y);
    }
  }
  // Normal line spacing is ~1.2 × font height. Designs with looser spacing (sidebars at 1.6×)
  // would otherwise split at every line, so the reference also tracks the typical baseline
  // distance (lower quartile: most distances are "normal", the large ones are the gaps).
  const typicalDistance = percentile(
    distances.filter((d) => d > 0),
    0.25,
  );
  const reference = Math.max(medianHeight, typicalDistance / 1.2);
  if (!(reference > 0)) {
    return [lines];
  }
  const threshold = reference * BAND_GAP_RATIO;

  const bands: Line[][] = [];
  let current: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    const distance = distances[i - 1];
    if (current.length > 0 && distance !== undefined && distance > threshold) {
      bands.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    bands.push(current);
  }
  return bands;
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

/** Nearest-rank percentile (`p` in 0..1); 0 for an empty list. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 0;
}

/**
 * Renders a baseline line to text. Items are joined with a space when the horizontal gap is
 * wider than a third of a character; an item flagged `hasEOL` ends the output line early.
 *
 * A second copy of the previous item's text starting (almost) where it starts is a shadow or
 * fake-bold pass that `dropOverprint` missed because its vertical offset was larger (still on
 * the same baseline line) or because the producer split the run differently; it is dropped.
 */
function renderLine(line: Line): string[] {
  const out: string[] = [];
  let parts: string[] = [];
  const items = line.items.filter((item, i) => {
    const prev = line.items[i - 1];
    return !(
      prev &&
      prev.str.trim() === item.str.trim() &&
      Math.abs(item.x - prev.x) < overprintTolerance(prev, item)
    );
  });

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) {
      continue;
    }
    const prev = items[i - 1];
    if (prev) {
      const gap = item.x - (prev.x + prev.width);
      const charWidth = averageCharWidth(prev) || averageCharWidth(item) || item.height * 0.5 || 1;
      if (gap > charWidth * SPACE_GAP_RATIO) {
        parts.push(" ");
      }
    }
    parts.push(item.str);
    if (item.hasEOL && i < items.length - 1) {
      out.push(flush(parts));
      parts = [];
    }
  }
  out.push(flush(parts));
  return out.filter((text) => text.length > 0);
}

function averageCharWidth(item: TextItem): number {
  return item.str.length > 0 && item.width > 0 ? item.width / item.str.length : 0;
}

function flush(parts: string[]): string {
  return parts.join("").replace(/\s+/g, " ").trim();
}
