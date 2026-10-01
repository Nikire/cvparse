/**
 * DOCX → reading-order plain text.
 *
 * Strategy: mammoth converts the document to a small, predictable HTML subset (headings, lists,
 * tables, paragraphs, line breaks) and a dependency-free converter below turns that HTML into
 * text that keeps the section structure an LLM relies on. If the HTML conversion blows up we
 * fall back to mammoth's raw text. Text boxes that mammoth cannot see (DrawingML `wps:txbx`
 * without a VML fallback, common in design templates) are recovered straight from the main
 * document part and appended at the end with a warning.
 */

import { inflateRawSync } from "node:zlib";
import { CvparseError } from "../errors.js";
import type { ExtractedDocument } from "./types.js";

// mammoth ships its own `export =` typings (node_modules/mammoth/lib/index.d.ts); under
// NodeNext + esModuleInterop the dynamic import exposes them as `default`.
type Mammoth = typeof import("mammoth");
type MammothResult = Awaited<ReturnType<Mammoth["extractRawText"]>>;

const TEXT_BOX_WARNING = "text box content appended at the end";
const ZIP64_WARNING = "zip64 archive: text boxes could not be scanned";

/** Hard cap on a single decompressed zip part. A real CV's document.xml is a few MiB at most. */
const MAX_PART_BYTES = 256 * 1024 * 1024;

/**
 * Extracts reading-order text from a DOCX file.
 *
 * @param data Raw bytes of the `.docx` file.
 * @throws {CvparseError} with code `EXTRACTION_FAILED` when the bytes are not a zip, the main
 * document part exceeds the size limit, or neither the built-in reader nor mammoth can read
 * the document.
 */
export async function extractDocxText(data: Uint8Array): Promise<ExtractedDocument> {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const warnings: string[] = [];

  if (buffer.length < 4 || buffer.readUInt32LE(0) !== SIG_LOCAL) {
    throw new CvparseError("EXTRACTION_FAILED", "Not a DOCX file: missing zip signature");
  }

  // Best-effort structural read: it is cheap, yields clearer errors than mammoth's internals and
  // gives us the raw XML for text-box recovery. When it fails we still let mammoth try.
  const pkg = readDocxPackage(buffer);
  if (pkg.issue?.kind === "zip64") warnings.push(ZIP64_WARNING);

  const mammoth = await loadMammoth();
  let text: string;
  try {
    const html = await mammoth.convertToHtml({ buffer }, { ignoreEmptyParagraphs: true });
    collectMessages(html.messages, warnings);
    text = htmlToText(html.value);
  } catch (htmlError) {
    let raw: MammothResult;
    try {
      raw = await mammoth.extractRawText({ buffer });
    } catch (rawError) {
      throw unreadable(pkg.issue, rawError);
    }
    collectMessages(raw.messages, warnings);
    warnings.push(`HTML conversion failed (${describe(htmlError)}); fell back to raw text`);
    text = normalizeBlocks(raw.value.split(/\n{2,}/));
  }

  // Text boxes mammoth did not surface (DrawingML shapes without a VML fallback). Only lines
  // that already appear verbatim in the body are dropped; substrings do not count.
  if (pkg.documentXml !== undefined) {
    const bodyLines = new Set(text.split("\n").map(bodyLineKey));
    const missing = textBoxParagraphs(pkg.documentXml).filter(
      (line) => !bodyLines.has(bodyLineKey(line)),
    );
    if (missing.length > 0) {
      text = text.length > 0 ? `${text}\n\n${missing.join("\n")}` : missing.join("\n");
      warnings.push(TEXT_BOX_WARNING);
    }
  }

  return { text, format: "docx", pages: undefined, layout: "unknown", warnings };
}

/** Key used to match a text-box line against a body line: trimmed, without a bullet marker. */
function bodyLineKey(line: string): string {
  return line.trim().replace(/^- /, "");
}

async function loadMammoth(): Promise<Mammoth> {
  const mod = await import("mammoth");
  return mod.default;
}

