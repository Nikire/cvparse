import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CvparseError } from "../src/errors.js";
import { extractPdfText } from "../src/extract/pdf.js";

// Records when unpdf (and with it pdf.js) is first loaded, so we can assert laziness.
const unpdfLoaded = vi.hoisted(() => ({ value: false }));
vi.mock("unpdf", async (importOriginal) => {
  unpdfLoaded.value = true;
  return await importOriginal<typeof import("unpdf")>();
});

const here = dirname(fileURLToPath(import.meta.url));

function pdfFixture(name: string): Uint8Array {
  return readFileSync(join(here, "fixtures", "pdf", name));
}

/** Index of `needle` in `text`, failing the test when it is absent. */
function indexOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  expect(index, `expected "${needle}" in:\n${text}`).toBeGreaterThanOrEqual(0);
  return index;
}

function expectInOrder(text: string, needles: string[]): void {
  const positions = needles.map((needle) => indexOf(text, needle));
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

describe("extractPdfText", () => {
  it("does not load unpdf until a PDF is actually parsed", async () => {
    expect(unpdfLoaded.value).toBe(false);
    await extractPdfText(pdfFixture("single-column-es.pdf"));
    expect(unpdfLoaded.value).toBe(true);
  });

  it("extracts a single-column CV with sections in order", async () => {
    const result = await extractPdfText(pdfFixture("single-column-es.pdf"));

    expect(result.format).toBe("pdf");
    expect(result.pages).toBe(1);
    expect(result.layout).toBe("single-column");
    expect(result.warnings).toEqual([]);
    expectInOrder(result.text, [
      "MARÍA FERNANDA LÓPEZ GARCÍA",
      "PERFIL",
      "EXPERIENCIA LABORAL",
      "Fintonic Latam",
      "Marzo 2021 – Actualidad",
      "Mercado Local S.A.",
      "Freelance",
      "FORMACIÓN ACADÉMICA",
      "CURSOS Y CERTIFICACIONES",
      "HABILIDADES",
      "IDIOMAS",
      "Portugués: intermedio",
    ]);
    // Accents survive the standard-font encoding round trip.
    expect(result.text).toContain("Diseñé la arquitectura de pagos");
  });

  it("reads a two-column CV with a full-width header column by column", async () => {
    const result = await extractPdfText(pdfFixture("two-column-es.pdf"));

    expect(result.layout).toBe("multi-column");
    expect(result.pages).toBe(1);
    expectInOrder(result.text, [
      "MARÍA FERNANDA LÓPEZ GARCÍA",
      "mfernanda.lopez@example.com",
      "EXPERIENCIA",
      "Fintonic Latam",
      "marzo 2021 – actualidad",
      "Mercado Local S.A.",
      "Freelance",
      "Sitios y tiendas online",
      "HABILIDADES",
      "IDIOMAS",
      "EDUCACIÓN",
      "2012 – 2017",
    ]);
    // The whole Experiencia block (all three jobs) precedes the right column.
    expect(indexOf(result.text, "Sitios y tiendas online")).toBeLessThan(
      indexOf(result.text, "HABILIDADES"),
    );
    // No line mixes left and right column text.
    for (const line of result.text.split("\n")) {
      expect(line).not.toMatch(/Kafka\) que procesa.*(Node\.js, TypeScript|Español)/);
    }
  });

  it("reads a sidebar CV: sidebar first, then the main column in order", async () => {
    const result = await extractPdfText(pdfFixture("sidebar-es.pdf"));

    expect(result.layout).toBe("multi-column");
    expectInOrder(result.text, [
      "CONTACTO",
      "mfernanda.lopez@example.com",
      "HABILIDADES",
      "IDIOMAS",
      "CERTIFICACIONES",
      "MARÍA FERNANDA LÓPEZ GARCÍA",
      "PERFIL",
      "EXPERIENCIA",
      "Fintonic Latam",
      "marzo 2021 – actualidad",
      "Mercado Local S.A.",
      "Freelance",
    ]);
    expect(result.text).toContain(
      "Fintonic Latam — Buenos Aires\nTech Lead Backend · marzo 2021 – actualidad",
    );
  });

  it("concatenates pages of a multi-page CV", async () => {
    const result = await extractPdfText(pdfFixture("two-pages-es.pdf"));

    expect(result.pages).toBe(2);
    expect(result.layout).toBe("single-column");
    expect(result.warnings).toEqual([]);
    expectInOrder(result.text, [
      "MARÍA FERNANDA LÓPEZ GARCÍA",
      "EXPERIENCIA LABORAL",
      "IDIOMAS",
      "Portugués: intermedio",
    ]);
  });

  it("throws NO_TEXT_LAYER for a PDF without a text layer", async () => {
    const error = await extractPdfText(pdfFixture("no-text.pdf")).catch((e: unknown) => e);

    expect(CvparseError.is(error)).toBe(true);
    expect((error as CvparseError).code).toBe("NO_TEXT_LAYER");
    expect((error as CvparseError).message).toMatch(/text layer/);
  });

  it("throws EXTRACTION_FAILED for corrupt bytes", async () => {
    const error = await extractPdfText(Buffer.from("%PDF-1.7 garbage")).catch((e: unknown) => e);

    expect(CvparseError.is(error)).toBe(true);
    expect((error as CvparseError).code).toBe("EXTRACTION_FAILED");
    expect((error as CvparseError).cause).toBeInstanceOf(Error);
  });

  it("accepts a plain Uint8Array as well as a Buffer", async () => {
    const buffer = pdfFixture("single-column-es.pdf");
    const plain = new Uint8Array(buffer);
    const [fromBuffer, fromPlain] = await Promise.all([
      extractPdfText(buffer),
      extractPdfText(plain),
    ]);
    expect(fromPlain.text).toBe(fromBuffer.text);
  });

  it("never detaches the caller's buffer (pdf.js transfers its input to a worker)", async () => {
    const plain = new Uint8Array(pdfFixture("single-column-es.pdf"));
    const before = plain.byteLength;
    await extractPdfText(plain);
    expect(plain.byteLength).toBe(before);
    // A second extraction over the very same array must work too.
    const again = await extractPdfText(plain);
    expect(again.pages).toBe(1);
  });
});
