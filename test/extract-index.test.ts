import { describe, expect, it } from "vitest";
import { CvparseError } from "../src/errors.js";
import { detectFormat, extractText } from "../src/extract/index.js";

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new TextEncoder().encode(text);

describe("detectFormat", () => {
  it("recognizes PDF by magic bytes, even with a few leading junk bytes", () => {
    expect(detectFormat(ascii("%PDF-1.7\n%âãÏÓ\n"))).toBe("pdf");
    expect(detectFormat(ascii("\n\n%PDF-1.4 garbage"))).toBe("pdf");
  });

  it("recognizes DOCX as a ZIP containing word/ entries", () => {
    const zipWithWord = new Uint8Array([
      ...bytes(0x50, 0x4b, 0x03, 0x04),
      ...ascii("....word/document.xml"),
    ]);
    expect(detectFormat(zipWithWord)).toBe("docx");
  });

  it("uses the file name to break ties for ZIPs without visible word/ entries", () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00);
    expect(detectFormat(zip, "cv.docx")).toBe("docx");
    expect(detectFormat(zip, "archive.zip")).toBe("zip");
    expect(detectFormat(zip)).toBe("zip");
  });

  it("recognizes images and legacy .doc files", () => {
    expect(detectFormat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe("image");
    expect(detectFormat(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image");
    expect(detectFormat(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image");
    expect(detectFormat(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe("legacy-doc");
  });

  it("treats valid UTF-8 without NUL bytes as text, including a BOM", () => {
    expect(detectFormat(ascii("María Pérez\nDesarrolladora"))).toBe("text");
    expect(detectFormat(new Uint8Array([0xef, 0xbb, 0xbf, ...ascii("hola")]))).toBe("text");
  });

  it("keeps a .txt/.md file that merely mentions %PDF- as text", () => {
    const note = ascii("Notas: el archivo original era %PDF-1.4 exportado desde Word.\nAna Pérez");
    expect(detectFormat(note, "cv.txt")).toBe("text");
    expect(detectFormat(note, "cv.md")).toBe("text");
    // Without a text extension the magic bytes win, as for a real PDF.
    expect(detectFormat(note)).toBe("pdf");
  });

  it("recognizes UTF-16 text by its BOM", () => {
    const utf16le = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    const utf16be = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
    expect(detectFormat(utf16le, "cv.txt")).toBe("text");
    expect(detectFormat(utf16be)).toBe("text");
  });

  it("returns unknown for empty input and binary garbage", () => {
    expect(detectFormat(new Uint8Array())).toBe("unknown");
    expect(detectFormat(bytes(0x00, 0x01, 0x02, 0xff))).toBe("unknown");
    expect(detectFormat(bytes(0xc3, 0x28, 0xa0, 0xa1))).toBe("unknown"); // invalid UTF-8
  });
});

describe("extractText", () => {
  it("decodes text bytes and strips a UTF-8 BOM", async () => {
    const doc = await extractText(new Uint8Array([0xef, 0xbb, 0xbf, ...ascii("Ana Pérez\n")]));
    expect(doc).toEqual({ text: "Ana Pérez\n", format: "text", layout: "unknown", warnings: [] });
  });

  it("decodes UTF-16 text files written by Notepad", async () => {
    const le = new Uint8Array([0xff, 0xfe, ...Buffer.from("Ana Pérez", "utf16le")]);
    expect((await extractText(le)).text).toBe("Ana Pérez");
    const beBody = Buffer.from("hola", "utf16le").swap16();
    const be = new Uint8Array([0xfe, 0xff, ...beBody]);
    expect((await extractText(be)).text).toBe("hola");
  });

  it("parseResume rejects an empty document with INVALID_INPUT before any extraction", async () => {
    const { parseResume } = await import("../src/parse.js");
    const model = {} as unknown as import("ai").LanguageModel;
    const error = await parseResume(new Uint8Array(0), { model }).catch((e: unknown) => e);
    expect((error as CvparseError).code).toBe("INVALID_INPUT");
    const error2 = await parseResume({ data: new Uint8Array(0) }, { model }).catch(
      (e: unknown) => e,
    );
    expect((error2 as CvparseError).code).toBe("INVALID_INPUT");
  });

  it("accepts { data, filename } and an explicit format override", async () => {
    const doc = await extractText({ data: ascii("hola"), filename: "cv.txt" });
    expect(doc.text).toBe("hola");
    const forced = await extractText({ data: bytes(0x00, 0x68, 0x69), format: "text" });
    expect(forced.format).toBe("text");
  });

  it("rejects images, legacy .doc, non-DOCX zips and unknown bytes with UNSUPPORTED_INPUT", async () => {
    const cases: Array<[Uint8Array, string | undefined, RegExp]> = [
      [bytes(0x89, 0x50, 0x4e, 0x47), "scan.png", /OCR/],
      [bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), "old.doc", /Legacy Word/],
      [bytes(0x50, 0x4b, 0x03, 0x04, 0x00, 0x00), "a.zip", /ZIP archive/],
      [bytes(0x00, 0x01, 0x02), undefined, /Could not recognize/],
    ];
    for (const [data, filename, pattern] of cases) {
      const error = await extractText({ data, filename }).catch((e: unknown) => e);
      expect(CvparseError.is(error), filename).toBe(true);
      expect((error as CvparseError).code).toBe("UNSUPPORTED_INPUT");
      expect((error as CvparseError).message).toMatch(pattern);
    }
  });

  it("rejects non-byte input with INVALID_INPUT", async () => {
    const error = await extractText({ data: "nope" as unknown as Uint8Array }).catch(
      (e: unknown) => e,
    );
    expect((error as CvparseError).code).toBe("INVALID_INPUT");
  });
});