function collectMessages(messages: MammothResult["messages"], warnings: string[]): void {
  for (const message of messages) {
    const line = `${message.type}: ${message.message}`;
    if (!warnings.includes(line)) warnings.push(line);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Error for a document neither reader could open, phrased with the structural diagnosis. */
function unreadable(issue: PackageIssue | undefined, mammothError: unknown): CvparseError {
  const detail = `mammoth: ${describe(mammothError)}`;
  if (issue === undefined || issue.kind === "zip64") {
    return new CvparseError("EXTRACTION_FAILED", `Could not read DOCX: ${detail}`, {
      cause: mammothError,
    });
  }
  const prefix = issue.kind === "missing-part" ? "Not a DOCX file" : "Corrupt DOCX";
  return new CvparseError("EXTRACTION_FAILED", `${prefix}: ${issue.message} (${detail})`, {
    cause: issue.cause ?? mammothError,
  });
}

// ---------------------------------------------------------------------------------------------
// Minimal zip reader: enough to pull the main document part out of a DOCX without a dependency.
// Reads the central directory (robust against data descriptors), supports stored and deflate.
// ---------------------------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const DEFAULT_MAIN_PART = "word/document.xml";
const OFFICE_DOCUMENT_REL = "/officeDocument";

/** Why the built-in reader could not deliver the main document part. */
export type PackageIssue =
  | { kind: "zip64"; message: string; cause?: undefined }
  | { kind: "corrupt"; message: string; cause: unknown }
  | { kind: "missing-part"; message: string; cause?: undefined };

export interface DocxPackage {
  /** Decoded XML of the main document part, when it could be located and read. */
  documentXml: string | undefined;
  /** Zip path of the main part (`word/document.xml` unless `_rels/.rels` says otherwise). */
  mainPart: string;
  /** Set when `documentXml` is undefined. */
  issue?: PackageIssue;
}

/** Thrown by the zip reader when the archive uses zip64 end-of-central-directory markers. */
class Zip64Error extends Error {
  override readonly name = "Zip64Error";
}

/**
 * Locates and decodes the main document part. Never throws for structural problems (they are
 * reported through `issue`); only a part larger than `maxPartBytes` is a hard
 * `EXTRACTION_FAILED` error, since decompressing it would exhaust memory in every reader.
 *
 * Exported for tests.
 */
export function readDocxPackage(buffer: Buffer, maxPartBytes = MAX_PART_BYTES): DocxPackage {
  let entries: ZipDirectory;
  try {
    entries = readZipDirectory(buffer);
  } catch (error) {
    if (error instanceof Zip64Error) {
      return {
        documentXml: undefined,
        mainPart: DEFAULT_MAIN_PART,
        issue: { kind: "zip64", message: error.message },
      };
    }
    return {
      documentXml: undefined,
      mainPart: DEFAULT_MAIN_PART,
      issue: { kind: "corrupt", message: describe(error), cause: error },
    };
  }

  let mainPart = DEFAULT_MAIN_PART;
  try {
    const rels = readZipEntry(buffer, entries, "_rels/.rels", maxPartBytes);
    if (rels !== undefined) mainPart = mainPartFromRels(rels.toString("utf8")) ?? mainPart;
  } catch (error) {
    if (error instanceof CvparseError) throw error;
    // A damaged .rels is not fatal: fall back to the conventional part name.
  }

  let entry: Buffer | undefined;
  try {
    entry = readZipEntry(buffer, entries, mainPart, maxPartBytes);
  } catch (error) {
    if (error instanceof CvparseError) throw error;
    return {
      documentXml: undefined,
      mainPart,
      issue: { kind: "corrupt", message: describe(error), cause: error },
    };
  }
  if (entry === undefined) {
    return {
      documentXml: undefined,
      mainPart,
      issue: { kind: "missing-part", message: `${mainPart} not found` },
    };
  }
  return { documentXml: entry.toString("utf8"), mainPart };
}

/**
 * Target of the `officeDocument` relationship in `_rels/.rels`, as a zip path (no leading `/`).
 * Exported for tests.
 */
export function mainPartFromRels(relsXml: string): string | undefined {
  for (const rel of relsXml.matchAll(/<Relationship\b([^>]*)>/g)) {
    const attrs = rel[1] ?? "";
    const type = /\bType\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    if (type === undefined || !type.endsWith(OFFICE_DOCUMENT_REL)) continue;
    const target = /\bTarget\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    if (target === undefined || target.length === 0) continue;
    const mode = /\bTargetMode\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    if (mode === "External") continue;
    return decodeEntities(target).replace(/^\/+/, "");
  }
  return undefined;
}

interface ZipEntryInfo {
  method: number;
  compressedSize: number;
  localOffset: number;
}
type ZipDirectory = Map<string, ZipEntryInfo>;

/** Parses the central directory into a name → entry map. Throws on a damaged archive. */
function readZipDirectory(buffer: Buffer): ZipDirectory {
  // End-of-central-directory record: fixed 22 bytes plus an optional comment (<= 64 KiB).
  const minEocd = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= minEocd; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("end of central directory not found");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (isZip64Eocd(entryCount, centralSize, centralOffset)) {
    throw new Zip64Error("zip64 end of central directory is not supported by the built-in reader");
  }

  const entries: ZipDirectory = new Map();
  let offset = centralOffset;
  for (let n = 0; n < entryCount; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new Error("central directory entry is damaged");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!entries.has(name)) entries.set(name, { method, compressedSize, localOffset });
  }
  return entries;
}

/**
 * True when the classic EOCD carries the "see the zip64 record" markers. Exported for tests.
 */
export function isZip64Eocd(
  entryCount: number,
  centralSize: number,
  centralOffset: number,
): boolean {
  return entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;
}

/**
 * Decompressed bytes of `wanted`, or `undefined` when the archive has no such entry. Throws a
 * plain `Error` for structural damage and `CvparseError` when the part exceeds `maxPartBytes`.
 */
function readZipEntry(
  buffer: Buffer,
  entries: ZipDirectory,
  wanted: string,
  maxPartBytes: number,
): Buffer | undefined {
  const info = entries.get(wanted);
  if (info === undefined) return undefined;
  const { method, compressedSize, localOffset } = info;

  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw new Error(`local header for ${wanted} is damaged`);
  }
  const dataStart =
    localOffset +
    30 +
    buffer.readUInt16LE(localOffset + 26) +
    buffer.readUInt16LE(localOffset + 28);
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buffer.length) throw new Error(`${wanted} is truncated`);
  const data = buffer.subarray(dataStart, dataEnd);
  if (method === 0) {
    if (data.length > maxPartBytes) throw tooLarge(wanted, maxPartBytes);
    return data;
  }
  if (method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: maxPartBytes });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw tooLarge(wanted, maxPartBytes, error);
      }
      throw new Error(`${wanted} is not valid deflate data: ${describe(error)}`);
    }
  }
  throw new Error(`unsupported compression method ${method} for ${wanted}`);
}

function tooLarge(part: string, maxPartBytes: number, cause?: unknown): CvparseError {
  const mib = Math.round(maxPartBytes / (1024 * 1024));
  return new CvparseError(
    "EXTRACTION_FAILED",
    `DOCX part ${part} exceeds the ${mib} MiB decompressed size limit`,
    { cause },
  );
}

// ---------------------------------------------------------------------------------------------
// Text boxes straight from WordprocessingML.
// ---------------------------------------------------------------------------------------------

/**
 * Plain-text lines of every paragraph inside a `w:txbxContent` element, in document order.
 *
 * Word emits the same box twice inside one `mc:AlternateContent` (`mc:Choice` + `mc:Fallback`),
 * so a box that repeats an earlier box of the *same* `mc:AlternateContent` block is skipped.
 * Boxes in different blocks are independent: two boxes that both say "Inglés" yield two lines.
 * A `w:br`/`w:cr` inside a paragraph produces separate lines; `w:tab` becomes a space.
 */
export function textBoxParagraphs(documentXml: string): string[] {
  if (!documentXml.includes("txbxContent")) return [];
  const lines: string[] = [];
  const pattern =
    /<mc:AlternateContent\b[^>]*>([\s\S]*?)<\/mc:AlternateContent>|<w:txbxContent\b[^>]*>([\s\S]*?)<\/w:txbxContent>/g;
  for (const match of documentXml.matchAll(pattern)) {
    if (match[1] !== undefined) {
      const seen = new Set<string>();
      for (const box of textBoxes(match[1])) {
        const key = box.join("\n");
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(...box);
      }
    } else {
      lines.push(...textBoxLines(match[2] ?? ""));
    }
  }
  return lines;
}

/** Each `w:txbxContent` inside `xml`, as its list of lines. */
function* textBoxes(xml: string): Generator<string[]> {
  for (const box of xml.matchAll(/<w:txbxContent\b[^>]*>([\s\S]*?)<\/w:txbxContent>/g)) {
    yield textBoxLines(box[1] ?? "");
  }
}

function textBoxLines(boxXml: string): string[] {
  const lines: string[] = [];
  for (const paragraph of boxXml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    for (const line of paragraphText(paragraph[1] ?? "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) lines.push(trimmed);
    }
  }
  return lines;
}

/**
 * Text of one `w:p`, with `\n` for `w:br`/`w:cr`. Self-closing `<w:t/>` is empty text, so the
 * lazy `[\s\S]*?` never swallows markup up to the next `</w:t>`.
 */
function paragraphText(paragraphXml: string): string {
  let out = "";
  for (const token of paragraphXml.matchAll(
    /<w:t(?:\s[^>]*)?\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*?\/?>/g,
  )) {
    if (token[2] === "tab") out += " ";
    else if (token[2] !== undefined) out += "\n";
    else if (token[1] !== undefined) out += decodeEntities(token[1]);
  }
  return out
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n");
}

// ---------------------------------------------------------------------------------------------
// HTML (mammoth's subset) → text.
// ---------------------------------------------------------------------------------------------

interface HtmlElement {
  tag: string;
  children: HtmlNode[];
}
type HtmlNode = HtmlElement | string;

const VOID_TAGS = new Set(["br", "img", "hr", "wbr", "input", "col", "meta", "link"]);
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "div",
  "pre",
  "blockquote",
  "dl",
  "dt",
  "dd",
  "section",
  "article",
]);

/** Converts mammoth's HTML subset to plain text. Exported for tests. */
export function htmlToText(html: string): string {
  const root = parseHtml(html);
  return normalizeBlocks(renderBlocks(root.children));
}

function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { tag: "#root", children: [] };
  const stack: HtmlElement[] = [root];
  const tagPattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let last = 0;
  for (const match of html.matchAll(tagPattern)) {
    const index = match.index ?? 0;
    const current = stack[stack.length - 1] as HtmlElement;
    if (index > last) current.children.push(decodeEntities(html.slice(last, index)));
    last = index + match[0].length;
    const tag = match[1]?.toLowerCase();
    if (tag === undefined) continue; // comment
    if (match[0].startsWith("</")) {
      // Close the nearest open element with this tag; tolerate stray closers.
      for (let i = stack.length - 1; i > 0; i--) {
        if ((stack[i] as HtmlElement).tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const element: HtmlElement = { tag, children: [] };
    current.children.push(element);
    if (!(VOID_TAGS.has(tag) || match[2] === "/")) stack.push(element);
  }
  if (last < html.length)
    (stack[stack.length - 1] as HtmlElement).children.push(decodeEntities(html.slice(last)));
  return root;
}

/** Renders a sequence of nodes into text blocks (each block may contain `\n`-separated lines). */
function renderBlocks(nodes: HtmlNode[]): string[] {
  const blocks: string[] = [];
  let inline = "";
  const flush = () => {
    if (inline.trim().length > 0) blocks.push(inline);
    inline = "";
  };
  for (const node of nodes) {
    if (typeof node === "string") {
      inline += node;
      continue;
    }
    if (!BLOCK_TAGS.has(node.tag)) {
      inline += renderInline(node);
      continue;
    }
    flush();
    blocks.push(...renderBlock(node));
  }
  flush();
  return blocks;
}

function renderBlock(element: HtmlElement): string[] {
  switch (element.tag) {
    case "ul":
    case "ol":
      return [renderList(element)];
    case "li":
      return [renderListItem(element)];
    case "table":
      return renderTable(element);
    case "thead":
    case "tbody":
    case "tfoot":
    case "tr":
    case "td":
    case "th":
      // A stray cell outside a table: fall through to its content.
      return renderBlocks(element.children);
    default:
      // p, h1-h6, div, pre, blockquote, dl/dt/dd, section...: inline content plus nested blocks.
      return renderBlocks(element.children);
  }
}

function renderInline(element: HtmlElement): string {
  if (element.tag === "br") return "\n";
  if (element.tag === "img") return "";
  let out = "";
  for (const child of element.children) {
    if (typeof child === "string") out += child;
    else if (BLOCK_TAGS.has(child.tag)) out += `\n${renderBlocks([child]).join("\n")}\n`;
    else out += renderInline(child);
  }
  return out;
}

function renderList(list: HtmlElement): string {
  const items: string[] = [];
  for (const child of list.children) {
    if (typeof child === "string") {
      if (child.trim().length > 0) items.push(child.trim());
      continue;
    }
    items.push(child.tag === "li" ? renderListItem(child) : renderBlocks([child]).join("\n"));
  }
  return items.filter((item) => item.length > 0).join("\n");
}

function renderListItem(item: HtmlElement): string {
  const blocks = renderBlocks(item.children)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  if (blocks.length === 0) return "";
  const [first, ...rest] = blocks;
  const lines = [`- ${first}`];
  for (const block of rest) {
    for (const line of block.split("\n")) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

function renderTable(table: HtmlElement): string[] {
  const rows: string[][][] = []; // rows → cells → blocks
  const visit = (nodes: HtmlNode[]) => {
    for (const node of nodes) {
      if (typeof node === "string") continue;
      if (node.tag === "tr") {
        const cells: string[][] = [];
        for (const cell of node.children) {
          if (typeof cell === "string") continue;
          if (cell.tag === "td" || cell.tag === "th") {
            cells.push(
              renderBlocks(cell.children)
                .map((block) => block.trim())
                .filter((block) => block.length > 0),
            );
          }
        }
        rows.push(cells);
      } else {
        visit(node.children);
      }
    }
  };
  visit(table.children);

  // A data table has short single-block cells: render it as "a | b | c" lines. A table used as
  // page layout (CV templates) has multi-block or long cells: emit the cells one after another
  // so each column reads as its own section.
  const isGrid = rows.every((cells) =>
    cells.every(
      (blocks) =>
        blocks.length <= 1 && (blocks[0] ?? "").length <= 80 && !(blocks[0] ?? "").includes("\n"),
    ),
  );
  if (isGrid) {
    const lines = rows
      .map((cells) => cells.map((blocks) => blocks[0] ?? "").join(" | "))
      .filter((line) => line.replace(/[\s|]/g, "").length > 0);
    return lines.length > 0 ? [lines.join("\n")] : [];
  }
  return rows.flatMap((cells) => cells.flat());
}

/** Trims lines, drops empty blocks and joins the rest with a blank line. */
function normalizeBlocks(blocks: string[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => {
        // Keep the indentation of nested list items; collapse everything else.
        const indent = /^( +)(?=- )/.exec(line)?.[1] ?? "";
        return (
          indent +
          line
            .slice(indent.length)
            .replace(/[ \t ]+/g, " ")
            .trim()
        );
      })
      .filter((line) => line.length > 0);
    if (lines.length > 0) out.push(lines.join("\n"));
  }
  return out.join("\n\n");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const REPLACEMENT_CHAR = "�";

/** Decodes the XML/HTML entities mammoth and WordprocessingML emit. Exported for tests. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return codePointToString(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return codePointToString(Number.parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** `String.fromCodePoint` that maps out-of-range and surrogate code points to U+FFFD. */
function codePointToString(codePoint: number): string {
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return REPLACEMENT_CHAR;
  }
  return String.fromCodePoint(codePoint);
}
